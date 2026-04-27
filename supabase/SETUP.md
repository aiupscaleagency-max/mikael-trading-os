# Supabase Setup — Mikael Trading OS

Detta är **Fas 2: Multi-tenant SaaS**. Varje user har egna API-nycklar (krypterat), egna sessions, egna trades. Row-Level Security säkerställer isolation.

## 1. Skapa Supabase-projekt (gratis)

1. Gå till https://supabase.com/dashboard
2. **Sign up** (Google eller GitHub funkar bra)
3. Klicka **"New Project"**
4. Fyll i:
   - **Name:** `mikael-trading-os`
   - **Database Password:** generera + spara säkert (behövs för psql-direct-access)
   - **Region:** `Europe (Stockholm)` om finns, annars `Europe (Frankfurt)`
   - **Pricing:** **Free** (räcker för 0-100 betalande customers)
5. Klicka **Create** — vänta ~2 min medan db provisionas

## 2. Hämta projekt-credentials

Efter att projektet skapats:
1. Gå till **Project Settings → API** i Supabase Dashboard
2. Kopiera:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public key**: börjar med `eyJ...`
   - **service_role secret**: börjar med `eyJ...` ⚠️ HEMLIG (bara backend, aldrig frontend)

## 3. Sätt encryption-key för API-nyckel-kryptering

API-nycklar (Anthropic, Binance) ska KRYPTERAS i db, inte plaintext. Kör i Supabase SQL Editor:

```sql
-- Generera en 32-tecken random key (gör en gång, spara säkert!)
-- Du kan generera lokalt: openssl rand -hex 16
ALTER DATABASE postgres SET app.settings.encryption_key = 'DIN_32_TECKEN_RANDOM_STRING';
```

Efter detta kan funktionerna `public.encrypt_key()` och `public.decrypt_key()` användas.

## 4. Kör schema-migration

I Supabase Dashboard → **SQL Editor** → **New Query**:

1. Öppna lokalt: `supabase/migrations/0001_init_schema.sql`
2. Kopiera ALLT innehåll
3. Klistra in i SQL Editor
4. Klicka **Run** ▶

Du ska se:
```
Success. No rows returned.
```

Om fel: läs felmeddelande, kontakta mig (Claude) för fix.

## 5. Verifiera tabellerna

Gå till **Table Editor**. Du ska se:
- `profiles`
- `api_keys`
- `user_settings`
- `user_sessions`
- `user_decisions`
- `user_positions`
- `cost_tracking`
- `chat_messages`
- `subscriptions`

Alla ska ha **🔒 RLS enabled** (Row-Level Security).

## 6. Aktivera Email-auth

I Supabase Dashboard → **Authentication → Providers**:
1. **Email** ska vara enabled (är default)
2. Disable **"Confirm email"** för demo-test (aktivera senare i prod)
3. Auth → URL Configuration → sätt **Site URL** till din domän (typ `https://trading.aiupscale.agency` eller `http://localhost:5180`)

## 7. Skicka credentials till Claude

Lägg in följande i `.env` på VPS:en:
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_ENCRYPTION_KEY=DIN_32_TECKEN_KEY
```

Och i frontend `dashboard.html` (Settings):
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

## 8. Klart

Frontend kommer automatiskt:
- Använda Supabase Auth istället för localStorage (om SUPABASE_URL satt)
- Spara API-nycklar krypterat via RPC
- Spara chat, decisions, sessions per user
- RLS säkerställer ingen kan se andras data

Backend (run.ts) läser per-user-nycklar från Supabase istället för .env.

---

## Felsökning

**"app.settings.encryption_key ej satt"** → kör steg 3 ovan.

**"permission denied for table profiles"** → RLS-policy saknas eller user är inte autentiserad. Kolla att auth.uid() returnerar något (testa `select auth.uid();` i SQL Editor när inloggad).

**"new row violates row-level security policy"** → RLS-check failar. Verifiera att user_id i ny rad matchar auth.uid().
