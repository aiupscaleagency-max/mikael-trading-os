// ═══════════════════════════════════════════════════════════════════════════
//  SUPABASE — Server-side client (service_role) för per-user-keys
//
//  Backend använder service_role-nyckeln för att läsa user-nycklar
//  utan RLS-begränsning. ALDRIG exponera service_role till frontend.
//
//  Hur det funkar:
//   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY i .env
//   - Backend kan läsa api_keys för valfritt user_id
//   - SUPABASE_USER_ID i .env styr VILKEN user backend kör som
//     (admin = aiupscaleagency-konto, för paper-test idag)
//   - Senare: backend itererar över alla aktiva users och kör per-user
// ═══════════════════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return null;
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

export interface UserApiKeys {
  anthropic?: string;
  binance_key?: string;
  binance_secret?: string;
  perplexity?: string;
  oanda_token?: string;
  oanda_account?: string;
}

// Hämta nycklar för specifik user. Returnerar null om Supabase ej konfigurerad
// (då faller backend tillbaka till .env-nycklar).
export async function getUserKeys(userId: string): Promise<UserApiKeys | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("api_keys")
      .select("anthropic, binance_key, binance_secret, perplexity, oanda_token, oanda_account")
      .eq("user_id", userId)
      .single();
    if (error) {
      log.warn(`[Supabase] Kunde inte hämta nycklar för user ${userId.slice(0, 8)}: ${error.message}`);
      return null;
    }
    return data as UserApiKeys;
  } catch (err) {
    log.warn(`[Supabase] getUserKeys fel: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Kolla om user är admin (för admin-only operationer)
export async function isAdmin(userId: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { data } = await sb.from("profiles").select("is_admin").eq("id", userId).single();
  return data?.is_admin === true;
}

// Hämta alla aktiva users (för multi-user agent-loop senare)
export async function getActiveUsers(): Promise<Array<{ id: string; email: string; tier: string; is_admin: boolean }>> {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from("profiles")
    .select("id, email, tier, is_admin")
    .eq("status", "active");
  if (error) {
    log.warn(`[Supabase] getActiveUsers fel: ${error.message}`);
    return [];
  }
  return data || [];
}
