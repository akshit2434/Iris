-- Milestone 3, Slice 2: provider-aware token accounting and bounded working
-- context telemetry. Raw messages remain immutable; only estimates and
-- request metadata are persisted.

alter table public.messages
  add column if not exists estimated_tokens integer,
  add column if not exists tokenizer_provider text,
  add column if not exists tokenizer_model text,
  add column if not exists tokenizer_version text;

alter table public.messages
  drop constraint if exists messages_estimated_tokens_check;
alter table public.messages
  add constraint messages_estimated_tokens_check
  check (estimated_tokens is null or estimated_tokens >= 0);

alter table public.agent_runs
  add column if not exists estimated_input_tokens integer,
  add column if not exists actual_input_tokens integer,
  add column if not exists actual_output_tokens integer,
  add column if not exists actual_total_tokens integer,
  add column if not exists context_token_ledger jsonb not null default '{}'::jsonb,
  add column if not exists usage_metadata jsonb not null default '{}'::jsonb;

alter table public.agent_runs
  drop constraint if exists agent_runs_token_counts_check;
alter table public.agent_runs
  add constraint agent_runs_token_counts_check
  check (
    (estimated_input_tokens is null or estimated_input_tokens >= 0)
    and (actual_input_tokens is null or actual_input_tokens >= 0)
    and (actual_output_tokens is null or actual_output_tokens >= 0)
    and (actual_total_tokens is null or actual_total_tokens >= 0)
  );

-- Keep the explicit input boundary in SQL aligned with the route. The
-- context assembler still rejects a current turn that exceeds its token
-- burst; this database limit only protects storage and request parsing.
create or replace function public.create_thread_with_first_message(
  p_profile_id text,
  p_thread_id uuid,
  p_user_message_id uuid,
  p_run_id uuid,
  p_assistant_message_id uuid,
  p_request_id text,
  p_content text,
  p_model text
)
returns table(
  thread_id uuid,
  user_message_id uuid,
  run_id uuid,
  assistant_message_id uuid,
  duplicate boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_run public.agent_runs%rowtype;
  existing_content text;
  baseline_revision bigint := 0;
begin
  if p_profile_id is null or p_profile_id not in ('profile-a', 'profile-b') then
    raise exception 'Invalid profile';
  end if;
  if p_request_id is null or char_length(btrim(p_request_id)) not between 1 and 200 then
    raise exception 'Invalid request';
  end if;
  if p_content is null or char_length(btrim(p_content)) = 0 or char_length(p_content) > 500000 then
    raise exception 'Invalid message';
  end if;
  if p_model is null or char_length(btrim(p_model)) = 0 or char_length(p_model) > 200 then
    raise exception 'Invalid model';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'Profile not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_profile_id || ':' || btrim(p_request_id), 0));

  select r.* into existing_run
  from public.agent_runs r
  where r.profile_id = p_profile_id and r.request_id = btrim(p_request_id)
  order by r.created_at asc
  limit 1;

  if found then
    if existing_run.user_message_id is null then
      raise exception 'Request is already in progress';
    end if;
    select m.content into existing_content
    from public.messages m
    where m.id = existing_run.user_message_id
      and m.profile_id = p_profile_id
      and m.thread_id = existing_run.thread_id;
    if existing_content is null or existing_content <> btrim(p_content) then
      raise exception 'Request already used';
    end if;
    return query select existing_run.thread_id, existing_run.user_message_id,
      existing_run.id, coalesce(existing_run.assistant_message_id, p_assistant_message_id), true;
    return;
  end if;

  select coalesce(s.current_revision, 0) into baseline_revision
  from public.profile_memory_state s
  where s.profile_id = p_profile_id;

  insert into public.threads(id, profile_id, title)
  values (p_thread_id, p_profile_id, 'New chat');

  insert into public.thread_context(thread_id, profile_id, memory_revision_seen)
  values (p_thread_id, p_profile_id, baseline_revision)
  on conflict on constraint thread_context_pkey do update
    set memory_revision_seen = greatest(public.thread_context.memory_revision_seen, excluded.memory_revision_seen),
        updated_at = now();

  insert into public.messages(id, thread_id, profile_id, role, content, agent_run_id, is_complete)
  values (p_user_message_id, p_thread_id, p_profile_id, 'user', btrim(p_content), null, true);

  insert into public.agent_runs(
    id, profile_id, thread_id, request_id, user_message_id, model, status
  ) values (
    p_run_id, p_profile_id, p_thread_id, btrim(p_request_id), p_user_message_id, btrim(p_model), 'running'
  );

  update public.messages as m
  set agent_run_id = p_run_id
  where m.id = p_user_message_id and m.profile_id = p_profile_id and m.thread_id = p_thread_id;

  return query select p_thread_id, p_user_message_id, p_run_id, p_assistant_message_id, false;
end;
$$;
