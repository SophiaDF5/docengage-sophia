// =============================================================================
// doc_inbound_post
// =============================================================================
// Entry point for new LinkedIn posts pushed in by the Make.com scenario.
// Authenticated via a shared secret (MAKE_WEBHOOK_SECRET), NOT a user JWT —
// Make.com is a trusted server-to-server caller, not a logged-in user, so
// requireAuth()/createUserClient() (JWT-based) don't apply here.
//
// Because there is no authenticated user session, RLS would reject any
// insert regardless of which user_id value is set on the row (policies key
// off auth.uid(), not the row's own user_id column). This function therefore
// uses the service_role client to bypass RLS — the same reasoning that
// already applies to doc_daily_followups, extended here since this is the
// same category of trusted automated caller.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { callOpenAI } from "../_shared/openai.ts";

const InboundPostSchema = z.object({
  org_id: z.string().uuid(),
  linkedin_post_url: z.string().url(),
  author_name: z.string().optional(),
  author_headline: z.string().optional(),
  content: z.string(),
  secret_token: z.string(),
});

// Constant-time string comparison — never use === for secrets, since string
// equality short-circuits on the first mismatched character, leaking timing
// information an attacker could use to guess the secret byte-by-byte.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Validate input shape first (cheap, no secrets/DB involved yet)
    const [body, validationError] = await validateBody(req, InboundPostSchema);
    if (validationError) return validationError;

    // 2. Verify the shared secret — this is this function's "auth" step
    const expectedSecret = Deno.env.get("MAKE_WEBHOOK_SECRET");
    if (!expectedSecret || !constantTimeEqual(body.secret_token, expectedSecret)) {
      return new Response(
        JSON.stringify({ error: "Invalid secret token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Service-role client — required since there is no user JWT to scope RLS to.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // 4. Look up the org (needed for rate-limit key, auto_post_enabled, AI tone)
    const { data: org, error: orgError } = await supabase
      .from("doc_organizations")
      .select("user_id, auto_post_enabled, ai_system_prompt")
      .eq("id", body.org_id)
      .single();

    if (orgError || !org) {
      return new Response(
        JSON.stringify({ error: "Organization not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Rate limit — keyed on the org owner, since there's no calling user to key on directly
    const [, rateLimitError] = await rateLimit(org.user_id, "write");
    if (rateLimitError) return rateLimitError;

    const authorName = body.author_name?.trim() || "Author";

    // 6. Idempotency — skip regeneration if this post was already ingested for this org
    const { data: existingPost } = await supabase
      .from("doc_posts")
      .select("id")
      .eq("org_id", body.org_id)
      .eq("linkedin_post_url", body.linkedin_post_url)
      .maybeSingle();

    if (existingPost) {
      return new Response(
        JSON.stringify({ data: { id: existingPost.id, status: "pending_or_approved" } }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 7. Save the post
    const { data: post, error: postError } = await supabase
      .from("doc_posts")
      .insert({
        user_id: org.user_id,
        org_id: body.org_id,
        linkedin_post_url: body.linkedin_post_url,
        author_name: authorName,
        author_headline: body.author_headline ?? null,
        content: body.content,
        published_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (postError || !post) {
      console.error("Failed to save inbound post:", postError);
      return safeError(new Error("Failed to save post"));
    }

    // 8. Draft a comment via OpenAI. If it fails, keep the post but mark the
    // comment generation_failed instead of blocking the whole ingestion.
    const basePrompt = org.ai_system_prompt ||
      "You are a professional healthcare CEO. Write a thoughtful, genuine LinkedIn comment.";
    const systemPrompt = `${basePrompt}\n\nWrite a short, natural-sounding LinkedIn comment replying to the post below. Keep it warm and specific to the content — avoid generic praise.`;
    const userPrompt = `Post by ${authorName}${body.author_headline ? ` (${body.author_headline})` : ""}:\n\n"${body.content}"\n\nDraft a comment:`;

    const generatedContent = await callOpenAI(systemPrompt, userPrompt);

    const initialStatus = generatedContent
      ? (org.auto_post_enabled ? "approved" : "pending")
      : "generation_failed";

    const { data: comment, error: commentError } = await supabase
      .from("doc_comments")
      .insert({
        user_id: org.user_id,
        post_id: post.id,
        org_id: body.org_id,
        generated_content: generatedContent,
        status: initialStatus,
      })
      .select("id, status")
      .single();

    if (commentError || !comment) {
      console.error("Failed to save comment:", commentError);
      // Post is already saved — return success for the post, but surface that
      // comment creation failed so this doesn't look fully successful.
      return new Response(
        JSON.stringify({ data: { id: post.id, status: "generation_failed" } }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 9. If auto-post is enabled and we actually have a draft, push it to Make.com
    // to post on LinkedIn. Never let a Make.com failure crash this request —
    // fall back to 'pending' so a human can review/retry manually.
    if (org.auto_post_enabled && generatedContent) {
      const webhookId = Deno.env.get("MAKE_WEBHOOK_ID");
      const webhookSecret = Deno.env.get("MAKE_WEBHOOK_SECRET");

      if (webhookId && webhookSecret) {
        try {
          const makeResponse = await fetch(`https://hook.us1.make.com/${webhookId}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${webhookSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: "comment_approved",
              org_id: body.org_id,
              post_url: body.linkedin_post_url,
              comment_content: generatedContent,
              contact_name: authorName,
            }),
          });

          if (makeResponse.status >= 500 || !makeResponse.ok) {
            console.error("Make.com webhook failed for auto-post:", makeResponse.status);
            await supabase.from("doc_comments").update({ status: "pending" }).eq("id", comment.id);
            comment.status = "pending";
          }
        } catch (err) {
          console.error("Make.com webhook request failed:", err);
          await supabase.from("doc_comments").update({ status: "pending" }).eq("id", comment.id);
          comment.status = "pending";
        }
      } else {
        // Auto-post configured but Make.com isn't wired up — don't silently
        // claim it was posted.
        await supabase.from("doc_comments").update({ status: "pending" }).eq("id", comment.id);
        comment.status = "pending";
      }
    }

    return new Response(
      JSON.stringify({ data: { id: post.id, status: comment.status === "approved" ? "pending_or_approved" : comment.status } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
