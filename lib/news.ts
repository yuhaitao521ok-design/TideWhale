import { cached, dropCache } from "@/lib/cache";
import {
  dedupeNews,
  hotTickers,
  makeNewsItem,
  matchesQuery,
  parseFeed,
  parseSecFilings,
  type NewsItem,
} from "@/lib/news-parse";
import {
  GOOGLE_COMPANY_QUERY,
  GOOGLE_WORLD_TOPIC_URL,
  NEWS_SOURCES,
  TRUSTED_PUBLISHERS,
  googleNewsUrl,
  secEightKUrl,
  type NewsSource,
} from "@/lib/news-sources";

/**
 * 新闻聚合编排（免 Key、无第三方依赖）。
 *
 *  - 并发抓取所有 RSS / SEC 源，单源 8s 超时、单源失败不影响其它源
 *  - 跨源按标题相似度去重，再按重要度 + 时间排序
 *  - 进程内缓存 60s（stale 宽限 10 分钟），`refresh=1` 强制刷新
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FEED_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
};

const SEC_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/plain, */*",
};

const FETCH_TIMEOUT_MS = 8_000;
const MAX_ITEMS = 220;

export interface NewsSourceStatus {
  id: string;
  name: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface NewsPayload {
  items: NewsItem[];
  filings: NewsItem[];
  hot: { ticker: string; count: number }[];
  sources: NewsSourceStatus[];
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  query: string;
}

type NewsCore = Omit<NewsPayload, "cached" | "stale">;

async function fetchFeedXml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: FEED_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchSecJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: SEC_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** 按源类型与搜索词生成实际地址（Google News 用检索式，SEC 用全文检索） */
export function sourceUrl(source: NewsSource, query: string): string {
  if (source.kind === "sec") return secEightKUrl(query);
  if (source.id === "google-company") {
    return googleNewsUrl(query ? `(${query}) when:7d` : GOOGLE_COMPANY_QUERY);
  }
  if (source.id === "google-world") {
    // 有搜索词时只保留一路 Google News，避免同一批结果重复抓取
    return query ? "" : GOOGLE_WORLD_TOPIC_URL;
  }
  return source.url;
}

async function loadFeedSource(
  source: NewsSource,
  query: string,
  fetchedAt: string,
  statuses: NewsSourceStatus[],
  collected: NewsItem[],
): Promise<void> {
  const url = sourceUrl(source, query);
  if (!url) return;
  const status: NewsSourceStatus = { id: source.id, name: source.name, ok: false, count: 0, ms: 0 };
  const started = Date.now();
  try {
    const xml = await fetchFeedXml(url);
    const entries = parseFeed(xml, url, source.limit, { googleNews: source.id.startsWith("google") });
    const items = entries
      .map((entry) => makeNewsItem(entry, source, fetchedAt))
      .filter((item) => {
        // 公司检索结果只保留主流媒体，过滤不明博客与标题党（世界版来自 topic，质量已足够）
        if (item.sourceId === "google-company" && item.sourceDetail) {
          return TRUSTED_PUBLISHERS.test(item.sourceDetail);
        }
        return true;
      });
    collected.push(...items);
    status.ok = true;
    status.count = items.length;
  } catch (error) {
    status.error = (error as Error)?.message || "请求失败";
  } finally {
    status.ms = Date.now() - started;
    statuses.push(status);
  }
}

async function loadSecSource(
  source: NewsSource,
  query: string,
  fetchedAt: string,
  statuses: NewsSourceStatus[],
  filings: NewsItem[],
): Promise<void> {
  const status: NewsSourceStatus = { id: source.id, name: source.name, ok: false, count: 0, ms: 0 };
  const started = Date.now();
  try {
    const payload = await fetchSecJson(sourceUrl(source, query));
    const items = parseSecFilings(payload, { fetchedAt, keyword: query, limit: source.limit });
    filings.push(...items);
    status.ok = true;
    status.count = items.length;
  } catch (error) {
    status.error = (error as Error)?.message || "请求失败";
  } finally {
    status.ms = Date.now() - started;
    statuses.push(status);
  }
}

async function loadNews(query: string): Promise<NewsCore> {
  const fetchedAt = new Date().toISOString();
  const statuses: NewsSourceStatus[] = [];
  const collected: NewsItem[] = [];
  const filings: NewsItem[] = [];

  await Promise.all(
    NEWS_SOURCES.map((source) =>
      source.kind === "sec"
        ? loadSecSource(source, query, fetchedAt, statuses, filings)
        : loadFeedSource(source, query, fetchedAt, statuses, collected),
    ),
  );

  const okSources = statuses.filter((status) => status.ok).length;
  if (okSources === 0) {
    const firstError = statuses.find((status) => status.error)?.error;
    throw new Error(`新闻源暂时不可用${firstError ? `（${firstError}）` : ""}`);
  }

  const news = query ? collected.filter((item) => matchesQuery(item, query)) : collected;
  const items = dedupeNews(news).slice(0, MAX_ITEMS);
  const filteredFilings = query
    ? filings.filter((item) => matchesQuery(item, query))
    : filings;

  return {
    items,
    filings: filteredFilings,
    hot: hotTickers(items),
    sources: statuses.sort((a, b) => a.name.localeCompare(b.name)),
    fetchedAt,
    query,
  };
}

/** 拉取新闻（带缓存）。`refresh` 会丢弃缓存并重新抓取所有源。 */
export async function getNews(
  options: { query?: string; refresh?: boolean } = {},
): Promise<NewsPayload> {
  const query = (options.query ?? "").trim().slice(0, 80);
  const key = `news:v1:${query || "*"}`;
  if (options.refresh) dropCache(key);
  const result = await cached(key, 90, 900, () => loadNews(query));
  return { ...result.value, cached: result.cached, stale: result.stale };
}
