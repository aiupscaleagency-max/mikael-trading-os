import { log } from "../logger.js";

// ═══════════════════════════════════════════════════════════════════════════
// Telegram bot-bridge — interaktiv kommunikation mellan Mike och agenterna
//
// Funktioner:
//   - sendMessage: skicka HTML-meddelande till Mikes chat
//   - handleUpdate: ta emot inkommande meddelanden, klassa intent, svara
//   - setupWebhook: registrera webhook hos Telegram (anropas vid boot)
//
// Säkerhet: bara meddelanden från ALLOWED_CHAT_ID (Mikes egna) processeras.
// Andra avvisas tyst.
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_CHAT_ID = parseInt(process.env.TELEGRAM_CHAT_ID || "1928144865", 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    message?: TelegramMessage;
    data?: string;
  };
}

// Skicka meddelande till Mike via bot
export async function sendMessage(text: string, opts?: { parseMode?: "HTML" | "Markdown"; replyMarkup?: unknown }): Promise<boolean> {
  if (!BOT_TOKEN) {
    log.warn("TELEGRAM_BOT_TOKEN saknas — kan inte skicka meddelande");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ALLOWED_CHAT_ID,
        text,
        parse_mode: opts?.parseMode || "HTML",
        reply_markup: opts?.replyMarkup,
      }),
    });
    return res.ok;
  } catch (err) {
    log.error(`Telegram sendMessage-fel: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Sätt upp webhook hos Telegram (anropas vid boot)
export async function setupWebhook(publicUrl: string): Promise<boolean> {
  if (!BOT_TOKEN) {
    log.warn("TELEGRAM_BOT_TOKEN saknas — webhook ej konfigurerad");
    return false;
  }
  const webhookUrl = `${publicUrl.replace(/\/$/, "")}/api/telegram/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (data.ok) {
      log.ok(`Telegram-webhook satt: ${webhookUrl}`);
      return true;
    } else {
      log.error(`Telegram-webhook-fel: ${data.description}`);
      return false;
    }
  } catch (err) {
    log.error(`Telegram-webhook-undantag: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Intent-klassning — enkel regex-baserad routing
export type Intent =
  | { type: "buy"; sym: string; amount: number }
  | { type: "sell"; sym: string; amount: number }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "status" }
  | { type: "session_start" }
  | { type: "session_stop" }
  | { type: "ask_agent"; agent: string; question: string }
  | { type: "chat"; question: string }
  | { type: "help" };

export function classifyIntent(text: string): Intent {
  const t = text.trim().toLowerCase();

  // Bekräftelse
  if (/^(ja|yes|y|ok|kör|kor|gör det|do it|confirm)\b/.test(t)) return { type: "confirm" };
  if (/^(nej|no|n|avbryt|cancel|stoppa|skippa)\b/.test(t)) return { type: "cancel" };

  // Status
  if (/^(status|hur går det|hur gar det|läge|sammanfatta|portfolio|positioner)\b/.test(t)) return { type: "status" };

  // Session-styrning
  if (/^(starta|start)\s+session|^kör session|^ny session/.test(t)) return { type: "session_start" };
  if (/^(avsluta|stoppa|sluta)\s+session|^pausa session/.test(t)) return { type: "session_stop" };

  // Help
  if (/^(hjälp|help|kommandon|\/help|\/kommandon)\b/.test(t)) return { type: "help" };
  if (t === "/start") return { type: "help" };

  // Köp / sälj — försök extrahera symbol + belopp
  const buyMatch = t.match(/(köp|kop|buy)\s+([a-z]{2,6})(?:\s|$).*?\$?(\d+)/);
  if (buyMatch && buyMatch[2] && buyMatch[3]) {
    const raw = buyMatch[2].toUpperCase();
    const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
    return { type: "buy", sym, amount: parseInt(buyMatch[3], 10) };
  }
  const sellMatch = t.match(/(sälj|salj|sell|short)\s+([a-z]{2,6})(?:\s|$).*?\$?(\d+)/);
  if (sellMatch && sellMatch[2] && sellMatch[3]) {
    const raw = sellMatch[2].toUpperCase();
    const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
    return { type: "sell", sym, amount: parseInt(sellMatch[3], 10) };
  }

  // Fråga specifik agent (Hanna, Tomas, Karin, Markus, Rasmus, Petra, Sara, Lars, Emma, Albert, Viktor)
  const agentMatch = t.match(/^(hanna|tomas|karin|markus|rasmus|petra|sara|lars|emma|albert|viktor)\s*[,:]?\s+(.+)$/i);
  if (agentMatch && agentMatch[1] && agentMatch[2]) {
    return { type: "ask_agent", agent: agentMatch[1].toLowerCase(), question: agentMatch[2] };
  }

  // Annars: generell chat (skickas till Hanna)
  return { type: "chat", question: text };
}

// Hantera inkommande update från Telegram
export async function handleUpdate(
  update: TelegramUpdate,
  agents: {
    askAgent: (agent: string, question: string) => Promise<string>;
    getStatus: () => Promise<string>;
  },
): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text) return;
  // Säkerhet: bara Mikes chat
  if (msg.chat.id !== ALLOWED_CHAT_ID) {
    log.warn(`Avvisade Telegram-meddelande från okänd chat-id: ${msg.chat.id}`);
    return;
  }

  const intent = classifyIntent(msg.text);
  log.info(`Telegram intent: ${intent.type} ← "${msg.text.slice(0, 60)}"`);

  switch (intent.type) {
    case "help":
      await sendMessage(
        `<b>🎯 Mikael Trading OS — Telegram-kommandon</b>\n\n` +
        `<b>Trading:</b>\n` +
        `• <code>köp BTC $50</code> — starta bevakning (om session aktiv) eller direkt-trade\n` +
        `• <code>sälj ETH $30</code> — short-bevakning / direkt-trade\n` +
        `• <code>JA</code> / <code>NEJ</code> — bekräfta eller avbryt A+ setup\n\n` +
        `<b>Session:</b>\n` +
        `• <code>starta session</code> — ny 5-trade träningssession\n` +
        `• <code>avsluta session</code> — pausa pågående\n\n` +
        `<b>Status:</b>\n` +
        `• <code>status</code> — portfölj + senaste resultat\n\n` +
        `<b>Prata med agenter:</b>\n` +
        `• <code>Hanna, vad tycker du om BTC?</code>\n` +
        `• <code>Tomas, är EMA-cross live på ETH?</code>\n` +
        `• <code>Karin, är det hög volatilitet nu?</code>\n` +
        `• <code>Rasmus, hur är risken i portföljen?</code>\n` +
        `• <code>Viktor, vad gör EUR/USD inför Fed?</code>  ← NY (forex)\n\n` +
        `<i>Du chattar via boten, agenterna är hjärnan.</i>`,
      );
      break;

    case "status": {
      const status = await agents.getStatus();
      await sendMessage(status);
      break;
    }

    case "ask_agent": {
      await sendMessage(`💭 ${capitalize(intent.agent)} tänker...`);
      try {
        const reply = await agents.askAgent(intent.agent, intent.question);
        await sendMessage(`<b>${capitalize(intent.agent)}:</b>\n${reply}`);
      } catch (err) {
        await sendMessage(`❌ Fel: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "chat": {
      await sendMessage(`💭 Hanna tänker...`);
      try {
        const reply = await agents.askAgent("head_trader", intent.question);
        await sendMessage(`<b>Hanna:</b>\n${reply}`);
      } catch (err) {
        await sendMessage(`❌ Fel: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case "buy":
    case "sell":
    case "session_start":
    case "session_stop":
    case "confirm":
    case "cancel":
      // Dessa kräver dashboard-state (sessions, watches) som lever i frontend.
      // Skicka instruktion: kör i dashboard, eller bygg shared backend-state senare.
      await sendMessage(
        `🔄 Kommandot <code>${intent.type}</code> kräver dashboarden just nu.\n\n` +
        `Öppna https://trading.aiupscale.agency och kör där.\n\n` +
        `Direktstyrning från Telegram (utan dashboard) kommer i nästa version.`,
      );
      break;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
