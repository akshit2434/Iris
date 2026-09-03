-- Future checks carry their purpose so recurrence and recovery remain explainable
-- without asking a model to rediscover scheduling intent.
alter table public.scheduled_checks
  add column if not exists purpose text not null default 'initial'
    check (purpose in ('initial', 'routine', 'follow_up', 'recovery')),
  add column if not exists recurrence_policy jsonb;

create index if not exists scheduled_checks_profile_purpose_pending_idx
  on public.scheduled_checks(profile_id, purpose, due_at) where status = 'pending';
