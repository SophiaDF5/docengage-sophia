begin;

-- ============================================================
-- Migration 019: Keep the comments on a post, and let a draft
-- be a reply to one of them.
--
-- Originally written as migration 014 in a separate line of work that was
-- pushed to GitHub without this repo's local migrations 014-018 (multi-
-- workspace support, invited status, keyword search, email verification,
-- doc_organizations RLS re-assertion). Renumbered to 019 on reconciling the
-- two histories — no schema content changed, only the filename/number and
-- this header.
--
-- The scraper already pulls every comment on a post through Apify.
-- It read the commenter's name, headline and profile URL, decided
-- whether they looked like a doctor, and threw the words away — so
-- the app could tell you WHO commented but never WHAT they said,
-- and only for the people who passed the doctor filter.
--
-- Two changes:
--   1. doc_post_comments — every comment harvested from a post,
--      with the commenter's LinkedIn profile URL, kept for everyone
--      who commented rather than only the doctors.
--   2. doc_comments gains a pointer to the comment it answers, plus
--      a copy of who said what. The copy is deliberate: a reply must
--      still make sense in the history after the harvested comment
--      is deleted or the post is re-scraped.
-- ============================================================

-- 1. Every comment we harvested from a post
create table if not exists public.doc_post_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  post_id uuid not null references public.doc_posts(id) on delete cascade,

  -- LinkedIn's own id for the comment where the scraper gives us one.
  -- Where it doesn't, the scraper builds a stable substitute out of the
  -- commenter's profile URL and the opening of what they wrote, so
  -- re-scraping the same post updates rows instead of duplicating them,
  -- while a second, genuinely different comment by the same person
  -- still gets its own row.
  linkedin_comment_id text not null,
  linkedin_comment_url text,

  commenter_name text not null,
  commenter_headline text,
  commenter_linkedin_url text,
  comment_text text,

  -- Whether this commenter matched the healthcare filter the scraper
  -- already applies when harvesting leads. Stored so the reply screen
  -- can put likely doctors first without re-running the keyword match
  -- in the browser.
  is_doctor_lead boolean not null default false,

  commented_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint doc_post_comments_post_comment_unique
    unique (post_id, linkedin_comment_id)
);

alter table public.doc_post_comments enable row level security;

create policy "doc_post_comments_select_org"
  on public.doc_post_comments for select
  using (org_id in (select public.doc_user_org_ids()));

create policy "doc_post_comments_insert_org"
  on public.doc_post_comments for insert
  with check (
    user_id = auth.uid()
    and org_id in (select public.doc_user_org_ids())
  );

create policy "doc_post_comments_update_org"
  on public.doc_post_comments for update
  using (org_id in (select public.doc_user_org_ids()))
  with check (org_id in (select public.doc_user_org_ids()));

create policy "doc_post_comments_delete_org"
  on public.doc_post_comments for delete
  using (org_id in (select public.doc_user_org_ids()));

create index if not exists doc_post_comments_org_id_idx
  on public.doc_post_comments(org_id);
create index if not exists doc_post_comments_post_id_idx
  on public.doc_post_comments(post_id);
create index if not exists doc_post_comments_org_created_idx
  on public.doc_post_comments(org_id, created_at desc);
create index if not exists doc_post_comments_commenter_url_idx
  on public.doc_post_comments(commenter_linkedin_url);

create trigger doc_post_comments_updated_at
  before update on public.doc_post_comments
  for each row execute function public.doc_handle_updated_at();

revoke all on public.doc_post_comments from anon, authenticated;
grant select, insert, update, delete on public.doc_post_comments to authenticated;

-- 2. A generated comment can be a reply to one of those comments.
--    parent_comment_id goes null rather than cascading, because losing
--    the harvested comment must not delete the reply we wrote to it —
--    the three reply_to_* columns are what keep it readable.
alter table public.doc_comments
  add column if not exists parent_comment_id uuid
    references public.doc_post_comments(id) on delete set null;

alter table public.doc_comments
  add column if not exists reply_to_name text;

alter table public.doc_comments
  add column if not exists reply_to_linkedin_url text;

alter table public.doc_comments
  add column if not exists reply_to_text text;

create index if not exists doc_comments_parent_comment_idx
  on public.doc_comments(parent_comment_id);

-- 3. Put the LinkedIn profile URL in the column that means it.
--    Migration 010 added doc_dm_leads.linkedin_profile_url, but the
--    Comment Generator kept writing the profile URL into `links` (the
--    freeform "their links" field), so the app had two columns holding
--    the same fact and looked people up in the wrong one. Backfill the
--    structured column from `links` where `links` is clearly a LinkedIn
--    profile; `links` keeps its value, because it is also what the DM
--    prompt reads.
update public.doc_dm_leads
set linkedin_profile_url = trim(links)
where linkedin_profile_url is null
  and links is not null
  and trim(links) ~* '^https?://([a-z]{2,3}\.)?linkedin\.com/in/';

create index if not exists doc_dm_leads_linkedin_url_idx
  on public.doc_dm_leads(linkedin_profile_url);

commit;
