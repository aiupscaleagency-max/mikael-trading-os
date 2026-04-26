// ═══════════════════════════════════════════════════════════════════════════
//  Capitol Trades / Politician Trading Data
//
//  Spårar US Congress-medlemmars aktietransaktioner (STOCK Act disclosures).
//  Primär källa: Capitol Trades HTML-parser (ingen auth).
//  Fallback: House EFDS / Senate EFDS direkt.
//
//  OBS: Trades publiceras med fördröjning (upp till 45 dagar per lag).
//  "Copy trading" politiker = trading på fördröjd info, inte realtid.
//  Edge finns om marknaden inte fullt prisat in informationen under delay.
// ═══════════════════════════════════════════════════════════════════════════

export interface PoliticianTrade {
  politician: string;
  party: string;
  chamber: "House" | "Senate";
  ticker: string;
  assetName: string;
  type: "purchase" | "sale" | "sale_partial" | "sale_full" | "exchange";
  amountRange: string; // "$1,001 - $15,000" etc.
  disclosedAt: string; // ISO date
  tradedAt: string; // ISO date
  daysSinceTraded: number;
  source: string;
}

// Lista av kända top-performande politiker att följa
const TOP_POLITICIANS = [
  "Nancy Pelosi",
  "Michael McCaul",
  "Dan Crenshaw",
  "Tommy Tuberville",
  "Marjorie Taylor Greene",
  "Josh Gottheimer",
  "Ro Khanna",
  "Mark Green",
];

/**
 * Hämtar senaste politician-trades via Capitol Trades RSS/HTML.
 * Capitol Trades: https://www.capitoltrades.com/trades
 * Returnerar de senaste n transaktionerna sorterade nyast-först.
 */
export async function getRecentPoliticianTrades(
  limit = 20,
): Promise<PoliticianTrade[]> {
  const trades: PoliticianTrade[] = [];

  // Försök Capitol Trades "recent" page
  try {
    const url = "https://www.capitoltrades.com/trades?per_page=96&txType=purchase";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; trading-agent/0.1)",
        Accept: "text/html",
      },
    });

    if (res.ok) {
      const html = await res.text();
      const parsed = parseCapitolTradesHtml(html, limit);
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: QuiverQuant (om tillgängligt)
  try {
    const url = "https://api.quiverquant.com/beta/live/congresstrading";
    const res = await fetch(url, {
      headers: { "User-Agent": "trading-agent/0.1" },
    });
    if (res.ok) {
      const data = (await res.json()) as QuiverTrade[];
      for (const t of data.slice(0, limit)) {
        const tradedDate = new Date(t.TransactionDate);
        const daysSince = Math.round((Date.now() - tradedDate.getTime()) / 86400000);
        trades.push({
          politician: t.Representative,
          party: t.Party === "D" ? "Democrat" : t.Party === "R" ? "Republican" : t.Party,
          chamber: t.House === "Senate" ? "Senate" : "House",
          ticker: t.Ticker,
          assetName: t.Asset,
          type: t.Transaction.toLowerCase().includes("purchase") ? "purchase" : "sale",
          amountRange: t.Range,
          disclosedAt: t.ReportDate,
          tradedAt: t.TransactionDate,
          daysSinceTraded: daysSince,
          source: "QuiverQuant",
        });
      }
      return trades;
    }
  } catch {
    // Final fallback
  }

  return trades;
}

/**
 * Filtrerar trades till bara "top performers" — politiker med
 * dokumenterat bra track record.
 */
export function filterTopPerformers(
  trades: PoliticianTrade[],
): PoliticianTrade[] {
  return trades.filter((t) =>
    TOP_POLITICIANS.some(
      (name) => t.politician.toLowerCase().includes(name.toLowerCase()),
    ),
  );
}

/**
 * Filtrerar till bara köp (purchases) — det vi kopierar.
 * Sälj-trades kan användas som varningssignal.
 */
export function filterPurchasesOnly(
  trades: PoliticianTrade[],
): PoliticianTrade[] {
  return trades.filter((t) => t.type === "purchase");
}

// ── Capitol Trades HTML-parser ──

function parseCapitolTradesHtml(
  html: string,
  limit: number,
): PoliticianTrade[] {
  const trades: PoliticianTrade[] = [];

  // Capitol Trades renderar trades i table rows med data-attribut
  // Vi letar efter <tr> mönster som innehåller de relevanta fälten.
  // Notera: HTML-strukturen kan ändras — detta är best-effort.

  // Enkel approach: extrahera ticker-symboler, politiker-namn och typ
  // från repetitiva mönster i HTML.
  const rowPattern =
    /<tr[^>]*class="[^"]*q-tr[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(html)) !== null && trades.length < limit) {
    const row = match[1]!;

    // Extrahera fält ur celler
    const politician = extractCellText(row, "politician") ?? "Unknown";
    const ticker = extractTicker(row);
    if (!ticker) continue;

    const type = row.toLowerCase().includes("purchase") ? "purchase" as const : "sale" as const;
    const amount = extractAmountRange(row);
    const dateStr = extractDate(row);

    const tradedDate = dateStr ? new Date(dateStr) : new Date();
    const daysSince = Math.round((Date.now() - tradedDate.getTime()) / 86400000);

    trades.push({
      politician,
      party: row.includes("democrat") || row.includes("Democrat") ? "Democrat" : "Republican",
      chamber: row.toLowerCase().includes("senate") ? "Senate" : "House",
      ticker,
      assetName: ticker,
      type,
      amountRange: amount ?? "Unknown",
      disclosedAt: new Date().toISOString().slice(0, 10),
      tradedAt: dateStr ?? new Date().toISOString().slice(0, 10),
      daysSinceTraded: daysSince,
      source: "Capitol Trades",
    });
  }

  return trades;
}

function extractCellText(row: string, _field: string): string | null {
  // Politiker-namn: ofta i en <a>-tagg med /politicians/ i href
  const politicianMatch = /\/politicians\/[^"]*"[^>]*>([^<]+)</.exec(row);
  if (politicianMatch) return politicianMatch[1]!.trim();
  return null;
}

function extractTicker(row: string): string | null {
  // Ticker: ofta i en <a>-tagg med /stocks/ i href, eller en span med class "q-field--issuer-ticker"
  const tickerMatch = /\/stocks\/([A-Z]{1,5})[/"']/.exec(row);
  if (tickerMatch) return tickerMatch[1]!;
  const spanMatch = /ticker[^>]*>([A-Z]{1,5})</.exec(row);
  if (spanMatch) return spanMatch[1]!;
  return null;
}

function extractAmountRange(row: string): string | null {
  const match = /\$[\d,]+\s*[-–]\s*\$[\d,]+/.exec(row);
  return match ? match[0] : null;
}

function extractDate(row: string): string | null {
  // ISO-format datum: YYYY-MM-DD
  const match = /(\d{4}-\d{2}-\d{2})/.exec(row);
  return match ? match[1]! : null;
}

// ── Extern typ ──

interface QuiverTrade {
  Representative: string;
  Party: string;
  House: string;
  Ticker: string;
  Asset: string;
  Transaction: string;
  Range: string;
  ReportDate: string;
  TransactionDate: string;
}
