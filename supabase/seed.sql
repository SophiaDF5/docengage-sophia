-- SEED DATA
-- Development/testing only - never run in production
-- Test users must be created in Supabase Auth separately
-- (via dashboard, CLI, or the abuse test setup script)
--
-- Users:
--   User A: 11111111-1111-1111-1111-111111111111
--   User B: 22222222-2222-2222-2222-222222222222
--
-- Since migration 012, every login is its own fully isolated account —
-- there is no team/multi-user concept anymore. Each user gets exactly one
-- doc_organizations row (an internal per-account settings container, not a
-- shared "organization" — auto-created by the doc_on_auth_user_created
-- trigger on real signups). This seed inserts that row directly for the
-- two test users rather than relying on the trigger, since the trigger
-- only fires on actual auth.users inserts.

begin;

-- ============================================================
-- NOTE: Auth users must be created BEFORE running this seed.
-- Run scripts/create-test-users.sh after `supabase start`.
-- The seed is designed to be run manually after users exist:
--   psql $DB_URL -f supabase/seed.sql
-- Or disable auto-seed in config.toml and run separately.
-- ============================================================

-- ============================================================
-- Accounts (one doc_organizations row per user)
-- ============================================================

insert into public.doc_organizations (id, user_id, name, auto_post_enabled, ai_system_prompt)
values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'My Account', false, 'You are a professional healthcare CEO. Focus on empathy and leadership.'),
  ('b2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'My Account', true, 'You are an academic researcher. Use formal language.')
on conflict do nothing;

-- ============================================================
-- Posts
-- ============================================================

insert into public.doc_posts (id, user_id, org_id, linkedin_post_url, author_name, author_headline, content, published_at)
values
  ('d0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/post/1', 'Dr. Smith', 'Cardiologist', 'Great insights on preventative heart health today in the clinic.', now()),
  ('d0111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/post/2', 'Dr. Jones', 'Surgeon', 'The future of robotic surgery is already here.', null),
  ('d0222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'https://linkedin.com/post/3', 'Dr. Evans', 'Neurologist', 'New studies on brain plasticity are challenging our previous models.', now())
on conflict do nothing;

-- ============================================================
-- Comments (various statuses to populate all Dashboard tabs)
-- ============================================================

insert into public.doc_comments (id, user_id, post_id, org_id, generated_content, edited_content, status, approved_by)
values
  ('c0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'd0111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Completely agree, Dr. Smith. Prevention is the cornerstone of modern cardiology. How are your patients responding to the new guidelines?', null, 'pending', null),
  ('c0111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'd0111111-2222-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Robotics are fascinating.', 'Robotics are transforming the surgical suite. What system are you currently favoring, Dr. Jones?', 'approved', '11111111-1111-1111-1111-111111111111'),
  ('c0111111-3333-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'd0111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', null, null, 'generation_failed', null),
  ('c0222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'd0222222-1111-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'Great post.', null, 'rejected', '22222222-2222-2222-2222-222222222222')
on conflict do nothing;

-- ============================================================
-- Contacts (status values match the current check constraint:
-- pending / messaged / engaged — see migration 007)
-- ============================================================

insert into public.doc_contacts (id, user_id, org_id, linkedin_profile_url, full_name, status, source, last_contacted_at)
values
  ('f0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drsmith', 'Dr. Alan Smith', 'pending', 'scraped', null),
  ('f0111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drjones', 'Dr. Sarah Jones', 'messaged', 'scraped', now()),
  ('f0111111-3333-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drpatel', 'Dr. Raj Patel', 'pending', 'manual', null),
  ('f0222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'https://linkedin.com/in/drevans', 'Dr. Marcus Evans', 'engaged', 'scraped', now())
on conflict do nothing;

-- Backdate the stale contact so daily followup logic (if/when built) picks it up
update public.doc_contacts
  set created_at = now() - interval '10 days'
  where id = 'f0111111-3333-1111-1111-111111111111';

-- ============================================================
-- Tone Samples (paths use org_id per migration 002 storage fix)
-- ============================================================

insert into public.doc_tone_samples (id, user_id, org_id, file_path, extracted_text, processing_status)
values
  ('f1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111/ceo_keynote.mp4', null, 'pending'),
  ('f1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111/podcast_interview.mp3', 'It is crucial to keep pushing the boundaries of what our systems can handle while maintaining the human touch...', 'completed'),
  ('f1222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222/damaged_audio.wav', null, 'failed')
on conflict do nothing;

commit;
