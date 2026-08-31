-- The UI ships with these two profile scopes, so every environment needs the
-- corresponding rows before profile selection or profile-scoped writes.
insert into public.profiles (id, display_name)
values ('profile-a', 'Profile A'), ('profile-b', 'Profile B')
on conflict (id) do nothing;
