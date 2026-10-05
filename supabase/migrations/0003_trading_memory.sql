-- Tradingminne: en rad per analys (Trading OS). Bara backend (service_role) skriver/läser.
create table if not exists public.trading_memory (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  trigger text not null,
  symbols text[] not null default '{}',
  decision text not null,
  note text,
  signals jsonb not null default '[]',
  jev_stopped jsonb not null default '[]',
  proposals jsonb not null default '[]',
  summary text,
  created_at timestamptz not null default now()
);
create index if not exists trading_memory_at_idx on public.trading_memory (at desc);
alter table public.trading_memory enable row level security;
