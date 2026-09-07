begin;

-- ============================================================
-- Migration 018: Re-assert doc_organizations RLS policies directly
--
-- Reina hit "new row violates row-level security policy for table
-- doc_organizations" when creating a second workspace (the new
-- multi-workspace feature — see useOrganization.ts / WorkspaceSwitcher.tsx).
--
-- All four CRUD policies on this table should already check
-- `user_id = auth.uid()` — true since migration 001, and migration 002
-- only renamed them (doc_organizations_insert_own -> ..._insert_auth, etc.),
-- it didn't change the actual check. So this error means what's actually
-- live in production has drifted from what these migration files describe
-- — most likely from earlier manual SQL Editor cleanup (migration 012's own
-- notes mention "your earlier SQL Editor history created more than one
-- doc_organizations row," confirming this table specifically had ad-hoc
-- manual edits at some point).
--
-- Rather than try to diagnose exactly what's live, this migration is fully
-- idempotent: it drops every policy name doc_organizations has ever had
-- across this repo's migration history, then recreates the four canonical
-- ones from scratch. Safe to run even if some of these names don't exist.
--
-- Also deliberately scoped directly to `user_id = auth.uid()` rather than
-- through doc_user_org_ids() — that function is itself DEFINED in terms of
-- doc_organizations.user_id (migration 012), so routing this one table's
-- own policies through it would be circular for no benefit.
-- ============================================================

drop policy if exists "doc_organizations_select_own" on public.doc_organizations;
drop policy if exists "doc_organizations_insert_own" on public.doc_organizations;
drop policy if exists "doc_organizations_update_own" on public.doc_organizations;
drop policy if exists "doc_organizations_delete_own" on public.doc_organizations;
drop policy if exists "doc_organizations_select_member" on public.doc_organizations;
drop policy if exists "doc_organizations_insert_auth" on public.doc_organizations;
drop policy if exists "doc_organizations_update_owner" on public.doc_organizations;
drop policy if exists "doc_organizations_delete_owner" on public.doc_organizations;

create policy "doc_organizations_select_own" on public.doc_organizations
  for select using (user_id = auth.uid());

create policy "doc_organizations_insert_own" on public.doc_organizations
  for insert with check (user_id = auth.uid());

create policy "doc_organizations_update_own" on public.doc_organizations
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "doc_organizations_delete_own" on public.doc_organizations
  for delete using (user_id = auth.uid());

commit;
