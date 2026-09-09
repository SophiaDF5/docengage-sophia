import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth, createUserClient } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { safeError } from "../_shared/error-handler.ts";
import { validateBody, z } from "../_shared/validate.ts";
import { normalizePostUrl } from "../_shared/linkedin.ts";

const ScrapeSchema = z.object({
  org_id: z.string().uuid(),
  linkedin_post_url: z.string().trim().url(),
});

// HarvestAPI linkedin-post-comments output shape.
//
// `actor` is the person who left the comment; the top-level fields are the
// comment itself. The comment text and id are read through a list of
// candidate field names because the actor has changed them before and a
// renamed field would otherwise silently store every comment as blank —
// see readCommentText/readCommentId below, which log when they find nothing.
interface ApifyComment {
  id?: string;
  commentId?: string;
  urn?: string;
  linkedinUrl?: string;
  commentUrl?: string;
  url?: string;
  commentary?: string;
  text?: string;
  comment?: string;
  commentText?: string;
  content?: string;
  createdAt?: string;
  postedAt?: string;
  actor?: {
    name?: string;
    linkedinUrl?: string;
    position?: string;
  };
}

function readCommentText(item: ApifyComment): string | null {
  const candidates = [item.commentary, item.text, item.comment, item.commentText, item.content];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function readCommentUrl(item: ApifyComment): string | null {
  const candidates = [item.linkedinUrl, item.commentUrl, item.url];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/**
 * A stable identity for one comment, so re-scraping a post updates its rows
 * instead of duplicating them.
 *
 * LinkedIn's own id is used where the actor gives us one. Where it doesn't,
 * the substitute is the commenter's profile plus the opening of what they
 * wrote — which is stable across runs, and still distinct when the same
 * person leaves two different comments on the same post.
 */
function commentIdentity(item: ApifyComment, profileUrl: string, text: string | null): string {
  const given = item.id ?? item.commentId ?? item.urn;
  if (typeof given === "string" && given.trim()) return given.trim();
  return `${profileUrl}#${(text ?? "").slice(0, 160)}`;
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
    // Normalised so this and the comment generator store the same post under
    // the same string in doc_posts.
    const postUrl = normalizePostUrl(body.linkedin_post_url);
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

    // 7. Read every comment, then pick the doctor leads out of them.
    //
    // Two different things come out of one pass, and they dedupe differently:
    // a PERSON is counted once however often they commented, but every
    // COMMENT is kept, because a reply has to answer particular words.
    const seen = new Set<string>();
    const doctorLeads: { name: string; profileUrl: string; headline: string }[] = [];
    const harvested: {
      commentId: string;
      commentUrl: string | null;
      name: string;
      headline: string;
      profileUrl: string;
      text: string | null;
      isDoctor: boolean;
      commentedAt: string | null;
    }[] = [];
    const byIdentity = new Set<string>();
    let itemsWithNoText = 0;

    for (const item of allItems as ApifyComment[]) {
      const profileUrl = item.actor?.linkedinUrl;
      const name = item.actor?.name;
      const headline = item.actor?.position ?? "";

      if (!profileUrl || !name) continue;

      const text = readCommentText(item);
      if (!text) itemsWithNoText++;

      const isDoctor = isDoctorLead(name, headline);

      // Every comment, deduped on the comment rather than the person.
      const commentId = commentIdentity(item, profileUrl, text);
      if (!byIdentity.has(commentId)) {
        byIdentity.add(commentId);
        harvested.push({
          commentId,
          commentUrl: readCommentUrl(item),
          name,
          headline,
          profileUrl,
          text,
          isDoctor,
          commentedAt: item.createdAt ?? item.postedAt ?? null,
        });
      }

      // One lead per person, as before.
      if (seen.has(profileUrl)) continue;
      seen.add(profileUrl);
      if (isDoctor) doctorLeads.push({ name, profileUrl, headline });
    }

    console.log("Comments harvested:", harvested.length, "| doctor leads:", doctorLeads.length);

    if (harvested.length > 0 && itemsWithNoText === harvested.length) {
      // Every comment came back blank. That is the shape of a renamed field
      // in the actor's output, not of a post whose comments are all empty,
      // so say so rather than storing a wall of nulls in silence.
      console.warn(
        "Apify returned comments but none of them had text in any known field. " +
          "The actor's output shape may have changed — check _debug_first_item.",
        { runId, sample: allItems[0] }
      );
    }

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

    // 9. Keep the comments themselves.
    //
    // Until now the words were read, used to decide whether someone looked
    // like a doctor, and dropped. They are what a reply has to answer, so
    // they are stored against the post — reusing the post row if we have
    // commented on this post before, because doc_posts is unique on
    // (org_id, linkedin_post_url).
    let postId: string | null = null;
    let commentsSaved = 0;

    if (harvested.length > 0) {
      const { data: existingPost } = await supabase
        .from("doc_posts")
        .select("id")
        .eq("org_id", body.org_id)
        .eq("linkedin_post_url", postUrl)
        .maybeSingle();

      if (existingPost) {
        postId = existingPost.id;
      } else {
        // The comments dataset does not tell us who wrote the post, so the
        // author stays unknown here. If the Comment Generator is later used
        // on the same URL it reuses this row and does not overwrite it —
        // filling the author in is a separate job, not a silent one.
        const { data: inserted, error: postInsertError } = await supabase
          .from("doc_posts")
          .insert({
            org_id: body.org_id,
            linkedin_post_url: postUrl,
            author_name: "Unknown",
          })
          .select("id")
          .single();
        if (postInsertError) console.error("Failed to create post row:", postInsertError.message);
        postId = inserted?.id ?? null;
      }

      if (postId) {
        const rows = harvested.map((c) => ({
          user_id: user.id,
          org_id: body.org_id,
          post_id: postId,
          linkedin_comment_id: c.commentId,
          linkedin_comment_url: c.commentUrl,
          commenter_name: c.name,
          commenter_headline: c.headline || null,
          commenter_linkedin_url: c.profileUrl,
          comment_text: c.text,
          is_doctor_lead: c.isDoctor,
          commented_at: c.commentedAt,
        }));

        // Chunked so one long thread does not send a single enormous insert.
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          const { data: savedChunk, error: commentError } = await supabase
            .from("doc_post_comments")
            .upsert(chunk, { onConflict: "post_id,linkedin_comment_id" })
            .select("id");
          if (commentError) {
            console.error("Failed to save comments:", commentError.message);
          } else {
            commentsSaved += savedChunk?.length ?? 0;
          }
        }
      }
    }

    console.log("Comments saved:", commentsSaved, "of", harvested.length, "on post", postId);

    return new Response(
      JSON.stringify({
        data: {
          total_items: allItems.length,
          total_engagers: seen.size,
          total_comments: harvested.length,
          comments_saved: commentsSaved,
          post_id: postId,
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
