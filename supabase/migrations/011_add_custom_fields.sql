begin;

-- ============================================================
-- Migration 011: Custom fields on leads
--
-- Lets users attach arbitrary key/value info to a lead (job title,
-- company, phone, specialty, whatever) without needing a new schema
-- migration every time someone wants to track a new attribute.
-- Stored as jsonb: { "Title": "Cardiologist", "Company": "Mayo Clinic" }
-- Keys/values are both freeform text, validated client-side only
-- (non-empty key, reasonable length) — no server-side schema for
-- what a "custom field" can be, by design.
-- ============================================================

alter table public.doc_contacts
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.doc_dm_leads
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

commit;
