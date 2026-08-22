-- Accountability claims move into a Postgres RPC: bundled PostgREST mishandles
-- limited UPDATE+select claims, so the reservation must happen server-side.
create function public.claim_accountability_checks(
  p_profile_id text, p_now timestamptz, p_stale_before timestamptz, p_limit integer
)
returns setof public.scheduled_checks language plpgsql security definer set search_path = public as $body$
begin
  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then raise exception 'Unknown profile scope'; end if;
  return query
    with candidates as (
      select sc.id from public.scheduled_checks sc
      where sc.profile_id = p_profile_id and sc.status = 'pending' and sc.due_at <= p_now
        and (sc.claimed_at is null or sc.claimed_at < p_stale_before)
      order by sc.due_at asc, sc.id asc
      for update skip locked
      limit greatest(coalesce(p_limit, 8), 1)
    )
    update public.scheduled_checks sc set claimed_at = p_now
    from candidates c
    where sc.id = c.id
    returning sc.*;
end;
$body$;

revoke all on function public.claim_accountability_checks(text, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_accountability_checks(text, timestamptz, timestamptz, integer) to service_role;
