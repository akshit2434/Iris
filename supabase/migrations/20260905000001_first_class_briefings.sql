-- A briefing is information, not an open-loop question.  It deliberately has
-- no loop_id or response state, so it cannot become Home attention.
create table if not exists public.briefing_deliveries (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  due_at timestamptz not null,
  rendered_at timestamptz,
  content text not null check (char_length(content) between 1 and 4000),
  created_at timestamptz not null default now(),
  unique (profile_id, due_at)
);
create index if not exists briefing_deliveries_due_idx on public.briefing_deliveries(profile_id, due_at) where rendered_at is null;
alter table public.briefing_deliveries enable row level security;
revoke all on table public.briefing_deliveries from public, anon, authenticated;
