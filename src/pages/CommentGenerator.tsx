import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "../lib/supabaseClient";
import { callEdgeFunction } from "../lib/apiClient";
import { useOrganization } from "../hooks/useOrganization";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Copy, RefreshCw, Upload, Loader2, Trash2, MessageSquare, Search } from "lucide-react";
import type { CommentWithPost, Post, PostComment } from "../types/database";

interface GenerateResult {
  data: {
    comment_id: string | null;
    post_id: string;
    generated_content: string;
    is_reply?: boolean;
    replied_to?: string | null;
    saved: boolean;
  };
}

/**
 * Save a person to Engaged Leads if we have not met them before.
 *
 * The LinkedIn URL is written to both columns on purpose. `links` is the
 * freeform field the DM prompt reads and every existing row uses;
 * `linkedin_profile_url` is the structured column migration 010 added and is
 * what lookups should match on. Writing one and not the other is how the app
 * ended up unable to find people it had already saved.
 */
async function saveEngagedLead(
  orgId: string,
  name: string,
  linkedinUrl: string,
  headline?: string | null
): Promise<boolean> {
  const cleanName = name.trim();
  const cleanUrl = linkedinUrl.trim();
  if (!cleanName || !cleanUrl) return false;

  const { data: existing } = await supabase
    .from("doc_dm_leads")
    .select("id")
    .eq("org_id", orgId)
    .or(`linkedin_profile_url.eq.${cleanUrl},links.eq.${cleanUrl}`)
    .limit(1)
    .maybeSingle();
  if (existing) return false;

  // Commenting on someone's post, or replying to their comment, counts as
  // engaging with them — so this starts at "engaged", not the table default.
  const { error } = await supabase.from("doc_dm_leads").insert({
    org_id: orgId,
    name: cleanName,
    links: cleanUrl,
    linkedin_profile_url: cleanUrl,
    bio: headline?.trim() || null,
    status: "engaged",
  });
  return !error;
}

export function CommentGenerator() {
  const { currentOrgId } = useOrganization();

  if (!currentOrgId) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No organization selected.
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comment Generator</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate AI-powered LinkedIn comments. Copy and paste to LinkedIn.
        </p>
      </div>

      <Tabs defaultValue="caption">
        <TabsList>
          <TabsTrigger value="caption">Caption</TabsTrigger>
          <TabsTrigger value="image">Image</TabsTrigger>
          <TabsTrigger value="reply">Reply to a comment</TabsTrigger>
        </TabsList>

        <TabsContent value="caption" className="mt-4">
          <CaptionMode orgId={currentOrgId} />
        </TabsContent>
        <TabsContent value="image" className="mt-4">
          <ImageMode orgId={currentOrgId} />
        </TabsContent>
        <TabsContent value="reply" className="mt-4">
          <ReplyMode orgId={currentOrgId} />
        </TabsContent>
      </Tabs>

      <CommentHistory orgId={currentOrgId} />
    </div>
  );
}

function OutputArea({
  content,
  commentId,
  isLoading,
  onRegenerate,
}: {
  content: string | null;
  commentId?: string | null;
  isLoading: boolean;
  onRegenerate: () => void;
}) {
  const [edited, setEdited] = useState(content ?? "");
  const queryClient = useQueryClient();

  // Sync when new content arrives
  useEffect(() => {
    if (content) setEdited(content);
  }, [content]);

  // Copying is the moment a human takes the draft, so that is the approval —
  // and it is the only point at which we learn what they changed. Drafts are
  // saved pending; this is what moves them, via the existing approve function.
  const handleCopy = async () => {
    await navigator.clipboard.writeText(edited);
    toast.success("Copied to clipboard");

    if (!commentId || !edited.trim()) return;
    try {
      await callEdgeFunction("doc_approve_comment", {
        comment_id: commentId,
        edited_content: edited,
      });
      queryClient.invalidateQueries({ queryKey: ["comment-history"] });
    } catch {
      // The clipboard already has it; a failed status write must not look
      // like a failed copy.
    }
  };

  if (isLoading) {
    return (
      <Card className="mt-4">
        <CardContent className="pt-6 space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      </Card>
    );
  }

  if (!content) return null;

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Generated Comment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
          rows={4}
          className="text-sm"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {edited.length} characters
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onRegenerate}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Regenerate
            </Button>
            <Button size="sm" onClick={handleCopy}>
              <Copy className="h-4 w-4 mr-1" />
              Copy
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function CaptionMode({ orgId }: { orgId: string }) {
  const [content, setContent] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [authorLinkedin, setAuthorLinkedin] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const queryClient = useQueryClient();

  const saveLeadIfNew = async () => {
    if (await saveEngagedLead(orgId, authorName, authorLinkedin)) {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", orgId] });
      toast.success(`${authorName.trim()} saved to Engaged Leads`);
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<GenerateResult>("doc_generate_comment", {
        org_id: orgId,
        mode: "caption",
        content,
        author_name: authorName || undefined,
        author_linkedin_url: authorLinkedin.trim() || undefined,
        linkedin_post_url: postUrl.trim() || undefined,
      });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["comment-history", orgId] });
      await saveLeadIfNew();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    },
  });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Post Caption *</Label>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste the LinkedIn post text here..."
          rows={5}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Author Name</Label>
          <Input
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder="Dr. Smith"
          />
        </div>
        <div className="space-y-2">
          <Label>Author LinkedIn URL</Label>
          <Input
            value={authorLinkedin}
            onChange={(e) => setAuthorLinkedin(e.target.value)}
            placeholder="https://linkedin.com/in/dr-smith"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label>Post URL</Label>
        <Input
          value={postUrl}
          onChange={(e) => setPostUrl(e.target.value)}
          placeholder="https://linkedin.com/posts/..."
        />
        <p className="text-xs text-muted-foreground">
          Optional, but it keeps every comment on the same post together
          instead of creating a new record each time.
        </p>
      </div>
      {authorName.trim() && authorLinkedin.trim() && (
        <p className="text-xs text-muted-foreground">
          This person will be saved to Engaged Leads after generation.
        </p>
      )}
      <Button
        onClick={() => mutation.mutate()}
        disabled={!content.trim() || mutation.isPending}
      >
        {mutation.isPending ? (
          <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</>
        ) : (
          "Generate Comment"
        )}
      </Button>
      <OutputArea
        content={mutation.data?.data?.generated_content ?? null}
        commentId={mutation.data?.data?.comment_id ?? null}
        isLoading={mutation.isPending}
        onRegenerate={() => mutation.mutate()}
      />
    </div>
  );
}

function ImageMode({ orgId }: { orgId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [authorName, setAuthorName] = useState("");
  const [authorLinkedin, setAuthorLinkedin] = useState("");
  const queryClient = useQueryClient();

  const saveLeadIfNew = async () => {
    if (await saveEngagedLead(orgId, authorName, authorLinkedin)) {
      queryClient.invalidateQueries({ queryKey: ["dm-leads", orgId] });
      toast.success(`${authorName.trim()} saved to Engaged Leads`);
    }
  };

  const mutation = useMutation({
    mutationFn: async (imagePath: string) => {
      return callEdgeFunction<GenerateResult>("doc_generate_comment", {
        org_id: orgId,
        mode: "image",
        image_path: imagePath,
        author_name: authorName || undefined,
        author_linkedin_url: authorLinkedin.trim() || undefined,
      });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["comment-history", orgId] });
      await saveLeadIfNew();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    },
  });

  const handleUploadAndGenerate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setFileName(file.name);

    try {
      const ext = file.name.split(".").pop() ?? "png";
      const filePath = `${orgId}/${crypto.randomUUID()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("doc_comment_images")
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      mutation.mutate(filePath);
    } catch {
      toast.error("Failed to upload image");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Author Name</Label>
          <Input
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            placeholder="Dr. Smith"
          />
        </div>
        <div className="space-y-2">
          <Label>Author LinkedIn URL</Label>
          <Input
            value={authorLinkedin}
            onChange={(e) => setAuthorLinkedin(e.target.value)}
            placeholder="https://linkedin.com/in/dr-smith"
          />
        </div>
      </div>
      {authorName.trim() && authorLinkedin.trim() && (
        <p className="text-xs text-muted-foreground">
          This person will be saved to Engaged Leads after generation.
        </p>
      )}
      <div className="space-y-2">
        <Label>Screenshot of LinkedIn Post</Label>
        <div
          className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-foreground/30 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={handleUploadAndGenerate}
          />
          {uploading || mutation.isPending ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {uploading ? "Uploading..." : "Analyzing image..."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {fileName ? fileName : "Click to upload a screenshot"}
              </p>
              <p className="text-xs text-muted-foreground">PNG, JPG, or WebP</p>
            </div>
          )}
        </div>
      </div>
      <OutputArea
        content={mutation.data?.data?.generated_content ?? null}
        commentId={mutation.data?.data?.comment_id ?? null}
        isLoading={mutation.isPending}
        onRegenerate={() => {
          if (fileInputRef.current) fileInputRef.current.click();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Reply to a comment                                                 */
/* ------------------------------------------------------------------ */

/**
 * Replying inside a thread, rather than commenting on the post.
 *
 * Most of the volley happens here: the post author usually says nothing back,
 * and the person who commented almost always does. Comments come from the
 * scraper, which now keeps what people wrote instead of only who they were —
 * so this picks one and answers it. Pasting a comment by hand covers a post
 * that has never been scraped.
 */
function ReplyMode({ orgId }: { orgId: string }) {
  const [source, setSource] = useState<"saved" | "paste">("saved");
  const [postId, setPostId] = useState("");
  const [search, setSearch] = useState("");
  const [selectedCommentId, setSelectedCommentId] = useState("");

  // Pasted-comment fields, for a post we never scraped.
  const [pastedPost, setPastedPost] = useState("");
  const [pastedName, setPastedName] = useState("");
  const [pastedUrl, setPastedUrl] = useState("");
  const [pastedComment, setPastedComment] = useState("");

  const queryClient = useQueryClient();

  // Which posts actually have comments saved against them. Two small queries
  // rather than one join, so the post text is not sent back once per comment.
  const postsQuery = useQuery({
    queryKey: ["reply-posts", orgId],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("doc_post_comments")
        .select("post_id")
        .eq("org_id", orgId)
        .limit(5000);
      if (error) throw error;

      const counts = new Map<string, number>();
      for (const row of (rows ?? []) as { post_id: string }[]) {
        counts.set(row.post_id, (counts.get(row.post_id) ?? 0) + 1);
      }
      if (counts.size === 0) return [];

      const { data: posts, error: postError } = await supabase
        .from("doc_posts")
        .select("id, linkedin_post_url, author_name, content, created_at")
        .eq("org_id", orgId)
        .in("id", [...counts.keys()])
        .order("created_at", { ascending: false });
      if (postError) throw postError;

      return ((posts ?? []) as Post[]).map((p) => ({
        ...p,
        commentCount: counts.get(p.id) ?? 0,
      }));
    },
  });

  const commentsQuery = useQuery({
    queryKey: ["post-comments", orgId, postId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("doc_post_comments")
        .select("*")
        .eq("org_id", orgId)
        .eq("post_id", postId)
        // Likely doctors first — that is who this app is looking for — then
        // most recent.
        .order("is_doctor_lead", { ascending: false })
        .order("commented_at", { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as PostComment[];
    },
    enabled: !!postId,
  });

  const comments = commentsQuery.data ?? [];
  const term = search.trim().toLowerCase();
  const visible = term
    ? comments.filter(
        (c) =>
          c.commenter_name.toLowerCase().includes(term) ||
          (c.commenter_headline ?? "").toLowerCase().includes(term) ||
          (c.comment_text ?? "").toLowerCase().includes(term)
      )
    : comments;

  const posts = postsQuery.data ?? [];
  const selected = comments.find((c) => c.id === selectedCommentId) ?? null;
  const selectedPost = posts.find((p) => p.id === postId) ?? null;
  // The scraper saves who commented and what they said, but not the post
  // itself — the comments dataset does not carry it. Offer to fill it in
  // once; the reply is better with it and it is kept for next time.
  const postTextMissing = !!selectedPost && !selectedPost.content;

  const mutation = useMutation({
    mutationFn: async () => {
      if (source === "saved") {
        // A saved comment carries its post and its commenter, so the id is
        // the whole request.
        return callEdgeFunction<GenerateResult>("doc_generate_comment", {
          org_id: orgId,
          mode: "caption",
          reply_to_comment_id: selectedCommentId,
          // Only sent when the post's text is missing and the person typed
          // it in; the saved comment supplies everything else.
          content: postTextMissing ? pastedPost.trim() || undefined : undefined,
        });
      }
      return callEdgeFunction<GenerateResult>("doc_generate_comment", {
        org_id: orgId,
        mode: "caption",
        content: pastedPost.trim() || undefined,
        reply_to_name: pastedName.trim(),
        reply_to_linkedin_url: pastedUrl.trim() || undefined,
        reply_to_text: pastedComment.trim(),
      });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["comment-history", orgId] });

      const name = source === "saved" ? selected?.commenter_name : pastedName;
      const url =
        source === "saved" ? selected?.commenter_linkedin_url : pastedUrl;
      const headline = source === "saved" ? selected?.commenter_headline : null;
      if (name && url && (await saveEngagedLead(orgId, name, url, headline))) {
        queryClient.invalidateQueries({ queryKey: ["dm-leads", orgId] });
        toast.success(`${name.trim()} saved to Engaged Leads`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Generation failed");
    },
  });

  const canGenerate =
    source === "saved"
      ? !!selectedCommentId
      : !!pastedName.trim() && !!pastedComment.trim();

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button
          variant={source === "saved" ? "default" : "outline"}
          size="sm"
          onClick={() => setSource("saved")}
        >
          From a scraped post
        </Button>
        <Button
          variant={source === "paste" ? "default" : "outline"}
          size="sm"
          onClick={() => setSource("paste")}
        >
          Paste a comment
        </Button>
      </div>

      {source === "saved" ? (
        <>
          <div className="space-y-2">
            <Label>Which post?</Label>
            <select
              value={postId}
              onChange={(e) => {
                setPostId(e.target.value);
                setSelectedCommentId("");
                setSearch("");
              }}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Select a post you have scraped</option>
              {posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.author_name !== "Unknown" ? `${p.author_name} — ` : ""}
                  {p.linkedin_post_url.replace(/^https?:\/\/(www\.)?linkedin\.com\//, "")}
                  {` (${p.commentCount} comments)`}
                </option>
              ))}
            </select>
            {!postsQuery.isLoading && posts.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No comments saved yet. Scrape a post from the Scraped Leads
                page first — that is what collects the comments — or paste one
                in above.
              </p>
            )}
          </div>

          {postId && (
            <div className="space-y-2">
              <Label>Whose comment are you answering?</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by name, headline, or what they said"
                  className="pl-8"
                />
              </div>

              {postTextMissing && (
                <div className="space-y-2 pt-1">
                  <Label>The post itself (optional)</Label>
                  <Textarea
                    value={pastedPost}
                    onChange={(e) => setPastedPost(e.target.value)}
                    placeholder="Paste the post text — the scraper cannot read it, and the reply is better with it"
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    Saved against this post, so you only paste it once.
                  </p>
                </div>
              )}

              {commentsQuery.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : visible.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No comments match that.
                </p>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {visible.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedCommentId(c.id)}
                      className={`w-full text-left rounded-md border p-3 transition-colors ${
                        selectedCommentId === c.id
                          ? "border-foreground bg-accent"
                          : "hover:bg-accent/50"
                      }`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {c.commenter_name}
                        </span>
                        {c.is_doctor_lead && (
                          <Badge variant="outline">doctor</Badge>
                        )}
                      </div>
                      {c.commenter_headline && (
                        <p className="text-xs text-muted-foreground line-clamp-1">
                          {c.commenter_headline}
                        </p>
                      )}
                      <p className="text-sm mt-1 line-clamp-3">
                        {c.comment_text ?? (
                          <span className="text-muted-foreground italic">
                            The scraper did not capture this comment&rsquo;s
                            text — the reply will be to the person, not to
                            their words.
                          </span>
                        )}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label>The post they commented on</Label>
            <Textarea
              value={pastedPost}
              onChange={(e) => setPastedPost(e.target.value)}
              placeholder="Paste the post text — this is background for the reply"
              rows={4}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Who commented? *</Label>
              <Input
                value={pastedName}
                onChange={(e) => setPastedName(e.target.value)}
                placeholder="Dr. Smith"
              />
            </div>
            <div className="space-y-2">
              <Label>Their LinkedIn URL</Label>
              <Input
                value={pastedUrl}
                onChange={(e) => setPastedUrl(e.target.value)}
                placeholder="https://linkedin.com/in/dr-smith"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>What they said *</Label>
            <Textarea
              value={pastedComment}
              onChange={(e) => setPastedComment(e.target.value)}
              placeholder="Paste their comment"
              rows={4}
            />
          </div>
          {pastedName.trim() && pastedUrl.trim() && (
            <p className="text-xs text-muted-foreground">
              This person will be saved to Engaged Leads after generation.
            </p>
          )}
        </>
      )}

      <Button
        onClick={() => mutation.mutate()}
        disabled={!canGenerate || mutation.isPending}
      >
        {mutation.isPending ? (
          <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Generating...</>
        ) : (
          <><MessageSquare className="h-4 w-4 mr-1" /> Draft Reply</>
        )}
      </Button>

      <OutputArea
        content={mutation.data?.data?.generated_content ?? null}
        commentId={mutation.data?.data?.comment_id ?? null}
        isLoading={mutation.isPending}
        onRegenerate={() => mutation.mutate()}
      />
    </div>
  );
}

function CommentHistory({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();

  const historyQuery = useQuery({
    queryKey: ["comment-history", orgId],
    queryFn: async () => {
      // Reading the history used to delete everything older than five days.
      // That is a write hidden inside a read, and it destroyed the record of
      // what we have already said to a person — the one thing that stops us
      // repeating ourselves. The list is capped at 20 below; that is what
      // keeps this screen short, not deletion. Individual drafts can still be
      // deleted by hand with the button on each card.
      const { data, error } = await supabase
        .from("doc_comments")
        .select(
          "id, generated_content, edited_content, source, reply_to_name, reply_to_text, created_at, doc_posts(author_name, content)"
        )
        .eq("org_id", orgId)
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      return data as unknown as CommentWithPost[];
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (commentId: string) => {
      const { error } = await supabase
        .from("doc_comments")
        .delete()
        .eq("id", commentId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["comment-history", orgId] });
    },
    onError: () => {
      toast.error("Failed to delete comment");
    },
  });

  const items = historyQuery.data ?? [];
  if (items.length === 0) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Recent Comments</h2>
      {items.map((item) => (
        <Card key={item.id}>
          <CardContent className="pt-4 space-y-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{item.source}</Badge>
              {item.reply_to_name ? (
                <span>reply to {item.reply_to_name}</span>
              ) : (
                item.doc_posts?.author_name && (
                  <span>for {item.doc_posts.author_name}</span>
                )
              )}
              <span>{new Date(item.created_at).toLocaleDateString()}</span>
            </div>
            <p className="text-sm line-clamp-3">
              {item.edited_content || item.generated_content}
            </p>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    item.edited_content || item.generated_content || ""
                  );
                  toast.success("Copied");
                }}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => deleteMutation.mutate(item.id)}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
