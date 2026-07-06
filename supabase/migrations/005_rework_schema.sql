begin;

-- ============================================================
-- Migration 005: Rework schema for manual comment generation,
-- DM assistant, and Apify lead scraping.
-- Removes Make.com dependency.
-- ============================================================

-- 1. New table: doc_dm_drafts
create table if not exists public.doc_dm_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  conversation_context text not null,
  last_reply text not null,
  generated_content text,
  edited_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.doc_dm_drafts enable row level security;

create policy "doc_dm_drafts_select_org"
  on public.doc_dm_drafts for select
  using (org_id in (select public.doc_user_org_ids()));

create policy "doc_dm_drafts_insert_org"
  on public.doc_dm_drafts for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

create policy "doc_dm_drafts_update_org"
  on public.doc_dm_drafts for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

create policy "doc_dm_drafts_delete_org"
  on public.doc_dm_drafts for delete
  using (org_id in (select public.doc_user_org_ids()));

create index if not exists doc_dm_drafts_user_id_idx on public.doc_dm_drafts(user_id);
create index if not exists doc_dm_drafts_org_id_idx on public.doc_dm_drafts(org_id);
create index if not exists doc_dm_drafts_org_created_idx on public.doc_dm_drafts(org_id, created_at desc);

create trigger doc_dm_drafts_updated_at
  before update on public.doc_dm_drafts
  for each row execute function public.doc_handle_updated_at();

revoke all on public.doc_dm_drafts from anon, authenticated;
grant select, insert, update, delete on public.doc_dm_drafts to authenticated;

-- 2. Add source column to doc_comments (how the comment was generated)
alter table public.doc_comments
  add column if not exists source text not null default 'caption'
  check (source in ('caption', 'image', 'link'));

-- 3. Add headline column to doc_contacts (populated by Apify scraper)
alter table public.doc_contacts
  add column if not exists headline text;

-- 4. Storage bucket for comment generator image uploads
insert into storage.buckets (id, name, public)
values ('doc_comment_images', 'doc_comment_images', false)
on conflict (id) do nothing;

create policy "doc_comment_images_select_org"
  on storage.objects for select
  using (
    bucket_id = 'doc_comment_images'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

create policy "doc_comment_images_insert_org"
  on storage.objects for insert
  with check (
    bucket_id = 'doc_comment_images'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

create policy "doc_comment_images_delete_org"
  on storage.objects for delete
  using (
    bucket_id = 'doc_comment_images'
    and (storage.foldername(name))[1]::uuid in (select public.doc_user_org_ids())
  );

commit;
