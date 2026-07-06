import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

const ApproveCommentSchema = z.object({
  comment_id: z.string().uuid(),
  edited_content: z.string().min(1).max(3000),
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    const [, rateLimitError] = await rateLimit(user.id, "write");
    if (rateLimitError) return rateLimitError;

    const [body, validationError] = await validateBody(req, ApproveCommentSchema);
    if (validationError) return validationError;

    const supabase = createUserClient(req);

    // Fetch and verify pending status
    const { data: comment, error: fetchError } = await supabase
      .from("doc_comments")
      .select("id, status")
      .eq("id", body.comment_id)
      .single();

    if (fetchError || !comment) {
      return new Response(
        JSON.stringify({ error: "Comment not found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (comment.status !== "pending") {
      return new Response(
        JSON.stringify({ error: "Comment is not in pending status" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update to approved
    const { data: updated, error: updateError } = await supabase
      .from("doc_comments")
      .update({
        edited_content: body.edited_content,
        status: "approved",
        approved_by: user.id,
      })
      .eq("id", body.comment_id)
      .eq("status", "pending")
      .select("id, status")
      .single();

    if (updateError || !updated) {
      return new Response(
        JSON.stringify({ error: "Failed to approve comment. It may have already been processed." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ data: { id: updated.id, status: updated.status } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
