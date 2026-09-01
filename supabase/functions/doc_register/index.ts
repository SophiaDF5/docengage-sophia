// =============================================================================
// doc_register
// =============================================================================
// Public sign-up entry point. There is no user JWT yet — by definition, an
// account doesn't exist until this function creates one — so this uses the
// service_role client for the same underlying reason doc_inbound_post does
// (no session exists to scope RLS to). Extends the exception list in Rule 1:
// creating an auth user and controlling its email_confirm flag requires the
// admin API, which requires service_role. This function never accepts or
// trusts a user_id/org_id from the client — it only ever creates a brand
// new account for the email address the caller proves they control (by
// entering the code doc_verify_email checks).
//
// Flow: create an UNCONFIRMED auth user -> generate a 6-digit code -> email
// it via Brevo -> the account is unusable until doc_verify_email confirms
// the code. Requires "Confirm email" to be ON in Supabase Auth settings —
// see claude.md Auth Settings.
//
// Known limitation: no IP-based throttling on this endpoint (the shared
// rateLimit() helper keys off an existing auth.users.id, which doesn't
// exist yet here). If spam signups become a problem, add a CAPTCHA or an
// IP-keyed table rather than skipping this note.
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { sendEmail } from "../_shared/brevo.ts";

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(8).max(72),
  name: z.string().trim().min(1).max(200).optional(),
});

const CODE_EXPIRY_MINUTES = 15;

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
    const [body, validationError] = await validateBody(req, RegisterSchema);
    if (validationError) return validationError;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Admin-created users never trigger Supabase's own confirmation email
    // (that only happens via the public auth.signUp() client call) — so
    // nothing goes out until we send our own code below.
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: body.email,
      password: body.password,
      email_confirm: false,
    });

    if (createError || !created.user) {
      const alreadyExists = createError?.message?.toLowerCase().includes("already") ?? false;
      if (alreadyExists) {
        return new Response(
          JSON.stringify({
            error:
              "An account with this email already exists. If you already registered, check your email for the code (or use Resend Code) — otherwise, try logging in.",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      console.error("doc_register: createUser failed", createError);
      return safeError(new Error("Failed to create account"));
    }

    const userId = created.user.id;

    // Optional business/account name — overwrites the trigger's default
    // 'My Account' on the row it already auto-created for this new user.
    if (body.name) {
      const { error: nameError } = await supabase
        .from("doc_organizations")
        .update({ name: body.name })
        .eq("user_id", userId);
      if (nameError) console.error("doc_register: failed to set account name", nameError);
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60_000).toISOString();

    const { error: upsertError } = await supabase.from("doc_email_verifications").upsert(
      { user_id: userId, email: body.email, code, attempts: 0, expires_at: expiresAt },
      { onConflict: "user_id" }
    );

    if (upsertError) {
      console.error("doc_register: failed to store verification code", upsertError);
      return safeError(new Error("Failed to start verification"));
    }

    const emailSent = await sendEmail({
      toEmail: body.email,
      toName: body.name,
      subject: "Your DocEngage verification code",
      html: `
        <p>Welcome to DocEngage! Your verification code is:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">${code}</p>
        <p>This code expires in ${CODE_EXPIRY_MINUTES} minutes.</p>
      `,
    });

    if (!emailSent) {
      // Storage (account creation) succeeded; the email leg failed — these
      // are two separate outcomes (Rule 19). Surface it so the frontend can
      // tell the user to use "Resend Code" rather than silently claiming
      // success.
      console.error("doc_register: account created but email failed to send", {
        userId,
        email: body.email,
      });
    }

    return new Response(
      JSON.stringify({ data: { email: body.email, email_sent: emailSent } }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
