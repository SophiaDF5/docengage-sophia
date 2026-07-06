-- Enforce idempotency at the DB level: one post per LinkedIn URL per org.
-- The doc_inbound_post edge function checks this via query, but a unique
-- constraint prevents race-condition duplicates from concurrent webhooks.

alter table public.doc_posts
  add constraint doc_posts_org_url_unique unique (org_id, linkedin_post_url);

-- Enforce one contact per LinkedIn profile per org.
-- Required for the upsert in doc_inbound_post when auto-creating contacts.

alter table public.doc_contacts
  add constraint doc_contacts_org_profile_unique unique (org_id, linkedin_profile_url);
