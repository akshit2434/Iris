-- Lazy chat persistence. A blank composer route is not a thread; the first
-- user message and its execution record are committed together.

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
  if p_content is null or char_length(btrim(p_content)) = 0 or char_length(p_content) > 12000 then
    raise exception 'Invalid message';
  end if;
  if p_model is null or char_length(btrim(p_model)) = 0 or char_length(p_model) > 200 then
    raise exception 'Invalid model';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    raise exception 'Profile not found';
  end if;

  -- Serialize retries for the same profile/request without introducing a
  -- second durable idempotency table. All writes below remain one transaction.
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

  -- Insert the message before the run so the run's ownership FK can point to
  -- the exact first message. It is linked to the run before this transaction
  -- can commit, so no observable blank thread or unowned first message exists.
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

revoke all on function public.create_thread_with_first_message(text, uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.create_thread_with_first_message(text, uuid, uuid, uuid, uuid, text, text, text) to service_role;
