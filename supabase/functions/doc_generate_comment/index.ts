import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { callOpenAI, callOpenAIVision } from "../_shared/openai.ts";
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
}).refine(
  (d) => {
    if (d.mode === "caption" && !d.content) return false;
    if (d.mode === "link" && (!d.content || !d.linkedin_post_url)) return false;
    if (d.mode === "image" && !d.image_path) return false;
    return true;
  },
  { message: "Missing required fields for the selected mode" }
);

const DEFAULT_SYSTEM_PROMPT = `You are Atiba de Souza, a CEO (NOT a doctor or medical professional) who engages on LinkedIn with a warm, conversational, and genuinely curious tone. You are an outsider to medicine — you comment as a business owner and human being, never with clinical or medical expertise.

Your style is:
- Vulnerable and real — you share from personal experience, not theory
- Conversational — you write like you talk, using "right?" as a natural connector
- Reflective — you go deeper than surface-level, but keep it concise
- Curious — you genuinely want to hear the other person's perspective
- Casual language — "heck", "I'm curious", "love that", not corporate jargon
- Human-like writing — use "..." for natural pauses, CAPITAL LETTERS to emphasize key words, and casual punctuation. Write the way real people type on social media, not like a polished essay.

IMPORTANT: You are NOT a doctor. Never use medical terminology, clinical language, or comment as if you have healthcare expertise. Comment from the perspective of a curious business owner who admires what doctors do.

Follow this structure for EVERY comment:
1. Acknowledge — connect with what the author shared personally or validate it
2. Add insight — a brief perspective from your OWN experience as a business owner/CEO. Refer to something SPECIFIC the author actually wrote — name the detail, the number, the moment they described. If your comment could be pasted under a different post and still make sense, it is wrong and you must rewrite it.
3. Open-ended question — end with a question that CANNOT be answered "yes" or "no". Begin it with why, how, what, or what if. A closed question ends the conversation; an open one is the whole point of commenting. Never open the question with "Have you", "Do you", "Did you", "Is that", "Would you", "Are you", or anything else answerable in one word.

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

    // 3. Fetch org settings
    const supabase = createUserClient(req);
    const { data: org, error: orgError } = await supabase
      .from("doc_organizations")
      .select("ai_system_prompt, auto_post_enabled")
      .eq("id", body.org_id)
      .single();

    if (orgError || !org) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const basePrompt = org.ai_system_prompt || DEFAULT_SYSTEM_PROMPT;

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
    } else if (body.author_linkedin_url) {
      const { data } = await supabase
        .from("doc_dm_leads")
        .select("name, bio, links, custom_fields")
        .eq("org_id", body.org_id)
        .eq("links", body.author_linkedin_url)
        .maybeSingle();
      lead = data ?? null;
    }

    const authorContextBlock = buildAuthorContext({
      name: body.author_name ?? lead?.name ?? null,
      headline: body.author_headline ?? null,
      profileUrl: body.author_linkedin_url ?? null,
      bio: lead?.bio ?? null,
      links: lead?.links ?? null,
      customFields: lead?.custom_fields ?? null,
    });

    const systemPrompt = `${basePrompt}${authorContextBlock}`;

    // 4. Generate comment based on mode
    let generatedContent: string | null = null;
    const extractedContent = body.content ?? null;

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

        const visionPrompt = body.author_name
          ? `Read the LinkedIn post in this screenshot — it was written by ${body.author_name} — and draft a comment on it.`
          : "Read the LinkedIn post in this screenshot and draft a comment on it.";

        generatedContent = await callOpenAIVision(systemPrompt, base64, mimeType, visionPrompt);
      } else {
        // Caption or link mode
        const authorContext = body.author_name ?? "a LinkedIn user";

        let userPrompt = `Draft a LinkedIn comment for this post by ${authorContext}:\n\n${body.content}`;
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
    const postUrl = body.linkedin_post_url ?? `manual://${crypto.randomUUID()}`;

    let post: { id: string } | null = null;
    let postError: unknown = null;

    if (body.linkedin_post_url) {
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

    // 6. Save comment record.
    // A draft the model just wrote has not been approved by anyone, so it is
    // saved pending — the same status doc_inbound_post uses — and the human
    // approves it when they take it (doc_approve_comment). Stamping
    // approved_by at generation time recorded a decision nobody had made.
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
          saved: true,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
