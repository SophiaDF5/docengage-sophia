/**
 * Shared Brevo (transactional email) helper — used only by the registration
 * flow (doc_register, doc_resend_code) to email verification codes.
 *
 * Chosen over Resend/SendGrid because it can send to arbitrary recipients on
 * the free plan without owning/verifying a whole domain — only a single
 * sender email address needs to be verified (click a link Brevo emails you).
 * Free plan: 300 emails/day, no credit card, no expiry.
 */

const BREVO_BASE = "https://api.brevo.com/v3";

function getApiKey(): string | null {
  const key = Deno.env.get("BREVO_API_KEY");
  if (!key) console.error("BREVO_API_KEY not configured");
  return key ?? null;
}

/**
 * Sends a transactional email via Brevo. Returns true/false rather than
 * throwing — callers should treat "account created" and "email sent" as two
 * separate outcomes (see Rule 19: storage vs. processing success are never
 * the same event) instead of failing the whole request if only the email
 * leg fails.
 */
export async function sendEmail(params: {
  toEmail: string;
  toName?: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = getApiKey();
  if (!apiKey) return false;

  const senderEmail = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!senderEmail) {
    console.error("BREVO_SENDER_EMAIL not configured");
    return false;
  }

  try {
    const response = await fetch(`${BREVO_BASE}/smtp/email`, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: "DocEngage" },
        to: [{ email: params.toEmail, name: params.toName }],
        subject: params.subject,
        htmlContent: params.html,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Brevo send failed:", response.status, errBody);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Brevo request failed:", err);
    return false;
  }
}
