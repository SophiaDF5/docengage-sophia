// =============================================================================
// doc_enrich_emails
// =============================================================================
// Attempts to find email addresses for existing doc_contacts, using the
// harvestapi/linkedin-profile-scraper actor's "email search" mode.
//
// IMPORTANT — set expectations correctly: LinkedIn does not publish emails on
// profiles. This actor performs an independent email search/verification
// (SMTP checks) per the vendor's own docs, and explicitly does NOT guarantee
// finding an email for every profile. Treat results as partial coverage.
// =============================================================================

import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

const EnrichEmailsSchema = z.object({
  org_id: z.string().uuid(),
  contact_ids: z.array(z.string().uuid()).min(1).max(50),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The actor stores emails under different possible keys depending on version —
// check the most likely candidates defensively rather than assuming one name.
function extractEmail(item: Record<string, unknown>): string | null {
  if (typeof item.email === "string" && item.email.includes("@")) return item.email;
  if (Array.isArray(item.emails) && typeof item.emails[0] === "string") return item.emails[0] as string;
  const contactInfo = item.contactInfo as Record<string, unknown> | undefined;
  if (contactInfo && typeof contactInfo.email === "string") return contactInfo.email;
  if (typeof item.workEmail === "string" && item.workEmail.includes("@")) return item.workEmail;
  return null;
}

function normalizeUrl(url: string): string {
  return url.split("?")[0].replace(/\/$/, "").toLowerCase();
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

    const [body, validationError] = await validateBody(req, EnrichEmailsSchema);
    if (validationError) return validationError;

    const apifyToken = Deno.env.get("APIFY_API_KEY");
    if (!apifyToken) {
      return new Response(
        JSON.stringify({ error: "Apify API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createUserClient(req);

    // RLS-scoped fetch — user can only enrich contacts they actually have access to.
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

    const urls = contacts.map((c) => c.linkedin_profile_url);
    const actorId = "harvestapi~linkedin-profile-scraper";
    const runUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}&waitForFinish=0`;

    let runResponse: Response;
    try {
      runResponse = await fetch(runUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          // Exact enum value required by this actor's own schema (includes price in the string).
          profileScraperMode: "Profile details + email search ($10 per 1k)",
        }),
      });
    } catch (err) {
      console.error("Apify request failed:", err);
      return new Response(
        JSON.stringify({ error: "Failed to connect to email search service" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!runResponse.ok) {
      const errText = await runResponse.text();
      console.error("Apify run failed:", runResponse.status, errText);
      return new Response(
        JSON.stringify({ error: "Email search service returned an error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const runData = await runResponse.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;
    const initialStatus = runData.data?.status;

    if (!runId || !datasetId) {
      return new Response(
        JSON.stringify({ error: "Email search service did not return a run ID" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (initialStatus === "FAILED" || initialStatus === "ABORTED" || initialStatus === "TIMED-OUT") {
      return new Response(
        JSON.stringify({ error: "Email search failed — the actor did not complete successfully" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (initialStatus !== "SUCCEEDED") {
      const maxWaitMs = 120_000;
      const pollIntervalMs = 10_000;
      const startTime = Date.now();
      let succeeded = false;

      while (Date.now() - startTime < maxWaitMs) {
        await sleep(pollIntervalMs);

        const statusResp = await fetch(
          `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
        );
        if (!statusResp.ok) continue;

        const statusData = await statusResp.json();
        const status = statusData.data?.status;

        if (status === "SUCCEEDED") { succeeded = true; break; }
        if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
          return new Response(
            JSON.stringify({ error: "Email search failed — the actor did not complete successfully" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      if (!succeeded) {
        return new Response(
          JSON.stringify({ error: "Email search timed out — try again with fewer leads at once." }),
          { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`;
    const datasetResponse = await fetch(datasetUrl);

    if (!datasetResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Failed to retrieve email search results" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const items: Record<string, unknown>[] = await datasetResponse.json();

    // Match returned profiles back to our contacts by normalized LinkedIn URL.
    const urlToContactId = new Map(
      contacts.map((c) => [normalizeUrl(c.linkedin_profile_url), c.id])
    );

    let found = 0;
    for (const item of items) {
      const itemUrl = typeof item.linkedinUrl === "string" ? normalizeUrl(item.linkedinUrl) : null;
      if (!itemUrl) continue;
      const contactId = urlToContactId.get(itemUrl);
      if (!contactId) continue;

      const email = extractEmail(item);
      if (!email) continue;

      const { error: updateError } = await supabase
        .from("doc_contacts")
        .update({ email })
        .eq("id", contactId);

      if (!updateError) found++;
      else console.error("Failed to save email for contact:", contactId, updateError.message);
    }

    const runConsoleUrl = `https://console.apify.com/actors/${actorId}/runs/${runId}`;

    return new Response(
      JSON.stringify({
        data: {
          requested: contacts.length,
          found,
          run_url: runConsoleUrl,
          warning:
            found === 0
              ? "No emails found for any of these leads. This is expected sometimes — email search isn't guaranteed to succeed per profile. Check the run for details."
              : null,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
