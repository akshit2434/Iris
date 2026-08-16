-- Milestone 3, Slice 7: profile controls and explicit derived-memory cleanup.
-- Raw chats remain intact. This function only invalidates replaceable
-- reference-history snapshots and prevents queued jobs from recreating them
-- during a user-requested clear operation.

create or replace function public.clear_reference_history_data(p_profile_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception 'Unknown profile scope';
  end if;

  update public.reference_history_jobs
  set status = 'skipped',
      last_error_code = 'REFERENCE_HISTORY_CLEARED',
      last_error_message = 'Derived reference history was cleared by the user.',
      lease_expires_at = null,
      locked_at = null,
      locked_by = null,
      completed_at = coalesce(completed_at, now()),
      updated_at = now()
  where profile_id = p_profile_id
    and status in ('pending', 'running');

  update public.profile_reference_history_snapshots
  set status = 'invalidated'
  where profile_id = p_profile_id
    and status = 'active';

  update public.profile_reference_history_state
  set active_snapshot_id = null,
      active_snapshot_revision = 0,
      last_processed_token_watermark = 0,
      last_enqueued_token_watermark = 0,
      last_enqueued_at = null,
      last_source_at = null,
      updated_at = now()
  where profile_id = p_profile_id;

end;
$$;

alter table public.profile_reference_history_state enable row level security;
revoke all on function public.clear_reference_history_data(text) from public, anon, authenticated;
grant execute on function public.clear_reference_history_data(text) to service_role;
