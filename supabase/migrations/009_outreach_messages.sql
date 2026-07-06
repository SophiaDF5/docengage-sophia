begin;

-- ============================================================
-- Migration 009: Outreach messages — logs each assisted-send
-- message for a contact, so there's a history of what was sent
-- and when. Sending itself is never automated (see CLAUDE.md
-- "Out of Scope" — direct LinkedIn integration is prohibited);
-- this table just records what the user manually sent via
-- LinkedIn after copying the drafted/edited message.
-- ============================================================

create table if not exists public.doc_outreach_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  contact_id uuid not null references public.doc_contacts(id) on delete cascade,
  message_content text not null,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.doc_outreach_messages enable row level security;

create policy "doc_outreach_messages_select_org"
  on public.doc_outreach_messages for select
  using (org_id in (select public.doc_user_org_ids()));

create policy "doc_outreach_messages_insert_org"
  on public.doc_outreach_messages for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

create policy "doc_outreach_messages_update_org"
  on public.doc_outreach_messages for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

create policy "doc_outreach_messages_delete_org"
  on public.doc_outreach_messages for delete
  using (org_id in (select public.doc_user_org_ids()));

create index if not exists doc_outreach_messages_org_id_idx on public.doc_outreach_messages(org_id);
create index if not exists doc_outreach_messages_contact_id_idx on public.doc_outreach_messages(contact_id);
create index if not exists doc_outreach_messages_user_id_idx on public.doc_outreach_messages(user_id);
create index if not exists doc_outreach_messages_contact_sent_idx on public.doc_outreach_messages(contact_id, sent_at desc);

revoke all on public.doc_outreach_messages from anon, authenticated;
grant select, insert, update, delete on public.doc_outreach_messages to authenticated;

commit;
