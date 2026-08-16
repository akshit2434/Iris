-- Milestone 3, Slice 4: governed automatic memory lifecycle.
--
-- Consolidation is token-triggered and debounced. It is never driven by a
-- message count. The watermark is per profile/thread, so a short series of
-- turns can accumulate enough serialized source tokens without invoking an
-- extraction model on every turn.

alter table public.memory_consolidation_jobs
  add column if not exists source_token_total bigint not null default 0
  check (source_token_total >= 0);

create table if not exists public.memory_consolidation_state (
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  last_enqueued_token_total bigint not null default 0 check (last_enqueued_token_total >= 0),
  last_enqueued_at timestamptz,
  last_source_run_id uuid,
  updated_at timestamptz not null default now(),
  primary key (profile_id, thread_id),
  constraint memory_consolidation_state_thread_fkey
    foreign key (thread_id, profile_id) references public.threads(id, profile_id) on delete cascade,
  constraint memory_consolidation_state_run_fkey
    foreign key (last_source_run_id, profile_id, thread_id)
    references public.agent_runs(id, profile_id, thread_id) on delete cascade
);

create index if not exists memory_consolidation_state_activity_idx
  on public.memory_consolidation_state(profile_id, thread_id, last_enqueued_at desc);

drop function if exists public.enqueue_memory_consolidation_job(text, uuid, uuid);

create or replace function public.enqueue_memory_consolidation_job(
  p_profile_id text,
  p_thread_id uuid,
  p_source_run_id uuid,
  p_source_token_total bigint default 0,
  p_idle_signal boolean default false,
  p_debounce_seconds integer default 30
)
returns setof public.memory_consolidation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.memory_consolidation_state%rowtype;
  queued_id uuid;
  source_total bigint := greatest(coalesce(p_source_token_total, 0), 0);
  debounce_seconds integer := least(greatest(coalesce(p_debounce_seconds, 30), 5), 900);
begin
  if not exists (
    select 1 from public.agent_runs r
    where r.id = p_source_run_id
      and r.profile_id = p_profile_id
      and r.thread_id = p_thread_id
      and r.status = 'completed'
      and r.assistant_message_id is not null
  ) then
    raise exception 'Only completed runs with persisted assistant messages can be consolidated';
  end if;

  insert into public.memory_consolidation_state(profile_id, thread_id)
  values (p_profile_id, p_thread_id)
  on conflict (profile_id, thread_id) do nothing;

  select * into state
  from public.memory_consolidation_state s
  where s.profile_id = p_profile_id and s.thread_id = p_thread_id
  for update;

  -- 1,200 serialized tokens is the minimum automatic extraction batch. An
  -- idle signal can flush a smaller batch after the debounce window.
  if not coalesce(p_idle_signal, false)
     and source_total < state.last_enqueued_token_total + 1200 then
    return;
  end if;
  if not coalesce(p_idle_signal, false)
     and state.last_enqueued_at is not null
     and state.last_enqueued_at > now() - make_interval(secs => debounce_seconds) then
    return;
  end if;

  insert into public.memory_consolidation_jobs(profile_id, thread_id, source_run_id, source_token_total)
  values (p_profile_id, p_thread_id, p_source_run_id, source_total)
  on conflict (profile_id, source_run_id) do update
    set updated_at = now(), source_token_total = greatest(memory_consolidation_jobs.source_token_total, excluded.source_token_total)
  returning id into queued_id;

  update public.memory_consolidation_state
  set last_enqueued_token_total = greatest(last_enqueued_token_total, source_total),
      last_enqueued_at = now(),
      last_source_run_id = p_source_run_id,
      updated_at = now()
  where profile_id = p_profile_id and thread_id = p_thread_id;

  return query select * from public.memory_consolidation_jobs where id = queued_id;
end;
$$;

alter table public.memory_consolidation_state enable row level security;
revoke all on table public.memory_consolidation_state from public, anon, authenticated;
revoke all on function public.enqueue_memory_consolidation_job(text, uuid, uuid, bigint, boolean, integer) from public, anon, authenticated;
grant execute on function public.enqueue_memory_consolidation_job(text, uuid, uuid, bigint, boolean, integer) to service_role;
