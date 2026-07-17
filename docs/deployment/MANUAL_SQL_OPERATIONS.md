# Manual SQL Operations

SQL operations that must be run manually in the Supabase SQL Editor per environment
before deploying. Check each item after running it.

## Right now (pending as of 2026-07-17)

Your production project already has migrations through `009_outreach_messages.sql` applied
(you've already created your org via a manual insert, and `doc_outreach_messages` exists in its
original shape). What's still outstanding before the Scraped/Engaged/Manual/Outreach restructuring
will work:

- [ ] Run `supabase/migrations/010_unify_lead_sources.sql` (see full SQL below) — adds `source` to
  `doc_contacts`, adds `status`/`linkedin_profile_url`/`last_contacted_at` to `doc_dm_leads`, and
  makes `doc_outreach_messages.contact_id` nullable + adds `dm_lead_id`. **Without this, Scraped
  Leads, Manual Added Leads, and Outreach will fail to load with a "column does not exist" error**
  (the app now surfaces this as a toast instead of a blank screen, but it'll still be broken).
- [ ] Deploy edge functions (see "Deploy edge functions" below) — `doc_enrich_emails` and
  `doc_enrich_emails_apollo` are new since your last deploy, and `doc_scrape_post_commenters` /
  `doc_inbound_post` had fixes this session.
- [ ] Confirm `APOLLO_API_KEY` secret is set if you want "Try Apollo" to work.
- [ ] Redeploy the frontend (`dist` folder) to Netlify — the version currently live predates the
  SPA reload fix (`_redirects`) and the white-screen hardening.

### Migration 010 — paste this into the SQL Editor

```sql
begin;

-- 1. doc_contacts.source
alter table public.doc_contacts
  add column if not exists source text not null default 'scraped'
    check (source in ('scraped', 'manual'));

create index if not exists doc_contacts_source_idx on public.doc_contacts(source);

-- 2. doc_dm_leads gains a status pipeline + structured LinkedIn URL
alter table public.doc_dm_leads
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'messaged', 'engaged'));

alter table public.doc_dm_leads
  add column if not exists linkedin_profile_url text;

alter table public.doc_dm_leads
  add column if not exists last_contacted_at timestamptz;

create index if not exists doc_dm_leads_status_idx on public.doc_dm_leads(status);
create index if not exists doc_dm_leads_org_status_idx on public.doc_dm_leads(org_id, status);

-- 3. doc_outreach_messages — support logging against either source table
alter table public.doc_outreach_messages
  alter column contact_id drop not null;

alter table public.doc_outreach_messages
  add column if not exists dm_lead_id uuid references public.doc_dm_leads(id) on delete cascade;

alter table public.doc_outreach_messages
  drop constraint if exists doc_outreach_messages_exactly_one_target;

alter table public.doc_outreach_messages
  add constraint doc_outreach_messages_exactly_one_target
    check (
      (contact_id is not null and dm_lead_id is null)
      or (contact_id is null and dm_lead_id is not null)
    );

create index if not exists doc_outreach_messages_dm_lead_id_idx on public.doc_outreach_messages(dm_lead_id);

commit;
```

This is safe to run even if partially applied already — every step uses `if not exists` / `if
exists` guards.

### Verify it worked

```sql
select column_name from information_schema.columns
where table_name = 'doc_contacts' and column_name = 'source';

select column_name from information_schema.columns
where table_name = 'doc_dm_leads' and column_name in ('status', 'linkedin_profile_url', 'last_contacted_at');

select column_name, is_nullable from information_schema.columns
where table_name = 'doc_outreach_messages' and column_name in ('contact_id', 'dm_lead_id');
```

You should see `source` returned from the first query, all three columns from the second, and
`contact_id`/`dm_lead_id` both `is_nullable = YES` from the third.

## Deploy edge functions

Run these from the project root on your own machine (not in this chat — CLI auth tokens should
never be pasted into chat):

```bash
source .env
npx supabase functions deploy doc_enrich_emails --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_enrich_emails_apollo --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_scrape_post_commenters --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_inbound_post --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_approve_comment --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_process_tone --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_generate_comment --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_generate_dm --project-ref ijyhyozksijymweikkrm
npx supabase functions deploy doc_invite_member --project-ref ijyhyozksijymweikkrm
```

Or deploy everything at once: `npx supabase functions deploy --project-ref ijyhyozksijymweikkrm`

Note: `doc_daily_followups` is documented but not yet built (no `supabase/functions/doc_daily_followups/`
directory exists) — skip it, there's nothing to deploy.

### Verify secrets are set

```bash
npx supabase secrets list --project-ref ijyhyozksijymweikkrm
```

You should see `MAKE_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `APIFY_API_KEY`, and `APOLLO_API_KEY`. If
`APOLLO_API_KEY` is missing, "Try Apollo" will fail with a sanitized 500 — set it with:

```bash
npx supabase secrets set APOLLO_API_KEY="<your-apollo-key>" --project-ref ijyhyozksijymweikkrm
```

## Deploy the frontend (Netlify, manual drag-and-drop)

1. On your machine, in the project folder: `npm run build` (or use the `dist` folder already built
   for you — check it has a `_redirects` file inside; if not, rebuild).
2. Go to your Netlify site's dashboard → **Deploys** tab.
3. Drag the entire `dist` folder onto the deploy area (drop the folder itself, not a zip, not just
   its contents dragged individually — Netlify needs `index.html` at the root of what you drop).
4. Wait for "Published."

If Netlify is instead connected to GitHub for automatic builds, you also need to add
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under **Site settings → Environment variables** —
without them, the build produces a broken bundle (this was one of the causes of the white screen).

## Post-deploy verification checklist

- [ ] Load the site fresh (not from cache) and confirm it renders — not blank.
- [ ] Click every nav item once: Comments, DM Assistant, Engaged Leads, Scraped Leads, Manual
  Added, Outreach, Settings.
- [ ] On at least 2 of those pages, hit browser reload (F5) while on that page — should NOT 404 or
  go blank.
- [ ] Add a lead via "Add Lead" on the Manual Added Leads page, confirm it appears, then confirm it
  also shows up in the Outreach page under the "Manual Added" filter.
- [ ] Change a lead's status on one page (e.g. Outreach) and confirm it updates on the page it
  originated from (e.g. Scraped Leads or Engaged Leads) without a manual refresh.

## Production (original checklist — already applied)

- [x] Run `supabase/migrations/001_initial_schema.sql` through `009_outreach_messages.sql`
- [ ] Run `supabase/migrations/010_unify_lead_sources.sql` — see above
- [ ] Verify RLS is enabled on all `doc_*` tables:
  ```sql
  select tablename, rowsecurity
  from pg_tables
  where schemaname = 'public' and tablename like 'doc_%';
  ```
  All rows must show `rowsecurity = true`.
- [ ] Verify no policies reference `user_id = auth.uid()` directly (they should use `doc_user_org_ids()`):
  ```sql
  select policyname, qual
  from pg_policies
  where tablename like 'doc_%'
    and qual::text like '%user_id = auth.uid()%';
  ```
  Only `doc_organizations_insert_auth`, `doc_organizations_update_owner`, and `doc_organizations_delete_owner` should appear (these are intentionally owner-scoped).
- [ ] Verify storage bucket is private:
  ```sql
  select id, public from storage.buckets where id = 'doc_tone_uploads';
  ```
  Must show `public = false`.
- [ ] Verify Realtime is enabled only on `doc_comments`:
  ```sql
  select * from pg_publication_tables where pubname = 'supabase_realtime';
  ```
  Only `doc_comments` should be listed.
- [ ] Set Supabase secrets:
  ```bash
  supabase secrets set MAKE_WEBHOOK_SECRET="..." --project-ref ijyhyozksijymweikkrm
  supabase secrets set MAKE_WEBHOOK_ID="..." --project-ref ijyhyozksijymweikkrm
  supabase secrets set OPENAI_API_KEY="..." --project-ref ijyhyozksijymweikkrm
  supabase secrets set APIFY_API_KEY="..." --project-ref ijyhyozksijymweikkrm
  supabase secrets set APOLLO_API_KEY="..." --project-ref ijyhyozksijymweikkrm
  ```
- [ ] Deploy edge functions — see "Deploy edge functions" above
- [ ] Create initial owner account in Supabase Auth dashboard (public signup is disabled)
- [ ] Create initial organization and owner membership record (already done via manual insert)
- [ ] Disable public signup in Auth settings (Settings > Auth > User Signups > disable)
- [ ] Verify end-to-end: send a test webhook from Make.com and confirm the comment appears in the queue

## Staging

- [ ] Same as production checklist above
- [ ] Additionally: run `supabase/seed.sql` to populate test data
- [ ] Create test auth users (User A, B, C) via Supabase Auth dashboard matching seed UUIDs
- [ ] Run abuse tests:
  ```bash
  SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
    deno test --allow-net --allow-env tests/abuse-test.ts
  ```
- [ ] All abuse tests pass

## Local Development

- [ ] `supabase start`
- [ ] `supabase db push` (applies all migrations)
- [ ] Seed is auto-applied if configured, or run manually: `psql $DB_URL -f supabase/seed.sql`
- [ ] Create test auth users:
  ```bash
  # User A
  curl -X POST "http://localhost:54321/auth/v1/admin/users" \
    -H "apikey: <SERVICE_ROLE_KEY>" \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"email":"usera@test.com","password":"test123!","email_confirm":true,"id":"11111111-1111-1111-1111-111111111111"}'

  # User B
  curl -X POST "http://localhost:54321/auth/v1/admin/users" \
    -H "apikey: <SERVICE_ROLE_KEY>" \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"email":"userb@test.com","password":"test123!","email_confirm":true,"id":"22222222-2222-2222-2222-222222222222"}'

  # User C
  curl -X POST "http://localhost:54321/auth/v1/admin/users" \
    -H "apikey: <SERVICE_ROLE_KEY>" \
    -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
    -H "Content-Type: application/json" \
    -d '{"email":"userc@test.com","password":"test123!","email_confirm":true,"id":"33333333-3333-3333-3333-333333333333"}'
  ```
- [ ] Set edge function secrets: see `scripts/setup-integrations.md`
- [ ] `supabase functions serve` to run edge functions locally
