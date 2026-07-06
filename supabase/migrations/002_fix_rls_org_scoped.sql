begin;

-- ============================================================
-- Migration 002: Fix RLS policies to use org-membership scoping
--
-- Problem: All policies used `user_id = auth.uid()` which prevents
-- team members of the same org from seeing shared data.
--
-- Fix: Scope SELECT/INSERT/UPDATE/DELETE to org membership via
-- doc_organization_members, matching PRD Section 5 access model.
-- Also fixes storage bucket policies to use org_id paths.
-- ============================================================

-- 1. Helper function: returns all org_ids the current user belongs to
create or replace function public.doc_user_org_ids()
returns setof uuid
language sql
stable
security invoker
as $$
  select org_id from public.doc_organization_members where user_id = auth.uid();
$$;

-- 2. Helper function: check if user has owner/admin role in a given org
create or replace function public.doc_user_is_org_admin(target_org_id uuid)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1 from public.doc_organization_members
    where user_id = auth.uid()
      and org_id = target_org_id
      and role in ('owner', 'admin')
  );
$$;

-- ============================================================
-- 3. Drop all existing policies
-- ============================================================

-- doc_organizations
drop policy if exists "doc_organizations_select_own" on public.doc_organizations;
drop policy if exists "doc_organizations_insert_own" on public.doc_organizations;
drop policy if exists "doc_organizations_update_own" on public.doc_organizations;
drop policy if exists "doc_organizations_delete_own" on public.doc_organizations;

-- doc_organization_members
drop policy if exists "doc_organization_members_select_own" on public.doc_organization_members;
drop policy if exists "doc_organization_members_insert_own" on public.doc_organization_members;
drop policy if exists "doc_organization_members_update_own" on public.doc_organization_members;
drop policy if exists "doc_organization_members_delete_own" on public.doc_organization_members;

-- doc_posts
drop policy if exists "doc_posts_select_own" on public.doc_posts;
drop policy if exists "doc_posts_insert_own" on public.doc_posts;
drop policy if exists "doc_posts_update_own" on public.doc_posts;
drop policy if exists "doc_posts_delete_own" on public.doc_posts;

-- doc_comments
drop policy if exists "doc_comments_select_own" on public.doc_comments;
drop policy if exists "doc_comments_insert_own" on public.doc_comments;
drop policy if exists "doc_comments_update_own" on public.doc_comments;
drop policy if exists "doc_comments_delete_own" on public.doc_comments;

-- doc_contacts
drop policy if exists "doc_contacts_select_own" on public.doc_contacts;
drop policy if exists "doc_contacts_insert_own" on public.doc_contacts;
drop policy if exists "doc_contacts_update_own" on public.doc_contacts;
drop policy if exists "doc_contacts_delete_own" on public.doc_contacts;

-- doc_tone_samples
drop policy if exists "doc_tone_samples_select_own" on public.doc_tone_samples;
drop policy if exists "doc_tone_samples_insert_own" on public.doc_tone_samples;
drop policy if exists "doc_tone_samples_update_own" on public.doc_tone_samples;
drop policy if exists "doc_tone_samples_delete_own" on public.doc_tone_samples;

-- storage
drop policy if exists "doc_tone_uploads_select_own" on storage.objects;
drop policy if exists "doc_tone_uploads_insert_own" on storage.objects;
drop policy if exists "doc_tone_uploads_update_own" on storage.objects;
drop policy if exists "doc_tone_uploads_delete_own" on storage.objects;

-- ============================================================
-- 4. New org-scoped policies
-- ============================================================

-- doc_organizations
-- SELECT: can see orgs you are a member of
create policy "doc_organizations_select_member"
  on public.doc_organizations for select
  using (id in (select public.doc_user_org_ids()));

-- INSERT: anyone can create an org (they become owner via trigger/app logic)
create policy "doc_organizations_insert_auth"
  on public.doc_organizations for insert
  with check (user_id = auth.uid());

-- UPDATE: only the org owner can update settings (auto_post, ai_system_prompt)
create policy "doc_organizations_update_owner"
  on public.doc_organizations for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: only the org owner can delete
create policy "doc_organizations_delete_owner"
  on public.doc_organizations for delete
  using (user_id = auth.uid());

-- doc_organization_members
-- SELECT: can see all members of orgs you belong to
create policy "doc_organization_members_select_org"
  on public.doc_organization_members for select
  using (org_id in (select public.doc_user_org_ids()));

-- INSERT: owner/admin of the target org can add members
create policy "doc_organization_members_insert_admin"
  on public.doc_organization_members for insert
  with check (public.doc_user_is_org_admin(org_id));

-- UPDATE: owner/admin of the target org can change roles
create policy "doc_organization_members_update_admin"
  on public.doc_organization_members for update
  using (public.doc_user_is_org_admin(org_id))
  with check (public.doc_user_is_org_admin(org_id));

-- DELETE: owner/admin of the target org can remove members
create policy "doc_organization_members_delete_admin"
  on public.doc_organization_members for delete
  using (public.doc_user_is_org_admin(org_id));

-- doc_posts
-- SELECT: members of the post's org can see it
create policy "doc_posts_select_org"
  on public.doc_posts for select
  using (org_id in (select public.doc_user_org_ids()));

-- INSERT: members can create posts in their orgs
create policy "doc_posts_insert_org"
  on public.doc_posts for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

-- UPDATE: members of the post's org can update
create policy "doc_posts_update_org"
  on public.doc_posts for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

-- DELETE: members of the post's org can delete
create policy "doc_posts_delete_org"
  on public.doc_posts for delete
  using (org_id in (select public.doc_user_org_ids()));

-- doc_comments
-- SELECT: members of the comment's org can see it
create policy "doc_comments_select_org"
  on public.doc_comments for select
  using (org_id in (select public.doc_user_org_ids()));

-- INSERT: members can create comments in their orgs
create policy "doc_comments_insert_org"
  on public.doc_comments for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

-- UPDATE: members of the comment's org can update (approve/reject/edit)
create policy "doc_comments_update_org"
  on public.doc_comments for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

-- DELETE: members of the comment's org can delete
create policy "doc_comments_delete_org"
  on public.doc_comments for delete
  using (org_id in (select public.doc_user_org_ids()));

-- doc_contacts
-- SELECT: members of the contact's org can see it
create policy "doc_contacts_select_org"
  on public.doc_contacts for select
  using (org_id in (select public.doc_user_org_ids()));

-- INSERT: members can create contacts in their orgs
create policy "doc_contacts_insert_org"
  on public.doc_contacts for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

-- UPDATE: members of the contact's org can update
create policy "doc_contacts_update_org"
  on public.doc_contacts for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

-- DELETE: members of the contact's org can delete
create policy "doc_contacts_delete_org"
  on public.doc_contacts for delete
  using (org_id in (select public.doc_user_org_ids()));

-- doc_tone_samples
-- SELECT: members of the sample's org can see it
create policy "doc_tone_samples_select_org"
  on public.doc_tone_samples for select
  using (org_id in (select public.doc_user_org_ids()));

-- INSERT: members can upload tone samples to their orgs
create policy "doc_tone_samples_insert_org"
  on public.doc_tone_samples for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

-- UPDATE: members of the sample's org can update
create policy "doc_tone_samples_update_org"
  on public.doc_tone_samples for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

-- DELETE: members of the sample's org can delete
create policy "doc_tone_samples_delete_org"
  on public.doc_tone_samples for delete
  using (org_id in (select public.doc_user_org_ids()));

-- ============================================================
-- 5. Storage policies — scope to org_id path
-- Path format: /{org_id}/{uuid}.{ext}
-- ============================================================

create policy "doc_tone_uploads_select_org"
  on storage.objects for select
  using (
    bucket_id = 'doc_tone_uploads'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

create policy "doc_tone_uploads_insert_org"
  on storage.objects for insert
  with check (
    bucket_id = 'doc_tone_uploads'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

create policy "doc_tone_uploads_update_org"
  on storage.objects for update
  using (
    bucket_id = 'doc_tone_uploads'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  )
  with check (
    bucket_id = 'doc_tone_uploads'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

create policy "doc_tone_uploads_delete_org"
  on storage.objects for delete
  using (
    bucket_id = 'doc_tone_uploads'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

commit;
