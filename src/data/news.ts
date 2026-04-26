// Gratis nyhetsdata utan API-nycklar.
//   - Google News RSS: tematisk sökning, returnerar XML
//   - Reddit JSON: top posts per subreddit (passande för r/worldnews,
//     r/geopolitics, r/cryptocurrency, r/stockmarket, m.fl.)
//
// Poängen är att ge Claude råmaterial för egen bedömning — vi tolkar inte
// sentimentet här, bara levererar rubrikerna.

export interface NewsItem {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  summary?: string;
}

// Mycket enkel RSS-parser. Hanterar Google News-formatet specifikt.
// Ingen extern xml-parser → färre beroenden, mindre attackyta.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripCdata(s: string): string {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s);
  return m ? m[1]! : s;
}

function extract(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(block);
  if (!m) return null;
  return decodeHtmlEntities(stripCdata(m[1]!.trim()));
}

function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1]!;
    const title = extract(block, "title");
    if (!title) continue;
    items.push({
      title,
      source: extract(block, "source") ?? "Google News",
      publishedAt: extract(block, "pubDate") ?? "",
      url: extract(block, "link") ?? "",
    });
  }
  return items;
}

/**
 * Söker Google News RSS efter en fri sökfras. Exempel på queries:
 *   "oil prices OPEC"
 *   "Middle East conflict"
 *   "Trump crypto"
 *   "Federal Reserve interest rates"
 */
export async function searchNews(query: string, limit = 10): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; trading-agent/0.1)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, limit);
  } catch {
    return [];
  }
}

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        title?: string;
        created_utc?: number;
        permalink?: string;
        selftext?: string;
        url?: string;
        score?: number;
        num_comments?: number;
      };
    }>;
  };
}

/**
 * Hämtar top-posts från ett subreddit för de senaste 24 timmarna.
 * Relevanta subreddits för denna agent:
 *   worldnews, geopolitics, economics, energy, cryptocurrency,
 *   bitcoin, stockmarket, wallstreetbets
 */
export async function getRedditTop(subreddit: string, limit = 15): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top.json?limit=${limit}&t=day`,
      { headers: { "User-Agent": "trading-agent/0.1 (by /u/anon)" } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as RedditListing;
    const children = data.data?.children ?? [];
    return children
      .map((c) => c.data)
      .filter((d): d is NonNullable<typeof d> => !!d?.title)
      .map((d) => ({
        title: d.title!,
        source: `r/${subreddit} (score ${d.score ?? 0}, ${d.num_comments ?? 0} comments)`,
        publishedAt: d.created_utc
          ? new Date(d.created_utc * 1000).toISOString()
          : "",
        url: d.permalink ? `https://reddit.com${d.permalink}` : d.url ?? "",
        summary: d.selftext && d.selftext.length > 0 ? d.selftext.slice(0, 280) : undefined,
      }));
  } catch {
    return [];
  }
}
