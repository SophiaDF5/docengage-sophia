// =============================================================================
// doc_enrich_emails_apollo
// =============================================================================
// Second-attempt email finder using Apollo.io's People Enrichment API, for
// leads the primary (Apify/HarvestAPI) search already came up empty on.
// Kept as a SEPARATE function/button from doc_enrich_emails deliberately —
// Apollo credits are far scarcier (org's plan: 75/month) than Apify usage,
// so this should only be triggered deliberately, not bundled automatically.
//
// Endpoint confirmed against Apollo's own official API reference on 2026-07-12:
//   POST https://api.apollo.io/api/v1/people/match
//   Auth: `x-api-key` header — NOT `Authorization: Bearer`. The People
//     Enrichment doc page's interactive "Credentials: Bearer" label is
//     generic UI chrome, not the real requirement; the dedicated
//     Authentication reference page (docs.apollo.io/reference/authentication)
//     is the authoritative source and confirmed x-api-key. Got this wrong on
//     the first pass — every request 401'd until this was corrected.
//   Params: linkedin_url, reveal_personal_emails (set true to consume a
//     credit and get an email back if Apollo has one)
// NOTE: the exact shape of a successful 200 response body still wasn't
// visible in the fetched docs (rendered client-side). Parsing below checks a
// few likely paths defensively and returns the raw first result for
// debugging — if a real run comes back with 0 found, check
// `_debug_first_result` / the function logs to see the actual shape and
// adjust `extractEmail()` if needed.
// =============================================================================

import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

// Capped lower than doc_enrich_emails (50) on purpose — Apollo credits here
// are much scarcer than the Apify-based tool's budget.
const EnrichEmailsApolloSchema = z.object({
  org_id: z.string().uuid(),
  contact_ids: z.array(z.string().uuid()).min(1).max(20),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractEmail(result: Record<string, unknown>): string | null {
  const person = (result.person ?? result) as Record<string, unknown>;
  if (typeof person.email === "string" && person.email.includes("@")) return person.email;
  if (Array.isArray(person.personal_emails) && typeof person.personal_emails[0] === "string") {
    return person.personal_emails[0] as string;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const [user, authError] = await requireAuth(req);
    if (authError) return authError;

    const [, rateLimitError] = await rateLimit(user.id, "expensive");
    if (rateLimitError) return rateLimitError;

    const [body, validationError] = await validateBody(req, EnrichEmailsApolloSchema);
    if (validationError) return validationError;

    const apolloKey = Deno.env.get("APOLLO_API_KEY");
    if (!apolloKey) {
      return new Response(
        JSON.stringify({ error: "Apollo API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createUserClient(req);

    const { data: contacts, error: fetchError } = await supabase
      .from("doc_contacts")
      .select("id, linkedin_profile_url")
      .eq("org_id", body.org_id)
      .in("id", body.contact_ids);

    if (fetchError || !contacts || contacts.length === 0) {
      return new Response(
        JSON.stringify({ error: "No matching contacts found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let found = 0;
    let debugFirstResult: unknown = null;
    let authFailures = 0;

    for (const contact of contacts) {
      try {
        const response = await fetch("https://api.apollo.io/api/v1/people/match", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-api-key": apolloKey,
          },
          body: JSON.stringify({
            linkedin_url: contact.linkedin_profile_url,
            reveal_personal_emails: true,
          }),
        });

        if (response.status === 401) {
          authFailures++;
          console.error("Apollo rejected the API key (401) for contact:", contact.id);
          continue;
        }

        if (response.status === 429) {
          console.warn("Apollo rate limited — stopping this batch early");
          break;
        }

        if (!response.ok) {
          console.error("Apollo request failed:", contact.id, response.status);
          continue;
        }

        const result = await response.json();
        if (!debugFirstResult) {
          debugFirstResult = result;
          console.log("Apollo raw response (first result this batch):", JSON.stringify(result));
        }

        const email = extractEmail(result);
        if (email) {
          const { error: updateError } = await supabase
            .from("doc_contacts")
            .update({ email })
            .eq("id", contact.id);
          if (!updateError) found++;
          else console.error("Failed to save Apollo email:", contact.id, updateError.message);
        }
      } catch (err) {
        console.error("Apollo call failed for contact:", contact.id, err);
      }

      // Small gap between sequential calls to stay well under rate limits.
      await sleep(300);
    }

    if (authFailures === contacts.length) {
      return new Response(
        JSON.stringify({
          error: "Apollo rejected the API key for every lead in this batch (401 Unauthorized). The key is missing, wrong, or expired — check APOLLO_API_KEY.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          requested: contacts.length,
          found,
          warning:
            found === 0
              ? authFailures > 0
                ? `${authFailures} of ${contacts.length} calls were rejected by Apollo (401) — check APOLLO_API_KEY. The rest genuinely found no email.`
                : "No emails found via Apollo for these leads. Check function logs (_debug info) if this seems unexpected."
              : null,
          _debug_first_result: found === 0 ? debugFirstResult : undefined,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
