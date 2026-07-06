"```markdown
# DocEngage

Prefix: doc_
Architecture type: Dashboard
Single-user: no
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

## Rules

1. NEVER use the service_role key in application code. It exists only in
   test scripts and isolated admin functions (like `doc_daily_followups`).

2. NEVER accept user_id from request bodies, query parameters, headers,
   or any client-provided source. User identity is ALWAYS derived from the
   JWT via auth.uid() (database) or requireAuth() (edge functions).

3. NEVER create a table without enabling RLS and adding all four policies
   (SELECT, INSERT, UPDATE, DELETE) scoped to org membership via
   doc_user_org_ids(). INSERT policies must also enforce user_id = auth.uid().

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

### Deployment
- docs/deployment/MANUAL_SQL_OPERATIONS.md  → Manual SQL that must be run
                                               per environment before deploying

### Edge Functions
- supabase/functions/doc_inbound_post/index.ts    → Receives post from Make, triggers OpenAI, saves to DB
- supabase/functions/doc_approve_comment/index.ts → Approves comment, triggers Make webhook to post
- supabase/functions/doc_process_tone/index.ts    → Processes media via Whisper, updates org system prompt
- supabase/functions/doc_daily_followups/index.ts → Cron job pushing stale contacts to Make.com
- supabase/functions/doc_invite_member/index.ts  → Invites user to org (admin/owner only, uses service_role)
- supabase/functions/doc_scrape_post_commenters/index.ts → Lead scraper: pulls LinkedIn post commenters via Apify (HarvestAPI actor), filters for healthcare keywords, upserts doc_contacts

### Frontend
- src/pages/Dashboard.tsx     → Centralized queue of pending AI comments
- src/pages/Contacts.tsx      → CRM pipeline of doctors identified
- src/pages/Settings.tsx      → Org settings, tone samples, AI prompts
- src/pages/DmAssistant.tsx   → AI-drafted DM replies/openers for one conversation at a time, backed by doc_dm_drafts history
- src/pages/Leads.tsx         → Manual notes-based lead list (name/bio/links) feeding DM Assistant context, backed by doc_dm_leads
- src/pages/Outreach.tsx      → Bulk/personalized LinkedIn outreach: pick doc_contacts or upload CSV/Excel, draft messages, assisted-send (copies message + opens LinkedIn — never sends automatically, per Out of Scope section), logs to doc_outreach_messages
- src/components/QueueItem.tsx→ Comment review UI card with optimistic updates

### Scripts
- scripts/setup-integrations.md → Step-by-step credential setup for external integrations

### Tests
- tests/abuse-test.ts → Cross-user security tests

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

### doc_organizations
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| name | text | not null |
| auto_post_enabled | boolean | not null, default false |
| ai_system_prompt | text | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_organizations_select_member (org membership), doc_organizations_insert_auth (creator), doc_organizations_update_owner (owner only), doc_organizations_delete_owner (owner only)
Indexes: doc_organizations_user_id_idx

### doc_organization_members
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| role | text | not null, default 'member', check in ('owner', 'admin', 'member') |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_organization_members_select_org (see members of your orgs), doc_organization_members_insert_admin (owner/admin only), doc_organization_members_update_admin (owner/admin only), doc_organization_members_delete_admin (owner/admin only)
Indexes: doc_organization_members_user_id_idx, doc_organization_members_org_id_idx

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

Policies: doc_posts_select_org, doc_posts_insert_org, doc_posts_update_org, doc_posts_delete_org (all scoped to org membership)
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
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_comments_select_org, doc_comments_insert_org, doc_comments_update_org, doc_comments_delete_org (all scoped to org membership)
Indexes: doc_comments_user_id_idx, doc_comments_post_id_idx, doc_comments_org_id_idx, doc_comments_status_idx, doc_comments_org_status_idx
Realtime: Enabled ONLY for `status` column

### doc_contacts
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| linkedin_profile_url | text | not null |
| full_name | text | not null |
| status | text | not null, default 'no_action', check in ('no_action', 'connected', 'replied') |
| last_contacted_at | timestamptz | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_contacts_select_org, doc_contacts_insert_org, doc_contacts_update_org, doc_contacts_delete_org (all scoped to org membership)
Indexes: doc_contacts_user_id_idx, doc_contacts_org_id_idx, doc_contacts_status_idx, doc_contacts_org_status_idx

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

Policies: doc_tone_samples_select_org, doc_tone_samples_insert_org, doc_tone_samples_update_org, doc_tone_samples_delete_org (all scoped to org membership)
Indexes: doc_tone_samples_user_id_idx, doc_tone_samples_org_id_idx

### doc_dm_leads
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| name | text | not null |
| bio | text | |
| links | text | |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), auto-trigger |

Policies: doc_dm_leads_select_org, doc_dm_leads_insert_org, doc_dm_leads_update_org, doc_dm_leads_delete_org (all scoped to org membership)
Indexes: doc_dm_leads_org_id_idx, doc_dm_leads_org_name_idx

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

Policies: doc_dm_drafts_select_org, doc_dm_drafts_insert_org, doc_dm_drafts_update_org, doc_dm_drafts_delete_org (all scoped to org membership)
Indexes: doc_dm_drafts_user_id_idx, doc_dm_drafts_org_id_idx, doc_dm_drafts_org_created_idx
Notes: History auto-pruned to entries newer than 5 days by the DM Assistant UI on each load.

### doc_outreach_messages
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK → auth.users, not null, default auth.uid() |
| org_id | uuid | FK → doc_organizations, not null |
| contact_id | uuid | FK → doc_contacts, not null, on delete cascade |
| message_content | text | not null |
| sent_at | timestamptz | not null, default now() |
| created_at | timestamptz | not null, default now() |

Policies: doc_outreach_messages_select_org, doc_outreach_messages_insert_org, doc_outreach_messages_update_org, doc_outreach_messages_delete_org (all scoped to org membership)
Indexes: doc_outreach_messages_org_id_idx, doc_outreach_messages_contact_id_idx, doc_outreach_messages_user_id_idx, doc_outreach_messages_contact_sent_idx
Notes: Logs what was sent via the Outreach page's assisted-send flow (copy message + open LinkedIn manually). Written client-side after the user confirms they sent the message — the app never sends anything to LinkedIn itself, per the Out of Scope section.

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
    author_name: z.string(),
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
- External calls: OpenAI — see Section 6.5
- Notes: Validates `secret_token` against `MAKE_WEBHOOK_SECRET` via constant-time comparison. Extracts author info to construct AI prompt. Checks `auto_post_enabled` in `doc_organizations`. If true, bypasses manual queue (status='approved') and triggers outbound Make webhook. Idempotent: Skips generation if `linkedin_post_url` exists. If OpenAI fails, inserts post but leaves comment blank with `generation_failed` status.

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
  { "data": { "total_items": number, "total_engagers": number, "doctors_found": number, "contacts_saved": number, "run_url": "string", "warning": "string | null" } }
  ```
- Error responses:
  - 400: Invalid input
  - 401: Missing/invalid JWT
  - 429: Rate limit exceeded
  - 500: Sanitized message (e.g. Apify key not configured, Apify run failed)
  - 504: Scraping timed out (120s poll budget)
- Tables touched: doc_contacts (WRITE)
- External calls: Apify (`harvestapi~linkedin-post-comments` actor) — see Section 6.5
- Notes: Starts an Apify actor run, polls up to 120s for completion, fetches the resulting dataset,
  filters commenters against a healthcare-keyword list, and upserts matches into `doc_contacts`
  (`onConflict: org_id,linkedin_profile_url`, `ignoreDuplicates: true`) so re-scraping the same
  post is safe. Because this actor scrapes without LinkedIn login, LinkedIn can soft-block it and
  return a "successful" run with 0 items — the response includes `run_url` and a `warning` string
  so this is visible in the UI instead of silently returning zero saved leads.

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
- Tables touched: doc_organizations (READ, for ai_system_prompt), doc_dm_drafts (WRITE, history log)
- External calls: OpenAI — see Section 6.5
- Notes: Used by both the DM Assistant page (one conversation at a time) and the Outreach page's
  personalized mode (one AI-drafted opener per selected lead, passing `lead_name`/`lead_bio` from
  `doc_contacts` and a generic `new_topic` prompt since there's no prior conversation). Requires
  either both reply fields (continuing a conversation) or `new_topic` (starting one). This function
  only ever drafts text — nothing is sent to LinkedIn from here or anywhere else in the app; see
  doc_outreach_messages and the Out of Scope section.

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

### NEVER expose in frontend or edge function responses:
| Variable | Why |
|----------|-----|
| SUPABASE_SERVICE_ROLE_KEY | Bypasses all RLS — catastrophic if leaked |
| MAKE_WEBHOOK_SECRET | Exposes internal logic bridge |
| OPENAI_API_KEY | Exposes vendor credentials |
| APIFY_API_KEY | Exposes vendor credentials |

## Auth Settings

- Signup: Disabled after first account creation (members invited via admin.auth API).
- Providers: Email/password
- Email confirmation: Required in production, optional in dev
- JWT expiry: 1 hour
- Allowed redirect URLs:
  - http://localhost:5173 (development)
  - https://[production-domain] (production)
- Realtime: Enabled ONLY on `doc_comments` for the `status` column to allow UI to instantly remove comment from queue upon approval.

## Patterns

### New table migration
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

create policy "doc_example_select_own" on public.doc_example for select using (user_id = auth.uid());
create policy "doc_example_insert_own" on public.doc_example for insert with check (user_id = auth.uid());
create policy "doc_example_update_own" on public.doc_example for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_example_delete_own" on public.doc_example for delete using (user_id = auth.uid());

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
- User A (Org 1) cannot SELECT `doc_posts` belonging to Org 2.
- User A cannot UPDATE a comment ID belonging to Org 2.
- User A cannot trigger `doc_process_tone` for a `sample_id` outside their org.

For each edge function:
- `doc_approve_comment` rejects missing JWT (→ 401).
- `doc_inbound_post` rejects requests with invalid `secret_token` (→ 401).
- `doc_approve_comment` rejects `edited_content` > 3000 chars (→ 400).
- `doc_inbound_post` gracefully handles missing `author_name` (defaults to "Author").

Business logic tests:
- Double-Approval Replay: Submitting `doc_approve_comment` twice for the same `comment_id` must only trigger the Make.com webhook ONCE. Function must check `status = 'pending'` before proceeding.
- Privilege Escalation: A user with role `member` cannot change the `auto_post_enabled` boolean in `doc_organizations`.

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