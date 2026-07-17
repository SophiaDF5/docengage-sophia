begin;

-- ============================================================
-- Migration 013: Freeform tags for manually added / uploaded leads
--
-- Lets the user label a batch of leads with whatever category makes
-- sense to them (e.g. "YouTube", "Conference 2026", "Cold list") at
-- upload time or when adding a single lead by hand. The Manual Added
-- Leads page then builds its filter chips dynamically from whatever
-- distinct tag values actually exist — no fixed list, no migration
-- needed to add a new "type" of lead.
-- ============================================================

alter table public.doc_contacts
  add column if not exists tag text;

create index if not exists doc_contacts_tag_idx on public.doc_contacts(tag);

commit;
