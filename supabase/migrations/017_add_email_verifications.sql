-- Migration 017: Public registration with emailed verification codes
--
-- Adds doc_email_verifications — an infra table in the same family as
-- doc_rate_limits (migration 001): it has no org_id (there's no account yet
-- when a code is generated) and is only ever touched by the service_role
-- client inside doc_register / doc_verify_email / doc_resend_code. RLS is
-- enabled but intentionally carries NO policies for anon/authenticated —
-- default-deny, service_role bypasses RLS entirely. This mirrors
-- doc_rate_limits' documented CI exemption from the standard 4-policy check.
begin;

create table if not exists public.doc_email_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  code text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists doc_email_verifications_email_idx
  on public.doc_email_verifications(email);

alter table public.doc_email_verifications enable row level security;
revoke all on public.doc_email_verifications from anon, authenticated;
-- No policies added on purpose — only the service_role client (which
-- bypasses RLS) ever reads/writes this table, from inside edge functions.

create trigger doc_email_verifications_updated_at
  before update on public.doc_email_verifications
  for each row execute function public.doc_handle_updated_at();

commit;
