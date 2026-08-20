-- Adds "invited" as a fourth value in the status lifecycle
-- (pending -> invited -> messaged -> engaged), replacing the earlier
-- tag-based "Invited" approach (migration 014's doc_dm_leads.tag column
-- stays in place for general freeform tags like "YouTube", it's just no
-- longer special-cased for "Invited" — see src/pages/Outreach.tsx and the
-- Status dropdowns on Scraped/Manual/Engaged Leads).
begin;

alter table public.doc_contacts drop constraint if exists doc_contacts_status_check;
alter table public.doc_contacts
  add constraint doc_contacts_status_check
  check (status in ('pending', 'invited', 'messaged', 'engaged'));

alter table public.doc_dm_leads drop constraint if exists doc_dm_leads_status_check;
alter table public.doc_dm_leads
  add constraint doc_dm_leads_status_check
  check (status in ('pending', 'invited', 'messaged', 'engaged'));

commit;
