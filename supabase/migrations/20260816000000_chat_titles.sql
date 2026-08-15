-- Chat title provenance makes automatic naming replay-safe and protects manual
-- edits from a title request that is still resolving.
alter table public.threads
  add column if not exists title_source text not null default 'default',
  add column if not exists title_generation_attempted boolean not null default false;

-- Existing non-default labels came from the previous title path or a user's
-- edit. Preserve them and make them ineligible for a future auto-title.
update public.threads
set title_source = 'manual',
    title_generation_attempted = true
where title <> 'New chat'
  and title_source = 'default';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.threads'::regclass
      and conname = 'threads_title_source_check'
  ) then
    alter table public.threads
      add constraint threads_title_source_check
      check (title_source in ('default', 'automatic', 'manual'));
  end if;
end
$$;

create index if not exists threads_title_generation_idx
  on public.threads(profile_id, title_source, title_generation_attempted)
  where archived_at is null;
