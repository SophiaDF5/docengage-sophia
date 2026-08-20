# Manual SQL Operations

SQL operations that must be run manually in the Supabase SQL Editor per environment
before deploying. Check each item after running it.

## Right now (pending as of 2026-08-19, updated)

Migrations 010–013 should already be applied (the app has been running features that depend on
them — tags, custom fields, account isolation — since mid-July). Two new migrations are pending —
run both, in order, in one SQL Editor session:

- [ ] **Migration 014** — adds a `tag` column to `doc_dm_leads` (Engaged Leads), matching the one
  `doc_contacts` already has. General freeform tag support (e.g. "YouTube") — not used for
  "Invited" (see migration 015). See its section below.
- [ ] **Migration 015** — adds `'invited'` as a fourth status value (pending → invited → messaged
  → engaged) on both `doc_contacts` and `doc_dm_leads`. Without this, picking "Invited" from the
  Status dropdown on Scraped/Manual/Engaged Leads, or filtering by it on Outreach, will fail with a
  database constraint error. See its section below.
- [ ] Redeploy the frontend (`dist` folder) to Netlify after running both — that's the only other
  step, no edge functions changed.

<details>
<summary>Migrations 010–013 (should already be applied — expand only if you're not sure)</summary>

Your production project originally had migrations through `009_outreach_messages.sql` applied. If
you're setting up a fresh environment or aren't sure these ran, run the
following four migrations **in this exact order**, in one SQL Editor session, then deploy edge
functions and the frontend:

- [ ] **Migration 010** — adds `source` to `doc_contacts`, adds `status`/`linkedin_profile_url`/
  `last_contacted_at` to `doc_dm_leads`, makes `doc_outreach_messages.contact_id` nullable + adds
  `dm_lead_id`. Without this, Scraped Leads, Manual Added Leads, and Outreach fail to load.
- [ ] **Migration 011** — adds a `custom_fields` column (freeform per-lead info — job title,
  company, etc.) to `doc_contacts` and `doc_dm_leads`.
- [ ] **Migration 012 — biggest one: removes the organization/team concept entirely.** Every
  login becomes its own fully isolated account — no org switching, no inviting teammates, no
  roles. Check for duplicate account rows first (see below) before running this one.
- [ ] **Migration 013** — adds a `tag` column to `doc_contacts` (freeform label like "YouTube" set
  when uploading/adding a lead). Without this, the Manual Added Leads page's upload dialog and
  filter chips fail.
- [ ] Deploy edge functions (see "Deploy edge functions" below) — `doc_enrich_emails` and
  `doc_enrich_emails_apollo` are new since your last deploy, `doc_scrape_post_commenters` /
  `doc_inbound_post` had fixes, and `doc_invite_member` was deleted.
- [ ] Confirm `APOLLO_API_KEY` secret is set if you want "Try Apollo" to work.
- [ ] Redeploy the frontend (`dist` folder) to Netlify — the version currently live predates the
  SPA reload fix, the white-screen hardening, the account-model change, and the lead-tag/upload
  relocation (CSV/Excel upload moved from Outreach to Manual Added Leads).

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

### Migration 011 — paste this into the SQL Editor, right after 010

```sql
begin;

alter table public.doc_contacts
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.doc_dm_leads
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

commit;
```

Verify with:
```sql
select column_name from information_schema.columns
where table_name = 'doc_contacts' and column_name = 'custom_fields';
```

### Migration 012 — paste this into the SQL Editor, right after 011

**First, check for duplicate account rows** — your earlier SQL Editor history created more than
one `doc_organizations` row under your account at different points:

```sql
select user_id, count(*) as row_count, array_agg(id) as org_ids
from doc_organizations
group by user_id
having count(*) > 1;
```

If this returns a row, migration 012 still works fine (it never deletes anything), but going
forward the app assumes one account = one org. Pick which `id` is the one you're actually using
(check which one your app currently shows data for), and once migration 012 is applied you can
inspect and clean up the extra row(s):

```sql
-- inspect what's attached to a specific extra org_id before deleting it
select 'doc_posts' as tbl, count(*) from doc_posts where org_id = '<extra-org-id>'
union all select 'doc_contacts', count(*) from doc_contacts where org_id = '<extra-org-id>'
union all select 'doc_dm_leads', count(*) from doc_dm_leads where org_id = '<extra-org-id>';

-- only once you've confirmed it's empty/unwanted:
-- delete from doc_organizations where id = '<extra-org-id>';
```

Now run migration 012 itself:

```sql
begin;

insert into public.doc_organizations (user_id, name)
select u.id, 'My Account'
from auth.users u
left join public.doc_organizations o on o.user_id = u.id
where o.id is null;

create or replace function public.doc_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.doc_organizations (user_id, name)
  values (new.id, 'My Account')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists doc_on_auth_user_created on auth.users;
create trigger doc_on_auth_user_created
  after insert on auth.users
  for each row execute function public.doc_handle_new_user();

create or replace function public.doc_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.doc_organizations where user_id = auth.uid();
$$;

drop table if exists public.doc_organization_members;
drop function if exists public.doc_user_is_org_admin(uuid);

commit;
```

Verify it worked:

```sql
select count(*) from doc_organizations where user_id = auth.uid();
-- should return 1 (or more, only if you have duplicates you haven't cleaned up yet)

select tgname from pg_trigger where tgname = 'doc_on_auth_user_created';
-- should return one row
```

### Migration 013 — paste this into the SQL Editor, right after 012

```sql
begin;

alter table public.doc_contacts
  add column if not exists tag text;

create index if not exists doc_contacts_tag_idx on public.doc_contacts(tag);

commit;
```

Verify with:
```sql
select column_name from information_schema.columns
where table_name = 'doc_contacts' and column_name = 'tag';
```

</details>

### Migration 014 — paste this into the SQL Editor

```sql
begin;

alter table public.doc_dm_leads
  add column if not exists tag text;

create index if not exists doc_dm_leads_tag_idx on public.doc_dm_leads(tag);

commit;
```

Verify with:
```sql
select column_name from information_schema.columns
where table_name = 'doc_dm_leads' and column_name = 'tag';
```

### Migration 015 — paste this into the SQL Editor, right after 014

```sql
begin;

alter table public.doc_contacts drop constraint if exists doc_contacts_status_check;
alter table public.doc_contacts
  add constraint doc_contacts_status_check
  check (status in ('pending', 'invited', 'messaged', 'engaged'));

alter table public.doc_dm_leads drop constraint if exists doc_dm_leads_status_check;
alter table public.doc_dm_leads
  add constraint doc_dm_leads_status_check
  check (status in ('pending', 'invited', 'messaged', 'engaged'));

commit;
```

Verify with:
```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conname in ('doc_contacts_status_check', 'doc_dm_leads_status_check');
```
Both should show `'invited'` in the list of allowed values.

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
```

Note: `doc_invite_member` was deleted (migration 012 removed team invites) — if you deployed it
previously, you can leave the old deployed version in place (unused, harmless) or delete it from
the Supabase dashboard's Edge Functions list.

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
- [ ] Settings page shows "Account" (not "Organization") and has no Team Members section.
- [ ] Top nav bar has no org-switcher dropdown.
- [ ] Outreach page's "1. Choose your leads" step has no upload button — only filter chips.
- [ ] On Manual Added Leads, click "Upload Leads", type a tag (e.g. "Test"), upload a small
  CSV/Excel, confirm the leads import and a matching filter chip appears automatically.

## Production (original checklist — already applied)

- [x] Run `supabase/migrations/001_initial_schema.sql` through `009_outreach_messages.sql`
- [ ] Run `supabase/migrations/010_unify_lead_sources.sql`, `011_add_custom_fields.sql`,
  `012_remove_org_teams.sql`, and `013_add_contact_tags.sql` — see "Right now" above
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
- [x] Account row auto-created by the `doc_on_auth_user_created` trigger (migration 012) — no
  more manual "create organization + membership" step for new accounts
- [ ] Disable public signup in Auth settings (Settings > Auth > User Signups > disable)
- [ ] Verify end-to-end: send a test webhook from Make.com and confirm the comment appears in the queue

## Staging

- [ ] Same as production checklist above
- [ ] Additionally: run `supabase/seed.sql` to populate test data
- [ ] Create test auth users (User A, B) via Supabase Auth dashboard matching seed UUIDs
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
  ```
- [ ] Set edge function secrets: see `scripts/setup-integrations.md`
- [ ] `supabase functions serve` to run edge functions locally
