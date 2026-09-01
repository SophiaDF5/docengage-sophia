import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";

// Search-only: this function never writes to the database. It returns a
// preview list of people found; the frontend (KeywordSearch.tsx) lets Reina
// pick which ones to save, then inserts those directly into doc_contacts
// with source: 'keyword_search' (same pattern AddContactDialog uses for
// manual adds — a plain authenticated insert, not a second edge function).
const SearchSchema = z.object({
  org_id: z.string().uuid(),
  keyword: z.string().trim().min(2).max(200),
});

// Hardcoded server-side, not client-controlled — same reasoning as
// doc_scrape_post_commenters hardcoding maxItems: 500. Values below match
// what Reina chose when this feature was built: past week, up to 50 posts
// per search (~7 cents at HarvestAPI's $1.50/1,000 posts pricing).
const MAX_POSTS_PER_SEARCH = 50;
const POSTED_LIMIT = "week";

// Duplicated from doc_scrape_post_commenters on purpose — each edge function
// is deployed independently and there's no shared module for this list yet.
// If you change one, change both.
const HEALTHCARE_KEYWORDS = [
  "doctor", "dr.", "dr ", "physician", "surgeon", "medical director",
  "cardiologist", "dermatologist", "neurologist", "oncologist", "radiologist",
  "anesthesiologist", "pathologist", "psychiatrist", "pediatrician", "urologist",
  "ophthalmologist", "orthopedic", "gastroenterologist", "endocrinologist",
  "pulmonologist", "nephrologist", "rheumatologist", "hematologist",
  "internist", "gynecologist", "obstetrician", "geriatrician", "immunologist",
  "m.d.", "mbbs", "m.b.b.s", "d.o.", "dpt", "pharmd", "dnp", "phd",
  "facp", "facs", "fapa", "faafp", "famia",
  "nurse", "nursing", "rn ", "aprn", "physician assistant",
  "therapist", "pharmacist", "dentist", "optometrist", "chiropractor",
  "hospital", "clinic", "healthcare", "health care", "health system",
  "medical", "medicine", "clinical", "patient",
  "chief medical", "cmo", "cmio", "cno", "cido",
  "attending", "resident", "fellow",
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

// HarvestAPI's linkedin-post-search output shape wasn't fully documented in
// the actor's public input-schema page when this was first built (only the
// input fields were shown there) — confirmed since against HarvestAPI's own
// documented sample output (apify.com/harvestapi/linkedin-post-search
// README, "Sample output data"). Two things were wrong from the original
// guess, both fixed here:
//   1. `postedAt` is NOT a plain date string — it's an object
//      { timestamp, date, postedAgoShort, postedAgoText }. The real ISO
//      date is at `postedAt.date`. Handing the whole object to `new Date()`
//      is exactly what produced "Invalid Date" in the UI.
//   2. The author's headline/title is `author.info`, not `position` or
//      `headline` (neither of those fields exist on the real response).
//      Since it was always blank, isDoctorLead() below could only ever
//      match on the person's NAME containing a medical keyword — which is
//      why almost everything got filtered out even when real physicians
//      were in the results.
interface ApifyPost {
  linkedinUrl?: string;
  content?: string;
  postedAt?: { date?: string; timestamp?: number; postedAgoText?: string } | string;
  author?: { name?: string; linkedinUrl?: string; info?: string };
}

function extractPost(item: ApifyPost) {
  const author = item.author ?? {};
  const postedAt =
    typeof item.postedAt === "string" ? item.postedAt : item.postedAt?.date ?? null;

  return {
    name: author.name ?? "",
    profileUrl: author.linkedinUrl ?? "",
    headline: author.info ?? "",
    postUrl: item.linkedinUrl ?? "",
    content: item.content ?? "",
    postedAt,
  };
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
    const [body, validationError] = await validateBody(req, SearchSchema);
    if (validationError) return validationError;

    // 3. Check required env vars
    const apifyToken = Deno.env.get("APIFY_API_KEY");
    if (!apifyToken) {
      return new Response(
        JSON.stringify({ error: "Apify API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Start Apify actor
    const actorId = "harvestapi~linkedin-post-search";
    const runUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${apifyToken}&waitForFinish=0`;

    console.log("Sending to Apify — keyword:", body.keyword);

    let runResponse: Response;
    try {
      runResponse = await fetch(runUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchQueries: [body.keyword],
          maxPosts: MAX_POSTS_PER_SEARCH,
          postedLimit: POSTED_LIMIT,
          sortBy: "date",
          scrapeReactions: false,
          scrapeComments: false,
        }),
      });
    } catch (err) {
      console.error("Apify request failed:", err);
      return new Response(
        JSON.stringify({ error: "Failed to connect to search service" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!runResponse.ok) {
      const errText = await runResponse.text();
      console.error("Apify run failed:", runResponse.status, errText);
      return new Response(
        JSON.stringify({ error: "Search service returned an error" }),
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
        JSON.stringify({ error: "Search service did not return a run ID" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (initialStatus === "FAILED" || initialStatus === "ABORTED" || initialStatus === "TIMED-OUT") {
      return new Response(
        JSON.stringify({ error: "Search failed — the actor did not complete successfully" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Poll for completion — budget 120s (well under the 150s edge function limit)
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
            JSON.stringify({ error: "Search failed — the actor did not complete successfully" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      if (!succeeded) {
        return new Response(
          JSON.stringify({ error: "Search timed out. Try again in a few minutes." }),
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
        JSON.stringify({ error: "Failed to retrieve search results" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const allItems: ApifyPost[] = await datasetResponse.json();
    console.log("Total items from Apify:", allItems.length);

    const runConsoleUrl = `https://console.apify.com/actors/${actorId}/runs/${runId}`;

    // 7. Deduplicate by profile URL, filter for doctor/healthcare relevance
    const seen = new Set<string>();
    const matchedLeads: {
      name: string;
      profileUrl: string;
      headline: string;
      postUrl: string;
      postExcerpt: string;
      postedAt: string | null;
    }[] = [];

    for (const item of allItems) {
      const post = extractPost(item);
      if (!post.profileUrl || !post.name || seen.has(post.profileUrl)) continue;
      seen.add(post.profileUrl);

      if (isDoctorLead(post.name, post.headline)) {
        matchedLeads.push({
          name: post.name,
          profileUrl: post.profileUrl,
          headline: post.headline,
          postUrl: post.postUrl,
          postExcerpt: post.content.slice(0, 500),
          postedAt: post.postedAt,
        });
      }
    }

    console.log("Matched healthcare leads:", matchedLeads.length);

    return new Response(
      JSON.stringify({
        data: {
          keyword: body.keyword,
          total_items: allItems.length,
          matched_leads: matchedLeads,
          run_url: runConsoleUrl,
          warning:
            allItems.length === 0
              ? "Apify returned 0 posts for this keyword and time window. Try a broader keyword, or a wider time window if this keeps happening."
              : matchedLeads.length === 0
              ? `Found ${allItems.length} post(s) for "${body.keyword}", but none of the authors matched the healthcare/physician keyword filter. Try a more specific keyword.`
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
