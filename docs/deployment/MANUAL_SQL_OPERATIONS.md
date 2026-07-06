# Manual SQL Operations

SQL operations that must be run manually in the Supabase SQL Editor per environment
before deploying. Check each item after running it.

## Production

- [ ] Run `supabase/migrations/001_initial_schema.sql` (tables, indexes, triggers, storage)
- [ ] Run `supabase/migrations/002_fix_rls_org_scoped.sql` (org-scoped RLS policies, helper functions)
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
  supabase secrets set MAKE_WEBHOOK_SECRET="..."
  supabase secrets set MAKE_WEBHOOK_ID="..."
  supabase secrets set OPENAI_API_KEY="..."
  supabase secrets set APIFY_API_KEY="..."
  ```
- [ ] Deploy edge functions:
  ```bash
  supabase functions deploy doc_inbound_post
  supabase functions deploy doc_approve_comment
  supabase functions deploy doc_process_tone
  supabase functions deploy doc_daily_followups
  supabase functions deploy doc_scrape_post_commenters
  supabase functions deploy doc_generate_comment
  supabase functions deploy doc_generate_dm
  ```
- [ ] Verify `APIFY_API_KEY` is set and `doc_scrape_post_commenters` is deployed (this powers the
  lead scraper on the Contacts page — it's easy to lose this secret across environments since it's
  not part of the original Make.com/OpenAI integration set):
  ```bash
  supabase secrets list --project-ref <project-ref> | grep APIFY_API_KEY
  supabase functions list --project-ref <project-ref> | grep doc_scrape_post_commenters
  ```
- [ ] Create initial owner account in Supabase Auth dashboard (public signup is disabled)
- [ ] Create initial organization and owner membership record
- [ ] Disable public signup in Auth settings (Settings > Auth > User Signups > disable)
- [ ] Set up `doc_daily_followups` cron schedule:
  ```sql
  select cron.schedule(
    'doc-daily-followups',
    '0 9 * * *',
    $$
    select net.http_post(
      url := '<SUPABASE_URL>/functions/v1/doc_daily_followups',
      headers := jsonb_build_object(
        'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb
    );
    $$
  );
  ```
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
