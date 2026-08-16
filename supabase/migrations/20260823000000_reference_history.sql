-- Milestone 3, Slice 5: derived cross-chat reference history ("Dreaming").
--
-- This layer is rebuildable. Raw messages and governed saved memory remain the
-- only authorities. A snapshot is a bounded profile synthesis with explicit
-- source ranges, token watermarks, version metadata, and an immutable revision.

do $$ begin
  create type public.reference_history_status as enum ('active', 'superseded', 'invalidated');
exception when duplicate_object then null;
end $$;
do $$ begin
  create type public.reference_history_job_status as enum ('pending', 'running', 'completed', 'failed', 'conflict', 'skipped');
exception when duplicate_object then null;
end $$;

create table if not exists public.profile_memory_settings (
  profile_id text primary key references public.profiles(id) on delete cascade,
  saved_memory_enabled boolean not null default true,
  reference_history_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.profile_memory_settings(profile_id)
select id from public.profiles
on conflict (profile_id) do nothing;

create table if not exists public.profile_reference_history_state (
  profile_id text primary key references public.profiles(id) on delete cascade,
  last_enqueued_token_watermark bigint not null default 0 check (last_enqueued_token_watermark >= 0),
  last_processed_token_watermark bigint not null default 0 check (last_processed_token_watermark >= 0),
  last_enqueued_at timestamptz,
  last_source_at timestamptz,
  active_snapshot_id uuid,
  active_snapshot_revision bigint not null default 0 check (active_snapshot_revision >= 0),
  updated_at timestamptz not null default now()
);

insert into public.profile_reference_history_state(profile_id)
select id from public.profiles
on conflict (profile_id) do nothing;

create table if not exists public.profile_reference_history_snapshots (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  revision bigint not null check (revision > 0),
  status public.reference_history_status not null default 'active',
  document jsonb not null,
  rendered_text text not null,
  source_ranges jsonb not null default '[]'::jsonb,
  covered_token_watermark bigint not null check (covered_token_watermark >= 0),
  covered_through_at timestamptz,
  source_hash text not null,
  memory_revision bigint not null default 0 check (memory_revision >= 0),
  model text not null,
  synthesizer_version text not null,
  previous_snapshot_id uuid,
  created_at timestamptz not null default now(),
  unique (profile_id, revision),
  unique (id, profile_id),
  constraint reference_history_snapshot_previous_fkey
    foreign key (previous_snapshot_id, profile_id)
    references public.profile_reference_history_snapshots(id, profile_id)
    on delete set null
);

create unique index if not exists profile_reference_history_active_idx
  on public.profile_reference_history_snapshots(profile_id)
  where status = 'active';
create index if not exists profile_reference_history_revision_idx
  on public.profile_reference_history_snapshots(profile_id, revision desc);
create index if not exists profile_reference_history_watermark_idx
  on public.profile_reference_history_snapshots(profile_id, covered_token_watermark desc);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profile_reference_history_state_active_fkey'
      and conrelid = 'public.profile_reference_history_state'::regclass
  ) then
    alter table public.profile_reference_history_state
      add constraint profile_reference_history_state_active_fkey
      foreign key (active_snapshot_id, profile_id)
      references public.profile_reference_history_snapshots(id, profile_id)
      on delete set null;
  end if;
end $$;

-- The agent runtime already scopes every run by profile. This composite
-- uniqueness lets derived jobs enforce the same ownership at the FK boundary.
create unique index if not exists agent_runs_id_profile_idx
  on public.agent_runs(id, profile_id);

create table if not exists public.reference_history_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  source_run_id uuid,
  status public.reference_history_job_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  idempotency_key text not null,
  expected_snapshot_id uuid,
  expected_snapshot_revision bigint not null default 0 check (expected_snapshot_revision >= 0),
  source_start_token_watermark bigint not null default 0 check (source_start_token_watermark >= 0),
  source_end_token_watermark bigint not null check (source_end_token_watermark >= 0),
  rebuild_from_raw boolean not null default false,
  idle_signal boolean not null default false,
  model text not null,
  synthesizer_version text not null,
  available_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (profile_id, idempotency_key),
  unique (id, profile_id),
  constraint reference_history_job_run_fkey
    foreign key (source_run_id, profile_id)
    references public.agent_runs(id, profile_id)
    on delete cascade,
  constraint reference_history_job_expected_snapshot_fkey
    foreign key (expected_snapshot_id, profile_id)
    references public.profile_reference_history_snapshots(id, profile_id)
    on delete set null
);

create index if not exists reference_history_jobs_claim_idx
  on public.reference_history_jobs(status, available_at, created_at);
create index if not exists reference_history_jobs_profile_idx
  on public.reference_history_jobs(profile_id, status, created_at desc);

create or replace function public.enqueue_reference_history_job(
  p_profile_id text,
  p_source_run_id uuid default null,
  p_source_token_total bigint default null,
  p_idle_signal boolean default false,
  p_rebuild_from_raw boolean default false,
  p_model text default 'openai/gpt-5.6-luna',
  p_synthesizer_version text default 'iris-reference-history-v1',
  p_debounce_seconds integer default 30
)
returns setof public.reference_history_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  state public.profile_reference_history_state%rowtype;
  settings public.profile_memory_settings%rowtype;
  queued public.reference_history_jobs%rowtype;
  computed_total bigint;
  source_total bigint;
  debounce_seconds integer := least(greatest(coalesce(p_debounce_seconds, 30), 5), 900);
  idempotency text;
begin
  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'Reference history profile does not exist';
  end if;
  if p_source_run_id is not null and not exists (
    select 1 from public.agent_runs r
    where r.id = p_source_run_id and r.profile_id = p_profile_id
      and r.status = 'completed' and r.assistant_message_id is not null
  ) then
    raise exception 'Reference history source run is not a completed owned run';
  end if;

  insert into public.profile_memory_settings(profile_id) values (p_profile_id)
  on conflict (profile_id) do nothing;
  select * into settings from public.profile_memory_settings where profile_id = p_profile_id;
  if not settings.reference_history_enabled and not coalesce(p_rebuild_from_raw, false) then
    return;
  end if;

  insert into public.profile_reference_history_state(profile_id) values (p_profile_id)
  on conflict (profile_id) do nothing;
  select * into state from public.profile_reference_history_state
  where profile_id = p_profile_id for update;

  select coalesce(sum(coalesce(m.estimated_tokens, greatest(1, ceil(char_length(m.content)::numeric / 3))::bigint)), 0)::bigint
    into computed_total
  from public.messages m
  where m.profile_id = p_profile_id and m.is_complete;
  source_total := greatest(coalesce(p_source_token_total, 0), computed_total);

  if source_total <= state.last_processed_token_watermark and not coalesce(p_rebuild_from_raw, false) then
    return;
  end if;
  if not coalesce(p_rebuild_from_raw, false)
     and not coalesce(p_idle_signal, false)
     and source_total < state.last_processed_token_watermark + 2400 then
    return;
  end if;
  if not coalesce(p_rebuild_from_raw, false)
     and state.last_enqueued_at is not null
     and state.last_enqueued_at > now() - make_interval(secs => debounce_seconds) then
    return;
  end if;

  idempotency := coalesce(p_source_run_id::text, 'rebuild') || ':' || source_total::text || ':' || (case when p_rebuild_from_raw then 'raw' else 'incremental' end);
  insert into public.reference_history_jobs(
    profile_id, source_run_id, idempotency_key, expected_snapshot_id,
    expected_snapshot_revision, source_start_token_watermark,
    source_end_token_watermark, rebuild_from_raw, idle_signal, model,
    synthesizer_version
  ) values (
    p_profile_id, p_source_run_id, idempotency, state.active_snapshot_id,
    state.active_snapshot_revision, state.last_processed_token_watermark,
    source_total, coalesce(p_rebuild_from_raw, false), coalesce(p_idle_signal, false),
    left(coalesce(nullif(trim(p_model), ''), 'openai/gpt-5.6-luna'), 200),
    left(coalesce(nullif(trim(p_synthesizer_version), ''), 'iris-reference-history-v1'), 120)
  )
  on conflict (profile_id, idempotency_key) do update
    set updated_at = now(),
        source_end_token_watermark = greatest(reference_history_jobs.source_end_token_watermark, excluded.source_end_token_watermark)
  returning * into queued;

  update public.profile_reference_history_state
  set last_enqueued_token_watermark = greatest(last_enqueued_token_watermark, source_total),
      last_enqueued_at = now(), updated_at = now()
  where profile_id = p_profile_id;
  return next queued;
end;
$$;

create or replace function public.claim_reference_history_jobs(
  p_worker_id text, p_limit integer default 1, p_lease_seconds integer default 120
)
returns setof public.reference_history_jobs
language sql
security definer
set search_path = public
as $$
  with claimable as (
    select j.id from public.reference_history_jobs j
    where (j.status = 'pending' or (j.status = 'running' and j.lease_expires_at < now()))
      and j.available_at <= now()
    order by j.created_at asc
    for update skip locked limit least(greatest(coalesce(p_limit, 1), 1), 10)
  )
  update public.reference_history_jobs j
  set status = 'running', attempts = j.attempts + 1, locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 30), 900)),
      locked_by = left(coalesce(p_worker_id, 'iris-reference-worker'), 120), updated_at = now()
  from claimable c where j.id = c.id
  returning j.*;
$$;

create or replace function public.apply_reference_history_snapshot(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_expected_snapshot_id uuid,
  p_expected_snapshot_revision bigint,
  p_document jsonb,
  p_rendered_text text,
  p_source_ranges jsonb,
  p_covered_token_watermark bigint,
  p_covered_through_at timestamptz,
  p_source_hash text,
  p_memory_revision bigint,
  p_model text,
  p_synthesizer_version text,
  p_previous_snapshot_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.reference_history_jobs%rowtype;
  state public.profile_reference_history_state%rowtype;
  next_revision bigint;
  snapshot_id uuid;
begin
  select * into job from public.reference_history_jobs
  where id = p_job_id and profile_id = p_profile_id for update;
  if job.id is null or job.locked_by <> p_worker_id or job.status <> 'running' then
    raise exception 'Reference history job lease not owned by worker';
  end if;
  select * into state from public.profile_reference_history_state
  where profile_id = p_profile_id for update;
  if state.active_snapshot_id is distinct from p_expected_snapshot_id
     or state.active_snapshot_revision <> coalesce(p_expected_snapshot_revision, 0) then
    return 'conflict';
  end if;
  if p_previous_snapshot_id is not null and not exists (
    select 1 from public.profile_reference_history_snapshots s
    where s.id = p_previous_snapshot_id and s.profile_id = p_profile_id and s.status = 'active'
  ) then
    return 'invalidated';
  end if;

  next_revision := state.active_snapshot_revision + 1;
  update public.profile_reference_history_snapshots
  set status = 'superseded'
  where profile_id = p_profile_id and status = 'active';

  insert into public.profile_reference_history_snapshots(
    profile_id, revision, status, document, rendered_text, source_ranges,
    covered_token_watermark, covered_through_at, source_hash, memory_revision, model,
    synthesizer_version, previous_snapshot_id
  ) values (
    p_profile_id, next_revision, 'active', p_document, left(coalesce(p_rendered_text, ''), 50000),
    coalesce(p_source_ranges, '[]'::jsonb), greatest(coalesce(p_covered_token_watermark, 0), 0),
    p_covered_through_at, left(coalesce(p_source_hash, ''), 128), greatest(coalesce(p_memory_revision, 0), 0),
    left(coalesce(p_model, ''), 200), left(coalesce(p_synthesizer_version, ''), 120), p_previous_snapshot_id
  ) returning id into snapshot_id;

  update public.profile_reference_history_state
  set active_snapshot_id = snapshot_id, active_snapshot_revision = next_revision,
      last_processed_token_watermark = greatest(last_processed_token_watermark, p_covered_token_watermark),
      last_source_at = p_covered_through_at, updated_at = now()
  where profile_id = p_profile_id;
  return 'applied';
end;
$$;

create or replace function public.finish_reference_history_job(
  p_profile_id text, p_job_id uuid, p_worker_id text,
  p_status text, p_error_code text default null, p_error_message text default null,
  p_retry boolean default false, p_available_at timestamptz default null
)
returns setof public.reference_history_jobs
language plpgsql
security definer
set search_path = public
as $$
declare next_status public.reference_history_job_status;
begin
  if p_status not in ('completed', 'failed', 'conflict', 'skipped') then
    raise exception 'Invalid reference history completion status';
  end if;
  next_status := case when p_retry then 'pending'::public.reference_history_job_status else p_status::public.reference_history_job_status end;
  return query update public.reference_history_jobs j
  set status = next_status, last_error_code = left(p_error_code, 120),
      last_error_message = left(p_error_message, 500),
      available_at = coalesce(p_available_at, j.available_at),
      lease_expires_at = null, locked_at = null, locked_by = null,
      completed_at = case when next_status in ('completed', 'conflict', 'skipped') then now() else null end,
      updated_at = now()
  where j.id = p_job_id and j.profile_id = p_profile_id and j.locked_by = p_worker_id
  returning j.*;
end;
$$;

create or replace function public.invalidate_reference_history_snapshot(
  p_profile_id text, p_reason text default 'Reference history snapshot invalidated'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profile_reference_history_snapshots
  set status = 'invalidated'
  where profile_id = p_profile_id and status = 'active';
  update public.profile_reference_history_state
  set active_snapshot_id = null, active_snapshot_revision = 0,
      last_processed_token_watermark = 0, updated_at = now()
  where profile_id = p_profile_id;
end;
$$;

alter table public.profile_memory_settings enable row level security;
alter table public.profile_reference_history_state enable row level security;
alter table public.profile_reference_history_snapshots enable row level security;
alter table public.reference_history_jobs enable row level security;
revoke all on table public.profile_memory_settings from public, anon, authenticated;
revoke all on table public.profile_reference_history_state from public, anon, authenticated;
revoke all on table public.profile_reference_history_snapshots from public, anon, authenticated;
revoke all on table public.reference_history_jobs from public, anon, authenticated;
revoke all on function public.enqueue_reference_history_job(text, uuid, bigint, boolean, boolean, text, text, integer) from public, anon, authenticated;
revoke all on function public.claim_reference_history_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.apply_reference_history_snapshot(text, uuid, text, uuid, bigint, jsonb, text, jsonb, bigint, timestamptz, text, bigint, text, text, uuid) from public, anon, authenticated;
revoke all on function public.finish_reference_history_job(text, uuid, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.invalidate_reference_history_snapshot(text, text) from public, anon, authenticated;
grant execute on function public.enqueue_reference_history_job(text, uuid, bigint, boolean, boolean, text, text, integer) to service_role;
grant execute on function public.claim_reference_history_jobs(text, integer, integer) to service_role;
grant execute on function public.apply_reference_history_snapshot(text, uuid, text, uuid, bigint, jsonb, text, jsonb, bigint, timestamptz, text, bigint, text, text, uuid) to service_role;
grant execute on function public.finish_reference_history_job(text, uuid, text, text, text, text, boolean, timestamptz) to service_role;
grant execute on function public.invalidate_reference_history_snapshot(text, text) to service_role;
