-- ═══════════════════════════════════════════════════════════════════════════
--  MIKAEL TRADING OS — Initial Schema
--
--  Multi-tenant: varje user har egna API-nycklar, settings, decisions, sessions.
--  Row-Level Security (RLS) säkerställer att ingen kan se andras data.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── EXTENSIONS ──
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";  -- för symmetric encryption av API-nycklar

-- ═══════════════════════════════════════════════════════════════════════════
--  USERS — kompletterar auth.users (Supabase managed) med våra fält
-- ═══════════════════════════════════════════════════════════════════════════
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text,
  tier text not null default 'family' check (tier in ('family','starter','pro','enterprise')),
  status text not null default 'active' check (status in ('active','suspended','cancelled')),
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-skapa profil när Supabase auth-user skapas
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ═══════════════════════════════════════════════════════════════════════════
--  API_KEYS — krypterade per-user-nycklar (Anthropic, Binance, Perplexity, Oanda)
-- ═══════════════════════════════════════════════════════════════════════════
create table public.api_keys (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  -- Krypterade fält (pgcrypto + master key från env). Aldrig plaintext i db.
  anthropic_encrypted bytea,
  binance_key_encrypted bytea,
  binance_secret_encrypted bytea,
  perplexity_encrypted bytea,
  oanda_token_encrypted bytea,
  oanda_account text,  -- ej känsligt, bara id-string
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Helper-funktioner: encrypt/decrypt med master key (sätts via Supabase secret)
-- OBS: master_key måste sättas via Supabase Dashboard → Project Settings → Vault
create or replace function public.encrypt_key(plaintext text)
returns bytea
language plpgsql
security definer
as $$
declare
  master_key text;
begin
  master_key := current_setting('app.settings.encryption_key', true);
  if master_key is null or master_key = '' then
    raise exception 'app.settings.encryption_key ej satt — kör: ALTER DATABASE postgres SET app.settings.encryption_key = ''<32-char-string>''';
  end if;
  return pgp_sym_encrypt(plaintext, master_key);
end;
$$;

create or replace function public.decrypt_key(ciphertext bytea)
returns text
language plpgsql
security definer
as $$
declare
  master_key text;
begin
  if ciphertext is null then return null; end if;
  master_key := current_setting('app.settings.encryption_key', true);
  return pgp_sym_decrypt(ciphertext, master_key);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
--  USER_SETTINGS — per-user trading-config (mode, risk, symbols osv)
-- ═══════════════════════════════════════════════════════════════════════════
create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  mode text not null default 'paper' check (mode in ('paper','live')),
  execution_mode text not null default 'auto' check (execution_mode in ('auto','approve')),
  default_position_usd numeric not null default 50,
  min_position_usd numeric not null default 20,
  max_position_usd numeric not null default 100,
  max_total_exposure_usd numeric not null default 500,
  max_daily_loss_usd numeric not null default 50,
  max_open_positions int not null default 5,
  max_daily_spend_usd numeric not null default 2,
  max_weekly_spend_usd numeric not null default 10,
  crypto_symbols text[] not null default ARRAY['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','DOTUSDT','LINKUSDT','MATICUSDT','UNIUSDT','LTCUSDT','ATOMUSDT','NEARUSDT'],
  forex_symbols text[] not null default ARRAY['EUR_USD','GBP_USD','USD_JPY','USD_CHF','AUD_USD','USD_CAD','EUR_GBP'],
  loop_interval_seconds int not null default 43200,
  kill_switch_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
--  USER_SESSIONS — varje agent-turn user kör (logg)
-- ═══════════════════════════════════════════════════════════════════════════
create table public.user_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'running' check (status in ('running','completed','failed')),
  trigger text not null default 'scheduled' check (trigger in ('scheduled','manual','chat')),
  user_instruction text,  -- om manuell trigger via chat
  total_cost_usd numeric default 0,
  decision text,  -- BUY/SELL/HOLD
  reports jsonb,  -- alla rapporter från specialisterna
  error text
);
create index idx_user_sessions_user_started on public.user_sessions(user_id, started_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
--  USER_DECISIONS — varje BUY/SELL/HOLD beslut
-- ═══════════════════════════════════════════════════════════════════════════
create table public.user_decisions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.user_sessions(id) on delete cascade,
  timestamp timestamptz not null default now(),
  mode text not null,
  action text not null check (action in ('buy','sell','hold')),
  symbol text,
  size_usd numeric,
  reasoning text,
  tool_calls jsonb,
  order_result jsonb
);
create index idx_user_decisions_user_time on public.user_decisions(user_id, timestamp desc);

-- ═══════════════════════════════════════════════════════════════════════════
--  USER_POSITIONS — aktiva positioner per user
-- ═══════════════════════════════════════════════════════════════════════════
create table public.user_positions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  broker text not null,  -- 'binance' / 'oanda'
  symbol text not null,
  quantity numeric not null,
  avg_entry_price numeric not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  realized_pnl_usdt numeric,
  status text not null default 'open' check (status in ('open','closed'))
);
create index idx_user_positions_user_status on public.user_positions(user_id, status);
create unique index uq_user_positions_open_symbol on public.user_positions(user_id, broker, symbol) where status = 'open';

-- ═══════════════════════════════════════════════════════════════════════════
--  COST_TRACKING — varje Claude/Perplexity-anrop loggas (för billing + caps)
-- ═══════════════════════════════════════════════════════════════════════════
create table public.cost_tracking (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.user_sessions(id) on delete cascade,
  timestamp timestamptz not null default now(),
  agent text not null,  -- 'macro', 'advisor', 'head', etc
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric not null default 0
);
create index idx_cost_user_time on public.cost_tracking(user_id, timestamp desc);

-- ═══════════════════════════════════════════════════════════════════════════
--  CHAT_MESSAGES — team chat historik per user (delas mellan widget + Chat-sida)
-- ═══════════════════════════════════════════════════════════════════════════
create table public.chat_messages (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('user','team','system')),
  content text not null,
  timestamp timestamptz not null default now(),
  instruction text,  -- den ursprungliga instruktionen om team-svar
  metadata jsonb
);
create index idx_chat_user_time on public.chat_messages(user_id, timestamp desc);

-- ═══════════════════════════════════════════════════════════════════════════
--  SUBSCRIPTIONS — Stripe-billing per user
-- ═══════════════════════════════════════════════════════════════════════════
create table public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tier text not null check (tier in ('family','starter','pro','enterprise')),
  status text not null check (status in ('active','past_due','cancelled','trialing')),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  current_period_start timestamptz,
  current_period_end timestamptz,
  decisions_used_this_month int not null default 0,
  decisions_limit int,  -- NULL = unlimited (Enterprise)
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
--  ROW-LEVEL SECURITY (RLS) — varje user ser bara sina egna data
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.user_settings enable row level security;
alter table public.user_sessions enable row level security;
alter table public.user_decisions enable row level security;
alter table public.user_positions enable row level security;
alter table public.cost_tracking enable row level security;
alter table public.chat_messages enable row level security;
alter table public.subscriptions enable row level security;

-- Profiles: user kan läsa + uppdatera sin egen
create policy "users read own profile" on public.profiles
  for select using (auth.uid() = id);
create policy "users update own profile" on public.profiles
  for update using (auth.uid() = id);

-- Per-user-tabeller: user äger bara sina rader
create policy "users own their api_keys" on public.api_keys
  for all using (auth.uid() = user_id);
create policy "users own their settings" on public.user_settings
  for all using (auth.uid() = user_id);
create policy "users own their sessions" on public.user_sessions
  for all using (auth.uid() = user_id);
create policy "users own their decisions" on public.user_decisions
  for all using (auth.uid() = user_id);
create policy "users own their positions" on public.user_positions
  for all using (auth.uid() = user_id);
create policy "users own their cost_tracking" on public.cost_tracking
  for all using (auth.uid() = user_id);
create policy "users own their chat_messages" on public.chat_messages
  for all using (auth.uid() = user_id);
create policy "users read own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
--  AUTO-INIT: skapa user_settings + subscription när profil skapas
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.init_user_defaults()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.user_settings (user_id) values (new.id);
  insert into public.subscriptions (user_id, tier, status)
    values (new.id, 'family', 'active');
  return new;
end;
$$;

create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.init_user_defaults();
