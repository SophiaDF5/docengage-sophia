// =============================================================================
// doc_resend_code
// =============================================================================
// Regenerates and re-sends the code for an existing, still-unconfirmed
// registration (first email never arrived, or the code expired). Same
// no-user-session exception as doc_register/doc_verify_email.
//
// Deliberately returns the exact same generic response whether or not the
// email has a pending verification, so this endpoint can't be used to probe
// which emails have registered — but does enforce a cooldown per email so
// it can't be used to spam someone's inbox either.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { sendEmail } from "../_shared/brevo.ts";

const ResendSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const CODE_EXPIRY_MINUTES = 15;
const COOLDOWN_SECONDS = 60;

function generateCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] % 1_000_000).toString().padStart(6, "0");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const [body, validationError] = await validateBody(req, ResendSchema);
    if (validationError) return validationError;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const genericResponse = () =>
      new Response(
        JSON.stringify({
          data: { message: "If that email has a pending registration, a new code has been sent." },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );

    const { data: row, error: fetchError } = await supabase
      .from("doc_email_verifications")
      .select("id, updated_at")
      .eq("email", body.email)
      .maybeSingle();

    if (fetchError) {
      console.error("doc_resend_code: lookup failed", fetchError);
      return safeError(new Error("Failed to resend code"));
    }

    // Don't reveal whether the email has a pending registration — same
    // response either way.
    if (!row) return genericResponse();

    const secondsSinceLastSend = (Date.now() - new Date(row.updated_at).getTime()) / 1000;
    if (secondsSinceLastSend < COOLDOWN_SECONDS) {
      return new Response(
        JSON.stringify({
          error: `Please wait ${Math.ceil(COOLDOWN_SECONDS - secondsSinceLastSend)}s before requesting another code.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60_000).toISOString();

    const { error: updateError } = await supabase
      .from("doc_email_verifications")
      .update({ code, attempts: 0, expires_at: expiresAt })
      .eq("id", row.id);

    if (updateError) {
      console.error("doc_resend_code: failed to update code", updateError);
      return safeError(new Error("Failed to resend code"));
    }

    const emailSent = await sendEmail({
      toEmail: body.email,
      subject: "Your new DocEngage verification code",
      html: `
        <p>Here's your new verification code:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${code}</p>
        <p>This code expires in ${CODE_EXPIRY_MINUTES} minutes.</p>
      `,
    });

    if (!emailSent) {
      console.error("doc_resend_code: failed to send email", { email: body.email });
    }

    return genericResponse();
  } catch (err) {
    return safeError(err);
  }
});
