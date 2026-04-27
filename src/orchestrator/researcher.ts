// ═══════════════════════════════════════════════════════════════════════════
//  LARS — Research-Analytiker (Perplexity)
//
//  Lars körs FÖRST i varje session. Han hämtar färska nyheter, makrohändelser
//  och geopolitisk info via Perplexity Sonar API och förser resten av teamet
//  med kontext de inte hade kommit åt själva (Claude-agenter har inte realtids-
//  webbåtkomst).
//
//  Modell: Perplexity Sonar Pro (~$1/Mtok in, $1/Mtok out, ca $0.005/anrop)
//  Schema: 2x per dag = ~$0.07/vecka
// ═══════════════════════════════════════════════════════════════════════════

import { log } from "../logger.js";
import { trackPerplexityCall } from "../cost/tracker.js";

export interface ResearchReport {
  role: "researcher";
  available: boolean;
  marketSummary: string;     // 2-3 meningar om senaste 12h
  cryptoNews: string[];      // Top 3-5 crypto-nyheter
  macroEvents: string[];     // Top 3 makro-händelser (Fed, ECB, CPI...)
  geopolitical: string[];    // Krig, sanktioner, geopolitik
  riskAlerts: string[];      // Specifika varningar (token-hack, regulation, market-cracks)
  sources: string[];         // URLs som Perplexity refererade
  rawText: string;
}

const PROMPT = `Du är en research-analytiker i ett crypto/forex trading-team. Det är ${new Date().toISOString().slice(0,10)}.

Sök och sammanställ INFORMATION FRÅN SENASTE 12 TIMMARNA om:
1. Crypto-marknaden: stora pris-rörelser (BTC, ETH, SOL, top-15 alts), token-nyheter, ETF-flöden, on-chain-händelser
2. Makro: Fed/ECB-policy, CPI-data, jobs-data, räntebeslut, dollar-styrka, oljepris, VIX
3. Geopolitik: krig (Ukraina, Mellanöstern, Taiwan), sanktioner, regulering (SEC, MiCA), valutakris
4. Risk-alerts: hackerattacker, exchange-issues, stablecoin-depegs, specifika token-risker

Svara i EXAKT detta JSON-format (BARA JSON, inget annat):
{
  "marketSummary": "2-3 meningar: vad är viktigaste utvecklingen senaste 12h?",
  "cryptoNews": ["nyhet 1", "nyhet 2", "nyhet 3"],
  "macroEvents": ["händelse 1", "händelse 2", "händelse 3"],
  "geopolitical": ["händelse 1", "händelse 2"],
  "riskAlerts": ["alert 1 om sådan finns, annars tom array"]
}

Var konkret. Med datum/tid om relevant. Inga "kanske/möjligen". Källa via citation.`;

export async function runResearcher(apiKey: string): Promise<ResearchReport> {
  if (!apiKey) {
    log.warn("[Lars] Perplexity API-nyckel saknas — research-agent inaktiv.");
    return {
      role: "researcher",
      available: false,
      marketSummary: "Research ej tillgänglig (Perplexity-nyckel saknas).",
      cryptoNews: [],
      macroEvents: [],
      geopolitical: [],
      riskAlerts: [],
      sources: [],
      rawText: "",
    };
  }

  log.agent("[Team] Lars (Research-Analytiker) startar…");

  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "Du är en research-analytiker som svarar med korrekt JSON enligt instruktion." },
          { role: "user", content: PROMPT },
        ],
        max_tokens: 1500,
        temperature: 0.2,
        return_citations: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Perplexity ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      citations?: string[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (data.usage) {
      trackPerplexityCall("research", data.usage.prompt_tokens ?? 0, data.usage.completion_tokens ?? 0).catch(() => {});
    }

    const content = data.choices?.[0]?.message?.content ?? "";

    // Försök extrahera JSON ur svaret (Perplexity kan ibland slänga med text runt JSONen).
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Inget JSON i Perplexity-svaret.");
    }

    const parsed = JSON.parse(jsonMatch[0]) as Omit<ResearchReport, "role" | "available" | "sources" | "rawText">;

    log.agent(
      `[Lars] ${parsed.cryptoNews?.length ?? 0} crypto-nyheter, ${parsed.macroEvents?.length ?? 0} makro, ${parsed.riskAlerts?.length ?? 0} risk-alerts`,
    );

    return {
      role: "researcher",
      available: true,
      marketSummary: parsed.marketSummary ?? "",
      cryptoNews: parsed.cryptoNews ?? [],
      macroEvents: parsed.macroEvents ?? [],
      geopolitical: parsed.geopolitical ?? [],
      riskAlerts: parsed.riskAlerts ?? [],
      sources: data.citations ?? [],
      rawText: content,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[Lars] Research kraschade: ${msg}`);
    return {
      role: "researcher",
      available: false,
      marketSummary: `Research misslyckades: ${msg}`,
      cryptoNews: [],
      macroEvents: [],
      geopolitical: [],
      riskAlerts: [],
      sources: [],
      rawText: "",
    };
  }
}

// Hjälper specialisterna konsumera research som textkontext.
export function formatResearchForPrompt(report: ResearchReport): string {
  if (!report.available) return "(Research ej tillgänglig — kör utan färsk webbkontext)";
  return [
    `═══ FÄRSK RESEARCH (Lars / Perplexity, senaste 12h) ═══`,
    `Sammanfattning: ${report.marketSummary}`,
    report.cryptoNews.length ? `Crypto-nyheter:\n${report.cryptoNews.map((n) => `  • ${n}`).join("\n")}` : "",
    report.macroEvents.length ? `Makro:\n${report.macroEvents.map((n) => `  • ${n}`).join("\n")}` : "",
    report.geopolitical.length ? `Geopolitik:\n${report.geopolitical.map((n) => `  • ${n}`).join("\n")}` : "",
    report.riskAlerts.length ? `⚠ Risk-alerts:\n${report.riskAlerts.map((n) => `  • ${n}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
