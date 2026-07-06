```sql
-- MIGRATION
begin;

-- 1. Helper Functions
create or replace function public.doc_handle_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 2. Infrastructure Tables
create table if not exists public.doc_rate_limits (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists doc_rate_limits_key_created_idx
  on public.doc_rate_limits(key, created_at desc);
create index if not exists doc_rate_limits_user_id_idx
  on public.doc_rate_limits(user_id);

alter table public.doc_rate_limits enable row level security;
create policy "doc_rate_limits_insert"
  on public.doc_rate_limits for insert
  with check (true);

revoke all on public.doc_rate_limits from anon, authenticated;
grant insert on public.doc_rate_limits to authenticated;

-- 3. Application Tables

-- doc_organizations
create table if not exists public.doc_organizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  auto_post_enabled boolean not null default false,
  ai_system_prompt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- doc_organization_members
create table if not exists public.doc_organization_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- doc_posts
create table if not exists public.doc_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  linkedin_post_url text not null,
  author_name text not null,
  author_headline text,
  content text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- doc_comments
create table if not exists public.doc_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  post_id uuid not null references public.doc_posts(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  generated_content text,
  edited_content text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'generation_failed')),
  approved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- doc_contacts
create table if not exists public.doc_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  linkedin_profile_url text not null,
  full_name text not null,
  status text not null default 'no_action' check (status in ('no_action', 'connected', 'replied')),
  last_contacted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- doc_tone_samples
create table if not exists public.doc_tone_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  org_id uuid not null references public.doc_organizations(id) on delete cascade,
  file_path text not null,
  extracted_text text,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. RLS Enablement
alter table public.doc_organizations enable row level security;
alter table public.doc_organization_members enable row level security;
alter table public.doc_posts enable row level security;
alter table public.doc_comments enable row level security;
alter table public.doc_contacts enable row level security;
alter table public.doc_tone_samples enable row level security;

-- 5. Policies

-- doc_organizations
create policy "doc_organizations_select_own" on public.doc_organizations for select using (user_id = auth.uid());
create policy "doc_organizations_insert_own" on public.doc_organizations for insert with check (user_id = auth.uid());
create policy "doc_organizations_update_own" on public.doc_organizations for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_organizations_delete_own" on public.doc_organizations for delete using (user_id = auth.uid());

-- doc_organization_members
create policy "doc_organization_members_select_own" on public.doc_organization_members for select using (user_id = auth.uid());
create policy "doc_organization_members_insert_own" on public.doc_organization_members for insert with check (user_id = auth.uid());
create policy "doc_organization_members_update_own" on public.doc_organization_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_organization_members_delete_own" on public.doc_organization_members for delete using (user_id = auth.uid());

-- doc_posts
create policy "doc_posts_select_own" on public.doc_posts for select using (user_id = auth.uid());
create policy "doc_posts_insert_own" on public.doc_posts for insert with check (user_id = auth.uid());
create policy "doc_posts_update_own" on public.doc_posts for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_posts_delete_own" on public.doc_posts for delete using (user_id = auth.uid());

-- doc_comments
create policy "doc_comments_select_own" on public.doc_comments for select using (user_id = auth.uid());
create policy "doc_comments_insert_own" on public.doc_comments for insert with check (user_id = auth.uid());
create policy "doc_comments_update_own" on public.doc_comments for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_comments_delete_own" on public.doc_comments for delete using (user_id = auth.uid());

-- doc_contacts
create policy "doc_contacts_select_own" on public.doc_contacts for select using (user_id = auth.uid());
create policy "doc_contacts_insert_own" on public.doc_contacts for insert with check (user_id = auth.uid());
create policy "doc_contacts_update_own" on public.doc_contacts for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_contacts_delete_own" on public.doc_contacts for delete using (user_id = auth.uid());

-- doc_tone_samples
create policy "doc_tone_samples_select_own" on public.doc_tone_samples for select using (user_id = auth.uid());
create policy "doc_tone_samples_insert_own" on public.doc_tone_samples for insert with check (user_id = auth.uid());
create policy "doc_tone_samples_update_own" on public.doc_tone_samples for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "doc_tone_samples_delete_own" on public.doc_tone_samples for delete using (user_id = auth.uid());

-- 6. Indexes
create index if not exists doc_organizations_user_id_idx on public.doc_organizations(user_id);

create index if not exists doc_organization_members_user_id_idx on public.doc_organization_members(user_id);
create index if not exists doc_organization_members_org_id_idx on public.doc_organization_members(org_id);

create index if not exists doc_posts_user_id_idx on public.doc_posts(user_id);
create index if not exists doc_posts_org_id_idx on public.doc_posts(org_id);

create index if not exists doc_comments_user_id_idx on public.doc_comments(user_id);
create index if not exists doc_comments_post_id_idx on public.doc_comments(post_id);
create index if not exists doc_comments_org_id_idx on public.doc_comments(org_id);
create index if not exists doc_comments_status_idx on public.doc_comments(status);
create index if not exists doc_comments_org_status_idx on public.doc_comments(org_id, status);

create index if not exists doc_contacts_user_id_idx on public.doc_contacts(user_id);
create index if not exists doc_contacts_org_id_idx on public.doc_contacts(org_id);
create index if not exists doc_contacts_status_idx on public.doc_contacts(status);
create index if not exists doc_contacts_org_status_idx on public.doc_contacts(org_id, status);

create index if not exists doc_tone_samples_user_id_idx on public.doc_tone_samples(user_id);
create index if not exists doc_tone_samples_org_id_idx on public.doc_tone_samples(org_id);

-- 7. Triggers
create trigger doc_organizations_updated_at
  before update on public.doc_organizations
  for each row execute function public.doc_handle_updated_at();

create trigger doc_organization_members_updated_at
  before update on public.doc_organization_members
  for each row execute function public.doc_handle_updated_at();

create trigger doc_posts_updated_at
  before update on public.doc_posts
  for each row execute function public.doc_handle_updated_at();

create trigger doc_comments_updated_at
  before update on public.doc_comments
  for each row execute function public.doc_handle_updated_at();

create trigger doc_contacts_updated_at
  before update on public.doc_contacts
  for each row execute function public.doc_handle_updated_at();

create trigger doc_tone_samples_updated_at
  before update on public.doc_tone_samples
  for each row execute function public.doc_handle_updated_at();

-- 8. Storage Buckets and Policies
insert into storage.buckets (id, name, public)
values ('doc_tone_uploads', 'doc_tone_uploads', false)
on conflict (id) do nothing;

create policy "doc_tone_uploads_select_own" on storage.objects for select using (bucket_id = 'doc_tone_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_tone_uploads_insert_own" on storage.objects for insert with check (bucket_id = 'doc_tone_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_tone_uploads_update_own" on storage.objects for update using (bucket_id = 'doc_tone_uploads' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'doc_tone_uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "doc_tone_uploads_delete_own" on storage.objects for delete using (bucket_id = 'doc_tone_uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- 9. Permission Grants
revoke all on public.doc_organizations from anon, authenticated;
grant select, insert, update, delete on public.doc_organizations to authenticated;

revoke all on public.doc_organization_members from anon, authenticated;
grant select, insert, update, delete on public.doc_organization_members to authenticated;

revoke all on public.doc_posts from anon, authenticated;
grant select, insert, update, delete on public.doc_posts to authenticated;

revoke all on public.doc_comments from anon, authenticated;
grant select, insert, update, delete on public.doc_comments to authenticated;

revoke all on public.doc_contacts from anon, authenticated;
grant select, insert, update, delete on public.doc_contacts to authenticated;

revoke all on public.doc_tone_samples from anon, authenticated;
grant select, insert, update, delete on public.doc_tone_samples to authenticated;

commit;
```

```sql
-- SEED DATA
-- ⚠️ DEVELOPMENT/TESTING ONLY — never run in production
-- These test users must be created in Supabase Auth separately
-- (via dashboard, CLI, or the abuse test setup script)

begin;

-- User A data: '11111111-1111-1111-1111-111111111111'
insert into public.doc_organizations (id, user_id, name, auto_post_enabled, ai_system_prompt)
values
  ('a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Acme Health Group', false, 'You are a professional healthcare CEO. Focus on empathy and leadership.'),
  ('a1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Beta MedTech', true, 'You are an energetic startup founder bridging tech and medicine.')
on conflict do nothing;

insert into public.doc_organization_members (id, user_id, org_id, role)
values
  ('m1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'owner'),
  ('m1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-2222-1111-1111-111111111111', 'admin')
on conflict do nothing;

insert into public.doc_posts (id, user_id, org_id, linkedin_post_url, author_name, author_headline, content, published_at)
values
  ('p1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/post/1', 'Dr. Smith', 'Cardiologist', 'Great insights on preventative heart health today in the clinic.', now()),
  ('p1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/post/2', 'Dr. Jones', 'Surgeon', 'The future of robotic surgery is already here.', null)
on conflict do nothing;

insert into public.doc_comments (id, user_id, post_id, org_id, generated_content, edited_content, status, approved_by)
values
  ('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'p1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Completely agree, Dr. Smith. Prevention is the cornerstone of modern cardiology. How are your patients responding to the new guidelines?', null, 'pending', null),
  ('c1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'p1111111-2222-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Robotics are fascinating.', 'Robotics are transforming the surgical suite. What system are you currently favoring, Dr. Jones?', 'approved', '11111111-1111-1111-1111-111111111111'),
  ('c1111111-3333-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'p1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', null, null, 'generation_failed', null)
on conflict do nothing;

insert into public.doc_contacts (id, user_id, org_id, linkedin_profile_url, full_name, status, last_contacted_at)
values
  ('k1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drsmith', 'Dr. Alan Smith', 'no_action', null),
  ('k1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'https://linkedin.com/in/drjones', 'Dr. Sarah Jones', 'connected', now())
on conflict do nothing;

insert into public.doc_tone_samples (id, user_id, org_id, file_path, extracted_text, processing_status)
values
  ('t1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111/ceo_keynote.mp4', null, 'pending'),
  ('t1111111-2222-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111/podcast_interview.mp3', 'It is crucial to keep pushing the boundaries of what our systems can handle while maintaining the human touch...', 'completed')
on conflict do nothing;


-- User B data: '22222222-2222-2222-2222-222222222222'
insert into public.doc_organizations (id, user_id, name, auto_post_enabled, ai_system_prompt)
values
  ('b2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Gamma Orthopedics', false, 'You are an academic researcher. Use formal language.'),
  ('b2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'Delta Clinical', true, 'You are a friendly medical device sales representative.')
on conflict do nothing;

insert into public.doc_organization_members (id, user_id, org_id, role)
values
  ('m2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'owner'),
  ('m2222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'member')
on conflict do nothing;

insert into public.doc_posts (id, user_id, org_id, linkedin_post_url, author_name, author_headline, content, published_at)
values
  ('p2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'https://linkedin.com/post/3', 'Dr. Evans', 'Neurologist', 'New studies on brain plasticity are challenging our previous models.', now())
on conflict do nothing;

insert into public.doc_comments (id, user_id, post_id, org_id, generated_content, edited_content, status, approved_by)
values
  ('c2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'p2222222-1111-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'Great post.', null, 'rejected', '22222222-2222-2222-2222-222222222222')
on conflict do nothing;

insert into public.doc_contacts (id, user_id, org_id, linkedin_profile_url, full_name, status, last_contacted_at)
values
  ('k2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', 'https://linkedin.com/in/drevans', 'Dr. Marcus Evans', 'replied', now())
on conflict do nothing;

insert into public.doc_tone_samples (id, user_id, org_id, file_path, extracted_text, processing_status)
values
  ('t2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'b2222222-1111-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222/damaged_audio.wav', null, 'failed')
on conflict do nothing;

commit;
```