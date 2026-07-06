-- =============================================================================
-- RLS GATE CHECK
-- =============================================================================
-- Automated version of the manual verification queries in
-- docs/deployment/MANUAL_SQL_OPERATIONS.md. Run against a freshly-migrated
-- database (local or CI) with:
--
--   psql "$DB_URL" -f sql/rls-gate-check.sql --set ON_ERROR_STOP=1
--
-- Each check RAISEs an EXCEPTION on failure, which combined with
-- ON_ERROR_STOP=1 makes psql exit non-zero — CI treats that as a failed gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CHECK 1: RLS must be enabled on every doc_ table
-- ---------------------------------------------------------------------------
do $$
declare
  bad_tables text;
begin
  select string_agg(tablename, ', ')
  into bad_tables
  from pg_tables
  where schemaname = 'public'
    and tablename like 'doc_%'
    and rowsecurity = false;

  if bad_tables is not null then
    raise exception 'RLS GATE FAILED: RLS is not enabled on: %', bad_tables;
  end if;

  raise notice 'CHECK 1 PASSED: RLS enabled on all doc_ tables.';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 2: No policy may reference user_id = auth.uid() directly, except the
-- explicitly owner-scoped policies on doc_organizations (creation/ownership
-- transfer is intentionally tied to the creating user, not org membership).
-- ---------------------------------------------------------------------------
do $$
declare
  bad_policies text;
  allowed text[] := array[
    'doc_organizations_insert_auth',
    'doc_organizations_update_owner',
    'doc_organizations_delete_owner'
  ];
begin
  select string_agg(policyname, ', ')
  into bad_policies
  from pg_policies
  where tablename like 'doc_%'
    and qual::text like '%user_id = auth.uid()%'
    and policyname != all(allowed);

  if bad_policies is not null then
    raise exception 'RLS GATE FAILED: policies scoped to user_id instead of org membership: %', bad_policies;
  end if;

  raise notice 'CHECK 2 PASSED: no unexpected user_id-scoped policies.';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 3: doc_tone_uploads storage bucket must be private
-- ---------------------------------------------------------------------------
do $$
declare
  is_public boolean;
begin
  select public into is_public
  from storage.buckets
  where id = 'doc_tone_uploads';

  if is_public is null then
    raise exception 'RLS GATE FAILED: doc_tone_uploads bucket does not exist.';
  end if;

  if is_public then
    raise exception 'RLS GATE FAILED: doc_tone_uploads bucket is public — must be private.';
  end if;

  raise notice 'CHECK 3 PASSED: doc_tone_uploads bucket is private.';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 4: Realtime must be enabled only on doc_comments
-- ---------------------------------------------------------------------------
do $$
declare
  bad_tables text;
  has_comments boolean;
begin
  select string_agg(tablename, ', ')
  into bad_tables
  from pg_publication_tables
  where pubname = 'supabase_realtime'
    and tablename != 'doc_comments';

  if bad_tables is not null then
    raise exception 'RLS GATE FAILED: realtime enabled on unexpected tables: %', bad_tables;
  end if;

  select exists(
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'doc_comments'
  ) into has_comments;

  if not has_comments then
    raise exception 'RLS GATE FAILED: realtime is not enabled on doc_comments.';
  end if;

  raise notice 'CHECK 4 PASSED: realtime scoped only to doc_comments.';
end $$;

-- ---------------------------------------------------------------------------
-- CHECK 5: Every doc_ table must have all four CRUD policies present
-- ---------------------------------------------------------------------------
do $$
declare
  rec record;
  missing text := '';
  cmd_count int;
begin
  for rec in
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'doc_%'
  loop
    select count(distinct cmd) into cmd_count
    from pg_policies
    where tablename = rec.tablename
      and cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');

    if cmd_count < 4 then
      missing := missing || rec.tablename || ' (' || cmd_count || '/4 policies), ';
    end if;
  end loop;

  if missing != '' then
    raise exception 'RLS GATE FAILED: tables missing full CRUD policy coverage: %', missing;
  end if;

  raise notice 'CHECK 5 PASSED: every doc_ table has SELECT/INSERT/UPDATE/DELETE policies.';
end $$;

select 'ALL RLS GATE CHECKS PASSED.' as result;
