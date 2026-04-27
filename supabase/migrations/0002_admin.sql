-- ═══════════════════════════════════════════════════════════════════════════
--  Admin-funktionalitet — admins skippar onboarding och använder
--  systemets default-nycklar (från VPS .env) istället för per-user.
-- ═══════════════════════════════════════════════════════════════════════════

-- Lägg till is_admin på profiles
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Markera kända admin-email-adresser (som Mikes huvudkonto)
update public.profiles
  set is_admin = true,
      tier = 'enterprise',
      onboarding_complete = true
  where email in ('aiupscaleagency@gmail.com', 'mikael@aiupscaleagency.com');

-- Auto-flagga admin på framtida signups om email matchar
create or replace function public.handle_admin_email()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.email in ('aiupscaleagency@gmail.com', 'mikael@aiupscaleagency.com') then
    update public.profiles
      set is_admin = true,
          tier = 'enterprise',
          onboarding_complete = true
      where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_admin_check on public.profiles;
create trigger on_profile_admin_check
  after insert on public.profiles
  for each row execute function public.handle_admin_email();

-- Admin-policy: admins kan se ALLA users (för admin-dashboard)
-- (Vanliga users ser bara sin egen via RLS i 0001)
create policy "admins can read all profiles" on public.profiles
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

create policy "admins can read all subscriptions" on public.subscriptions
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );
