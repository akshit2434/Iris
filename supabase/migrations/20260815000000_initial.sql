create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key check (id in ('profile-a', 'profile-b')),
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, profile_id)
);

create table if not exists public.messages (
  id uuid primary key,
  thread_id uuid not null,
  profile_id text not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  created_at timestamptz not null default now(),
  constraint messages_thread_profile_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id)
    on delete cascade
);

-- This is the future working-context layer. Raw messages above remain immutable
-- source history even after summaries/pinned notes are added later.
create table if not exists public.thread_context (
  thread_id uuid primary key,
  profile_id text not null references public.profiles(id) on delete cascade,
  active_continuity_checkpoint_id uuid,
  continuity_revision bigint not null default 0,
  memory_revision_seen bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint thread_context_thread_profile_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id)
    on delete cascade
);

create index if not exists threads_profile_updated_idx
  on public.threads(profile_id, updated_at desc);

create index if not exists messages_profile_thread_created_idx
  on public.messages(profile_id, thread_id, created_at asc);

alter table public.profiles enable row level security;
alter table public.threads enable row level security;
alter table public.messages enable row level security;
alter table public.thread_context enable row level security;

-- The app uses a server-only Supabase service-role connection and scopes every
-- query by profile_id. RLS remains enabled so an accidental browser client does
-- not receive access by default.
