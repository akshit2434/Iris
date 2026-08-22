-- Accountability delivery links become deletable: composite ON DELETE SET NULL
-- foreign keys were impossible over NOT NULL scope columns and blocked delivery
-- and message deletion; profile scoping remains enforced at the query layer per
-- repo convention.
alter table public.scheduled_checks drop constraint if exists scheduled_checks_delivery_fkey;
alter table public.scheduled_checks
  add constraint scheduled_checks_delivery_fkey
  foreign key (delivery_id) references public.checkin_deliveries(id) on delete set null;
create index if not exists scheduled_checks_delivery_idx
  on public.scheduled_checks(delivery_id) where delivery_id is not null;

alter table public.checkin_deliveries drop constraint if exists checkin_deliveries_message_fkey;
alter table public.checkin_deliveries
  add constraint checkin_deliveries_message_fkey
  foreign key (message_id) references public.messages(id) on delete set null;
