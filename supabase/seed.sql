insert into public.profiles (id, display_name)
values ('profile-a', 'Profile A'), ('profile-b', 'Profile B')
on conflict (id) do update set display_name = excluded.display_name;
