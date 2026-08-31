-- Migration 016: Keyword / topic search for LinkedIn leads
--
-- New feature: search LinkedIn by a keyword or topic (e.g. "AI and
-- healthcare") to find people who recently posted about it, instead of
-- only scraping commenters off one known post URL (doc_scrape_post_commenters).
--
-- Adds a third doc_contacts.source value, 'keyword_search', plus columns to
-- record which keyword found the lead and a snippet of the post that
-- surfaced them, so the context isn't lost once the lead is saved.
begin;

alter table public.doc_contacts drop constraint if exists doc_contacts_source_check;
alter table public.doc_contacts
  add constraint doc_contacts_source_check
  check (source in ('scraped', 'manual', 'keyword_search'));

alter table public.doc_contacts add column if not exists matched_keyword text;
alter table public.doc_contacts add column if not exists source_post_url text;
alter table public.doc_contacts add column if not exists source_post_excerpt text;
alter table public.doc_contacts add column if not exists source_post_date timestamptz;

commit;
