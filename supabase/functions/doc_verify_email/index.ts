// =============================================================================
// doc_verify_email
// =============================================================================
// Confirms the code doc_register (or doc_resend_code) emailed. Same
// no-user-session exception as doc_register — the account exists but isn't
// confirmed yet, and there's no way to obtain a user JWT for an account that
// isn't confirmed, so this uses service_role like its siblings.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

const VerifySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().length(6),
});

const MAX_ATTEMPTS = 5;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const [body, validationError] = await validateBody(req, VerifySchema);
    if (validationError) return validationError;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: row, error: fetchError } = await supabase
      .from("doc_email_verifications")
      .select("id, user_id, code, attempts, expires_at")
      .eq("email", body.email)
      .maybeSingle();

    if (fetchError) {
      console.error("doc_verify_email: lookup failed", fetchError);
      return safeError(new Error("Verification failed"));
    }

    if (!row) {
      return new Response(
        JSON.stringify({ error: "No pending verification for this email. Register again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return new Response(
        JSON.stringify({ error: "This code has expired. Request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      return new Response(
        JSON.stringify({ error: "Too many incorrect attempts. Request a new code." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (row.code !== body.code) {
      await supabase
        .from("doc_email_verifications")
        .update({ attempts: row.attempts + 1 })
        .eq("id", row.id);
      return new Response(
        JSON.stringify({ error: "Incorrect code. Please try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { error: confirmError } = await supabase.auth.admin.updateUserById(row.user_id, {
      email_confirm: true,
    });

    if (confirmError) {
      console.error("doc_verify_email: failed to confirm user", confirmError);
      return safeError(new Error("Failed to activate account"));
    }

    // One-time use — remove the row so this code can't be replayed.
    await supabase.from("doc_email_verifications").delete().eq("id", row.id);

    return new Response(
      JSON.stringify({ data: { verified: true } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
