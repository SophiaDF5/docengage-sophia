"```markdown
# DocEngage

Prefix: doc_
Architecture type: Dashboard
Single-user: yes, per login — every account is its own fully isolated workspace (see "Account model" below). There is no team/multi-user sharing; a new signup starts completely empty.
Security templates repo: https://github.com/atibadesouza/Security-Repo

## Setup

Run these commands in order. Do not skip any step.

1. Clone security templates:
   git clone https://github.com/atibadesouza/Security-Repo /tmp/security-templates

2. Initialize project:
   npm create vite@latest . -- --template react-ts
   npm install @supabase/supabase-js zod react-router-dom

3. Copy security scaffolding:
   cp -r /tmp/security-templates/edge-functions/_shared/ supabase/functions/_shared/
   cp /tmp/security-templates/client/supabaseClient.ts src/lib/supabaseClient.ts
   cp /tmp/security-templates/client/apiClient.ts src/lib/apiClient.ts
   cp /tmp/security-templates/.gitignore .gitignore
   cp /tmp/security-templates/.env.example .env.example
   cp /tmp/security-templates/ci/pre-commit-hook.sh .git/hooks/pre-commit
   chmod +x .git/hooks/pre-commit
   mkdir -p .github/workflows .semgrep
   cp /tmp/security-templates/ci/github-actions.yml .github/workflows/security-checks.yml
   cp /tmp/security-templates/ci/semgrep-rules.yml .semgrep/semgrep-rules.yml
   cp /tmp/security-templates/tests/abuse-test.ts tests/abuse-test.ts

4. Initialize Supabase:
   supabase init
   # Copy the provided seed SQL into supabase/migrations/001_initial_schema.sql

5. Start local Supabase:
   supabase start

6. Apply migrations:
   supabase db push

7. Verify security gates:
   psql postgresql://postgres:postgres@localhost:54322/postgres -f sql/rls-gate-check.sql --set ON_ERROR_STOP=1

8. Configure external API secrets (from Section 7):
   supabase secrets set MAKE_WEBHOOK_SECRET="your_make_secret"
   supabase secrets set OPENAI_API_KEY="your_openai_key"

## Account model

There is still no team/multi-USER concept — nobody else can ever log into your account,
there are no roles (owner/admin/member), and nothing is ever shared between two different
logins. That part of migration 012 stands.

What changed since migration 012: a single login can now own multiple `doc_organizations`
rows — called "workspaces" in the UI — instead of exactly one. This is for one person (e.g.
an agency) running fully separate lead lists/comments/DMs per client under one login,
switchable from the picker in the header, rather than needing a separate email/account per
client. `doc_organizations` is still the literal table name (kept for historical reasons —
see migration 012's comment block), and every other table still carries the same `org_id`
column it always has.

- A brand new signup still auto-gets exactly one `doc_organizations` row from the
  `doc_on_auth_user_created` trigger — nothing changed there. The difference is the user can
  now create MORE of them afterward from the workspace switcher (`WorkspaceSwitcher.tsx`),
  each one starting completely empty, fully isolated from their other workspaces.
- `doc_user_org_ids()` — the function every table's RLS policy calls — did NOT need to
  change for this. It was already defined (migration 012) as
  `select id from doc_organizations where user_id = auth.uid()`, a set-returning function.
  There was also never a unique constraint on `doc_organizations.user_id`. So it already
  returned every org row a user owns, not just one — "one org per user" was purely a
  product/UX convention (one auto-created row, no UI to make more), never a DB-level limit.
  Every table's RLS policy across the whole app therefore already enforces correct
  per-account isolation for the multi-workspace case with zero per-table or per-policy
  changes — the exact "stays just as cheap" payoff migration 012's own comment predicted.
- RLS is the SECURITY boundary (User A can never see User B's data, regardless of how many
  workspaces either of them has) but is NOT the day-to-day filter between a user's OWN
  workspaces — a query with no `org_id` filter would return that user's data combined
  across all their workspaces. Isolation between one person's own workspaces is enforced by
  the frontend always scoping every query by `currentOrgId` from `useOrganization()`, the
  same pattern every page already used before this change. Any new query must follow it.
- `doc_organization_members` (the old team/roles table) is still dropped and still not
  coming back — this feature is "more workspaces for one person," not multi-user sharing.
- The frontend now DOES show a workspace switcher (`WorkspaceSwitcher.tsx`, in the header)
  that lets you switch, create, and — in Settings' danger zone — rename or delete a
  workspace. `useOrganization()` returns the full list plus the current selection instead of
  resolving to a single implicit "your account."
- Deleting a workspace cascades (every table's `org_id` FK is `on delete cascade`) and
  permanently wipes everything in it — see Settings.tsx's confirmation flow. The free
  Supabase plan has no automatic backups; see `scripts/backup-leads.mjs`.
- Known limitation: rate limiting (`rateLimit()`, see Rule 4's middleware chain) is keyed by
  `user_id`, not `org_id` — usage limits are shared across all of one user's workspaces, not
  per-workspace. Not changed as part of this — revisit if it becomes a real problem for
  someone running several active client workspaces at once.
- If you're setting up a Make.com scenario or any other integration that takes an `org_id`
  (e.g. `doc_inbound_post`, `doc_approve_comment`), make sure it points at the correct
  workspace's `org_id` — these aren't auto-detected from "whichever workspace is currently
  open in the browser," since the call isn't coming from the browser.

If you're adding a new table, follow the same pattern as every existing one: `org_id`
column + RLS policies scoped through `doc_user_org_ids()`. Don't scope directly off
`user_id` in new policies (except the three documented owner-only policies on
`doc_organizations` itself) — keeping every table routed through the one function is what
made both this and the migration 012 refactor cheap, and it means a future access-model
change stays just as cheap again.

## Rules

1. NEVER use the service_role key in application code. It exists only in
   test scripts and isolated admin functions with no user JWT to key RLS off
   of — currently `doc_daily_followups` (cron), `doc_inbound_post`
   (Make.com webhook, authenticated via MAKE_WEBHOOK_SECRET instead of a
   session), and `doc_register` / `doc_verify_email` / `doc_resend_code`
   (public registration — by definition there is no account, and therefore
   no user JWT, until doc_register creates one; confirming it requires the
   admin API's `updateUserById`, which requires service_role). Any new
   function added to this list must have the same property: a trusted (or,
   for the registration trio, tightly-scoped-to-only-the-caller's-own-new-account)
   caller with no user session, not just "it was convenient."

2. NEVER accept user_id from request bodies, query parameters, headers,
   or any client-provided source. User identity is ALWAYS derived from the
   JWT via auth.uid() (database) or requireAuth() (edge functions).

3. NEVER create a table without enabling RLS and adding all four policies
   (SELECT, INSERT, UPDATE, DELETE) scoped via doc_user_org_ids() — which,
   since migration 012, resolves to "my own account row," not "orgs I'm a
   member of." See "Account model" below. INSERT policies must also enforce
   user_id = auth.uid().

4. NEVER create an edge function without the full middleware chain:
   handlePreflight → requireAuth → rateLimit → validateBody →
   createUserClient → safeError

5. NEVER create a public storage bucket. All buckets are private.
   All file access uses signed URLs.

6. NEVER return raw database errors to the client. Use safeError() to
   sanitize all error responses.

7. NEVER use string interpolation in SQL. All queries are parameterized.

8. NEVER use SECURITY DEFINER on Postgres functions unless explicitly
   justified in the PRD. Default is SECURITY INVOKER.

9. NEVER bypass RLS by using service_role or by setting roles directly.

10. NEVER hardcode secrets, API keys, or credentials in source code.
    Use Deno.env.get() for edge functions and import.meta.env.VITE_ for
    frontend. All third-party credentials live in Supabase Vault.

11. NEVER skip input validation. Every edge function that accepts a
    request body MUST validate it with Zod before touching the database.

12. NEVER use select("*") in production code. Always specify the exact
    columns needed.

13. ALWAYS prefix all tables, policies, indexes, functions, triggers,
    and storage buckets with doc_.

14. ALWAYS create migrations for schema changes. Never modify the
    database directly.

15. ALWAYS test that User A cannot access User B's data before marking
    any feature complete.

16. NEVER call a third-party API from the frontend. All external API
    calls are made exclusively from edge functions. API keys must never
    appear in client-side code or responses.

17. NEVER call a third-party API using an endpoint, auth method, or
    payload shape not specified in Section 6.5 of this document.
    Do not invent or assume API contracts.

18. NEVER delete an uploaded file if external processing fails.
    Set the record status to 'failed', expose a retry
    mechanism in the UI, and log the failure with: file path, external
    service response code, and timestamp.

19. NEVER treat storage success and processing success as the same
    event. They are two separate operations with two separate failure
    modes. Handle each independently.

20. ALWAYS wrap every external API call in a try/catch. Never allow a
    third-party service failure to propagate as an unhandled 500.
    Return the sanitized error behavior specified in Section 6.5.

21. ALWAYS implement optimistic UI updates for comment approvals, reverting
    state if the Make.com edge function returns an error.

22. ALWAYS use a constant-time string comparison when validating incoming 
    webhooks (e.g., Make.com secret token).

23. NEVER bypass Make.com to communicate directly with LinkedIn from Supabase 
    edge functions. Direct LinkedIn integration is strictly prohibited.

## File Map

### Security (DO NOT MODIFY — copied from security templates)
- supabase/functions/_shared/auth.ts        → JWT verification + user derivation
- supabase/functions/_shared/rate-limit.ts  → Rate limiting middleware
- supabase/functions/_shared/cors.ts        → CORS handling
- supabase/functions/_shared/validate.ts    → Zod input validation
- supabase/functions/_shared/error-handler.ts → Sanitized error responses
- src/lib/supabaseClient.ts                 → Anon-key-only Supabase client
- src/lib/apiClient.ts                      → Edge function caller

### Database
- supabase/migrations/001_initial_schema.sql → Tables, RLS (original user-scoped), indexes
- supabase/migrations/002_fix_rls_org_scoped.sql → Fixes RLS to org-membership scoping, adds helper functions
- supabase/migrations/003_unique_post_per_org.sql → Unique constraints on posts and contacts per org
- supabase/migrations/004_fix_members_rls_recursion.sql → SECURITY DEFINER on helper functions to fix RLS recursion
- supabase/migrations/005_rework_schema.sql → Schema rework
- supabase/migrations/006_add_email_to_contacts.sql → Adds `email` column to doc_contacts
- supabase/migrations/007_add_connection_degree.sql → Adds `is_connected` to doc_contacts
- supabase/migrations/008_dm_leads.sql → Creates doc_dm_leads
- supabase/migrations/009_outreach_messages.sql → Creates doc_outreach_messages
- supabase/migrations/010_unify_lead_sources.sql → Adds `source` to doc_contacts; adds `status`/`linkedin_profile_url`/`last_contacted_at` to doc_dm_leads; makes doc_outreach_messages.contact_id nullable and adds dm_lead_id, so a lead from either table can flow through the unified Outreach queue
- supabase/migrations/011_add_custom_fields.sql → Adds `custom_fields` jsonb column to doc_contacts and doc_dm_leads for freeform per-lead info (title, company, etc.), no fixed schema
- supabase/migrations/012_remove_org_teams.sql → Collapses the org/team model into one isolated account per login: auto-creates a doc_organizations row per user via a new auth.users trigger, redefines doc_user_org_ids() to return only the caller's own row, drops doc_organization_members + doc_user_is_org_admin(). See "Account model" above.
- supabase/migrations/013_add_contact_tags.sql → Adds `tag` text column to doc_contacts — freeform label set at upload/add time (e.g. "YouTube"), drives the dynamic filter chips on the Manual Added Leads page
- supabase/migrations/014_add_tag_to_dm_leads.sql → Adds `tag` text column to doc_dm_leads, mirroring doc_contacts.tag — general freeform label support for Engaged leads (e.g. "YouTube"). Not used for "Invited" — see migration 015.
- supabase/migrations/015_add_invited_status.sql → Adds `'invited'` as a fourth allowed value (pending → invited → messaged → engaged) to the status CHECK constraint on both doc_contacts and doc_dm_leads. Replaces an earlier tag-based "Invited" approach — it's now a status you pick from the same Status dropdown as Pending/Messaged/Engaged, and filterable the same way in Outreach's Status row.
- supabase/migrations/016_add_keyword_search.sql → Adds `'keyword_search'` as a third allowed value on doc_contacts.source (alongside 'scraped'/'manual'), plus `matched_keyword`, `source_post_url`, `source_post_excerpt`, `source_post_date` columns — supports the Keyword Search page/feature (see doc_search_keyword_leads).
- supabase/migrations/017_add_email_verifications.sql → Creates `doc_email_verifications`, an infra table (like doc_rate_limits) with no org_id and no RLS policies — only ever touched by the service_role client inside doc_register/doc_verify_email/doc_resend_code. Supports public registration with emailed 6-digit codes.
- supabase/migrations/018_reassert_doc_organizations_rls.sql → Idempotently drops every policy name `doc_organizations` has ever had across this repo's history and recreates the canonical four (`..._select_own`/`..._insert_own`/`..._update_own`/`..._delete_own`, all `user_id = auth.uid()`). Fixes "new row violates row-level security policy for table doc_organizations" on creating a new workspace — production's live policies had drifted from what migrations 001/002 describe (likely from earlier manual SQL Editor activity on this table — see migration 012's own note about duplicate `doc_organizations` rows from that same history).
- supabase/migrations/019_post_comments_and_replies.sql → Adds `doc_post_comments` (every comment harvested off a scraped post — commenter name/headline/profile URL, the comment text itself, whether they matched the healthcare-keyword filter — kept for everyone who commented, not just doctor matches) and four columns on `doc_comments` (`parent_comment_id`, `reply_to_name`, `reply_to_linkedin_url`, `reply_to_text`) so a generated comment can be a reply to one of them. Also backfills `doc_dm_leads.linkedin_profile_url` from `links` where `links` is clearly a LinkedIn profile URL. Originally written and pushed to GitHub as migration 014 in a separate line of work that this repo's local history (multi-workspace support, invited status, keyword search, email verification, migrations 014-018 by number) never received — reconciled by renumbering to 019 when the two histories were merged; no schema content changed from the original, only the filename/number.

### Deployment
- docs/deployment/MANUAL_SQL_OPERATIONS.md  → Manual SQL that must be run
                                               per environment before deploying

### Edge Functions
- supabase/functions/doc_inbound_post/index.ts    → Receives post from Make, triggers OpenAI, saves to DB
- supabase/functions/doc_approve_comment/index.ts → Approves comment, triggers Make webhook to post
- supabase/functions/doc_process_tone/index.ts    → Processes media via Whisper, updates org system prompt (this summary is reference-only now — see doc_generate_comment/doc_generate_dm below, neither reads it anymore)
- supabase/functions/doc_daily_followups/index.ts → Documented but not yet built — no directory exists in the repo. Skip when deploying; there's nothing to deploy yet.
- supabase/functions/doc_scrape_post_commenters/index.ts → Lead scraper: pulls LinkedIn post commenters via Apify (HarvestAPI actor), filters for healthcare keywords, upserts doc_contacts. Also saves every harvested comment (not just doctor matches) into `doc_post_comments` via `_shared/linkedin.ts`'s `normalizePostUrl()` — reusing the post's existing `doc_posts` row where one exists — so the Comment Generator's Reply tab has something to reply to. Reads the comment text/id/URL through a list of candidate field names (`readCommentText`/`readCommentUrl`/`commentIdentity`) since HarvestAPI's field names for these have changed before without warning; logs a warning if every harvested comment comes back with no text (a sign the actor's schema changed again, not that the post genuinely has empty comments).
- supabase/functions/doc_search_keyword_leads/index.ts → Keyword/topic lead finder: searches LinkedIn posts by keyword via Apify (HarvestAPI `linkedin-post-search` actor, past week, max 50 posts/search), filters authors for healthcare keywords (same list as doc_scrape_post_commenters, duplicated not shared), and returns a preview list — does NOT write to the database. The frontend (KeywordSearch.tsx) lets the user pick which results to save, then inserts those directly into doc_contacts with `source: 'keyword_search'` (same "insert straight from the client" pattern as AddContactDialog, not a second edge function)
- supabase/functions/doc_enrich_emails/index.ts → Attempts to find emails for existing doc_contacts via a second Apify actor (HarvestAPI profile+email search) — partial coverage only, not guaranteed per lead
- supabase/functions/doc_enrich_emails_apollo/index.ts → Second-attempt email finder via Apollo.io People Enrichment API — deliberately separate button/cap (max 20) from doc_enrich_emails since Apollo credits are much scarcer
- supabase/functions/doc_generate_comment/index.ts → Drafts the AI comment for a post (used by doc_inbound_post and manual regeneration from the Comments dashboard) or a reply to one of that post's harvested comments; tone is the permanent, hardcoded Atiba persona from `_shared/atiba-persona.ts` — no longer reads doc_organizations.ai_system_prompt. `ATIBA_PERSPECTIVE_OVERRIDE` is appended after the reply-specific instructions too (not just the base persona), since those instructions also talk about "your own perspective" and needed the same no-job-title guard. A reply can point at a saved `doc_post_comments` row (`reply_to_comment_id` — brings its post and commenter along) or be typed in by hand (`reply_to_name`/`reply_to_text`/etc., for a post that was never scraped); either way it also looks up a matching `doc_dm_leads` row (by `lead_id`, or by matching profile URL) to fold in bio/links/custom fields. Saved status is `pending` (or `approved` immediately if the org has `auto_post_enabled`) — the Comment Generator's Copy button is what calls `doc_approve_comment` to move a pending draft to approved and save whatever the person edited before copying it, see CommentGenerator.tsx's `OutputArea`.
- supabase/functions/_shared/linkedin.ts → `normalizePostUrl()` — one canonical spelling for a LinkedIn post URL (lowercases the host, strips query string/fragment/trailing slash, leaves the case-sensitive path alone) so a post opened from a feed link and the same post opened from a share link land in the same `doc_posts` row instead of tripping the `(org_id, linkedin_post_url)` unique constraint into creating two. Used by both doc_scrape_post_commenters and doc_generate_comment.
- supabase/functions/doc_generate_dm/index.ts → Drafts DM replies/openers for DM Assistant and Outreach's personalized mode; tone is the same permanent, hardcoded Atiba persona from `_shared/atiba-persona.ts` — no longer reads doc_organizations.ai_system_prompt
- supabase/functions/_shared/atiba-persona.ts → Shared, hardcoded Atiba de Souza voice (`ATIBA_PERSONA`, `ATIBA_HUMAN_STYLE_GUIDE`, `ATIBA_PERSPECTIVE_OVERRIDE`) used by both doc_generate_comment and doc_generate_dm — the one permanent tone for every account, replacing the earlier per-account `doc_organizations.ai_system_prompt` approach. See its header comment for why (per-account tone-sample text kept resurfacing unwanted "as a business owner" framing that a trailing override couldn't fully suppress; Reina then asked for the voice to be locked/permanent across the whole app).
- supabase/functions/doc_register/index.ts → Public sign-up: creates an unconfirmed auth user (admin API), generates a 6-digit code, stores it in doc_email_verifications, emails it via Brevo. No requireAuth() — see Rule 1's exception list.
- supabase/functions/doc_verify_email/index.ts → Confirms a doc_register code: checks it against doc_email_verifications (expiry + 5-attempt cap), flips `email_confirm` to true via the admin API on success, deletes the row (one-time use). No requireAuth().
- supabase/functions/doc_resend_code/index.ts → Regenerates and re-sends the code for an existing unconfirmed registration, 60s cooldown per email, generic response either way so it can't be used to probe which emails are registered. No requireAuth().
- supabase/functions/_shared/brevo.ts → Shared Brevo transactional-email helper (`sendEmail()`), used only by doc_register/doc_resend_code. Returns true/false rather than throwing — same "don't conflate two outcomes" pattern as the file-processing rule (Rule 19).

### Frontend
- src/pages/CommentGenerator.tsx → "Comments" page (route `/`). Three tabs: Caption and Image draft a comment on a post (pasted text or an uploaded screenshot); Reply to a comment drafts a reply inside the thread instead — pick a post you've scraped and one of its harvested comments (`doc_post_comments`, searchable by name/headline/what they said), or paste a comment in by hand for a post never scraped. If you fill in Author/commenter Name + LinkedIn URL, that person is saved into `doc_dm_leads` (Engaged Leads) with `status = 'engaged'` on generation (commenting on — or replying to — their post/comment counts as engaging with them; `saveEngagedLead()` writes the URL to both `links` and `linkedin_profile_url` so later lookups by either column find them) — skipped if a lead with that LinkedIn URL already exists. The Copy button in the output area is what actually approves a draft (`doc_approve_comment`, saving whatever was edited before copying) — see doc_generate_comment's notes below. Recent Comments never deletes anything — no auto-expiry, no per-item delete button — it's meant as a permanent tracker of everything ever drafted (see Rule/decision history in doc_generate_comment).
- src/pages/Contacts.tsx      → "Scraped Leads" page. CRM pipeline of doctors identified via the scraper only (`source = 'scraped'`). Manually added leads live on the Manual Added Leads page instead, though both read/write the same doc_contacts table and `["contacts", orgId]` query key. Select leads without an email (max 50) to run doc_enrich_emails, or (max 20) to run doc_enrich_emails_apollo as a second attempt; export filtered view to CSV
- src/pages/ManualLeads.tsx   → "Manual Added Leads" page. Shows doc_contacts rows where `source = 'manual'` — added one-by-one via AddContactDialog, or via CSV/Excel upload (`UploadLeadsDialog`, defined in this file). Both let you set a freeform `tag` (e.g. "YouTube") on the lead(s); the page's filter chips are built dynamically from whatever distinct `tag` values currently exist — no fixed list. Supports status changes, delete, and the same email-enrichment (Find Emails) flow as Scraped Leads. Shares the `["contacts", orgId]` query key so status stays in sync with Scraped Leads and Outreach.
- src/pages/auth/Register.tsx → Public "Create your account" page (name/email/password/confirm). Calls doc_register, then routes to /verify carrying `{ email, password }` via router state (never persisted) so Verify can auto-sign-in once the code is confirmed.
- src/pages/auth/VerifyCode.tsx → "Check your email" page. Enter the 6-digit code → calls doc_verify_email → if we still have the password from Register's route state, signs the user in immediately and lands them in the app; otherwise sends them to /login. Includes a 60s-cooldown "Resend Code" button (doc_resend_code). Falls back to an editable email field if opened without route state (e.g. a page refresh lost it).
- src/pages/auth/Login.tsx → Unchanged sign-in form, plus a "Register" link, plus: if `signInWithPassword` fails with "email not confirmed," redirects to /verify with the email+password the user just typed instead of showing a dead-end error.
- src/pages/KeywordSearch.tsx → "Keyword Search" page. Type a topic (e.g. "AI and healthcare") → calls doc_search_keyword_leads → shows a preview list (name, headline, their post + link, posted date) with checkboxes, nothing saved yet. Selecting leads and clicking "Save Selected as Leads" upserts them into doc_contacts with `source = 'keyword_search'`, `matched_keyword`, and the post context (`source_post_url`/`source_post_excerpt`/`source_post_date`) — see migration 016. Below the search box, a second table shows everything already saved this way (own the `source = 'keyword_search'` rows, mirroring how Scraped Leads owns `'scraped'` and Manual Added Leads owns `'manual'`), with the same Status dropdown/CustomFieldsDialog/EditContactDialog/delete-with-confirm pattern as those pages, sharing `["contacts", orgId]` for the same cross-page sync.
- src/pages/Settings.tsx      → Settings for whichever workspace is currently selected (see "Account model" above) — workspace name, a Tone & Voice section that uploads audio/text samples and transcribes them via doc_process_tone (that transcription no longer drives Comment or DM tone — both are permanently the hardcoded Atiba persona, see `_shared/atiba-persona.ts` — the section is kept so Reina can pull a raw Whisper transcript via the "View Transcript" button as source material when hand-tuning that file), and a danger zone to delete the current workspace (disabled if it's the user's only one; cascades and permanently wipes everything in it, type-the-name-to-confirm). Still no team/member management — that's a different, unrelated axis from workspaces; see "Account model."
- src/hooks/useOrganization.ts → Fetches every workspace (`doc_organizations` row) the logged-in user owns, tracks which one is "current" (self-healing against a stale/missing localStorage selection — see the file's header comment), and exposes switchOrg/createOrg/renameOrg/deleteOrg. Every page that reads `currentOrgId` from this hook is unaffected by there now being more than one workspace — they already scoped every query by org id.
- src/components/WorkspaceSwitcher.tsx → Header dropdown (always visible, including on mobile — which page every nav item shows depends on which workspace is selected) to switch between workspaces or create a new one. Renaming/deleting a workspace is deliberately kept in Settings instead, next to that workspace's other settings.
- src/pages/DmAssistant.tsx   → AI-drafted DM replies/openers for one conversation at a time, backed by doc_dm_drafts history
- src/pages/Leads.tsx         → "Engaged Leads" page. Manually curated lead list (name/bio/LinkedIn URL) feeding DM Assistant context, backed by doc_dm_leads — has its own status pipeline (pending/messaged/engaged) matching doc_contacts. Also merges in (read-only structurally, but fully editable) any doc_contacts row — Scraped or Manual — whose `status` is `messaged` or `engaged`, using the same `["contacts", orgId]` query key as Scraped/Manual Added Leads. This is a display-time merge, not a data copy: there's still exactly one row per lead, status changes and custom fields write back to whichever table it actually lives in, and setting a merged-in lead's status back to `pending` just makes it disappear from this page (no delete needed). Deleting a merged-in lead is only available from its home page (Scraped Leads / Manual Added Leads), to avoid the appearance of two separate records for one person.
- src/pages/Outreach.tsx      → Unified outreach queue merging doc_contacts (scraped + manual) and doc_dm_leads (engaged) into one list. Filtering is layered: Source (Scraped/Engaged/Manual Added, multi-select) narrows which tables/rows are in scope; Status (Pending/Messaged/Engaged) and Tag (built dynamically from whatever tags exist among the source-filtered leads, plus an "Untagged" bucket) further refine within that scope — all three (Source/Status/Tag) use "empty selection = no restriction, click a chip to add one" so they default to showing everything (Source used to default to "all selected, click removes" — inconsistent with Status/Tag and caused deselecting every Source chip to silently show zero leads with no explanation; fixed to match); a text search box matches name/headline. All four combine (AND). "Invited" is a status value (migration 015), not a tag — set it from the same Status dropdown as Pending/Messaged/Engaged on Scraped Leads, Manual Added Leads, or Engaged Leads, or directly here: every lead row (both the picker list and the review queue) now has its own Status dropdown (Pending/Invited/Messaged/Engaged) so status can be changed without leaving Outreach; it then filters here the same way as the other three statuses. (An earlier iteration used a separate freeform tag for "Invited" — reverted per explicit feedback that it belonged in Status, not Tag.) No upload here anymore — CSV/Excel upload lives on the Manual Added Leads page (see above); this page only composes/sends. Draft messages (bulk or AI-personalized), assisted-send (copies message + opens LinkedIn — never sends automatically, per Out of Scope section). Logs to doc_outreach_messages against whichever source table (`contact_id` or `dm_lead_id`) the lead came from, and writes status back to that same table — see "Status sync" note under doc_outreach_messages below
- src/lib/csvImport.ts        → `parseLeadFile()` — shared CSV/XLSX parsing used by ManualLeads.tsx's upload dialog. Matches columns by header keyword ("linkedin"/"url"/"profile", "name") rather than exact names.
- src/components/AddContactDialog.tsx → Shared "Add Lead" dialog (name/LinkedIn URL/headline/tag), inserts into doc_contacts with `source = 'manual'`. Currently only used by the Manual Added Leads page — kept as its own component so the insert shape can't drift if it's ever wired into another page too.
- src/components/EditContactDialog.tsx → Shared "Edit Lead" dialog for fixing an existing doc_contacts row's core fields (name/LinkedIn URL/headline/email/tag) — e.g. a typo from manual entry or a bad CSV import. Separate from CustomFieldsDialog (freeform custom_fields only) and the status/connected dropdowns. Used on Scraped Leads and Manual Added Leads.
- src/components/CustomFieldsDialog.tsx → Shared dialog for adding freeform key/value info to a lead (job title, company, etc. — see doc_contacts.custom_fields / doc_dm_leads.custom_fields, migration 011). Used on Scraped Leads, Manual Added Leads, and Engaged Leads. Takes `table` ("doc_contacts" | "doc_dm_leads") + `queryKey` so it invalidates whichever page's cache owns the row.
- src/components/ErrorBoundary.tsx → Top-level React error boundary wrapping the router in App.tsx. Without it, any uncaught render error (bad query, null dereference, a bug in a new page) unmounts the whole tree and leaves a blank white screen with no message — this catches it and shows a real error + reload option instead.
- src/components/QueueItem.tsx→ Comment review UI card with optimistic updates

### Scripts
- scripts/setup-integrations.md → Step-by-step credential setup for external integrations
- scripts/create-account.mjs → Creates a new login (`node scripts/create-account.mjs <email> <password>`). Since migration 012 there's no manual org-insert step — creating the auth user is enough, the doc_on_auth_user_created trigger auto-creates their doc_organizations row. Uses SUPABASE_SERVICE_ROLE_KEY, local use only, never called from the app. Replaces the old pre-migration-012 manual "insert into doc_organizations + doc_organization_members" approach, which no longer works (that members table was dropped).
- scripts/backup-leads.mjs → Manual backup safety net (`node scripts/backup-leads.mjs`), added after an accidental data-loss incident (a leftover ad-hoc "delete" script in the Supabase SQL Editor history got re-run and wiped doc_contacts/doc_dm_leads for one org). The account is on Supabase's free plan, which has no automatic backups or Point-in-Time Recovery, so this fills that gap. Dumps doc_organizations, doc_contacts, doc_dm_leads, doc_outreach_messages, and doc_dm_drafts to a single timestamped JSON file in `backups/` (gitignored — contains real lead PII, never commit it). Run manually and regularly, and always before doing any manual cleanup/deletion in the Supabase SQL Editor.

### Tests
- tests/abuse-test.ts → Cross-account security tests (User A cannot see/modify User B's data)

### CI
- .github/workflows/security-checks.yml → Security gates
- .semgrep/semgrep-rules.yml            → Static analysis rules

## Database

### doc_rate_limits
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| key | text | not null |
| user_id | uuid | FK → auth.users, not null |
| created_at | timestamptz | not null, default now() |

### doc_email_verifications
Infra table (same family as doc_rate_limits) supporting public registration — pre-account, so
there's no org_id, and it's only ever touched by the service_role client inside
doc_register/doc_verify_email/doc_resend_code, never by an authenticated user's client.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, unique — one active code per account |
| email | text | not null |
| code | text | not null — 6-digit numeric, generated via crypto.getRandomValues |
| attempts | int | not null, default 0 — capped at 5 by doc_verify_email |
| expires_at | timestamptz | not null — 15 minutes from generation |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger — doubles as "last code sent at" for doc_resend_code's 60s cooldown |

RLS: enabled, but with NO policies for anon/authenticated (default-deny) — mirrors doc_rate_limits'
documented CI exemption from the standard 4-policy check. Only service_role (which bypasses RLS)
reads/writes this table.
Indexes: doc_email_verifications_email_idx

### doc_organizations
One or more rows per user — an internal per-workspace settings container, not a
user-facing "organization" (no multi-user sharing — see "Account model" above). Exactly one
row is auto-created by the `doc_on_auth_user_created` trigger on signup; a user can create
additional rows afterward from the workspace switcher (`WorkspaceSwitcher.tsx`) to run
separate, fully isolated lead lists/comments/DMs under the same login (e.g. one per client).

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() — NOT unique; a user can own multiple rows (multiple workspaces), see "Account model" |
| name | text | not null |
| auto_post_enabled | boolean | not null, default false |
| ai_system_prompt | text | no longer read by Comment/DM generation — see `_shared/atiba-persona.ts` |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_organizations_select_own, doc_organizations_insert_own, doc_organizations_update_own, doc_organizations_delete_own (all scoped to `user_id = auth.uid()` — unchanged since migration 001, already correct for "a user may touch any/all of their own rows")
Indexes: doc_organizations_user_id_idx (non-unique)

**doc_organization_members was dropped in migration 012** along with the team/roles concept
(owner/admin/member). There is no equivalent table anymore — don't recreate it without a
real product reason to bring back multi-user sharing.

### doc_posts
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| linkedin_post_url | text | not null |
| author_name | text | not null |
| author_headline | text | |
| content | text | |
| published_at | timestamptz | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_posts_select_org, doc_posts_insert_org, doc_posts_update_org, doc_posts_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_posts_user_id_idx, doc_posts_org_id_idx

### doc_comments
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| post_id | uuid | FK → doc_posts, not null |
| org_id | uuid | FK → doc_organizations, not null |
| generated_content | text | |
| edited_content | text | |
| status | text | not null, default 'pending', check in ('pending', 'approved', 'rejected', 'generation_failed') |
| approved_by | uuid | FK → auth.users |
| parent_comment_id | uuid | FK → doc_post_comments, on delete set null — set only when this draft is a reply to a harvested comment rather than a comment on the post itself. Added in migration 019. |
| reply_to_name | text | copy of who this is a reply to, added in migration 019 — kept independent of parent_comment_id so the reply still reads sensibly in history if that row is deleted or the post is re-scraped |
| reply_to_linkedin_url | text | added in migration 019 |
| reply_to_text | text | copy of what they said, added in migration 019 — same "keep it readable in history" reasoning as reply_to_name |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_comments_select_org, doc_comments_insert_org, doc_comments_update_org, doc_comments_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_comments_user_id_idx, doc_comments_post_id_idx, doc_comments_org_id_idx, doc_comments_status_idx, doc_comments_org_status_idx, doc_comments_parent_comment_idx
Realtime: Enabled ONLY for `status` column

### doc_post_comments
Every comment harvested off a scraped post by doc_scrape_post_commenters — kept for everyone who
commented, not just people who matched the healthcare-keyword doctor filter, because replying to a
comment (see doc_generate_comment's reply mode) means answering what it actually said. Added in
migration 019.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| post_id | uuid | FK → doc_posts, not null, on delete cascade |
| linkedin_comment_id | text | not null — LinkedIn's own id where HarvestAPI gives one; otherwise a stable substitute built from the commenter's profile URL + the opening of what they wrote, so re-scraping updates rows instead of duplicating them |
| linkedin_comment_url | text | |
| commenter_name | text | not null |
| commenter_headline | text | |
| commenter_linkedin_url | text | |
| comment_text | text | |
| is_doctor_lead | boolean | not null, default false — whether this commenter matched the same healthcare-keyword filter doc_scrape_post_commenters already applies, stored so the reply screen can put likely doctors first without re-running the match client-side |
| commented_at | timestamptz | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Constraint: `doc_post_comments_post_comment_unique` — unique on (post_id, linkedin_comment_id)
Policies: doc_post_comments_select_org, doc_post_comments_insert_org, doc_post_comments_update_org, doc_post_comments_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_post_comments_org_id_idx, doc_post_comments_post_id_idx, doc_post_comments_org_created_idx, doc_post_comments_commenter_url_idx

### doc_contacts
"Scraped Leads" page. Also holds one-by-one manually added leads (`source = 'manual'`) and rows
imported via the Manual Added Leads page's CSV/Excel upload (also tagged `source = 'manual'`).

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| linkedin_profile_url | text | not null |
| full_name | text | not null |
| headline | text | |
| email | text | (written only by doc_enrich_emails / doc_enrich_emails_apollo) |
| is_connected | boolean | not null, default false |
| status | text | not null, default 'pending', check in ('pending', 'invited', 'messaged', 'engaged') — 'invited' added in migration 015 |
| source | text | not null, default 'scraped', check in ('scraped', 'manual', 'keyword_search') — added in migration 010, 'keyword_search' added in migration 016 |
| custom_fields | jsonb | not null, default '{}' — freeform key/value lead info (title, company, etc.), added in migration 011 |
| tag | text | freeform label set at upload/add time (e.g. "YouTube"), added in migration 013 — drives Manual Added Leads' dynamic filter chips |
| matched_keyword | text | the keyword/topic search that surfaced this lead, added in migration 016 — only populated for `source = 'keyword_search'` |
| source_post_url | text | the specific LinkedIn post that matched the keyword search, added in migration 016 |
| source_post_excerpt | text | snippet (first 500 chars) of that post's content, added in migration 016 |
| source_post_date | timestamptz | when that post was published, added in migration 016 |
| last_contacted_at | timestamptz | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_contacts_select_org, doc_contacts_insert_org, doc_contacts_update_org, doc_contacts_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_contacts_user_id_idx, doc_contacts_org_id_idx, doc_contacts_status_idx, doc_contacts_org_status_idx, doc_contacts_source_idx, doc_contacts_tag_idx

### doc_tone_samples
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| file_path | text | not null |
| extracted_text | text | |
| processing_status | text | not null, default 'pending', check in ('pending', 'completed', 'failed') |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_tone_samples_select_org, doc_tone_samples_insert_org, doc_tone_samples_update_org, doc_tone_samples_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_tone_samples_user_id_idx, doc_tone_samples_org_id_idx

### doc_dm_leads
"Engaged Leads" page. Manually curated leads with notes/bio, feeding DM Assistant context. Since
migration 010, also participates in the same status pipeline as doc_contacts so it can be merged
into the Outreach queue.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| name | text | not null |
| bio | text | |
| links | text | |
| linkedin_profile_url | text | added in migration 010 |
| status | text | not null, default 'pending', check in ('pending', 'invited', 'messaged', 'engaged') — added in migration 010, 'invited' added in migration 015 |
| custom_fields | jsonb | not null, default '{}' — freeform key/value lead info, added in migration 011 |
| tag | text | freeform label (e.g. "Invited"), added in migration 014 — mirrors doc_contacts.tag so Outreach can tag/filter leads from any source the same way |
| last_contacted_at | timestamptz | added in migration 010 |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_dm_leads_select_org, doc_dm_leads_insert_org, doc_dm_leads_update_org, doc_dm_leads_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_dm_leads_org_id_idx, doc_dm_leads_org_name_idx, doc_dm_leads_status_idx, doc_dm_leads_org_status_idx

### doc_dm_drafts
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| conversation_context | text | not null |
| last_reply | text | not null |
| generated_content | text | |
| edited_content | text | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_dm_drafts_select_org, doc_dm_drafts_insert_org, doc_dm_drafts_update_org, doc_dm_drafts_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_dm_drafts_user_id_idx, doc_dm_drafts_org_id_idx, doc_dm_drafts_org_created_idx
Notes: History auto-pruned to entries newer than 5 days by the DM Assistant UI on each load.

### doc_outreach_messages
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| contact_id | uuid | FK → doc_contacts, nullable, on delete cascade — nullable since migration 010 |
| dm_lead_id | uuid | FK → doc_dm_leads, nullable, on delete cascade — added in migration 010 |
| message_content | text | not null |
| sent_at | timestamptz | not null, default now() |
| created_at | timestamptz | not null, default now() |

Constraint: `doc_outreach_messages_exactly_one_target` — exactly one of `contact_id` / `dm_lead_id` must be set (never both, never neither), since migration 010 lets a logged message point at either source table.
Policies: doc_outreach_messages_select_org, doc_outreach_messages_insert_org, doc_outreach_messages_update_org, doc_outreach_messages_delete_org (all scoped to your own account via doc_user_org_ids())
Indexes: doc_outreach_messages_org_id_idx, doc_outreach_messages_contact_id_idx, doc_outreach_messages_user_id_idx, doc_outreach_messages_contact_sent_idx, doc_outreach_messages_dm_lead_id_idx
Notes: Logs what was sent via the Outreach page's assisted-send flow (copy message + open LinkedIn manually). Written client-side after the user confirms they sent the message — the app never sends anything to LinkedIn itself, per the Out of Scope section.

**Status sync across the app**: doc_contacts and doc_dm_leads share the same status vocabulary
(`pending` / `messaged` / `engaged`). The Scraped Leads, Engaged Leads, and Outreach pages all query
these tables under the identical React Query keys (`["contacts", orgId]` / `["dm-leads", orgId]`).
Any mutation that changes a lead's status invalidates the query key for its source table; every
mounted page sharing that key refetches automatically, so a status change made on any one page
(e.g. marking a lead "messaged" from Outreach) is reflected everywhere else without a manual
refresh. When adding a new status-changing mutation, invalidate the matching key — don't invent a
new query key for the same underlying table.

### Storage Buckets
- `doc_tone_uploads` (Private). Paths format: `/{org_id}/{uuid}.{ext}`

**BEFORE deploying to any environment**, check `docs/deployment/MANUAL_SQL_OPERATIONS.md` for pending manual SQL operations that must be run in the Supabase SQL Editor. Run any unchecked items for that environment and mark them complete.

## Edge Functions

### doc_inbound_post
- Method: POST
- Rate limit tier: write
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    linkedin_post_url: z.string().url(),
    author_name: z.string().optional(),
    author_headline: z.string().optional(),
    content: z.string(),
    secret_token: z.string()
  })
  ```
- Success response (200):
  ```json
  { "data": { "id": "uuid", "status": "pending_or_approved" } }
  ```
- Error responses:
  - 400: Invalid input
  - 401: Invalid secret_token
  - 429: Rate limit exceeded
  - 500: Sanitized message
- Tables touched: doc_posts (WRITE), doc_comments (WRITE), doc_organizations (READ)
- External calls: OpenAI — see Section 6.5; Make.com — see Section 6.5 (only when `auto_post_enabled` is true)
- Notes: No user JWT exists for this call (Make.com is the caller, not a logged-in user), so it uses the
  service_role client — see the exception carved out in Rule 1. Validates `secret_token` against
  `MAKE_WEBHOOK_SECRET` via constant-time comparison (`constantTimeEqual`) — checked here, not via
  `requireAuth()`, which is why Gate 3 in CI has a documented exemption for this function specifically.
  Rate-limited against the org owner's user_id (there's no calling user to key on directly). Defaults
  `author_name` to "Author" when missing. Idempotent: returns the existing post/status instead of
  regenerating if `linkedin_post_url` already exists for this org. If OpenAI fails, inserts the post but
  marks the comment `generation_failed` instead of blocking ingestion. If `auto_post_enabled` is true,
  attempts the outbound Make.com webhook immediately; on any failure (or if Make.com isn't configured),
  falls back to `pending` so a human can review/retry rather than silently claiming it posted.

### doc_approve_comment
- Method: POST
- Rate limit tier: write
- Input schema:
  ```typescript
  z.object({
    comment_id: z.string().uuid(),
    edited_content: z.string().min(1).max(3000)
  })
  ```
- Success response (200):
  ```json
  { "data": { "id": "uuid", "status": "approved" } }
  ```
- Error responses:
  - 400: Invalid input (content > 3000 chars)
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message
- Tables touched: doc_comments (READ/WRITE)
- External calls: Make.com — see Section 6.5
- Notes: Must verify `status = 'pending'` before proceeding (prevents double-approval replay). Updates DB, triggers Make.com webhook to post. 

### doc_process_tone
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    sample_id: z.string().uuid()
  })
  ```
- Success response (200):
  ```json
  { "data": { "id": "uuid", "status": "completed" } }
  ```
- Error responses:
  - 400: Invalid input
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message
- Tables touched: doc_tone_samples (READ/WRITE), doc_organizations (WRITE)
- External calls: OpenAI (Whisper) — see Section 6.5
- Notes: Processes media file from Storage. If `processing_status` is already `completed`, returns early. On Whisper failure, never deletes file, sets `processing_status = 'failed'`.

### doc_daily_followups
- Method: POST
- Rate limit tier: auth (Cron only)
- Input schema: None (triggered by cron)
- Success response (200):
  ```json
  { "data": { "processed": number } }
  ```
- Tables touched: doc_contacts (READ)
- External calls: Make.com — see Section 6.5
- Notes: Identifies contacts in `no_action` for > 7 days and pushes them to Make.com. Utilizes `service_role` key ONLY in this specific wrapper to bypass user context restrictions.

### doc_scrape_post_commenters
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    linkedin_post_url: z.string().trim().url(),
  })
  ```
- Success response (200):
  ```json
  { "data": { "total_items": number, "total_engagers": number, "total_comments": number, "comments_saved": number, "post_id": "uuid | null", "doctors_found": number, "contacts_saved": number, "run_url": "string", "warning": "string | null" } }
  ```
- Error responses:
  - 400: Invalid input
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message (e.g. Apify key not configured, Apify run failed)
  - 504: Scraping timed out (120s poll budget)
- Tables touched: doc_contacts (WRITE), doc_posts (READ/WRITE), doc_post_comments (WRITE)
- External calls: Apify (`harvestapi~linkedin-post-comments` actor) — see Section 6.5
- Notes: Starts an Apify actor run, polls up to 120s for completion, fetches the resulting dataset,
  filters commenters against a healthcare-keyword list, and upserts matches into `doc_contacts`
  (`onConflict: org_id,linkedin_profile_url`, `ignoreDuplicates: true`) so re-scraping the same
  post is safe. Because this actor scrapes without LinkedIn login, LinkedIn can soft-block it and
  return a "successful" run with 0 items — the response includes `run_url` and a `warning` string
  so this is visible in the UI instead of silently returning zero saved leads. Also saves every
  harvested comment (not just doctor matches) into `doc_post_comments`, reusing the post's existing
  `doc_posts` row where one exists (matched via `normalizePostUrl()` from `_shared/linkedin.ts`, so a
  feed-link URL and a share-link URL for the same post land on the same row) — upserted on
  `(post_id, linkedin_comment_id)` in chunks of 200 so one long comment thread doesn't send a single
  oversized insert. These are what power the Comment Generator's Reply tab (see doc_generate_comment).
  The comment id/text/URL are each read through a short list of candidate field names
  (`readCommentId`/`readCommentText`/`readCommentUrl`) since HarvestAPI has renamed these before
  without warning — a run where every harvested comment comes back with no text logs a warning
  rather than silently storing blanks, since that shape means the actor's schema changed again, not
  that the post genuinely has empty comments.

### doc_search_keyword_leads
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    keyword: z.string().trim().min(2).max(200),
  })
  ```
- Success response (200):
  ```json
  { "data": { "keyword": "string", "total_items": number, "matched_leads": [{ "name": "string", "profileUrl": "string", "headline": "string", "postUrl": "string", "postExcerpt": "string", "postedAt": "string | null" }], "run_url": "string", "warning": "string | null" } }
  ```
- Error responses:
  - 400: Invalid input (keyword too short/long)
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message (e.g. Apify key not configured, Apify run failed)
  - 504: Search timed out (120s poll budget)
- Tables touched: None — this function only searches and returns a preview; it never writes to the database
- External calls: Apify (`harvestapi~linkedin-post-search` actor) — see Section 6.5
- Notes: Powers the Keyword Search page. Searches LinkedIn posts matching `keyword` from the past week
  (`postedLimit: "week"`), sorted by date, capped at 50 posts per search (`maxPosts: 50`) — these are
  hardcoded server-side, not client-controlled, same reasoning as doc_scrape_post_commenters hardcoding
  `maxItems`. Filters matched post authors against the same healthcare/physician keyword list used by
  doc_scrape_post_commenters (duplicated in this function, not shared — if you update one keyword list,
  update both). Because nothing is written to the database here, there's no RLS/org-scoping concern for
  this function itself; `org_id` is accepted for contract consistency with the app's other Apify-calling
  functions but isn't otherwise used. The frontend does the actual save as a plain authenticated
  `doc_contacts` upsert (`source: 'keyword_search'`), same pattern as AddContactDialog's manual-add insert.
  HarvestAPI's output schema wasn't visible in its public docs when this was first built (only the input
  schema was), so the initial field-name guesses were wrong in two ways — confirmed and fixed against
  HarvestAPI's own documented sample output: `postedAt` is an object (`{ date, timestamp, postedAgoText }`,
  not a plain string — the real ISO date is `postedAt.date`), and the author's headline is `author.info`,
  not `position`/`headline`. The wrong headline field meant the healthcare-keyword filter below could only
  ever match on the person's NAME, silently rejecting almost every real match — this is why early users saw
  very few results and "Invalid Date." `_debug_first_item` is still included in the response as a safety
  net if HarvestAPI changes their schema again.

### doc_enrich_emails
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    contact_ids: z.array(z.string().uuid()).min(1).max(50),
  })
  ```
- Success response (200):
  ```json
  { "data": { "requested": number, "found": number, "run_url": "string", "warning": "string | null" } }
  ```
- Error responses:
  - 400: Invalid input / no matching contacts
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message (e.g. Apify key not configured, Apify run failed)
  - 504: Search timed out (120s poll budget)
- Tables touched: doc_contacts (READ/WRITE — writes only the `email` column)
- External calls: Apify (`harvestapi~linkedin-profile-scraper` actor, `profileScraperMode: "Profile details + email search ($10 per 1k)"`) — see Section 6.5
- Notes: A second, separate Apify actor from the one used by `doc_scrape_post_commenters`. LinkedIn does
  not publish email addresses on profiles — this actor performs an independent search/verification
  (SMTP checks per vendor docs) and explicitly does not guarantee finding an email for every profile.
  Treat results as partial coverage, not a guarantee. Capped at 50 contacts per call to bound cost/time;
  callers must re-invoke for additional batches. Matches results back to contacts by normalized
  LinkedIn URL. Response includes `run_url` so a zero-result run can be inspected directly in Apify's
  console, same diagnostic pattern as `doc_scrape_post_commenters`.

### doc_enrich_emails_apollo
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    contact_ids: z.array(z.string().uuid()).min(1).max(20),
  })
  ```
- Success response (200):
  ```json
  { "data": { "requested": number, "found": number, "warning": "string | null" } }
  ```
- Error responses:
  - 400: Invalid input / no matching contacts
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message (e.g. Apollo key not configured)
- Tables touched: doc_contacts (READ/WRITE — writes only the `email` column)
- External calls: Apollo.io People Enrichment API — see Section 6.5
- Notes: A deliberate second attempt, separate from `doc_enrich_emails`, meant to be triggered manually
  on leads the first (Apify-based) search already came up empty on — never chained automatically, since
  Apollo credits are far scarcer (org's plan: 75/month) than the Apify-based tool's budget. Capped at 20
  contacts per call (vs. 50 for `doc_enrich_emails`) for the same reason. Calls the single-person
  enrichment endpoint once per contact sequentially (not the bulk endpoint) with a small delay between
  calls to stay under Apollo's rate limit; stops the batch early on a 429 rather than failing the whole
  request. `reveal_personal_emails: true` is required for Apollo to return an email at all — without it,
  the call succeeds but never includes contact info. Response parsing checks a couple of likely paths for
  the email field defensively, since the exact 200-response shape wasn't fully visible in Apollo's
  interactive docs when this was built — worth double-checking against a real response on first use.

### doc_generate_dm
- Method: POST
- Rate limit tier: expensive
- Input schema:
  ```typescript
  z.object({
    org_id: z.string().uuid(),
    my_last_reply: z.string().max(5000).optional(),
    their_last_reply: z.string().max(3000).optional(),
    new_topic: z.string().max(3000).optional(),
    lead_name: z.string().max(200).optional(),
    lead_bio: z.string().max(1000).optional(),
    lead_links: z.string().max(500).optional(),
  }).refine((d) => (d.my_last_reply && d.their_last_reply) || d.new_topic)
  ```
- Success response (200):
  ```json
  { "data": { "id": "uuid | null", "generated_content": "string" } }
  ```
- Tables touched: doc_organizations (READ, org_id existence check only — see Notes), doc_dm_drafts (WRITE, history log)
- External calls: OpenAI — see Section 6.5
- Notes: Used by both the DM Assistant page (one conversation at a time) and the Outreach page's
  personalized mode (one AI-drafted opener per selected lead, passing `lead_name`/`lead_bio` from
  `doc_contacts` and a generic `new_topic` prompt since there's no prior conversation). Requires
  either both reply fields (continuing a conversation) or `new_topic` (starting one). This function
  only ever drafts text — nothing is sent to LinkedIn from here or anywhere else in the app; see
  doc_outreach_messages and the Out of Scope section. Tone: always uses the hardcoded
  `ATIBA_PERSONA`/`ATIBA_HUMAN_STYLE_GUIDE`/`ATIBA_PERSPECTIVE_OVERRIDE` constants from
  `_shared/atiba-persona.ts` (shared with doc_generate_comment) — it no longer reads
  `doc_organizations.ai_system_prompt`. Reina asked for one permanent voice across every account
  rather than a per-account customizable one; see that file's header comment for the full history.

### doc_register
- Method: POST
- Rate limit tier: none — see "Known limitation" note below
- Auth: none (public, pre-account) — does NOT call requireAuth()
- Input schema:
  ```typescript
  z.object({
    email: z.string().trim().toLowerCase().email().max(255),
    password: z.string().min(8).max(72),
    name: z.string().trim().min(1).max(200).optional(),
  })
  ```
- Success response (200):
  ```json
  { "data": { "email": "string", "email_sent": boolean } }
  ```
- Error responses:
  - 400: Invalid input, or an account with this email already exists
  - 500: Sanitized message
- Tables touched: doc_organizations (WRITE, only if `name` given), doc_email_verifications (WRITE)
- External calls: Brevo — see Section 6.5
- Notes: Creates the auth user via `admin.createUser({ email_confirm: false })` — this does NOT
  trigger Supabase's own confirmation email (only the public `auth.signUp()` client call does that),
  so nothing is emailed until this function sends its own code via Brevo. `email_sent: false` in the
  response means the account WAS created but the email leg failed (see Rule 19 — these are separate
  outcomes) — the frontend tells the user to use "Resend Code." Known limitation: no IP-based
  throttling (the shared `rateLimit()` helper keys off an existing `auth.users.id`, which doesn't
  exist yet here) — if spam signups become a problem, add a CAPTCHA or an IP-keyed table rather than
  silently living with it.

### doc_verify_email
- Method: POST
- Rate limit tier: none (see doc_register's note — same limitation applies)
- Auth: none (public, pre-account) — does NOT call requireAuth()
- Input schema:
  ```typescript
  z.object({
    email: z.string().trim().toLowerCase().email(),
    code: z.string().trim().length(6),
  })
  ```
- Success response (200): `{ "data": { "verified": true } }`
- Error responses:
  - 400: No pending verification / code expired / incorrect code
  - 429: Too many incorrect attempts (capped at 5)
  - 500: Sanitized message
- Tables touched: doc_email_verifications (READ/WRITE/DELETE)
- Notes: On a correct code, flips `email_confirm` to true via `admin.updateUserById` and deletes the
  verification row (one-time use — replaying the same code afterward returns "no pending
  verification"). The frontend signs the user in immediately afterward with
  `signInWithPassword()`, using the password it already has in route state from Register.

### doc_resend_code
- Method: POST
- Rate limit tier: none — enforces its own 60s-per-email cooldown instead (see Notes)
- Auth: none (public, pre-account) — does NOT call requireAuth()
- Input schema: `z.object({ email: z.string().trim().toLowerCase().email() })`
- Success response (200): `{ "data": { "message": "string" } }` — same message whether or not the
  email actually has a pending registration
- Error responses:
  - 429: Cooldown not elapsed yet
  - 500: Sanitized message
- Tables touched: doc_email_verifications (READ/WRITE)
- External calls: Brevo — see Section 6.5
- Notes: Deliberately returns the identical generic response for both "email has a pending
  registration" and "no such pending registration," so this endpoint can't be used to enumerate
  which emails have registered. The 60-second cooldown is keyed off `updated_at` (refreshed every
  time a new code is generated) and exists specifically so this can't be used to spam someone's inbox.

## External Integrations

### Make.com (Integromat)
- Research source: https://www.make.com/en/help/tools/webhooks
- Base URL: `https://hook.us1.make.com/`
- Auth method: Webhook HMAC (Secret token in headers)
- Secret name: `MAKE_WEBHOOK_SECRET` (stored in Supabase Vault)
- Called from edge function(s): `doc_approve_comment`, `doc_daily_followups`
- Trigger: User action (Approval) / Scheduled
- Rate limit: Varies by Make plan (handle with async queuing)

**Outbound request shape:**
```typescript
const response = await fetch(`${BASE_URL}/your_webhook_id`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${Deno.env.get("MAKE_WEBHOOK_SECRET")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    event: "comment_approved",
    org_id: "uuid",
    post_url: "https://linkedin.com/...",
    comment_content: "Thank you for the insight...",
    contact_name: "Dr. Smith"
  }),
});
```

**Response handling:**
```typescript
if (response.status >= 500 || !response.ok) {
  // Log server-side with comment_id, status, and timestamp
  // Revert UI optimistic update gracefully. Do not crash app.
  throw new Error("Failed to post to LinkedIn. Click here to copy text.");
}
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Assume the credential is valid without checking response status
- Use any endpoint not listed above

### Apify (HarvestAPI linkedin-post-comments actor)
- Research source: https://apify.com/harvestapi/linkedin-post-comments/input-schema
- Base URL: `https://api.apify.com/v2/`
- Auth method: API token (query param `token`)
- Secret name: `APIFY_API_KEY` (stored in Supabase Vault)
- Called from edge function(s): `doc_scrape_post_commenters`
- Trigger: User action ("Scrape Commenters" button on Contacts page)
- Rate limit: Apify plan-dependent; app-side limited by the `expensive` rate limit tier (3/min)

**Outbound request shape (start run):**
```typescript
const runUrl = `https://api.apify.com/v2/acts/harvestapi~linkedin-post-comments/runs?token=${apifyToken}&waitForFinish=0`;
await fetch(runUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    posts: [postUrl],
    maxItems: 500,
    scrapeReplies: false,
    profileScraperMode: "short",
  }),
});
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Rename the `posts` / `maxItems` fields without checking the actor's current input schema first
  — an unrecognized field name fails silently (the run "succeeds" with 0 items) rather than erroring

### Apify (HarvestAPI linkedin-post-search actor — keyword lead search)
- Research source: https://apify.com/harvestapi/linkedin-post-search/input-schema
- Base URL: `https://api.apify.com/v2/`
- Auth method: same `APIFY_API_KEY` as the other two HarvestAPI actors, reused across all three
- Called from edge function(s): `doc_search_keyword_leads`
- Trigger: User action (typing a keyword and clicking "Search" on the Keyword Search page)
- Rate limit: Apify plan-dependent; app-side limited by the `expensive` rate limit tier

**Outbound request shape (start run):**
```typescript
const runUrl = `https://api.apify.com/v2/acts/harvestapi~linkedin-post-search/runs?token=${apifyToken}&waitForFinish=0`;
await fetch(runUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    searchQueries: [keyword],
    maxPosts: 50,
    postedLimit: "week",
    sortBy: "date",
    scrapeReactions: false,
    scrapeComments: false,
  }),
});
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Let `maxPosts`/`postedLimit` be set from client input — they're hardcoded server-side on purpose to
  bound cost per search
- Assume output field names without checking HarvestAPI's documented sample first — `postedAt` is a
  nested object (`postedAt.date` for the ISO string), and the author's headline is `author.info`, not
  `position`/`headline`. Getting this wrong the first time silently broke both the displayed date and the
  healthcare-relevance filter (see doc_search_keyword_leads' notes below) — `_debug_first_item` is logged
  in the response as a safety net if the schema ever changes again.

### Apify (HarvestAPI linkedin-profile-scraper actor — email enrichment)
- Research source: https://apify.com/harvestapi/linkedin-profile-scraper/api/openapi
- Base URL: `https://api.apify.com/v2/`
- Auth method: same `APIFY_API_KEY` as above, reused across both actors
- Called from edge function(s): `doc_enrich_emails`
- Trigger: User action ("Find Emails for Selected" button on Outreach page)
- Rate limit: Apify plan-dependent; app-side limited by the `expensive` rate limit tier

**Outbound request shape (start run):**
```typescript
const runUrl = `https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/runs?token=${apifyToken}&waitForFinish=0`;
await fetch(runUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    urls: [...profileUrls],
    // Exact enum string required by this actor's own schema — includes the price, unusually:
    profileScraperMode: "Profile details + email search ($10 per 1k)",
  }),
});
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Assume this will find an email for every profile — the vendor's own docs state it's not
  guaranteed; this is independent search/verification, not extraction of published data
- Change the `profileScraperMode` enum string without re-checking the actor's schema — it's
  matched exactly, price suffix included

### Apollo.io (People Enrichment API)
- Research source: https://docs.apollo.io/reference/authentication (auth) + https://docs.apollo.io/reference/people-enrichment (endpoint)
- Base URL: `https://api.apollo.io/api/v1/`
- Auth method: `x-api-key` header — NOT `Authorization: Bearer`. The People Enrichment doc page's
  interactive "Credentials: Bearer" label is generic UI chrome from their docs tool, not the actual
  requirement; the dedicated Authentication reference page is authoritative and confirms `x-api-key`.
  Got this wrong on the first build (every request 401'd) — fixed after checking the right page.
- Secret name: `APOLLO_API_KEY` (stored in Supabase Vault)
- Called from edge function(s): `doc_enrich_emails_apollo`
- Trigger: User action ("Try Apollo" button on Contacts page — deliberately separate from "Find Emails")
- Rate limit: Apollo plan-dependent (429 on excess); org's plan has 75 credits/month, so app-side this is
  used sparingly and capped at 20 contacts per call

**Outbound request shape:**
```typescript
const response = await fetch("https://api.apollo.io/api/v1/people/match", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": Deno.env.get("APOLLO_API_KEY")!,
  },
  body: JSON.stringify({
    linkedin_url: contact.linkedin_profile_url,
    reveal_personal_emails: true, // required — omitting this returns no contact info at all
  }),
});
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Use `run_waterfall_email`/`run_waterfall_phone` without also implementing the required webhook
  receiver — those parameters make the call asynchronous and need a public HTTPS callback URL,
  which isn't built yet. The current integration only uses the synchronous `reveal_personal_emails`
  path.
- Assume Apollo will find an email for every profile — same caveat as the Apify-based tool

### Brevo (transactional email — registration codes)
- Research source: https://developers.brevo.com/reference/sendtransacemail
- Base URL: `https://api.brevo.com/v3/`
- Auth method: API key in the `api-key` header (NOT `Authorization: Bearer`)
- Secret names: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL` (stored in Supabase Vault)
- Called from edge function(s): `doc_register`, `doc_resend_code`
- Trigger: User action (registering, or clicking "Resend Code")
- Rate limit: Brevo free plan — 300 emails/day, no expiry, no credit card required
- Why Brevo and not Resend/SendGrid: Resend requires verifying a domain you own before it will send
  to arbitrary recipients (its `onboarding@resend.dev` sender only delivers to the account owner's
  own address). SendGrid's free tier is now a time-limited trial, not permanent. Brevo's free plan
  sends to any recipient with only a single verified sender **email address** (no domain purchase or
  DNS needed) — the fit for a "$0, no domain" constraint.

**Outbound request shape:**
```typescript
const response = await fetch("https://api.brevo.com/v3/smtp/email", {
  method: "POST",
  headers: {
    "api-key": Deno.env.get("BREVO_API_KEY")!,
    "Content-Type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify({
    sender: { email: Deno.env.get("BREVO_SENDER_EMAIL")!, name: "DocEngage" },
    to: [{ email: recipientEmail }],
    subject: "Your DocEngage verification code",
    htmlContent: "<p>Your code is: 123456</p>",
  }),
});
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Assume delivery succeeded without checking `response.ok` — treat email send failure as a separate
  outcome from whatever database write already happened (Rule 19)

### OpenAI
- Research source: https://platform.openai.com/docs/api-reference/chat
- Base URL: `https://api.openai.com/v1/`
- Auth method: API Key
- Secret name: `OPENAI_API_KEY` (stored in Supabase Vault)
- Called from edge function(s): `doc_inbound_post`, `doc_process_tone`
- Trigger: Incoming webhook from Make / User tone upload
- Rate limit: Tier-dependent (handle 429 with exponential backoff)

**Outbound request shape:**
```typescript
const response = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [
      {"role": "system", "content": "You are a CEO. Tone: ..."},
      {"role": "user", "content": "Draft a LinkedIn comment for this post: ..."}
    ],
    temperature: 0.7
  }),
});
```

**Response handling:**
```typescript
if (response.status === 429) {
  // Retry 3 times with exponential backoff
}
if (response.status >= 500) {
  // Log server-side with status and timestamp
  // Save post to DB with comment status = 'generation_failed'
  // Return sanitized error: "AI draft unavailable - manual entry required"
}
```

**Never:**
- Call this API from the frontend
- Expose the credential in any response body or log
- Assume the credential is valid without checking response status
- Use any endpoint not listed above

## Environment Variables

### Frontend (.env)
| Variable | Purpose | Example |
|----------|---------|---------|
| VITE_SUPABASE_URL | Supabase project URL | https://xxx.supabase.co |
| VITE_SUPABASE_ANON_KEY | Public anon key (safe to expose) | eyJ... |

### Edge Functions (set via: supabase secrets set KEY=value)
| Variable | Purpose | Source |
|----------|---------|--------|
| SUPABASE_URL | Auto-set by Supabase runtime | Auto |
| SUPABASE_ANON_KEY | Auto-set by Supabase runtime | Auto |
| MAKE_WEBHOOK_SECRET | Make.com Webhook authentication | PRD Section 4 |
| OPENAI_API_KEY | OpenAI API authentication | PRD Section 4 |
| APIFY_API_KEY | Apify API authentication (lead scraper) | scripts/setup-integrations.md |
| APOLLO_API_KEY | Apollo.io API authentication (second-attempt email finder) | scripts/setup-integrations.md |
| BREVO_API_KEY | Brevo API authentication (registration verification emails) | scripts/setup-integrations.md |
| BREVO_SENDER_EMAIL | The email address verified as a sender in your Brevo account | scripts/setup-integrations.md |

### NEVER expose in frontend or edge function responses:
| Variable | Why |
|----------|-----|
| SUPABASE_SERVICE_ROLE_KEY | Bypasses all RLS — catastrophic if leaked |
| MAKE_WEBHOOK_SECRET | Exposes internal logic bridge |
| OPENAI_API_KEY | Exposes vendor credentials |
| APIFY_API_KEY | Exposes vendor credentials |
| APOLLO_API_KEY | Exposes vendor credentials |

## Auth Settings

- Signup: Public self-service registration is live (Register → emailed 6-digit code → Verify →
  auto sign-in), built via doc_register/doc_verify_email/doc_resend_code — see those functions'
  docs below. This goes through the **admin API** (`auth.admin.createUser`), which always works
  regardless of the dashboard's "Allow new signups" toggle — that toggle only gates the public
  `auth.signUp()` client call, which this app doesn't use for registration. So the toggle can stay
  in whatever state it was in; it's simply no longer the thing gating who can create an account.
- Providers: Email/password
- Email confirmation: **Must be ON** ("Confirm email" under Authentication → Providers → Email) —
  this is what actually blocks an unconfirmed account from signing in until doc_verify_email flips
  `email_confirm` to true. If this is OFF, newly registered accounts could sign in immediately
  without ever entering their code, defeating the whole verification step.
- JWT expiry: 1 hour
- Allowed redirect URLs:
  - http://localhost:5173 (development)
  - https://[production-domain] (production)
- Realtime: Enabled ONLY on `doc_comments` for the `status` column to allow UI to instantly remove comment from queue upon approval.

## Patterns

### New table migration
Every real table in this codebase is scoped through `org_id` + `doc_user_org_ids()`, not a
direct `user_id = auth.uid()` check (see "Account model" above for why — it keeps every
table's access rule routed through one single, auditable function instead of duplicating
the check everywhere). Follow this exact shape for any new table:

```sql
create table if not exists public.doc_example (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.doc_example enable row level security;

create policy "doc_example_select_org" on public.doc_example for select
  using (org_id in (select public.doc_user_org_ids()));
create policy "doc_example_insert_org" on public.doc_example for insert
  with check (user_id = auth.uid() and org_id in (select public.doc_user_org_ids()));
create policy "doc_example_update_org" on public.doc_example for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));
create policy "doc_example_delete_org" on public.doc_example for delete
  using (org_id in (select public.doc_user_org_ids()));

create index if not exists doc_example_user_id_idx on public.doc_example(user_id);
create index if not exists doc_example_org_id_idx on public.doc_example(org_id);

create trigger doc_example_updated_at
  before update on public.doc_example
  for each row execute function public.doc_handle_updated_at();
```

### New edge function skeleton
```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { rateLimit } from "../_shared/rate-limit.ts";
import { validateBody } from "../_shared/validate.ts";
import { safeError } from "../_shared/error-handler.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const schema = z.object({
  example_field: z.string().min(1)
});

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  
  try {
    const user = await requireAuth(req);
    await rateLimit(user.id, "write");
    const body = await validateBody(req, schema);

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    const { data, error } = await supabaseClient
      .from("doc_example")
      .insert({ org_id: user.user_metadata.org_id, status: body.example_field })
      .select()
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({ data }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    return safeError(error);
  }
});
```

### New storage bucket
```sql
insert into storage.buckets (id, name, public)
values ('doc_example_uploads', 'doc_example_uploads', false)
on conflict (id) do nothing;

create policy "doc_example_uploads_select_own" on storage.objects for select using (bucket_id = 'doc_example_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_example_uploads_insert_own" on storage.objects for insert with check (bucket_id = 'doc_example_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_example_uploads_update_own" on storage.objects for update using (bucket_id = 'doc_example_uploads' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'doc_example_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_example_uploads_delete_own" on storage.objects for delete using (bucket_id = 'doc_example_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
```

### Query pattern (read)
```typescript
const { data, error } = await supabase
  .from("doc_comments")
  .select("id, status, generated_content, created_at")
  .eq("status", "pending")
  .order("created_at", { ascending: false });
```

### Query pattern (insert — never pass user_id from client)
```typescript
const { data, error } = await supabase
  .from("doc_posts")
  .insert({ 
    org_id: currentOrgId, 
    linkedin_post_url: "https://...", 
    author_name: "John" 
  })
  .select("id, author_name")
  .single();
```

### File processing failure pattern
```typescript
// When external processing fails after successful storage:
await supabase
  .from("doc_tone_samples")
  .update({
    processing_status: "failed",
    extracted_text: `Whisper error: ${responseCode} at ${new Date().toISOString()}`,
  })
  .eq("id", sampleId);

// Log for debugging — never expose to client
console.error("doc_tone_samples processing failure", {
  record_id: sampleId,
  file_path: filePath,
  service: "OpenAI Whisper",
  status_code: responseCode,
  timestamp: new Date().toISOString(),
});

// Return to client — sanitized
return safeError(500, "Transcription failed. Your media has been saved — please retry.");
// NOTE: Never delete the file. Never return the raw error.
```

## Testing

### Security tests (abuse-test.ts)
The base abuse test from security templates covers:
- Cross-user read/write/update/delete isolation
- JWT bypass (missing, invalid, expired)
- Rate limit triggering
- Input validation rejection

### Project-specific tests to ADD:
For each user-data table:
- User A cannot SELECT `doc_posts` belonging to User B.
- User A cannot UPDATE a comment ID belonging to User B.
- User A cannot trigger `doc_process_tone` for a `sample_id` outside their own account.

For each edge function:
- `doc_approve_comment` rejects missing JWT (→ 401).
- `doc_inbound_post` rejects requests with invalid `secret_token` (→ 401).
- `doc_approve_comment` rejects `edited_content` > 3000 chars (→ 400).
- `doc_inbound_post` gracefully handles missing `author_name` (defaults to "Author").

Business logic tests:
- Double-Approval Replay: Submitting `doc_approve_comment` twice for the same `comment_id` must only trigger the Make.com webhook ONCE. Function must check `status = 'pending'` before proceeding.
- Account isolation: User A cannot change User B's `auto_post_enabled` boolean in `doc_organizations` (no roles exist anymore — every account is simply its own owner, see "Account model" above).

### Running tests locally
```bash
supabase start
supabase functions serve &
SUPABASE_URL=http://localhost:54321 \
SUPABASE_ANON_KEY=[local-anon-key] \
SUPABASE_SERVICE_ROLE_KEY=[local-service-role-key] \
  deno test --allow-net --allow-env tests/abuse-test.ts
```

### Test Credentials

All test credentials are stored in `.env.test` at the project root.
This file is gitignored and must never be committed.
`.env.test.example` is committed and shows the required variable names
with empty values.

**Before running any Playwright or abuse tests that require authentication:**
1. Check whether `.env.test` exists
2. If it exists, Playwright reads it automatically — no extra config needed
3. If it does not exist:
   - Copy `.env.test.example` to `.env.test`
   - Run `node scripts/create-test-users.mjs` to create the accounts
   - STOP and ask the user to confirm accounts were created before
     proceeding with auth-dependent tests

**Playwright config — load `.env.test` automatically:**
```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';

config({ path: '.env.test' });

export default defineConfig({
  use: {
    baseURL: process.env.VITE_APP_URL ?? 'http://localhost:5173',
  },
});
```

**Using credentials in tests:**
```typescript
// tests/auth.setup.ts
import { test as setup } from '@playwright/test';

setup('authenticate as owner', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name=email]', process.env.TEST_OWNER_EMAIL!);
  await page.fill('[name=password]', process.env.TEST_OWNER_PASSWORD!);
  await page.click('[type=submit]');
  await page.context().storageState({ path: 'tests/.auth/owner.json' });
});
```

**Never:**
- Hardcode credentials in test files
- Commit `.env.test`
- Invent credentials and proceed without confirmation

## Out of Scope — Do NOT implement

- Direct LinkedIn API Integration — Completely excluded. Bypassing Make.com to communicate directly with LinkedIn from Supabase edge functions is out of scope due to anti-automation protections.
- Direct Google Sheets API connection — Excluded. We route all sheet logging through the Make.com webhooks to adhere to the visual automation constraint.
- Native Mobile App — Out of scope. Desktop-first web dashboard only.
- Complex multi-step conversation AI — The AI writes a single comment. Back-and-forth automated DM chatting is excluded from v1 to prevent sounding like spam.
- Billing and Subscription Management — Out of scope for this internal-first phase.

Standard exclusions always present:
- Admin dashboard or service_role-based tooling
- Direct database connections or ETL pipelines
- Custom auth flows (use Supabase Auth as-is)
- Any integration not specified in Section 6.5 of this document
```"

## Supabase Operations

### Prerequisites
- Supabase CLI installed globally (`npx supabase` v2.78.1+)
- Project linked via `supabase/config.toml` (`project_id = "uslpzebjkvnabtuaqrmi"`)
- `.env` contains all required keys (see below)

### Environment Variables in `.env`
| Variable | Purpose |
|----------|---------|
| `VITE_SUPABASE_URL` | Supabase project URL (used by frontend) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Anon key (used by frontend — safe to expose) |
| `VITE_SUPABASE_PROJECT_ID` | Project ref ID |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS — for local admin scripts ONLY. NEVER used in edge functions or application code. |
| `SUPABASE_ACCESS_TOKEN` | Personal access token for Supabase CLI commands |

### CLI Commands (always source .env first)
The Supabase CLI does NOT auto-read `.env`. Always source it first:
```bash
source .env

# Deploy a single edge function
npx supabase functions deploy <function-name> --project-ref $VITE_SUPABASE_PROJECT_ID

# Deploy ALL edge functions
npx supabase functions deploy --project-ref $VITE_SUPABASE_PROJECT_ID

# Push local migrations to remote database
npx supabase db push --project-ref $VITE_SUPABASE_PROJECT_ID

# Check migration status
npx supabase migration list --project-ref $VITE_SUPABASE_PROJECT_ID

# List deployed edge functions
npx supabase functions list --project-ref $VITE_SUPABASE_PROJECT_ID
```

### Admin Scripts (Node.js — local use only)
For admin operations (creating test users, seeding data), write Node.js
scripts in `scripts/`. These use the service role key and bypass RLS.
NEVER deploy these scripts or call them from edge functions.
```js
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
config({ path: '.env' });

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // bypasses RLS — local admin only
);
```

Run with: `node scripts/<script-name>.mjs`

### Edge Function Secrets
```bash
npx supabase secrets set KEY=value --project-ref $VITE_SUPABASE_PROJECT_ID
npx supabase secrets list --project-ref $VITE_SUPABASE_PROJECT_ID
```