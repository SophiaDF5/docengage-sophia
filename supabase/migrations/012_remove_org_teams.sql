begin;

-- ============================================================
-- Migration 012: Collapse "organizations" into per-account scoping
--
-- Product decision: there is no more multi-user team/org concept.
-- Every login is its own fully isolated account — a brand new signup
-- starts completely empty, and nothing is ever shared between logins.
--
-- Rather than touching every table's RLS policies (every doc_* table's
-- SELECT/INSERT/UPDATE/DELETE policy calls doc_user_org_ids() to decide
-- what org_id values the caller may touch), this migration redefines
-- that ONE function to return only the caller's own single org row
-- instead of "every org I'm a member of." Every existing policy across
-- every table inherits the new behavior automatically, with zero
-- per-table changes and zero risk of missing one.
--
-- `doc_organizations` and the `org_id` columns on every table are kept
-- as-is structurally (renaming/dropping them would touch a much larger
-- surface for no functional benefit) — but from here on, "org_id" is
-- purely an internal per-account identifier. There's exactly one row
-- per user, auto-created the moment they sign up, never chosen, never
-- shared, never switched. `doc_organization_members` (the team/roles
-- table) is dropped entirely, along with the invite-a-teammate flow.
-- ============================================================

-- 1. Backfill: make sure every existing auth user already has their own
--    org row before we start relying on "exactly one org per user."
insert into public.doc_organizations (user_id, name)
select u.id, 'My Account'
from auth.users u
left join public.doc_organizations o on o.user_id = u.id
where o.id is null;

-- 2. Auto-create an account row for every new signup, so a brand new
--    login is immediately usable with its own empty, isolated data —
--    no manual SQL setup step required anymore.
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

-- 3. Redefine the core scoping function: "orgs I belong to" becomes
--    "my own single account row." Every doc_* table's RLS policy calls
--    this function already — none of them need to change.
create or replace function public.doc_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.doc_organizations where user_id = auth.uid();
$$;

-- 4. Drop the team/roles table and its now-unused helper function.
--    Nothing else references doc_organization_members via foreign key,
--    so this is an isolated drop.
drop table if exists public.doc_organization_members;
drop function if exists public.doc_user_is_org_admin(uuid);

commit;
