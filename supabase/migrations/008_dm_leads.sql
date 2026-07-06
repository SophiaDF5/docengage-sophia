begin;

-- ============================================================
-- Migration 008: DM leads — persist lead info (name, bio, links)
-- for the DM assistant so users can reuse them.
-- ============================================================

create table if not exists public.doc_dm_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  name text not null,
  bio text,
  links text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.doc_dm_leads enable row level security;

create policy "doc_dm_leads_select_org"
  on public.doc_dm_leads for select
  using (org_id in (select public.doc_user_org_ids()));

create policy "doc_dm_leads_insert_org"
  on public.doc_dm_leads for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

create policy "doc_dm_leads_update_org"
  on public.doc_dm_leads for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

create policy "doc_dm_leads_delete_org"
  on public.doc_dm_leads for delete
  using (org_id in (select public.doc_user_org_ids()));

create index if not exists doc_dm_leads_org_id_idx on public.doc_dm_leads(org_id);
create index if not exists doc_dm_leads_org_name_idx on public.doc_dm_leads(org_id, name);

create trigger doc_dm_leads_updated_at
  before update on public.doc_dm_leads
  for each row execute function public.doc_handle_updated_at();

revoke all on public.doc_dm_leads from anon, authenticated;
grant select, insert, update, delete on public.doc_dm_leads to authenticated;

commit;
