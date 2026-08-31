-- Profile-scoped asynchronous voice transcription jobs.
-- Audio is sent directly to AssemblyAI and is never stored in Iris.
create type public.voice_transcription_status as enum ('queued', 'processing', 'completed', 'failed', 'cancelled');

create table if not exists public.voice_transcriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  provider text not null default 'assemblyai' check (provider = 'assemblyai'),
  provider_transcript_id text not null unique,
  status public.voice_transcription_status not null default 'queued',
  transcript text,
  error_message text,
  vocabulary_term_count integer not null default 0 check (vocabulary_term_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, profile_id)
);

create index if not exists voice_transcriptions_profile_created_idx
  on public.voice_transcriptions(profile_id, created_at desc);

alter table public.voice_transcriptions enable row level security;
revoke all on table public.voice_transcriptions from public, anon, authenticated;

-- Corrections are deliberately kept separate from governed personal memory.
create table if not exists public.voice_vocabulary (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  term text not null check (char_length(term) between 1 and 120),
  normalized_term text generated always as (lower(trim(term))) stored,
  source text not null default 'correction' check (source in ('correction', 'manual')),
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, normalized_term)
);

create index if not exists voice_vocabulary_profile_updated_idx
  on public.voice_vocabulary(profile_id, updated_at desc);

alter table public.voice_vocabulary enable row level security;
revoke all on table public.voice_vocabulary from public, anon, authenticated;
