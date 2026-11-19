import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCategory,
  cleanSummary,
  decodeEntities,
  dedupeNews,
  extractTickers,
  hashId,
  hotTickers,
  isWorldHeadline,
  makeNewsItem,
  matchesQuery,
  parseDisplayName,
  parseFeed,
  parseSecFilings,
  scoreNews,
  stripHtml,
  titleSimilarity,
  titleTokens,
  toIso,
  type NewsItem,
} from "@/lib/news-parse";
import { NEWS_SOURCES, googleNewsUrl, secEightKUrl } from "@/lib/news-sources";
import { sourceUrl } from "@/lib/news";

const CNBC = NEWS_SOURCES.find((source) => source.id === "cnbc-top")!;
const GOOGLE = NEWS_SOURCES.find((source) => source.id === "google-company")!;
const SEC = NEWS_SOURCES.find((source) => source.id === "sec-8k")!;

function makeItem(overrides: Partial<NewsItem>): NewsItem {
  return {
    id: "id",
    title: "Title",
    summary: "",
    url: "https://example.com/item",
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

test("新闻解析：解码命名/数字实体并清除脚本与标签", () => {
  assert.equal(decodeEntities("A &amp; B &#39;s &mdash; &quot;ok&quot;"), `A & B 's — "ok"`);
  assert.equal(decodeEntities("&#x1F600;"), "\u{1F600}");
  assert.equal(decodeEntities("&unknown;"), "&unknown;");
  assert.equal(stripHtml("<p>Hello <b>World</b></p>"), "Hello World");
  assert.equal(stripHtml("<script>alert(1)</script>Safe <!-- note --> now"), "Safe now");
  assert.equal(stripHtml("A &amp;amp; B"), "A & B");
  assert.equal(stripHtml("Green Ind &amp;nbsp;&amp;nbsp; Benzinga"), "Green Ind Benzinga");
});

test("新闻解析：摘要与标题重复时清空，独立摘要保留", () => {
  assert.equal(cleanSummary("SEC probes Nvidia", "SEC probes Nvidia WSJ"), "");
  assert.equal(cleanSummary("SEC probes Nvidia", "SEC probes Nvidia"), "");
  assert.equal(
    cleanSummary("SEC probes Nvidia", "The regulator opened a review into disclosures."),
    "The regulator opened a review into disclosures.",
  );
  assert.equal(cleanSummary("Title", ""), "");
});

test("新闻解析：RSS 2.0 的 CDATA、相对链接与非法时间", () => {
  const published = new Date(Date.now() - 2 * 3600 * 1000);
  const rfcDate = published.toUTCString();
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item>
      <title><![CDATA[Stocks &amp; bonds surge]]></title>
      <link>https://example.com/a</link>
      <description><![CDATA[<p>Markets <b>rally</b> today.</p>]]></description>
      <pubDate>${rfcDate}</pubDate>
    </item>
    <item>
      <title>Second</title>
      <link>/b</link>
      <pubDate>not-a-date</pubDate>
    </item>
  </channel></rss>`;

  const entries = parseFeed(rss, "https://example.com/feed", 10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, "Stocks & bonds surge");
  assert.equal(entries[0].summary, "Markets rally today.");
  assert.equal(entries[0].publishedAt, new Date(rfcDate).toISOString());
  assert.equal(entries[1].link, "https://example.com/b");
  assert.equal(entries[1].publishedAt, null);
});

test("新闻解析：Atom 的 link rel=alternate 与 updated 字段", () => {
  const updated = new Date(Date.now() - 3600 * 1000).toISOString();
  const atom = `<?xml version="1.0"?><feed>
    <entry>
      <title>Fed holds rates steady</title>
      <link rel="self" href="https://example.com/self"/>
      <link rel="alternate" href="https://example.com/fed"/>
      <summary>Policy unchanged.</summary>
      <updated>${updated}</updated>
    </entry>
  </feed>`;

  const entries = parseFeed(atom, "https://example.com", 10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].link, "https://example.com/fed");
  assert.equal(entries[0].summary, "Policy unchanged.");
  assert.equal(entries[0].publishedAt, updated);
});

test("新闻解析：Google News 去掉「 - 来源」后缀，未来时间被夹到现在", () => {
  const feed = `<rss><channel><item>
    <title>Nvidia beats estimates - Reuters</title>
    <link>https://news.google.com/rss/articles/abc</link>
    <source url="https://www.reuters.com">Reuters</source>
    <pubDate>Thu, 01 Jan 2099 00:00:00 GMT</pubDate>
  </item></channel></rss>`;

  const entries = parseFeed(feed, "", 10, { googleNews: true });
  assert.equal(entries[0].title, "Nvidia beats estimates");
  assert.equal(entries[0].sourceName, "Reuters");
  assert.ok(Date.parse(entries[0].publishedAt!) <= Date.now());

  // 聚合条目的徽标展示真实媒体名，而不是 "Google News"
  const item = makeNewsItem(entries[0], GOOGLE, new Date().toISOString());
  assert.equal(item.source, "Reuters");
  assert.equal(item.sourceDetail, "Reuters");

  assert.equal(toIso("garbage"), null);
});

test("新闻解析：标题分词与相似度用于跨源去重", () => {
  const first = titleTokens("Nvidia shares surge after earnings beat");
  const second = titleTokens("Nvidia shares surge after earnings beat");
  const other = titleTokens("Fed keeps interest rates unchanged");
  assert.equal(titleSimilarity(first, second), 1);
  assert.ok(titleSimilarity(first, other) < 0.3);
});

test("新闻解析：识别显式代码与公司名，忽略无关文本", () => {
  const tickers = extractTickers("Apple and Nvidia rally; TSLA jumps after (NASDAQ:TSLA) filing");
  assert.ok(tickers.includes("AAPL"));
  assert.ok(tickers.includes("NVDA"));
  assert.ok(tickers.includes("TSLA"));
  assert.deepEqual(extractTickers("Weather forecast for the weekend"), []);
});

test("新闻解析：分类遵循「国际 > 宏观 > 公司 > 源默认」", () => {
  assert.equal(classifyCategory("company", "Nvidia earnings beat estimates"), "company");
  assert.equal(classifyCategory("company", "Fed holds rates as inflation cools"), "macro");
  assert.equal(classifyCategory("company", "Earthquake hits northern Japan"), "world");
  assert.equal(classifyCategory("world", "Apple launches a new product"), "world");
  assert.equal(classifyCategory("market", "S&P 500 closes at record high"), "market");
  assert.equal(classifyCategory("filing", "anything"), "filing");
});

test("新闻解析：国际标题识别与低价值技术面降权", () => {
  assert.equal(isWorldHeadline("Earthquake hits northern Japan"), true);
  assert.equal(isWorldHeadline("Police presence in Somerville, Massachusetts"), false);

  const now = Date.now();
  const publishedAt = new Date(now).toISOString();
  const lowValue = scoreNews({
    weight: 6,
    text: "Teleflex Reaches Analyst Target Price",
    tickers: [],
    publishedAt,
    now,
  });
  const normal = scoreNews({
    weight: 6,
    text: "Fed holds rates steady",
    tickers: [],
    publishedAt,
    now,
  });
  assert.ok(lowValue < normal, "技术面流水线应比正常新闻分数低");
});

test("新闻解析：跨源去重保留分数更高的一条，URL 相同直接合并", () => {
  const duplicated = dedupeNews([
    makeItem({ id: "a", title: "Nvidia shares surge after earnings beat", score: 12, url: "https://a.com/1" }),
    makeItem({ id: "b", title: "Nvidia shares surge after earnings beat", score: 9, url: "https://b.com/2" }),
    makeItem({ id: "c", title: "Fed keeps rates unchanged", score: 8, url: "https://c.com/3" }),
  ]);
  assert.equal(duplicated.length, 2);
  assert.equal(duplicated[0].id, "a");
  assert.equal(duplicated[1].id, "c");
});

test("新闻解析：标题相同但 URL 相同（带 tracking 参数）也会合并", () => {
  const merged = dedupeNews([
    makeItem({ id: "a", title: "Fed keeps rates unchanged", score: 9, url: "https://cnbc.com/x" }),
    makeItem({ id: "b", title: "Fed keeps rates unchanged", score: 8, url: "https://cnbc.com/x?utm_source=rss" }),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "a");
});

test("新闻解析：makeNewsItem 计算分类、标的与突发标记", () => {
  const item = makeNewsItem(
    {
      title: "Breaking: Nvidia shares plunge after guidance cut",
      link: "https://example.com/nvda",
      summary: "The chipmaker cut its outlook.",
      publishedAt: new Date().toISOString(),
    },
    CNBC,
    new Date().toISOString(),
  );

  assert.equal(item.category, "company");
  assert.ok(item.tickers.includes("NVDA"));
  assert.equal(item.hot, true);
  assert.ok(item.score >= 13);
});

test("新闻解析：搜索匹配（多词 AND）与热门标的统计", () => {
  const item = makeItem({ title: "Nvidia earnings beat", summary: "AI demand", tickers: ["NVDA"] });
  assert.equal(matchesQuery(item, "nvidia"), true);
  assert.equal(matchesQuery(item, "nvidia demand"), true);
  assert.equal(matchesQuery(item, "nvidia macro"), false);
  assert.equal(matchesQuery(item, ""), true);

  const hot = hotTickers([
    makeItem({ id: "1", tickers: ["NVDA", "AAPL"] }),
    makeItem({ id: "2", tickers: ["NVDA"] }),
    makeItem({ id: "3", tickers: ["TSLA"] }),
  ]);
  assert.deepEqual(hot[0], { ticker: "NVDA", count: 2 });
  assert.equal(hot.length, 3);
});

test("新闻解析：id 稳定且可区分", () => {
  assert.equal(hashId("abc"), hashId("abc"));
  assert.notEqual(hashId("abc"), hashId("abd"));
  assert.ok(hashId("https://example.com/a?b=1").length > 0);
});

test("SEC 8-K：解析公司名 / ticker / 事项与备案链接", () => {
  assert.deepEqual(parseDisplayName("NewtekOne, Inc.  (NEWT, NEWTG)  (CIK 0001587987)"), {
    company: "NewtekOne, Inc.",
    ticker: "NEWT",
  });
  assert.deepEqual(parseDisplayName("TUCSON ELECTRIC POWER CO  (CIK 0000100122)"), {
    company: "TUCSON ELECTRIC POWER CO",
    ticker: null,
  });

  const payload = {
    hits: {
      hits: [
        {
          _id: "0000320193-26-000010:aapl-8k.htm",
          _source: {
            display_names: ["Apple Inc.  (AAPL)  (CIK 0000320193)"],
            file_date: "2026-11-18",
            items: ["2.02", "9.01"],
            ciks: ["0000320193"],
          },
        },
        {
          _id: "0000000001-26-000001:tiny.htm",
          _source: {
            display_names: ["Tiny Co  (TINY)  (CIK 0000000001)"],
            file_date: "2026-11-18",
            items: ["9.01"],
            ciks: ["0000000001"],
          },
        },
      ],
    },
  };

  const filings = parseSecFilings(payload, { fetchedAt: "2026-11-19T00:00:00.000Z" });
  assert.equal(filings.length, 1);
  assert.equal(filings[0].filing?.company, "Apple Inc.");
  assert.equal(filings[0].filing?.ticker, "AAPL");
  assert.deepEqual(filings[0].filing?.items, ["2.02", "9.01"]);
  assert.equal(filings[0].category, "filing");
  assert.equal(filings[0].hot, true);
  assert.equal(
    filings[0].url,
    "https://www.sec.gov/Archives/edgar/data/320193/000032019326000010/0000320193-26-000010-index.htm",
  );
});

test("SEC 8-K：小公司只有 9.01 附件时被过滤，高信号事项即使小公司也保留", () => {
  const payload = {
    hits: {
      hits: [
        {
          _id: "0000000002-26-000002:bankrupt.htm",
          _source: {
            display_names: ["Small Corp  (SMLL)  (CIK 0000000002)"],
            file_date: "2026-11-18",
            items: ["1.03"],
            ciks: ["0000000002"],
          },
        },
      ],
    },
  };
  const filings = parseSecFilings(payload, { fetchedAt: "2026-11-19T00:00:00.000Z" });
  assert.equal(filings.length, 1);
  assert.equal(filings[0].filing?.items[0], "1.03");
  assert.ok(filings[0].score >= 15);
});

test("SEC 8-K：小公司只有财报(2.02)时被过滤，重大事项(2.01)保留", () => {
  const payload = {
    hits: {
      hits: [
        {
          _id: "0000000003-26-000003:tiny-earnings.htm",
          _source: {
            display_names: ["Tiny Earnings Co  (TNYE)  (CIK 0000000003)"],
            file_date: "2026-11-18",
            items: ["2.02", "9.01"],
            ciks: ["0000000003"],
          },
        },
        {
          _id: "0000000004-26-000004:small-deal.htm",
          _source: {
            display_names: ["Small Deal Co  (SMAL)  (CIK 0000000004)"],
            file_date: "2026-11-18",
            items: ["2.01", "9.01"],
            ciks: ["0000000004"],
          },
        },
      ],
    },
  };
  const filings = parseSecFilings(payload, { fetchedAt: "2026-11-19T00:00:00.000Z" });
  assert.equal(filings.length, 1);
  assert.equal(filings[0].filing?.company, "Small Deal Co");
});

test("新闻源：Google News 搜索式、SEC 8-K 参数与来源地址", () => {
  const googleUrl = sourceUrl(GOOGLE, "Nvidia");
  assert.ok(googleUrl.startsWith("https://news.google.com/rss/search"));
  assert.ok(googleUrl.includes("when%3A7d"));

  const secUrl = sourceUrl(SEC, "");
  assert.ok(secUrl.includes("forms=8-K"));
  assert.ok(secUrl.includes("dateRange=custom"));

  assert.equal(sourceUrl(SEC, "Apple"), secEightKUrl("Apple"));
  assert.equal(googleNewsUrl("test").includes("q=test"), true);

  // 有搜索词时不再重复抓第二路 Google News；无搜索词走 World 话题频道
  const googleWorld = NEWS_SOURCES.find((source) => source.id === "google-world")!;
  assert.equal(sourceUrl(googleWorld, "Apple"), "");
  assert.ok(sourceUrl(googleWorld, "").includes("topic/WORLD"));
});
