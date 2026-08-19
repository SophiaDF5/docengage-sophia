-- Extends the freeform `tag` label (added to doc_contacts in migration 013)
-- to doc_dm_leads too, so leads from every source (Scraped, Manual, and
-- Engaged) can be tagged consistently — e.g. "Invited" — and filtered
-- together on the Outreach page. See src/pages/Outreach.tsx's tag filter
-- chips and the "Mark Invited" quick action.
alter table public.doc_dm_leads
  add column if not exists tag text;

create index if not exists doc_dm_leads_tag_idx on public.doc_dm_leads(tag);
