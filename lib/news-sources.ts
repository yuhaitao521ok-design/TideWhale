/**
 * 新闻源配置与公司别名表（纯常量，客户端 / 服务端都可安全 import）。
 *
 * 全部来源都是公开、免 Key 的 RSS / Atom / SEC 全文检索：
 *  - CNBC / MarketWatch / Nasdaq / BBC：美国公司与市场快讯
 *  - CNBC World / Guardian / Al Jazeera：国际要闻
 *  - Google News RSS：按关键词与时间窗聚合（覆盖最广，作为补充）
 *  - SEC EDGAR full-text search：官方 8-K 重大事件备案（最权威，但只有公司事件）
 *
 * 不引入任何第三方依赖：XML 解析在 lib/news-parse.ts 里用容错的正则实现。
 */

export type NewsCategory = "company" | "market" | "macro" | "world" | "filing";

export type NewsSourceId =
  | "cnbc-top"
  | "cnbc-world"
  | "marketwatch-top"
  | "marketwatch-pulse"
  | "nasdaq-markets"
  | "bbc-business"
  | "guardian-world"
  | "aljazeera"
  | "google-company"
  | "google-world"
  | "sec-8k";

export interface NewsSource {
  id: NewsSourceId;
  /** 展示名（英文品牌名，不翻译） */
  name: string;
  /** RSS / Atom 地址；Google News 与 SEC 走动态查询，这里留空 */
  url: string;
  /** 默认分类；正文关键词命中时会被覆盖 */
  category: NewsCategory;
  /** 重要度权重（0–10），用于突发排序与去重时的保留优先级 */
  weight: number;
  /** 每个源最多保留条数 */
  limit: number;
  kind: "rss" | "atom" | "sec";
  /** 前端来源徽标的色相（HSL 色相角），保持界面克制 */
  hue: number;
}

export const NEWS_SOURCES: NewsSource[] = [
  {
    id: "cnbc-top",
    name: "CNBC",
    url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    category: "company",
    weight: 9,
    limit: 20,
    kind: "rss",
    hue: 205,
  },
  {
    id: "cnbc-world",
    name: "CNBC World",
    url: "https://www.cnbc.com/id/100727362/device/rss/rss.html",
    category: "world",
    weight: 8,
    limit: 12,
    kind: "rss",
    hue: 205,
  },
  {
    id: "marketwatch-top",
    name: "MarketWatch",
    url: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    category: "market",
    weight: 8,
    limit: 15,
    kind: "rss",
    hue: 150,
  },
  {
    id: "marketwatch-pulse",
    name: "MarketWatch Pulse",
    url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse",
    category: "market",
    weight: 6,
    limit: 12,
    kind: "rss",
    hue: 150,
  },
  {
    id: "nasdaq-markets",
    name: "Nasdaq",
    url: "https://www.nasdaq.com/feed/rssoutbound?category=Markets",
    category: "market",
    weight: 6,
    limit: 15,
    kind: "rss",
    hue: 190,
  },
  {
    id: "bbc-business",
    name: "BBC Business",
    url: "https://feeds.bbci.co.uk/news/business/rss.xml",
    category: "company",
    weight: 7,
    limit: 12,
    kind: "rss",
    hue: 350,
  },
  {
    id: "guardian-world",
    name: "The Guardian",
    url: "https://www.theguardian.com/world/rss",
    category: "world",
    weight: 6,
    limit: 12,
    kind: "rss",
    hue: 220,
  },
  {
    id: "aljazeera",
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    category: "world",
    weight: 6,
    limit: 10,
    kind: "rss",
    hue: 35,
  },
  {
    id: "google-company",
    name: "Google News",
    url: "",
    category: "company",
    weight: 5,
    limit: 20,
    kind: "rss",
    hue: 45,
  },
  {
    id: "google-world",
    name: "Google News World",
    url: "",
    category: "world",
    weight: 5,
    limit: 20,
    kind: "rss",
    hue: 45,
  },
  {
    id: "sec-8k",
    name: "SEC EDGAR",
    url: "",
    category: "filing",
    weight: 10,
    limit: 20,
    kind: "sec",
    hue: 265,
  },
];

/** Google News 检索地址（hl/gl/ceid 固定为美区英文） */
export function googleNewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export const GOOGLE_COMPANY_QUERY =
  '("Wall Street" OR earnings OR "stock market") (Apple OR Nvidia OR Microsoft OR Tesla OR Amazon OR Meta OR Alphabet) when:1d';

/** Google News 世界版头条（比关键词检索更准；请求会 302 到 topics，fetch 自动跟随） */
export const GOOGLE_WORLD_TOPIC_URL =
  "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en";

/** SEC EDGAR full-text search（8-K 最新备案，按提交日期倒序） */
export function secEightKUrl(keyword: string): string {
  const params = new URLSearchParams();
  if (keyword) params.set("q", keyword);
  params.set("forms", "8-K");
  params.set("dateRange", "custom");
  params.set("startdt", isoDateDaysAgo(2));
  params.set("enddt", isoDateDaysAgo(0));
  params.set("hits", "40");
  return `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
}

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 美国大公司（ticker → 常见写法），用于标题里的标的识别与热门标的统计。 */
export const COMPANY_ALIASES: { ticker: string; name: string; aliases: string[] }[] = [
  { ticker: "AAPL", name: "Apple", aliases: ["Apple"] },
  { ticker: "MSFT", name: "Microsoft", aliases: ["Microsoft"] },
  { ticker: "NVDA", name: "Nvidia", aliases: ["Nvidia", "NVIDIA"] },
  { ticker: "GOOGL", name: "Alphabet", aliases: ["Alphabet", "Google"] },
  { ticker: "AMZN", name: "Amazon", aliases: ["Amazon"] },
  { ticker: "META", name: "Meta", aliases: ["Meta Platforms", "Meta"] },
  { ticker: "TSLA", name: "Tesla", aliases: ["Tesla"] },
  { ticker: "AVGO", name: "Broadcom", aliases: ["Broadcom"] },
  { ticker: "BRK.B", name: "Berkshire Hathaway", aliases: ["Berkshire Hathaway", "Berkshire"] },
  { ticker: "JPM", name: "JPMorgan", aliases: ["JPMorgan", "JP Morgan"] },
  { ticker: "UNH", name: "UnitedHealth", aliases: ["UnitedHealth"] },
  { ticker: "XOM", name: "Exxon Mobil", aliases: ["Exxon"] },
  { ticker: "WMT", name: "Walmart", aliases: ["Walmart", "Wal-Mart"] },
  { ticker: "LLY", name: "Eli Lilly", aliases: ["Eli Lilly"] },
  { ticker: "ORCL", name: "Oracle", aliases: ["Oracle"] },
  { ticker: "COST", name: "Costco", aliases: ["Costco"] },
  { ticker: "HD", name: "Home Depot", aliases: ["Home Depot"] },
  { ticker: "JNJ", name: "Johnson & Johnson", aliases: ["Johnson & Johnson"] },
  { ticker: "NFLX", name: "Netflix", aliases: ["Netflix"] },
  { ticker: "AMD", name: "AMD", aliases: ["Advanced Micro Devices"] },
  { ticker: "CRM", name: "Salesforce", aliases: ["Salesforce"] },
  { ticker: "ADBE", name: "Adobe", aliases: ["Adobe"] },
  { ticker: "INTC", name: "Intel", aliases: ["Intel"] },
  { ticker: "CSCO", name: "Cisco", aliases: ["Cisco"] },
  { ticker: "QCOM", name: "Qualcomm", aliases: ["Qualcomm"] },
  { ticker: "MU", name: "Micron", aliases: ["Micron"] },
  { ticker: "BA", name: "Boeing", aliases: ["Boeing"] },
  { ticker: "DIS", name: "Disney", aliases: ["Walt Disney", "Disney"] },
  { ticker: "KO", name: "Coca-Cola", aliases: ["Coca-Cola", "Coca Cola"] },
  { ticker: "PEP", name: "PepsiCo", aliases: ["PepsiCo", "Pepsi"] },
  { ticker: "MCD", name: "McDonald's", aliases: ["McDonald"] },
  { ticker: "NKE", name: "Nike", aliases: ["Nike"] },
  { ticker: "GS", name: "Goldman Sachs", aliases: ["Goldman Sachs", "Goldman"] },
  { ticker: "MS", name: "Morgan Stanley", aliases: ["Morgan Stanley"] },
  { ticker: "BAC", name: "Bank of America", aliases: ["Bank of America"] },
  { ticker: "WFC", name: "Wells Fargo", aliases: ["Wells Fargo"] },
  { ticker: "PFE", name: "Pfizer", aliases: ["Pfizer"] },
  { ticker: "MRK", name: "Merck", aliases: ["Merck"] },
  { ticker: "ABBV", name: "AbbVie", aliases: ["AbbVie"] },
  { ticker: "VZ", name: "Verizon", aliases: ["Verizon"] },
  { ticker: "TMUS", name: "T-Mobile", aliases: ["T-Mobile"] },
  { ticker: "PLTR", name: "Palantir", aliases: ["Palantir"] },
  { ticker: "COIN", name: "Coinbase", aliases: ["Coinbase"] },
  { ticker: "UBER", name: "Uber", aliases: ["Uber"] },
  { ticker: "ABNB", name: "Airbnb", aliases: ["Airbnb"] },
  { ticker: "SHOP", name: "Shopify", aliases: ["Shopify"] },
  { ticker: "SNOW", name: "Snowflake", aliases: ["Snowflake"] },
  { ticker: "DELL", name: "Dell", aliases: ["Dell"] },
  { ticker: "IBM", name: "IBM", aliases: ["International Business Machines"] },
  { ticker: "CAT", name: "Caterpillar", aliases: ["Caterpillar"] },
  { ticker: "F", name: "Ford", aliases: ["Ford Motor", "Ford"] },
  { ticker: "GM", name: "General Motors", aliases: ["General Motors"] },
  { ticker: "RIVN", name: "Rivian", aliases: ["Rivian"] },
  { ticker: "SOFI", name: "SoFi", aliases: ["SoFi"] },
  { ticker: "HOOD", name: "Robinhood", aliases: ["Robinhood"] },
  { ticker: "MSTR", name: "Strategy", aliases: ["MicroStrategy", "Strategy Inc"] },
  { ticker: "BABA", name: "Alibaba", aliases: ["Alibaba"] },
  { ticker: "TSM", name: "TSMC", aliases: ["TSMC", "Taiwan Semiconductor"] },
  { ticker: "ASML", name: "ASML", aliases: ["ASML"] },
];

/** ticker 集合（用于 SEC display_names 与裸代码识别） */
export const COMPANY_TICKERS = new Set(COMPANY_ALIASES.map((item) => item.ticker));

/**
 * Google News 是聚合器，可能混入不明来源的博客 / 标题党。
 * 只保留主流财经与综合媒体（不区分大小写，子串匹配）。
 */
export const TRUSTED_PUBLISHERS =
  /\b(reuters|bloomberg|wall street journal|wsj|cnbc|associated press|ap news|financial times|new york times|nyt|barron|marketwatch|business insider|forbes|fortune|axios|politico|economist|yahoo finance|seeking alpha|benzinga|investing\.com|motley fool|techcrunch|the verge|nikkei|scmp|the guardian|bbc|npr|washington post|usa today)\b/i;

/**
 * 8-K 事项编号 → 中文标签（前端再走 t() 翻译）。
 * 只列常见事项；未知编号回退为 `Item x.xx`。
 */
export const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "重大协议",
  "1.02": "终止重大协议",
  "1.03": "破产 / 接管",
  "2.01": "完成收购 / 处置",
  "2.02": "财报业绩",
  "2.03": "新增重大债务",
  "2.04": "触发加速到期",
  "2.05": "退出 / 裁员成本",
  "2.06": "重大减值",
  "3.01": "退市 / 不符合上市规则",
  "3.02": "未注册股权销售",
  "3.03": "修改证券持有人权利",
  "4.01": "更换审计师",
  "4.02": "前期报表不可依赖",
  "5.01": "控制权变更",
  "5.02": "董事 / 高管变动",
  "5.03": "修改章程",
  "5.07": "股东大会表决结果",
  "7.01": "FD 披露",
  "8.01": "其他重大事件",
  "9.01": "财务报表与附件",
};

/** 值得单独推送的 8-K 事项（过滤掉只有 9.01 附件的例行备案） */
export const HIGH_SIGNAL_ITEMS = new Set([
  "1.01",
  "1.02",
  "1.03",
  "2.01",
  "2.02",
  "2.03",
  "2.04",
  "2.05",
  "2.06",
  "3.01",
  "4.01",
  "4.02",
  "5.01",
  "5.02",
  "5.03",
]);

/**
 * 小公司只有这些「真正重大」的事项才进新闻流：
 * 破产 / 接管、完成收购 / 处置、退市。
 * 1.01（重大协议，SPAC 例行文件）、2.02（财报）、5.02（高管变动）在小公司里过于常见，只保留大公司。
 */
export const CRITICAL_ITEMS = new Set(["1.03", "2.01", "3.01"]);

/** 单个 8-K 事项对股价的潜在影响（用于突发排序） */
export const EIGHT_K_ITEM_WEIGHT: Record<string, number> = {
  "1.03": 6,
  "3.01": 5,
  "2.01": 4,
  "2.02": 4,
  "5.01": 4,
  "2.05": 3,
  "2.06": 3,
  "5.02": 3,
  "1.01": 2,
  "1.02": 2,
  "2.03": 2,
  "4.01": 2,
  "4.02": 2,
};
