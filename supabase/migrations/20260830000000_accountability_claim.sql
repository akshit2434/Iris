-- Accountability atomic claim: claimed_at reservations make sweep delivery crash-safe.
alter table public.scheduled_checks add column if not exists claimed_at timestamptz;
create index if not exists scheduled_checks_claim_idx
  on public.scheduled_checks(profile_id, due_at)
  where status = 'pending';
