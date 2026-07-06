-- SEED DATA
-- Development/testing only - never run in production
-- Test users must be created in Supabase Auth separately
-- (via dashboard, CLI, or the abuse test setup script)
--
-- Users:
--   User A: 11111111-1111-1111-1111-111111111111 (owner of Acme Health, owner of Beta MedTech)
--   User B: 22222222-2222-2222-2222-222222222222 (owner of Gamma Orthopedics, owner of Delta Clinical)
--   User C: 33333333-3333-3333-3333-333333333333 (member of Acme Health — tests cross-user org access)

begin;

-- ============================================================
-- NOTE: Auth users must be created BEFORE running this seed.
-- Run scripts/create-test-users.sh after `supabase start`.
-- The seed is designed to be run manually after users exist:
--   psql $DB_URL -f supabase/seed.sql
-- Or disable auto-seed in config.toml and run separately.
-- ============================================================

-- ============================================================
-- Organizations
-- ============================================================

insert into public.doc_organizations (id, user_id, name, auto_post_enabled, ai_system_prompt)
values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Acme Health Group', false, 'You are a professional healthcare CEO. Focus on empathy and leadership.'),
  ('a1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Beta MedTech', true, 'You are an energetic startup founder bridging tech and medicine.'),
  ('b2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Gamma Orthopedics', false, 'You are an academic researcher. Use formal language.'),
  ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Delta Clinical', true, 'You are a friendly medical device sales representative.')
on conflict do nothing;

-- ============================================================
-- Organization Members
-- ============================================================

insert into public.doc_organization_members (id, user_id, org_id, role)
values
  ('e0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'owner'),
  ('e0111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-2222-1111-1111-111111111111', 'owner'),
  ('e0222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'owner'),
  ('e0222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'owner'),
  ('e0333333-1111-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'member')
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
-- Contacts
-- ============================================================

insert into public.doc_contacts (id, user_id, org_id, linkedin_profile_url, full_name, status, last_contacted_at)
values
  ('f0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drsmith', 'Dr. Alan Smith', 'no_action', null),
  ('f0111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drjones', 'Dr. Sarah Jones', 'connected', now()),
  ('f0111111-3333-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drpatel', 'Dr. Raj Patel', 'no_action', null),
  ('f0222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'https://linkedin.com/in/drevans', 'Dr. Marcus Evans', 'replied', now())
on conflict do nothing;

-- Backdate the stale contact so daily followup cron picks it up
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
