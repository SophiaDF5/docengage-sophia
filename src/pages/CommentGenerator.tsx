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
import { Copy, RefreshCw, Upload, Loader2, Trash2 } from "lucide-react";
import type { CommentWithPost } from "../types/database";

interface GenerateResult {
  data: {
    comment_id: string | null;
    post_id: string;
    generated_content: string;
    saved: boolean;
  };
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
        </TabsList>

        <TabsContent value="caption" className="mt-4">
          <CaptionMode orgId={currentOrgId} />
        </TabsContent>
        <TabsContent value="image" className="mt-4">
          <ImageMode orgId={currentOrgId} />
        </TabsContent>
      </Tabs>

      <CommentHistory orgId={currentOrgId} />
    </div>
  );
}

function OutputArea({
  content,
  isLoading,
  onRegenerate,
}: {
  content: string | null;
  isLoading: boolean;
  onRegenerate: () => void;
}) {
  const [edited, setEdited] = useState(content ?? "");

  // Sync when new content arrives
  useEffect(() => {
    if (content) setEdited(content);
  }, [content]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(edited);
    toast.success("Copied to clipboard");
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
  const queryClient = useQueryClient();

  const saveLeadIfNew = async () => {
    if (!authorName.trim() || !authorLinkedin.trim()) return;
    const { data: existing } = await supabase
      .from("doc_dm_leads")
      .select("id")
      .eq("org_id", orgId)
      .eq("links", authorLinkedin.trim())
      .maybeSingle();
    if (!existing) {
      const { error } = await supabase.from("doc_dm_leads").insert({
        org_id: orgId,
        name: authorName.trim(),
        links: authorLinkedin.trim(),
      });
      if (!error) {
        queryClient.invalidateQueries({ queryKey: ["dm-leads", orgId] });
        toast.success(`${authorName.trim()} saved to Leads`);
      }
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      return callEdgeFunction<GenerateResult>("doc_generate_comment", {
        org_id: orgId,
        mode: "caption",
        content,
        author_name: authorName || undefined,
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
      {authorName.trim() && authorLinkedin.trim() && (
        <p className="text-xs text-muted-foreground">
          This person will be saved to Leads after generation.
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
    if (!authorName.trim() || !authorLinkedin.trim()) return;
    const { data: existing } = await supabase
      .from("doc_dm_leads")
      .select("id")
      .eq("org_id", orgId)
      .eq("links", authorLinkedin.trim())
      .maybeSingle();
    if (!existing) {
      const { error } = await supabase.from("doc_dm_leads").insert({
        org_id: orgId,
        name: authorName.trim(),
        links: authorLinkedin.trim(),
      });
      if (!error) {
        queryClient.invalidateQueries({ queryKey: ["dm-leads", orgId] });
        toast.success(`${authorName.trim()} saved to Leads`);
      }
    }
  };

  const mutation = useMutation({
    mutationFn: async (imagePath: string) => {
      return callEdgeFunction<GenerateResult>("doc_generate_comment", {
        org_id: orgId,
        mode: "image",
        image_path: imagePath,
        author_name: authorName || undefined,
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
          This person will be saved to Leads after generation.
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
        isLoading={mutation.isPending}
        onRegenerate={() => {
          if (fileInputRef.current) fileInputRef.current.click();
        }}
      />
    </div>
  );
}

function CommentHistory({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  const historyQuery = useQuery({
    queryKey: ["comment-history", orgId],
    queryFn: async () => {
      await supabase
        .from("doc_comments")
        .delete()
        .eq("org_id", orgId)
        .lt("created_at", fiveDaysAgo);

      const { data, error } = await supabase
        .from("doc_comments")
        .select(
          "id, generated_content, edited_content, source, created_at, doc_posts(author_name, content)"
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
              {item.doc_posts?.author_name && (
                <span>for {item.doc_posts.author_name}</span>
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
