begin;

-- ============================================================
-- Migration 004: Fix infinite recursion in doc_organization_members RLS
--
-- Problem: doc_user_org_ids() is SECURITY INVOKER and queries
-- doc_organization_members, whose SELECT policy calls doc_user_org_ids()
-- → infinite recursion.
--
-- Fix: Make doc_user_org_ids() and doc_user_is_org_admin() SECURITY DEFINER
-- so they bypass RLS when reading doc_organization_members. This is safe
-- because both functions filter by auth.uid() — they can only return
-- data for the calling user.
-- ============================================================

-- 1. Recreate helper functions as SECURITY DEFINER
create or replace function public.doc_user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.doc_organization_members where user_id = auth.uid();
$$;

create or replace function public.doc_user_is_org_admin(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.doc_organization_members
    where user_id = auth.uid()
      and org_id = target_org_id
      and role in ('owner', 'admin')
  );
$$;

-- 2. No need to change policies — they already call these functions.
-- The SECURITY DEFINER change means the function body executes as the
-- function owner (postgres), bypassing RLS on doc_organization_members,
-- but still filtering by auth.uid() for safety.

commit;
