-- Private profile-scoped file metadata and storage.
-- The service-role server client owns these rows; client roles get no direct
-- table or bucket access. Every server query still supplies profile_id.
create type public.file_record_kind as enum ('upload', 'artifact');

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 255),
  storage_path text not null unique,
  mime_type text not null check (char_length(mime_type) between 1 and 200),
  size_bytes bigint not null check (size_bytes >= 0),
  record_kind public.file_record_kind not null default 'upload',
  source_thread_id uuid,
  source_message_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint files_source_thread_fkey
    foreign key (source_thread_id, profile_id)
    references public.threads(id, profile_id) on delete set null (source_thread_id),
  constraint files_source_message_fkey
    foreign key (source_message_id, profile_id, source_thread_id)
    references public.messages(id, profile_id, thread_id) on delete set null (source_message_id),
  constraint files_source_message_requires_thread_check
    check (source_message_id is null or source_thread_id is not null)
);

create index if not exists files_profile_created_idx
  on public.files(profile_id, created_at desc);
create index if not exists files_profile_kind_created_idx
  on public.files(profile_id, record_kind, created_at desc);
create index if not exists files_profile_name_idx
  on public.files(profile_id, lower(name));

alter table public.files enable row level security;
revoke all on table public.files from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('iris-files', 'iris-files', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;
