-- Give each consolidation job an exact cumulative-token source range. This
-- avoids both reprocessing arbitrary recent messages and dropping messages
-- that accumulated between extraction jobs.
alter table public.memory_consolidation_jobs
  add column if not exists source_start_token_total bigint not null default 0
  check (source_start_token_total >= 0);

alter table public.memory_consolidation_state
  add column if not exists last_processed_token_total bigint not null default 0
  check (last_processed_token_total >= 0);

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
  source_start bigint;
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

  if not coalesce(p_idle_signal, false)
     and source_total < state.last_enqueued_token_total + 1200 then
    return;
  end if;
  if not coalesce(p_idle_signal, false)
     and state.last_enqueued_at is not null
     and state.last_enqueued_at > now() - make_interval(secs => debounce_seconds) then
    return;
  end if;

  -- Start from successfully processed evidence, not merely enqueued evidence.
  -- A failed job therefore cannot create a permanent gap in the next range.
  source_start := least(state.last_processed_token_total, source_total);
  insert into public.memory_consolidation_jobs(
    profile_id, thread_id, source_run_id, source_start_token_total, source_token_total
  ) values (
    p_profile_id, p_thread_id, p_source_run_id, source_start, source_total
  )
  on conflict (profile_id, source_run_id) do update
    set updated_at = now(),
        source_start_token_total = least(memory_consolidation_jobs.source_start_token_total, excluded.source_start_token_total),
        source_token_total = greatest(memory_consolidation_jobs.source_token_total, excluded.source_token_total)
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

create or replace function public.finish_memory_consolidation_job(
  p_profile_id text, p_job_id uuid, p_worker_id text, p_status text, p_error_code text default null,
  p_error_message text default null, p_retry boolean default false, p_available_at timestamptz default null
)
returns setof public.memory_consolidation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  next_status text;
  finished public.memory_consolidation_jobs%rowtype;
begin
  if p_status not in ('completed', 'failed', 'skipped') then raise exception 'Invalid consolidation completion status'; end if;
  select case when p_retry and attempts < 3 then 'pending' else p_status end into next_status
  from public.memory_consolidation_jobs
  where id = p_job_id and profile_id = p_profile_id and locked_by = p_worker_id
  for update;
  if not found then raise exception 'Consolidation job lease not owned by worker'; end if;

  update public.memory_consolidation_jobs j
  set status = next_status,
      available_at = case when next_status = 'pending' then coalesce(p_available_at, now() + interval '30 seconds') else j.available_at end,
      lease_expires_at = null,
      locked_at = null,
      locked_by = null,
      last_error_code = case when p_error_code is null then null else left(p_error_code, 120) end,
      last_error_message = case when p_error_message is null then null else left(p_error_message, 500) end,
      completed_at = case when next_status in ('completed', 'skipped', 'failed') then now() else null end,
      updated_at = now()
  where j.id = p_job_id and j.profile_id = p_profile_id
  returning j.* into finished;

  if next_status in ('completed', 'skipped') then
    update public.memory_consolidation_state s
    set last_processed_token_total = greatest(s.last_processed_token_total, finished.source_token_total),
        updated_at = now()
    where s.profile_id = finished.profile_id and s.thread_id = finished.thread_id;
  end if;

  return next finished;
end;
$$;

create or replace function public.list_memory_consolidation_job_messages(
  p_profile_id text,
  p_job_id uuid,
  p_limit integer default 50
)
returns table(message_id uuid, thread_id uuid, profile_id text, content text)
language sql
security definer
set search_path = public
as $$
  with job_scope as (
    select j.thread_id, j.source_start_token_total, j.source_token_total
    from public.memory_consolidation_jobs j
    where j.id = p_job_id and j.profile_id = p_profile_id
  ), ordered as (
    select
      m.id,
      m.thread_id,
      m.profile_id,
      m.role,
      m.content,
      m.created_at,
      greatest(coalesce(m.estimated_tokens, ceil(char_length(m.content)::numeric / 4)::bigint), 1) as token_count,
      sum(greatest(coalesce(m.estimated_tokens, ceil(char_length(m.content)::numeric / 4)::bigint), 1))
        over (order by m.created_at asc, m.id asc) as token_end
    from public.messages m
    join job_scope j on j.thread_id = m.thread_id
    where m.profile_id = p_profile_id and m.is_complete = true
  )
  select o.id, o.thread_id, o.profile_id, o.content
  from ordered o
  cross join job_scope j
  where o.role = 'user'
    and o.token_end > j.source_start_token_total
    and o.token_end - o.token_count < j.source_token_total
  order by o.created_at asc, o.id asc
  limit least(greatest(coalesce(p_limit, 50), 1), 50);
$$;

revoke all on function public.list_memory_consolidation_job_messages(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.list_memory_consolidation_job_messages(text, uuid, integer) to service_role;

create or replace function public.claim_memory_consolidation_job(
  p_profile_id text,
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns setof public.memory_consolidation_jobs
language sql
security definer
set search_path = public
as $$
  update public.memory_consolidation_jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_by = left(nullif(trim(coalesce(p_worker_id, '')), ''), 120),
      locked_at = now(),
      lease_expires_at = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 15), 900)),
      updated_at = now()
  where j.id = p_job_id
    and j.profile_id = p_profile_id
    and j.attempts < 3
    and ((j.status = 'pending' and j.available_at <= now())
      or (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at <= now()))
  returning j.*;
$$;

revoke all on function public.claim_memory_consolidation_job(text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_memory_consolidation_job(text, uuid, text, integer) to service_role;
