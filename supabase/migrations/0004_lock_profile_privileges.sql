-- Skydda ägarrollen: row-level security begränsar rader, inte vilka kolumner
-- en användare får ändra. `is_admin`, `status` och `tier` ska bara ändras från
-- en betrodd server-/dashboard-session, aldrig med den publika anon-klienten.

revoke update on table public.profiles from anon, authenticated;
grant update (name, onboarding_complete, updated_at) on table public.profiles to authenticated;

-- E-postbaserad automatisk adminflagga kan ge en nyregistrerad användare
-- ägarbehörighet innan e-postadressen verifierats. Befintlig ägare behåller
-- sin nuvarande is_admin-data; SUPABASE_USER_ID är serverns enda API-ägarlås.
drop trigger if exists on_profile_admin_check on public.profiles;
drop function if exists public.handle_admin_email();
