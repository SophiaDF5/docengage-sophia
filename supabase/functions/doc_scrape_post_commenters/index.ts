import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

const ScrapeSchema = z.object({
  org_id: z.string().uuid(),
  linkedin_post_url: z.string().trim().url(),
});

// HarvestAPI linkedin-post-comments output shape
interface ApifyComment {
  actor?: {
    name?: string;
    linkedinUrl?: string;
    position?: string;
  };
}

const HEALTHCARE_KEYWORDS = [
  // Doctors & physicians
  "doctor", "dr.", "dr ", "physician", "surgeon", "medical director",
  // Specialties
  "cardiologist", "dermatologist", "neurologist", "oncologist", "radiologist",
  "anesthesiologist", "pathologist", "psychiatrist", "pediatrician", "urologist",
  "ophthalmologist", "orthopedic", "gastroenterologist", "endocrinologist",
  "pulmonologist", "nephrologist", "rheumatologist", "hematologist",
  "internist", "gynecologist", "obstetrician", "geriatrician", "immunologist",
  // Credentials
  "m.d.", "mbbs", "m.b.b.s", "d.o.", "dpt", "pharmd", "dnp", "phd",
  "facp", "facs", "fapa", "faafp", "famia",
  // Allied health & nursing
  "nurse", "nursing", "rn ", "aprn", "physician assistant",
  "therapist", "pharmacist", "dentist", "optometrist", "chiropractor",
  // Healthcare orgs & roles
  "hospital", "clinic", "healthcare", "health care", "health system",
  "medical", "medicine", "clinical", "patient",
  "chief medical", "cmo", "cmio", "cno", "cido",
  "attending", "resident", "fellow",
  // Health-adjacent
  "health tech", "healthtech", "medtech", "biotech", "digital health",
  "health informatics", "clinical informatics", "ehr", "emr", "epic",
  "telehealth", "telemedicine",
];

const HEALTHCARE_KEYWORDS_EXACT = [/\bmd\b/, /\bdo\b/, /\bpa\b/, /\bnp\b/, /\brn\b/, /\bdpt\b/, /\bcoo\b/];

function isDoctorLead(name: string, headline: string): boolean {
  const text = `${name.toLowerCase()} ${headline.toLowerCase()}`;
  return (
    HEALTHCARE_KEYWORDS.some((kw) => text.includes(kw)) ||
    HEALTHCARE_KEYWORDS_EXACT.some((re) => re.test(text))
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const [body, validationError] = await validateBody(req, ScrapeSchema);
    if (validationError) return validationError;

    // 3. Check required env vars
    const apifyToken = Deno.env.get("APIFY_API_KEY");

    if (!apifyToken) {
      return new Response(
        JSON.stringify({ error: "Apify API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Start Apify actor — no cookies required
    const actorId = "harvestapi~linkedin-post-comments";
    // waitForFinish=0 returns immediately; all time budget goes to polling below.
    const runUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}&waitForFinish=0`;

    // HarvestAPI accepts the original LinkedIn post URL directly — no URN conversion needed.
    const postUrl = body.linkedin_post_url.split("?")[0];
    console.log("Sending to Apify — post url:", postUrl);

    let runResponse: Response;
    try {
      runResponse = await fetch(runUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          posts: [postUrl],
          maxItems: 500,
          scrapeReplies: false,
          profileScraperMode: "short",
        }),
      });
    } catch (err) {
      console.error("Apify request failed:", err);
      return new Response(
        JSON.stringify({ error: "Failed to connect to scraping service" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!runResponse.ok) {
      const errText = await runResponse.text();
      console.error("Apify run failed:", runResponse.status, errText);
      return new Response(
        JSON.stringify({ error: "Scraping service returned an error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const runData = await runResponse.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;
    const initialStatus = runData.data?.status;

    console.log("Apify run started:", runId, "dataset:", datasetId, "status:", initialStatus);

    if (!runId || !datasetId) {
      return new Response(
        JSON.stringify({ error: "Scraping service did not return a run ID" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (initialStatus === "FAILED" || initialStatus === "ABORTED" || initialStatus === "TIMED-OUT") {
      return new Response(
        JSON.stringify({ error: "Scraping failed — the actor did not complete successfully" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Poll for completion — budget 120s (well under the 150s edge function limit).
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
        if (!statusResp.ok) {
          console.error("Failed to poll Apify run status:", statusResp.status);
          continue;
        }

        const statusData = await statusResp.json();
        const status = statusData.data?.status;
        console.log("Apify poll:", status, `(${Math.round((Date.now() - startTime) / 1000)}s)`);

        if (status === "SUCCEEDED") { succeeded = true; break; }
        if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
          return new Response(
            JSON.stringify({ error: "Scraping failed — the actor did not complete successfully" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      if (!succeeded) {
        return new Response(
          JSON.stringify({ error: "Scraping timed out — the post may be too large. Try again in a few minutes." }),
          { status: 504, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 6. Fetch results
    const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`;
    const datasetResponse = await fetch(datasetUrl);

    if (!datasetResponse.ok) {
      console.error("Failed to fetch Apify dataset:", datasetResponse.status);
      return new Response(
        JSON.stringify({ error: "Failed to retrieve scraping results" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const allItems: ApifyComment[] = await datasetResponse.json();
    console.log("Total items from Apify:", allItems.length);

    const runConsoleUrl = `https://console.apify.com/actors/${actorId}/runs/${runId}`;

    if (allItems.length === 0) {
      console.warn(
        "Apify run succeeded but returned 0 items — likely LinkedIn blocked the no-login scraper for this post, the post has no comments, or the URL didn't resolve to a real post.",
        { runId, datasetId, postUrl }
      );
    }

    // 7. Deduplicate and filter for doctor leads
    // HarvestAPI returns nested author object; support flat fallbacks too.
    const seen = new Set<string>();
    const doctorLeads: { name: string; profileUrl: string; headline: string }[] = [];

    for (const item of allItems as ApifyComment[]) {
      const profileUrl = item.actor?.linkedinUrl;
      const name = item.actor?.name;
      const headline = item.actor?.position ?? "";

      if (!profileUrl || !name || seen.has(profileUrl)) continue;
      seen.add(profileUrl);

      if (isDoctorLead(name, headline)) {
        doctorLeads.push({ name, profileUrl, headline });
      }
    }

    console.log("Doctor leads found:", doctorLeads.length);

    // 8. Upsert contacts
    const supabase = createUserClient(req);
    let contactsNew = 0;

    for (const lead of doctorLeads) {
      const { error } = await supabase
        .from("doc_contacts")
        .upsert(
          {
            user_id: user.id,
            org_id: body.org_id,
            linkedin_profile_url: lead.profileUrl,
            full_name: lead.name,
            headline: lead.headline || null,
            is_connected: false,
            status: "pending",
          },
          { onConflict: "org_id,linkedin_profile_url", ignoreDuplicates: true }
        );

      if (!error) contactsNew++;
      else console.error("Failed to upsert contact:", lead.profileUrl, error.message);
    }

    console.log("Contacts saved:", contactsNew);

    return new Response(
      JSON.stringify({
        data: {
          total_items: allItems.length,
          total_engagers: seen.size,
          doctors_found: doctorLeads.length,
          contacts_saved: contactsNew,
          run_url: runConsoleUrl,
          warning:
            allItems.length === 0
              ? "Apify returned 0 comments. This usually means LinkedIn blocked the no-login scraper for this specific post, the post genuinely has no comments, or the URL wasn't a valid post link. Check the run in Apify console for details, then try again."
              : null,
          _debug_first_item: allItems[0] ?? null,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return safeError(err);
  }
});
