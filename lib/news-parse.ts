import {
  COMPANY_ALIASES,
  COMPANY_TICKERS,
  CRITICAL_ITEMS,
  EIGHT_K_ITEMS,
  EIGHT_K_ITEM_WEIGHT,
  HIGH_SIGNAL_ITEMS,
  type NewsCategory,
  type NewsSource,
} from "@/lib/news-sources";

/**
 * 新闻解析与排序（纯函数，无网络请求，可直接单元测试）。
 *
 * 设计原则：
 *  - 只用容错正则解析 RSS / Atom：新闻源的 XML 经常不规范（未转义 &、CDATA 混用），
 *    用严格 XML 解析器反而更容易整源失败；
 *  - 所有文案在这里只输出「中文原文」，前端统一走 t() 翻译；
 *  - 服务端与客户端共用类型，客户端不 import 运行时函数以外的服务端依赖。
 */

export interface NewsFiling {
  company: string;
  ticker: string | null;
  items: string[];
  accession: string;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  sourceId: string;
  source: string;
  /** Google News 聚合时的原始媒体名（用于展示与白名单过滤） */
  sourceDetail?: string;
  /** 本地化后的英文原文（用于悬停对照，仅翻译时存在） */
  titleOriginal?: string;
  summaryOriginal?: string;
  category: NewsCategory;
  publishedAt: string;
  tickers: string[];
  score: number;
  hot: boolean;
  filing?: NewsFiling;
}

export interface ParsedEntry {
  title: string;
  link: string;
  summary: string;
  publishedAt: string | null;
  /** Google News 的 <source>：原始媒体名（Reuters / WSJ…） */
  sourceName?: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
};

/** 解码 HTML / XML 实体（含数字实体），未知实体保持原样 */
export function decodeEntities(text: string): string {
  if (!text) return "";
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const value = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (code.startsWith("#")) {
      const value = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** 去掉 HTML 标签、脚本与多余空白，得到纯文本摘要 */
export function stripHtml(input: string): string {
  if (!input) return "";
  let text = input.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  // 源站常见二次转义（&amp;nbsp;）：解码两轮再剥标签
  text = decodeEntities(decodeEntities(text));
  text = text.replace(/<[^>]*>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function unwrapCdata(value: string): string {
  const match = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return match ? match[1] : value;
}

/** 按顺序取第一个存在的标签内容（RSS 与 Atom 的字段名不同） */
function readTag(block: string, tags: string[]): string {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) return unwrapCdata(match[1]).trim();
  }
  return "";
}

/** 解析 <link>：RSS 是文本节点，Atom 是 rel="alternate" 的 href 属性 */
function readLink(block: string, baseUrl: string): string {
  // RSS：<link>https://…</link>（也可能包一层 CDATA）
  const textLink = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (textLink) {
    const raw = unwrapCdata(textLink[1]).trim();
    if (raw && !raw.startsWith("<")) return absolutize(decodeEntities(raw), baseUrl);
  }

  const anchors = block.match(/<link\b[^>]*\/?>/gi) ?? [];
  let fallback = "";
  for (const anchor of anchors) {
    const href = anchor.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    const rel = anchor.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (href) {
      if (!rel || rel === "alternate") return absolutize(decodeEntities(href), baseUrl);
      fallback = fallback || href;
      continue;
    }
    const text = anchor.replace(/<[^>]*>/g, "").trim();
    if (text) return absolutize(decodeEntities(text), baseUrl);
  }
  if (fallback) return absolutize(decodeEntities(fallback), baseUrl);
  return "";
}

function absolutize(link: string, baseUrl: string): string {
  if (!link) return "";
  if (/^https?:\/\//i.test(link)) return link;
  if (!baseUrl) return link;
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return link;
  }
}

/** 解析 RSS 2.0 / Atom，返回最多 limit 条原始条目 */
export function parseFeed(
  xml: string,
  baseUrl = "",
  limit = 40,
  options: { googleNews?: boolean } = {},
): ParsedEntry[] {
  if (!xml) return [];
  const blocks = [
    ...(xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/gi) ?? []).map((chunk) =>
      chunk.replace(/^<item\b[^>]*>/i, "").replace(/<\/item>$/i, ""),
    ),
    ...(xml.match(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi) ?? []).map((chunk) =>
      chunk.replace(/^<entry\b[^>]*>/i, "").replace(/<\/entry>$/i, ""),
    ),
  ];

  const entries: ParsedEntry[] = [];
  for (const block of blocks) {
    const sourceName = stripHtml(readTag(block, ["source"]));
    let title = stripHtml(readTag(block, ["title"]));
    // Google News 的标题固定带「 - 来源」后缀，去掉后与原始标题一致
    if (options.googleNews) {
      const suffix = sourceName ? ` - ${sourceName}` : "";
      if (suffix && title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
    const link = readLink(block, baseUrl);
    const summary = stripHtml(
      readTag(block, ["description", "summary", "content:encoded", "content"]),
    ).slice(0, 480);
    const rawDate = readTag(block, ["pubDate", "published", "updated", "dc:date"]);
    const publishedAt = rawDate ? toIso(rawDate) : null;
    if (!title || !link) continue;
    entries.push({ title, link, summary, publishedAt, sourceName: sourceName || undefined });
    if (entries.length >= limit) break;
  }
  return entries;
}

/** 宽松时间解析：RFC822 / ISO 都能处理；非法值返回 null */
export function toIso(value: string): string | null {
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) return null;
  // 有些源会给出未来时间（时区标注错误），夹到当前时刻避免「3 小时后」
  return new Date(Math.min(timestamp, Date.now())).toISOString();
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "as",
  "at",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "has",
  "have",
  "had",
  "it",
  "its",
  "this",
  "that",
  "after",
  "over",
  "says",
  "say",
  "new",
  "up",
  "down",
  "amid",
  "into",
  "about",
  "will",
  "can",
  "could",
  "may",
  "than",
  "then",
  "more",
  "most",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标题分词（去停用词、去标点、小写），用于跨源去重 */
export function titleTokens(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
  return new Set(
    cleaned
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

/** Jaccard 相似度：0（完全不同）~ 1（完全相同） */
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** 稳定的短 id（djb2），避免把完整 URL 当 React key */
export function hashId(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

const EXPLICIT_TICKER_PATTERNS = [
  /\b(?:NASDAQ|NYSE|AMEX|NYSEARCA)\s*:\s*([A-Z]{1,5})\b/g,
  /\$([A-Z]{2,5})\b/g,
];

/** 从标题/摘要里识别相关标的（显式代码 + 公司名），最多 6 个 */
export function extractTickers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  for (const pattern of EXPLICIT_TICKER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const ticker = match[1];
      if (COMPANY_TICKERS.has(ticker) || ticker.length >= 3) found.add(ticker);
    }
  }

  for (const company of COMPANY_ALIASES) {
    for (const alias of [company.name, ...company.aliases]) {
      if (alias.length < 3) continue;
      if (new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text)) {
        found.add(company.ticker);
        break;
      }
    }
  }

  return [...found].slice(0, 6);
}

const WORLD_PATTERNS = [
  /\b(war|warfare|military|troops|missile|airstrike|invasion|ceasefire|sanctions|embargo|coup|protest|earthquake|hurricane|wildfire|flood|refugee|NATO|United Nations|Gaza|Ukraine|Taiwan|North Korea|Venezuela|Middle East)\b/i,
];

/** 是否为国际 / 突发事件类标题（用于过滤 Google News 的泛化结果） */
export function isWorldHeadline(text: string): boolean {
  return WORLD_PATTERNS.some((pattern) => pattern.test(text));
}

const MACRO_PATTERNS = [
  /\b(Federal Reserve|FOMC|inflation|CPI|PPI|jobs report|nonfarm|payrolls|GDP|recession|rate cut|rate hike|Treasury yield|bond yield|debt ceiling|government shutdown|consumer confidence|tariff)\b/i,
];

const COMPANY_PATTERNS = [
  /\b(earnings|revenue|guidance|forecast|CEO|CFO|board|shareholders|acquisition|merger|takeover|buyback|IPO|lawsuit|antitrust|recall|layoffs|bankruptcy|FDA)\b/i,
];

/** 分类：源默认分类 + 标题关键词覆盖（国际 > 宏观 > 公司 > 默认） */
export function classifyCategory(defaultCategory: NewsCategory, text: string): NewsCategory {
  if (defaultCategory === "filing") return "filing";
  const isCompany = COMPANY_PATTERNS.some((pattern) => pattern.test(text));
  if (defaultCategory === "world") return "world";
  if (!isCompany && WORLD_PATTERNS.some((pattern) => pattern.test(text))) return "world";
  if (MACRO_PATTERNS.some((pattern) => pattern.test(text))) return "macro";
  if (isCompany) return "company";
  return defaultCategory;
}

const BREAKING_PATTERNS =
  /\b(breaking|urgent|halted|plunges|surges|soars|tumbles|bankruptcy|recall|probe|investigation|layoffs|resigns|steps down|acquisition|merger|takeover|approval|outage|hack|data breach|default|downgrade|upgrade|exclusive)\b/i;

/** 技术面流水线（分析师目标价 / 均线穿越）与个人理财专栏价值低，降权避免挤占突发位 */
const LOW_VALUE_PATTERNS =
  /\b(analyst target|crosses above|crosses below|moving average|52-week (high|low)|price target|technical analysis|should you buy|better buy|is it time to buy|millionaire|retire early|my husband|my wife|my children|how can i)\b/i;

/** 新闻重要度：来源权重 + 突发词 + 相关标的 + 时效 - 低价值内容 */
export function scoreNews(input: {
  weight: number;
  text: string;
  tickers: string[];
  publishedAt: string;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const ageMinutes = Math.max(0, (now - Date.parse(input.publishedAt)) / 60_000);
  let score = input.weight;
  if (BREAKING_PATTERNS.test(input.text)) score += 4;
  if (input.tickers.length > 0) score += 2;
  if (ageMinutes <= 60) score += 2;
  else if (ageMinutes <= 180) score += 1;
  else if (ageMinutes > 24 * 60) score -= 2;
  if (LOW_VALUE_PATTERNS.test(input.text) && input.tickers.length === 0) score -= 3;
  return Math.round(score * 10) / 10;
}

/** 按重要度排序后跨源去重（同链接或标题高度相似只保留一条） */
export function dedupeNews(items: NewsItem[], threshold = 0.86): NewsItem[] {
  const ordered = [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });

  const kept: NewsItem[] = [];
  const keptTokens: Set<string>[] = [];
  const seenUrls = new Set<string>();

  for (const item of ordered) {
    const urlKey = item.url.split("?")[0];
    if (urlKey && seenUrls.has(urlKey)) continue;
    const tokens = titleTokens(item.title);
    const duplicate = keptTokens.some((existing) => titleSimilarity(existing, tokens) >= threshold);
    if (duplicate) continue;
    kept.push(item);
    keptTokens.push(tokens);
    if (urlKey) seenUrls.add(urlKey);
  }

  return kept;
}

/**
 * Google News 等源的 description 常是「标题 + 来源」，与标题重复。
 * 摘要包含标题或反过来时直接丢弃，避免卡片上下两行说同一句话。
 */
export function cleanSummary(title: string, summary: string): string {
  const normalizedTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedSummary = summary.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedSummary || !normalizedTitle) return summary;
  if (normalizedSummary === normalizedTitle) return "";
  if (normalizedSummary.startsWith(normalizedTitle)) return "";
  if (normalizedTitle.startsWith(normalizedSummary)) return "";
  const head = normalizedSummary.slice(0, Math.max(60, normalizedTitle.length));
  if (head.includes(normalizedTitle)) return "";
  return summary;
}

/** 把一条 RSS 条目转换成统一的 NewsItem（含分类 / 标的 / 重要度） */
export function makeNewsItem(
  entry: ParsedEntry,
  source: NewsSource,
  fetchedAt: string,
): NewsItem {
  const publishedAt = entry.publishedAt ?? fetchedAt;
  const text = `${entry.title} ${entry.summary}`;
  const tickers = extractTickers(text);
  const category = classifyCategory(source.category, text);
  const score = scoreNews({ weight: source.weight, text, tickers, publishedAt });
  // Google News 是聚合器：徽标展示真实媒体名，便于判断可信度
  const publisher = source.id.startsWith("google") ? entry.sourceName?.trim() : undefined;
  return {
    id: hashId(entry.link || entry.title),
    title: entry.title.replace(/\s+/g, " ").trim(),
    // Nasdaq 等源的摘要以「Key Points」开头且与后文粘连，去掉这个前缀
    summary: cleanSummary(
      entry.title,
      entry.summary.replace(/^Key Points\s*/i, "").trim(),
    ),
    url: entry.link,
    sourceId: source.id,
    source: publisher || source.name,
    sourceDetail: publisher || undefined,
    category,
    publishedAt,
    tickers,
    score,
    hot: score >= 13,
  };
}

/** 是否命中搜索词（标题 / 摘要 / 来源，多词 AND，不区分大小写） */
export function matchesQuery(item: NewsItem, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${item.title} ${item.summary} ${item.source} ${item.tickers.join(" ")}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** 新闻里出现次数最多的标的（右栏「热门标的」） */
export function hotTickers(items: NewsItem[], size = 8): { ticker: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const ticker of item.tickers) counts.set(ticker, (counts.get(ticker) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([ticker, count]) => ({ ticker, count }))
    .sort((a, b) => b.count - a.count || a.ticker.localeCompare(b.ticker))
    .slice(0, size);
}

interface SecHit {
  _id?: string;
  _source?: {
    display_names?: unknown;
    file_date?: unknown;
    items?: unknown;
    ciks?: unknown;
  };
}

/** 解析 SEC display_names：`Apple Inc.  (AAPL)  (CIK 0000320193)` */
export function parseDisplayName(display: string): { company: string; ticker: string | null } {
  const withTicker = display.match(/^(.*?)\s*\(([^()]*)\)\s*\(CIK\s*\d+\)/);
  if (withTicker) {
    const ticker = withTicker[2].split(",")[0]?.trim() || null;
    return { company: withTicker[1].trim(), ticker };
  }
  const plain = display.match(/^(.*?)\s*\(CIK\s*\d+\)/);
  if (plain) return { company: plain[1].trim(), ticker: null };
  return { company: display.trim(), ticker: null };
}

function secFilingUrl(accession: string, cik: string): string {
  const cikNumber = Number.parseInt(cik, 10);
  const safeCik = Number.isFinite(cikNumber) ? String(cikNumber) : cik;
  return `https://www.sec.gov/Archives/edgar/data/${safeCik}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

/**
 * 解析 EDGAR full-text search 响应 → 8-K 快讯。
 *  - 大公司（COMPANY_TICKERS）或含高信号事项的备案才保留，过滤掉海量小公司例行 8-K
 *  - 标题只放公司名，事项标签由前端用 EIGHT_K_ITEMS + t() 渲染
 */
export function parseSecFilings(
  payload: unknown,
  options: { fetchedAt: string; keyword?: string; limit?: number },
): NewsItem[] {
  const hits = (payload as { hits?: { hits?: SecHit[] } } | null)?.hits?.hits ?? [];
  const keyword = (options.keyword ?? "").trim();
  const limit = options.limit ?? 20;
  const results: NewsItem[] = [];

  for (const hit of hits) {
    const source = hit._source ?? {};
    const display = Array.isArray(source.display_names) ? String(source.display_names[0] ?? "") : "";
    if (!display) continue;

    const { company, ticker } = parseDisplayName(display);
    const codes = Array.isArray(source.items)
      ? source.items.filter((code): code is string => typeof code === "string")
      : [];
    const signals = codes.filter((code) => HIGH_SIGNAL_ITEMS.has(code));
    const isBigCompany = ticker !== null && COMPANY_TICKERS.has(ticker);
    const critical = codes.some((code) => CRITICAL_ITEMS.has(code));
    // 大公司：所有高信号事项；小公司：只保留破产 / 收购 / 退市 / 控制权变更等真正重大的事件。
    // 有搜索词时按用户意图返回全部命中。
    if (!isBigCompany && !critical && !keyword) continue;

    const accession = typeof hit._id === "string" ? hit._id.split(":")[0] : "";
    if (!accession) continue;
    const cik = Array.isArray(source.ciks) ? String(source.ciks[0] ?? "") : "";
    const fileDate = typeof source.file_date === "string" ? source.file_date : "";
    const publishedAt = /^\d{4}-\d{2}-\d{2}$/.test(fileDate)
      ? `${fileDate}T12:00:00.000Z`
      : options.fetchedAt;

    const impact = Math.max(0, ...codes.map((code) => EIGHT_K_ITEM_WEIGHT[code] ?? 0));
    const score = 10 + impact + (isBigCompany ? 2 : 0) + Math.min(3, signals.length);
    const labels = codes.map((code) => EIGHT_K_ITEMS[code]).filter((label): label is string => Boolean(label));

    results.push({
      id: `sec-${accession}`,
      title: company,
      summary: labels.join(" · "),
      url: secFilingUrl(accession, cik),
      sourceId: "sec-8k",
      source: "SEC EDGAR",
      category: "filing",
      publishedAt,
      tickers: ticker ? [ticker] : [],
      score,
      hot: isBigCompany && impact >= 4,
      filing: { company, ticker, items: codes, accession },
    });

    if (results.length >= limit) break;
  }

  return results.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
