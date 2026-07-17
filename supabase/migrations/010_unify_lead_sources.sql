begin;

-- ============================================================
-- Migration 010: Unify lead sources for Outreach
--
-- The Outreach page now pulls leads from two tables:
--   - doc_contacts  ("Scraped Leads" page) — from the LinkedIn scraper,
--     CSV/Excel upload, or a new manual-add form
--   - doc_dm_leads  ("Engaged Leads" page) — manually curated leads
--
-- To let both participate in the same status pipeline and outreach
-- log, this migration:
--   1. Adds `source` to doc_contacts, distinguishing scraper-sourced
--      rows from manually-added ones (CSV upload and one-by-one add).
--   2. Adds `status` and `linkedin_profile_url` (+ `last_contacted_at`)
--      to doc_dm_leads, matching doc_contacts' pipeline so both tables
--      speak the same status vocabulary.
--   3. Restructures doc_outreach_messages so a logged message can point
--      at EITHER a doc_contacts row or a doc_dm_leads row (never both,
--      never neither) — contact_id becomes nullable, a new nullable
--      dm_lead_id is added, and a check constraint enforces exactly
--      one is set.
-- ============================================================

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
