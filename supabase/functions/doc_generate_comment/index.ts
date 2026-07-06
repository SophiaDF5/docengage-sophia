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
2. Add insight — a brief perspective from your OWN experience as a business owner/CEO
3. Follow-up question — end with a simple, genuine question to keep the conversation going

Keep it to 2-4 sentences. Sound like a real human having a conversation, not an AI or a press release. Never use phrases like "Great post!", "Thanks for sharing!", or "Wow..." — go straight to the substance.`;

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
      .select("ai_system_prompt")
      .eq("id", body.org_id)
      .single();

    if (orgError || !org) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const systemPrompt = org.ai_system_prompt || DEFAULT_SYSTEM_PROMPT;

    // 4. Generate comment based on mode
    let generatedContent: string | null = null;
    let extractedContent = body.content ?? null;

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

        generatedContent = await callOpenAIVision(systemPrompt, base64, mimeType);
      } else {
        // Caption or link mode
        const authorContext = body.author_name ?? "a LinkedIn user";

        const userPrompt = `Draft a LinkedIn comment for this post by ${authorContext}:\n\n${body.content}`;
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

    // 5. Save post record
    const { data: post, error: postError } = await supabase
      .from("doc_posts")
      .insert({
        org_id: body.org_id,
        linkedin_post_url: body.linkedin_post_url ?? `manual://${crypto.randomUUID()}`,
        author_name: body.author_name ?? "Unknown",
        author_headline: body.author_headline ?? null,
        content: extractedContent,
      })
      .select("id")
      .single();

    if (postError || !post) {
      console.error("Failed to insert post:", postError);
      // Still return the generated content even if save fails
      return new Response(
        JSON.stringify({ data: { generated_content: generatedContent, saved: false } }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 6. Save comment record
    const { data: comment, error: commentError } = await supabase
      .from("doc_comments")
      .insert({
        post_id: post.id,
        org_id: body.org_id,
        generated_content: generatedContent,
        status: "approved",
        approved_by: user.id,
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
