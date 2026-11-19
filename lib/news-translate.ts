import { chat, hasLlmConfig } from "@/lib/llm";
import { hashId, type NewsItem } from "@/lib/news-parse";

/**
 * 新闻标题 / 摘要翻译（跟随界面语言）。
 *
 * 渠道优先级（全部失败时保留英文原文，不阻塞页面）：
 *  1. llm       —— 复用现有 LLM Key（质量最好，支持繁简），`NEWS_TRANSLATE_PROVIDER=llm`
 *  2. google    —— translate.googleapis.com 的 dict-chrome-ex 端点（免 Key，可批量）
 *  3. mymemory  —— MyMemory 公共接口（免 Key，`|||` 分隔批量，配额有限）
 *
 * 设计要点：
 *  - 只翻译标题与摘要（摘要截断 240 字），公司名 / 代码 / SEC 8-K 保留原文
 *  - 条目级缓存 6 小时（key = 语言 + 原文 hash），同一条新闻不会重复翻译
 *  - 语言切换只影响翻译层，不会重复抓取 11 个新闻源
 */

export type NewsLocale = "zh-Hans" | "zh-Hant";
export type TranslateProvider = "llm" | "google" | "mymemory" | "none";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const GOOGLE_TIMEOUT_MS = 6_000;
const MYMEMORY_TIMEOUT_MS = 8_000;
const SUMMARY_LIMIT = 160;
/** 只为前 N 条新闻翻译摘要（首屏），其余保留英文摘要以控制耗时 */
const SUMMARY_ITEM_LIMIT = 40;
/** 单次请求的翻译总预算，超过后保留未翻译原文 */
const LOCALIZE_DEADLINE_MS = 6_000;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const CACHE_MAX_ENTRIES = 4000;

const BATCH_SIZE: Record<TranslateProvider, number> = {
  llm: 15,
  google: 12,
  mymemory: 6,
  none: 1,
};

interface CacheEntry {
  value: string;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 仅测试使用 */
export function clearTranslateCache(): void {
  cache.clear();
}

export function isTranslatableLocale(locale: string): locale is NewsLocale {
  return locale === "zh-Hans" || locale === "zh-Hant";
}

export function translationTarget(locale: NewsLocale): "zh-CN" | "zh-TW" {
  return locale === "zh-Hant" ? "zh-TW" : "zh-CN";
}

export function resolveTranslateProvider(
  env: Record<string, string | undefined> = process.env,
): TranslateProvider {
  const raw = (env.NEWS_TRANSLATE_PROVIDER || "google").trim().toLowerCase();
  if (raw === "off" || raw === "none") return "none";
  if (raw === "llm") return "llm";
  if (raw === "mymemory") return "mymemory";
  return "google";
}

function cacheKey(locale: NewsLocale, text: string): string {
  return `${locale}:${hashId(text)}`;
}

function readCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expireAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCached(key: string, value: string): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
}

export function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

/** 从 LLM 输出里提取 JSON 字符串数组（容错 Markdown 代码块与前后解释） */
export function parseTranslatedArray(content: string, expected: number): string[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("LLM 未返回 JSON 数组");
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (!Array.isArray(parsed) || parsed.length !== expected) {
    throw new Error("LLM 返回条数不匹配");
  }
  const values = parsed.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (values.some((value) => !value)) throw new Error("LLM 返回了空翻译");
  return values;
}

export type BatchTranslator = (texts: string[], locale: NewsLocale) => Promise<string[]>;

/** 解析 Google dict-chrome-ex 响应（单条时可能多包一层数组） */
export function parseGoogleTranslations(data: unknown, expected: number): string[] {
  const flat =
    Array.isArray(data) && data.length === 1 && Array.isArray(data[0]) ? (data[0] as unknown[]) : data;
  if (!Array.isArray(flat) || flat.length !== expected) {
    throw new Error("翻译结果条数不匹配");
  }
  const values = flat.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (values.some((value) => !value)) throw new Error("翻译结果为空");
  return values;
}

/** 解析 MyMemory 响应（`|||` 分隔的批量文本） */
export function parseMyMemoryTranslations(payload: unknown, expected: number): string[] {
  const data = payload as { responseData?: { translatedText?: string } } | null;
  const translated = data?.responseData?.translatedText ?? "";
  const parts = translated.split(/\s*\|\s*\|\s*\|\s*/).map((value) => value.trim());
  if (parts.length !== expected || parts.some((value) => !value)) {
    throw new Error("翻译结果条数不匹配");
  }
  return parts;
}

async function googleBatch(texts: string[], locale: NewsLocale): Promise<string[]> {
  const params = new URLSearchParams({
    client: "dict-chrome-ex",
    sl: "en",
    tl: translationTarget(locale),
  });
  for (const text of texts) params.append("q", text);

  const response = await fetch(`https://translate.googleapis.com/translate_a/t?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseGoogleTranslations(await response.json(), texts.length);
}

async function myMemoryBatch(texts: string[], locale: NewsLocale): Promise<string[]> {
  const joined = texts.join(" ||| ");
  const langpair = `en|${translationTarget(locale)}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(joined)}&langpair=${encodeURIComponent(langpair)}`;

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(MYMEMORY_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseMyMemoryTranslations(await response.json(), texts.length);
}

async function llmBatch(texts: string[], locale: NewsLocale): Promise<string[]> {
  const role = hasLlmConfig("insight") ? "insight" : "quote";
  if (!hasLlmConfig(role)) throw new Error("未配置 LLM Key");

  const target = locale === "zh-Hant" ? "繁体中文（台湾用语）" : "简体中文";
  const result = await chat(
    role,
    [
      {
        role: "system",
        content: `你是财经新闻译者。把输入 JSON 数组里的每条英文翻译成${target}，保留公司名、股票代码、数字与百分比。只输出与输入等长的 JSON 字符串数组，不要 Markdown、不要解释。`,
      },
      { role: "user", content: JSON.stringify(texts) },
    ],
    { temperature: 0, maxTokens: 2400 },
  );
  return parseTranslatedArray(result.content, texts.length);
}

function providerTranslator(provider: TranslateProvider): BatchTranslator {
  if (provider === "llm") return llmBatch;
  if (provider === "mymemory") return myMemoryBatch;
  return googleBatch;
}

/** 翻译一批文本：先查缓存，未命中的按渠道批量请求（单批失败保留 null） */
async function translateBatchWithProvider(
  texts: string[],
  locale: NewsLocale,
  provider: TranslateProvider,
  translator: BatchTranslator,
  deadline: number,
): Promise<(string | null)[]> {
  const results = new Array<string | null>(texts.length).fill(null);
  const missing: { index: number; text: string; key: string }[] = [];

  texts.forEach((text, index) => {
    const key = cacheKey(locale, text);
    const hit = readCached(key);
    if (hit) results[index] = hit;
    else missing.push({ index, text, key });
  });
  if (missing.length === 0) return results;

  const batches = chunk(missing, BATCH_SIZE[provider]);
  for (const group of chunk(batches, 4)) {
    if (Date.now() >= deadline) break;
    await Promise.all(
      group.map(async (batch) => {
        try {
          const values = await translator(batch.map((item) => item.text), locale);
          batch.forEach((item, index) => {
            const value = values[index]?.trim();
            if (!value) return;
            results[item.index] = value;
            writeCached(item.key, value);
          });
        } catch {
          // 整批失败时逐条重试：单条 URL 更短，长标题 / 特殊字符的成功率更高
          for (const single of chunk(batch, 4)) {
            if (Date.now() >= deadline) break;
            await Promise.all(
              single.map(async (item) => {
                try {
                  const values = await translator([item.text], locale);
                  const value = values[0]?.trim();
                  if (!value) return;
                  results[item.index] = value;
                  writeCached(item.key, value);
                } catch {
                  // 保留原文
                }
              }),
            );
          }
        }
      }),
    );
  }
  return results;
}

export interface LocalizeOptions {
  provider?: TranslateProvider;
  translator?: BatchTranslator;
  chain?: TranslateProvider[];
}

export interface LocalizeResult {
  items: NewsItem[];
  locale: string;
  provider: TranslateProvider;
  translated: number;
  total: number;
}

/**
 * 把一批新闻本地化：只翻标题与摘要，SEC 8-K 跳过；
 * 渠道按 llm → google → mymemory 依次降级，最终失败保留原文。
 */
export async function localizeNews(
  items: NewsItem[],
  locale: string,
  options: LocalizeOptions = {},
): Promise<LocalizeResult> {
  const total = items.filter((item) => !item.filing).length;
  if (!isTranslatableLocale(locale) || items.length === 0) {
    return { items, locale, provider: "none", translated: 0, total };
  }

  const primary = options.provider ?? resolveTranslateProvider();
  if (primary === "none") {
    return { items, locale, provider: "none", translated: 0, total };
  }

  const slots: { item: number; field: "title" | "summary"; text: string }[] = [];
  items.forEach((item, index) => {
    if (item.filing) return;
    slots.push({ item: index, field: "title", text: item.title });
    if (index >= SUMMARY_ITEM_LIMIT) return;
    const summary = item.summary.slice(0, SUMMARY_LIMIT).trim();
    if (summary) slots.push({ item: index, field: "summary", text: summary });
  });
  if (slots.length === 0) {
    return { items, locale, provider: "none", translated: 0, total };
  }
  // 标题优先：批次失败时优先保证标题翻译，摘要作为第二批次的增强
  slots.sort((a, b) => (a.field === b.field ? 0 : a.field === "title" ? -1 : 1));

  // 繁體模式下不使用 MyMemory 兜底：它经常把 zh-TW 返回成简体，导致简繁混排
  const fallbackChain: TranslateProvider[] =
    locale === "zh-Hant" ? ["google"] : ["google", "mymemory"];
  const chain =
    options.chain ?? Array.from(new Set<TranslateProvider>([primary, ...fallbackChain]));
  const values: (string | null)[] = new Array(slots.length).fill(null);
  const deadline = Date.now() + LOCALIZE_DEADLINE_MS;
  let used: TranslateProvider = "none";

  for (const provider of chain) {
    if (provider === "none" || Date.now() >= deadline) continue;
    const pending = slots.map((_, index) => index).filter((index) => !values[index]);
    if (pending.length === 0) break;

    const translator = options.translator ?? providerTranslator(provider);
    const results = await translateBatchWithProvider(
      pending.map((index) => slots[index].text),
      locale,
      provider,
      translator,
      deadline,
    );

    let filled = 0;
    pending.forEach((slotIndex, offset) => {
      const value = results[offset];
      if (!value) return;
      values[slotIndex] = value;
      filled += 1;
    });
    if (filled > 0 && used === "none") used = provider;
  }

  const next = items.map((item) => ({ ...item }));
  let translated = 0;
  slots.forEach((slot, index) => {
    const value = values[index];
    if (!value) return;
    const item = next[slot.item];
    if (slot.field === "title") {
      item.titleOriginal = item.title;
      item.title = value;
      translated += 1;
    } else {
      item.summaryOriginal = item.summary;
      item.summary = value;
    }
  });

  return { items: next, locale, provider: used, translated, total };
}
