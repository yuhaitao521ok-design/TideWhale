import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  chunk,
  clearTranslateCache,
  isTranslatableLocale,
  localizeNews,
  parseGoogleTranslations,
  parseMyMemoryTranslations,
  parseTranslatedArray,
  resolveTranslateProvider,
  translationTarget,
} from "@/lib/news-translate";
import type { NewsItem } from "@/lib/news-parse";

function makeItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: "item",
    title: "Title",
    summary: "",
    url: "https://example.com/a",
    sourceId: "cnbc-top",
    source: "CNBC",
    category: "company",
    publishedAt: new Date().toISOString(),
    tickers: [],
    score: 10,
    hot: false,
    ...overrides,
  };
}

beforeEach(() => {
  clearTranslateCache();
});

test("翻译：语言判定与目标语言", () => {
  assert.equal(isTranslatableLocale("zh-Hans"), true);
  assert.equal(isTranslatableLocale("zh-Hant"), true);
  assert.equal(isTranslatableLocale("en"), false);
  assert.equal(isTranslatableLocale(""), false);
  assert.equal(translationTarget("zh-Hans"), "zh-CN");
  assert.equal(translationTarget("zh-Hant"), "zh-TW");
});

test("翻译：渠道环境变量解析", () => {
  assert.equal(resolveTranslateProvider({}), "google");
  assert.equal(resolveTranslateProvider({ NEWS_TRANSLATE_PROVIDER: "google" }), "google");
  assert.equal(resolveTranslateProvider({ NEWS_TRANSLATE_PROVIDER: "mymemory" }), "mymemory");
  assert.equal(resolveTranslateProvider({ NEWS_TRANSLATE_PROVIDER: "llm" }), "llm");
  assert.equal(resolveTranslateProvider({ NEWS_TRANSLATE_PROVIDER: "off" }), "none");
  assert.equal(resolveTranslateProvider({ NEWS_TRANSLATE_PROVIDER: "unknown" }), "google");
});

test("翻译：文本分块", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test("翻译：Google 响应解析（单条嵌套 / 多条 / 条数不匹配）", () => {
  assert.deepEqual(parseGoogleTranslations(["甲", "乙"], 2), ["甲", "乙"]);
  assert.deepEqual(parseGoogleTranslations([["甲"]], 1), ["甲"]);
  assert.throws(() => parseGoogleTranslations(["只有一个"], 2), /条数/);
  assert.throws(() => parseGoogleTranslations(null, 1), /条数/);
  assert.throws(() => parseGoogleTranslations(["甲", ""], 2), /为空/);
});

test("翻译：MyMemory 响应解析与分隔符容错", () => {
  assert.deepEqual(
    parseMyMemoryTranslations({ responseData: { translatedText: "甲 ||| 乙" } }, 2),
    ["甲", "乙"],
  );
  assert.deepEqual(
    parseMyMemoryTranslations({ responseData: { translatedText: "甲| | |乙" } }, 2),
    ["甲", "乙"],
  );
  assert.throws(
    () => parseMyMemoryTranslations({ responseData: { translatedText: "甲" } }, 2),
    /条数/,
  );
});

test("翻译：LLM JSON 数组解析容错 Markdown 与说明文字", () => {
  assert.deepEqual(parseTranslatedArray('```json\n["甲","乙"]\n```', 2), ["甲", "乙"]);
  assert.deepEqual(parseTranslatedArray('翻译如下：["甲","乙"]', 2), ["甲", "乙"]);
  assert.throws(() => parseTranslatedArray('["甲"]', 2), /条数/);
  assert.throws(() => parseTranslatedArray("没有数组", 2), /JSON/);
  assert.throws(() => parseTranslatedArray('["甲",""]', 2), /空翻译/);
});

test("翻译：只翻标题与摘要，SEC 8-K 跳过，保留原文", async () => {
  const items = [
    makeItem({ title: "Nvidia beats estimates", summary: "Shares rose in extended trading." }),
    makeItem({
      title: "Apple Inc.",
      summary: "Earnings results",
      category: "filing",
      filing: { company: "Apple Inc.", ticker: "AAPL", items: ["2.02"], accession: "1" },
    }),
  ];

  const result = await localizeNews(items, "zh-Hans", {
    provider: "google",
    chain: ["google"],
    translator: async (texts) => texts.map((text) => `译:${text}`),
  });

  assert.equal(result.provider, "google");
  assert.equal(result.translated, 1);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, "译:Nvidia beats estimates");
  assert.equal(result.items[0].titleOriginal, "Nvidia beats estimates");
  assert.equal(result.items[0].summary, "译:Shares rose in extended trading.");
  assert.equal(result.items[0].summaryOriginal, "Shares rose in extended trading.");
  // 8-K 的公司名与事项不翻译
  assert.equal(result.items[1].title, "Apple Inc.");
  assert.equal(result.items[1].titleOriginal, undefined);
});

test("翻译：摘要超过 160 字时截断后再翻", async () => {
  const longSummary = "x".repeat(400);
  let received = "";
  await localizeNews([makeItem({ summary: longSummary })], "zh-Hans", {
    provider: "google",
    chain: ["google"],
    translator: async (texts) => {
      received = texts[1] ?? "";
      return texts.map((text) => `译:${text}`);
    },
  });
  assert.equal(received.length, 160);
});

test("翻译：条目级缓存命中后不再调用翻译器", async () => {
  const items = [makeItem({ title: "Unique headline for cache" })];
  let calls = 0;
  const translator = async (texts: string[]) => {
    calls += 1;
    return texts.map((text) => `译:${text}`);
  };

  await localizeNews(items, "zh-Hans", { provider: "google", chain: ["google"], translator });
  assert.equal(calls, 1);

  const again = await localizeNews(items, "zh-Hans", {
    provider: "google",
    chain: ["google"],
    translator,
  });
  assert.equal(calls, 1, "缓存命中时不应再次请求翻译渠道");
  assert.equal(again.items[0].title, "译:Unique headline for cache");
});

test("翻译：简体与繁体缓存互相独立", async () => {
  const items = [makeItem({ title: "Shared headline" })];
  const seen: string[] = [];
  const translator = async (texts: string[], locale: "zh-Hans" | "zh-Hant") => {
    seen.push(locale);
    return texts.map((text) => `${locale}:${text}`);
  };

  await localizeNews(items, "zh-Hans", { provider: "google", chain: ["google"], translator });
  await localizeNews(items, "zh-Hant", { provider: "google", chain: ["google"], translator });
  assert.deepEqual(seen, ["zh-Hans", "zh-Hant"]);
});

test("翻译：首个渠道失败时自动降级到下一个", async () => {
  const items = [makeItem({ title: "Fallback headline" })];
  let attempts = 0;

  const result = await localizeNews(items, "zh-Hans", {
    provider: "llm",
    chain: ["llm", "google"],
    translator: async (texts) => {
      attempts += 1;
      // 第 1 次整批失败、第 2 次单条重试也失败 → 才会真正换到下一个渠道
      if (attempts <= 2) throw new Error("llm down");
      return texts.map((text) => `回退:${text}`);
    },
  });

  assert.equal(result.provider, "google");
  assert.equal(result.items[0].title, "回退:Fallback headline");
});

test("翻译：全部渠道失败时保留英文原文", async () => {
  const items = [makeItem({ title: "Keep english" })];
  const result = await localizeNews(items, "zh-Hans", {
    provider: "google",
    chain: ["google"],
    translator: async () => {
      throw new Error("network down");
    },
  });

  assert.equal(result.provider, "none");
  assert.equal(result.translated, 0);
  assert.equal(result.items[0].title, "Keep english");
  assert.equal(result.items[0].titleOriginal, undefined);
});

test("翻译：英文界面不调用翻译渠道", async () => {
  let called = false;
  const result = await localizeNews([makeItem()], "en", {
    provider: "google",
    translator: async () => {
      called = true;
      return [];
    },
  });

  assert.equal(called, false);
  assert.equal(result.provider, "none");
  assert.equal(result.items[0].title, "Title");
});
