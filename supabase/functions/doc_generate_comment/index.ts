import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { callOpenAI, callOpenAIVision } from "../_shared/openai.ts";
import { normalizePostUrl } from "../_shared/linkedin.ts";
import { ATIBA_PERSONA, ATIBA_HUMAN_STYLE_GUIDE, ATIBA_PERSPECTIVE_OVERRIDE } from "../_shared/atiba-persona.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GenerateCommentSchema = z.object({
  org_id: z.string().uuid(),
  mode: z.enum(["caption", "image", "link"]),
  content: z.string().min(1).max(10000).optional(),
  author_name: z.string().max(200).optional(),
  author_headline: z.string().max(500).optional(),
  author_linkedin_url: z.string().url().optional(),
  lead_id: z.string().uuid().optional(), // Look up bio/links/custom fields we already hold
  linkedin_post_url: z.string().url().optional(),
  image_path: z.string().optional(), // Storage path for image mode

  // Replying to a comment on the post rather than to the post itself.
  // Either point at a comment we already harvested (reply_to_comment_id,
  // which brings the post with it), or paste one in.
  reply_to_comment_id: z.string().uuid().optional(),
  reply_to_name: z.string().max(200).optional(),
  reply_to_headline: z.string().max(500).optional(),
  reply_to_linkedin_url: z.string().url().optional(),
  reply_to_text: z.string().min(1).max(5000).optional(),
}).refine(
  (d) => {
    // A saved comment carries its own post, so the caller does not have to
    // send the post text again.
    if (d.mode === "caption" && !d.content && !d.reply_to_comment_id) return false;
    if (d.mode === "link" && (!d.content || !d.linkedin_post_url)) return false;
    if (d.mode === "image" && !d.image_path) return false;
    // A pasted comment has to say who said it — a reply addressed to nobody
    // is the generic draft this whole change exists to stop.
    if (d.reply_to_text && !d.reply_to_comment_id && !d.reply_to_name) return false;
    return true;
  },
  { message: "Missing required fields for the selected mode" }
);

// The base persona (ATIBA_PERSONA), the DM-style formatting rules
// (ATIBA_HUMAN_STYLE_GUIDE), and the "don't label your perspective" override
// (ATIBA_PERSPECTIVE_OVERRIDE) all live in ../_shared/atiba-persona.ts and are
// shared with doc_generate_dm — this is now the app's one permanent, hardcoded
// voice for every account, not something read from doc_organizations
// .ai_system_prompt. See that file's header comment for the full history of
// why (the "as a business owner" framing kept resurfacing from Reina's
// per-account tone-sample text even with a trailing override, and she then
// asked for the voice to be locked/permanent across the whole app).
const COMMENT_STRUCTURE = `

Follow this structure for EVERY comment:
1. Acknowledge — connect with what the author shared personally or validate it
2. Add insight — a brief, plainly-stated thought or reaction of your own. Don't announce where it's coming from or frame it as advice — just say what you think.
3. Follow-up question — end with a simple, genuine question to keep the conversation going

Keep it to 2-4 sentences. Sound like a real human having a conversation, not an AI or a press release. Never use phrases like "Great post!", "Thanks for sharing!", or "Wow..." — go straight to the substance.`;

/**
 * Everything we already know about the person, folded into the prompt.
 * The app was storing all of this and sending none of it, which is why the
 * drafts read like they could have been written for anyone.
 */
function buildAuthorContext(parts: {
  name?: string | null;
  headline?: string | null;
  profileUrl?: string | null;
  bio?: string | null;
  links?: string | null;
  customFields?: Record<string, unknown> | null;
}): string {
  const lines: string[] = [];
  if (parts.name) lines.push(`Name: ${parts.name}`);
  if (parts.headline) lines.push(`LinkedIn headline: ${parts.headline}`);
  if (parts.profileUrl) lines.push(`Profile: ${parts.profileUrl}`);
  if (parts.bio) lines.push(`What we know about them: ${parts.bio}`);
  if (parts.links) lines.push(`Their links: ${parts.links}`);
  if (parts.customFields) {
    for (const [key, value] of Object.entries(parts.customFields)) {
      if (typeof value === "string" && value.trim()) lines.push(`${key}: ${value}`);
    }
  }
  if (lines.length === 0) return "";
  return `\n\nAbout the person who wrote this post:\n${lines.join("\n")}`;
}

/**
 * Replying to a comment is a different job from commenting on a post, and
 * getting it wrong is obvious to everyone reading the thread: the reply
 * praises a post the commenter did not write, or answers a point they did
 * not make. So the structure is restated against the commenter, and the post
 * is demoted to background.
 *
 * The volley is unchanged — acknowledge, add something of your own, ask a
 * question that cannot be closed — because that is the whole mechanism. The
 * only thing that changes is who it is aimed at.
 *
 * Deliberately never labels "your own perspective" with any job title or
 * identity (no "as a business owner" etc.) — see atiba-persona.ts and
 * ATIBA_PERSPECTIVE_OVERRIDE, which is appended after this block for exactly
 * that reason.
 */
function buildReplyInstructions(parts: {
  commenterName: string;
  commenterHeadline?: string | null;
  commenterProfileUrl?: string | null;
  commentText?: string | null;
  postAuthorName?: string | null;
}): string {
  const who: string[] = [`Name: ${parts.commenterName}`];
  if (parts.commenterHeadline) who.push(`LinkedIn headline: ${parts.commenterHeadline}`);
  if (parts.commenterProfileUrl) who.push(`Profile: ${parts.commenterProfileUrl}`);

  const postAuthor = parts.postAuthorName && parts.postAuthorName !== "Unknown"
    ? `a post written by ${parts.postAuthorName}`
    : "someone else's post";

  const said = parts.commentText
    ? parts.commentText
    : "(their comment text was not captured — reply to the person, and do not invent what they said)";

  return `

YOU ARE WRITING A REPLY TO A COMMENT, NOT A COMMENT ON THE POST.

${parts.commenterName} left a comment under ${postAuthor}. You are replying to ${parts.commenterName} in that thread, where they and everyone else reading the post will see it.

Who you are replying to:
${who.join("\n")}

What they said:
"""
${said}
"""

The post is background. Reply to the COMMENT.
1. Acknowledge what ${parts.commenterName} said — not what the post said.
2. Add your own perspective, and refer to something SPECIFIC in THEIR comment: their words, their example, the thing they noticed. If your reply would still make sense under a different person's comment, it is wrong and you must rewrite it.
3. End with an open-ended question addressed to ${parts.commenterName}, beginning why, how, what, or what if. Never one they can answer in a single word.

Never open with an exclamation of surprise. "Wow", "Great point", "Great post", "Thanks for sharing", "That's amazing" and anything like them are banned as the first words — start on the substance instead. Never thank them for commenting, never compliment the post author here, and never hand ${parts.commenterName} their own point back as though it were yours.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Auth + rate limit
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    const [, rateLimitError] = await rateLimit(user.id, "expensive");
    if (rateLimitError) return rateLimitError;

    // 2. Validate
    const [body, validationError] = await validateBody(req, GenerateCommentSchema);
    if (validationError) return validationError;

    // 3. Confirm org exists. Only auto_post_enabled is read — ai_system_prompt
    // is no longer used by this function (see comment above the persona
    // import) but auto_post_enabled still decides whether a freshly generated
    // comment is auto-approved (see step 6).
    const supabase = createUserClient(req);
    const { data: org, error: orgError } = await supabase
      .from("doc_organizations")
      .select("id, auto_post_enabled")
      .eq("id", body.org_id)
      .single();

    if (orgError || !org) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3a. Work out what we are replying to, if anything.
    //
    // A saved comment brings its post with it, so the screen only has to send
    // an id. A pasted comment carries its own details and needs the post text
    // sent alongside it, which the schema enforces.
    let replyTarget: {
      parentCommentId: string | null;
      commenterName: string;
      commenterHeadline: string | null;
      commenterProfileUrl: string | null;
      commentText: string | null;
    } | null = null;
    let replyPostId: string | null = null;
    let replyPostContent: string | null = null;
    let replyPostAuthor: string | null = null;

    if (body.reply_to_comment_id) {
      const { data: parent, error: parentError } = await supabase
        .from("doc_post_comments")
        .select(
          "id, post_id, commenter_name, commenter_headline, commenter_linkedin_url, comment_text, doc_posts(content, author_name)"
        )
        .eq("id", body.reply_to_comment_id)
        .eq("org_id", body.org_id)
        .maybeSingle();

      if (parentError || !parent) {
        return new Response(
          JSON.stringify({
            error:
              "That comment is not in your saved comments any more. Scrape the post again, or paste the comment in by hand.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const parentPost = Array.isArray(parent.doc_posts) ? parent.doc_posts[0] : parent.doc_posts;

      replyTarget = {
        parentCommentId: parent.id,
        // The screen may override the name it shows, but never the identity
        // we stored — that came from LinkedIn.
        commenterName: parent.commenter_name,
        commenterHeadline: parent.commenter_headline ?? null,
        commenterProfileUrl: parent.commenter_linkedin_url ?? null,
        commentText: parent.comment_text ?? body.reply_to_text ?? null,
      };
      replyPostId = parent.post_id;
      replyPostContent = parentPost?.content ?? null;
      replyPostAuthor = parentPost?.author_name ?? null;
    } else if (body.reply_to_text || body.reply_to_name) {
      replyTarget = {
        parentCommentId: null,
        commenterName: body.reply_to_name!,
        commenterHeadline: body.reply_to_headline ?? null,
        commenterProfileUrl: body.reply_to_linkedin_url ?? null,
        commentText: body.reply_to_text ?? null,
      };
      replyPostAuthor = body.author_name ?? null;
    }

    // The post the reply sits under. A saved comment supplies it; anything
    // typed on the screen wins, because the person is looking at the post.
    const postContent = body.content ?? replyPostContent ?? null;

    // 3b. Pull what we already hold about this person.
    // Prefer the lead row (curated bio, links, custom fields); fall back to
    // whatever the screen sent. A missing lead is not an error — it just
    // means we comment with less.
    let lead: {
      name?: string | null;
      bio?: string | null;
      links?: string | null;
      custom_fields?: Record<string, unknown> | null;
    } | null = null;

    if (body.lead_id) {
      const { data } = await supabase
        .from("doc_dm_leads")
        .select("name, bio, links, custom_fields")
        .eq("id", body.lead_id)
        .eq("org_id", body.org_id)
        .maybeSingle();
      lead = data ?? null;
    }

    // Who the draft is actually about: the commenter when this is a reply,
    // the post author otherwise.
    const subjectUrl = replyTarget?.commenterProfileUrl ?? body.author_linkedin_url ?? null;

    if (!lead && subjectUrl) {
      // The profile URL lives in two columns: linkedin_profile_url (added in
      // migration 010, which is what it means) and links (the freeform field
      // the Comment Generator has been writing it into). Match either, so a
      // lead saved by any screen is found.
      const { data } = await supabase
        .from("doc_dm_leads")
        .select("name, bio, links, custom_fields")
        .eq("org_id", body.org_id)
        .or(`linkedin_profile_url.eq.${subjectUrl},links.eq.${subjectUrl}`)
        .limit(1)
        .maybeSingle();
      lead = data ?? null;
    }

    // What we hold about whoever the draft is aimed at — the commenter on a
    // reply, the post author otherwise.
    const authorContextBlock = buildAuthorContext({
      name: replyTarget?.commenterName ?? body.author_name ?? lead?.name ?? null,
      headline: replyTarget?.commenterHeadline ?? body.author_headline ?? null,
      profileUrl: replyTarget?.commenterProfileUrl ?? body.author_linkedin_url ?? null,
      bio: lead?.bio ?? null,
      links: lead?.links ?? null,
      customFields: lead?.custom_fields ?? null,
    });

    const replyBlock = replyTarget
      ? buildReplyInstructions({
          commenterName: replyTarget.commenterName,
          commenterHeadline: replyTarget.commenterHeadline,
          commenterProfileUrl: replyTarget.commenterProfileUrl,
          commentText: replyTarget.commentText,
          postAuthorName: replyPostAuthor ?? body.author_name ?? null,
        })
      : "";

    // ATIBA_PERSPECTIVE_OVERRIDE is appended last, after everything else the
    // prompt says (including the reply instructions above, which talk about
    // "your own perspective") — it says "follow this above anything said
    // earlier" and it means it: this is what actually stops the model
    // reaching for "as a business owner" or similar framing anywhere in the
    // final draft. See atiba-persona.ts's header comment for the history.
    const systemPrompt =
      ATIBA_PERSONA + COMMENT_STRUCTURE + authorContextBlock + replyBlock +
      ATIBA_HUMAN_STYLE_GUIDE + ATIBA_PERSPECTIVE_OVERRIDE;

    // 4. Generate comment based on mode
    let generatedContent: string | null = null;
    const extractedContent = postContent;

    try {
      if (body.mode === "image") {
        // Download image from storage
        const serviceClient = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const { data: fileData, error: downloadError } = await serviceClient
          .storage
          .from("doc_comment_images")
          .download(body.image_path!);

        if (downloadError || !fileData) {
          console.error("Failed to download image:", downloadError);
          return new Response(
            JSON.stringify({ error: "Failed to download uploaded image" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const bytes = new Uint8Array(await fileData.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const ext = body.image_path!.split(".").pop()?.toLowerCase() ?? "png";
        const mimeType =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";

        const visionPrompt = replyTarget
          ? `Read the LinkedIn post in this screenshot, then draft a reply to ${replyTarget.commenterName}'s comment on it. Reply to the comment, not to the post.`
          : body.author_name
            ? `Read the LinkedIn post in this screenshot — it was written by ${body.author_name} — and draft a comment on it.`
            : "Read the LinkedIn post in this screenshot and draft a comment on it.";

        generatedContent = await callOpenAIVision(systemPrompt, base64, mimeType, visionPrompt);
      } else {
        // Caption or link mode
        const authorContext = replyPostAuthor ?? body.author_name ?? "a LinkedIn user";

        let userPrompt: string;
        if (replyTarget) {
          const postBlock = postContent
            ? `The post (by ${authorContext}), for context only:\n\n${postContent}`
            : `The post itself was not captured — you have only the comment.`;
          userPrompt =
            `${postBlock}\n\n` +
            `Now draft your reply to ${replyTarget.commenterName}'s comment, quoted in your instructions. ` +
            `Reply to the comment, not to the post.`;
        } else {
          userPrompt = `Draft a LinkedIn comment for this post by ${authorContext}:\n\n${postContent}`;
        }
        if (body.linkedin_post_url) {
          userPrompt += `\n\n(Post URL: ${body.linkedin_post_url})`;
        }
        generatedContent = await callOpenAI(systemPrompt, userPrompt);
      }
    } catch (aiErr) {
      console.error("OpenAI call failed:", aiErr);
      const msg = aiErr instanceof Error ? aiErr.message : "Unknown AI error";
      return new Response(
        JSON.stringify({ error: `AI generation failed: ${msg}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!generatedContent) {
      return new Response(
        JSON.stringify({ error: "AI draft unavailable — OPENAI_API_KEY may not be set" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Save post record.
    // doc_posts is unique on (org_id, linkedin_post_url), so a real URL that
    // has been commented on before must reuse its existing row rather than
    // blow up on the constraint. Only fall back to a synthetic URL when the
    // screen genuinely has no post link to give us.
    const normalizedPostUrl = body.linkedin_post_url
      ? normalizePostUrl(body.linkedin_post_url)
      : null;
    const postUrl = normalizedPostUrl ?? `manual://${crypto.randomUUID()}`;

    let post: { id: string } | null = null;
    let postError: unknown = null;

    // Replying to a saved comment: we already know which post it sits under,
    // so never look one up and never create a second row for it.
    if (replyPostId) {
      post = { id: replyPostId };
    } else if (normalizedPostUrl) {
      const { data: existingPost } = await supabase
        .from("doc_posts")
        .select("id")
        .eq("org_id", body.org_id)
        .eq("linkedin_post_url", postUrl)
        .maybeSingle();
      post = existingPost ?? null;
    }

    if (!post) {
      const { data: inserted, error: insertError } = await supabase
        .from("doc_posts")
        .insert({
          org_id: body.org_id,
          linkedin_post_url: postUrl,
          author_name: body.author_name ?? "Unknown",
          author_headline: body.author_headline ?? null,
          content: extractedContent,
        })
        .select("id")
        .single();
      post = inserted ?? null;
      postError = insertError;
    }

    if (postError || !post) {
      console.error("Failed to insert post:", postError);
      // Still return the generated content even if save fails
      return new Response(
        JSON.stringify({ data: { generated_content: generatedContent, saved: false } }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5b. A scraped post has no text — the comments dataset does not carry
    // it. If the person pasted it in while replying, keep it, so the next
    // reply under the same post starts with the context already there. This
    // only ever fills a gap: the `is null` guard means a post we already have
    // the words for is never overwritten.
    if (replyPostId && postContent && !replyPostContent) {
      const { error: fillError } = await supabase
        .from("doc_posts")
        .update({ content: postContent })
        .eq("id", replyPostId)
        .eq("org_id", body.org_id)
        .is("content", null);
      if (fillError) console.error("Failed to save post text:", fillError.message);
    }

    // 6. Save comment record.
    // A draft the model just wrote has not been approved by anyone, so it is
    // saved pending — the same status doc_inbound_post uses — and the human
    // approves it when they take it (doc_approve_comment, called from the
    // Comment Generator's Copy button — see CommentGenerator.tsx's
    // OutputArea). Stamping approved_by at generation time recorded a
    // decision nobody had made. If the workspace has auto-posting on,
    // there's no separate approval step to wait for, so it's approved
    // immediately instead, same as the org's other auto-posted comments.
    const initialStatus = org.auto_post_enabled ? "approved" : "pending";

    const { data: comment, error: commentError } = await supabase
      .from("doc_comments")
      .insert({
        post_id: post.id,
        org_id: body.org_id,
        generated_content: generatedContent,
        status: initialStatus,
        approved_by: org.auto_post_enabled ? user.id : null,
        source: body.mode,
        // Null on a normal comment. On a reply, the pointer plus a copy of
        // who said what — the copy is what keeps the reply readable in the
        // history after the post is re-scraped or the comment row goes.
        parent_comment_id: replyTarget?.parentCommentId ?? null,
        reply_to_name: replyTarget?.commenterName ?? null,
        reply_to_linkedin_url: replyTarget?.commenterProfileUrl ?? null,
        reply_to_text: replyTarget?.commentText ?? null,
      })
      .select("id")
      .single();

    if (commentError) {
      console.error("Failed to insert comment:", commentError);
    }

    return new Response(
      JSON.stringify({
        data: {
          comment_id: comment?.id ?? null,
          post_id: post.id,
          generated_content: generatedContent,
          is_reply: !!replyTarget,
          replied_to: replyTarget?.commenterName ?? null,
          saved: true,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
