/**
 * 国会披露（STOCK Act）数据源：美国众议院 Clerk
 *  - 年度索引：`https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.xml`
 *  - PTR 文件：`https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{docId}.pdf`
 *
 * 国会成员**不提交 13F**，PTR 只有交易（买入 / 卖出 / 部分卖出 / 置换），
 * 没有持仓快照，金额是区间（`$50,001 - $100,000`）而不是精确市值。
 * 本文件只负责取数与 PDF 文本抽取，表格解析在 lib/congress-parse.ts（纯函数）。
 */
import { getDocumentProxy } from "unpdf";
import { cached } from "@/lib/cache";
import {
  parseHouseIndex,
  parsePtrTrades,
  type CongressFiling,
  type CongressTrade,
  type HouseFilingRow,
  type PtrTextItem,
} from "@/lib/congress-parse";
import { buildCongressQuarters, type SuperInvestor, type ThirteenFResult } from "@/lib/institutions";

const CLERK_BASE = "https://disclosures-clerk.house.gov/public_disc";
const CLERK_HEADERS = {
  "User-Agent": "TideWhale research contact@tidewhale.local",
  Accept: "application/xml,application/pdf,*/*",
};

/** 最近 6 份 PTR 足够覆盖一年多的交易；再多会明显拖慢首次解析 */
const MAX_FILINGS = 6;
const PDF_CONCURRENCY = 3;
const CACHE_SECONDS = 21600;

/** unpdf 没有导出 PDFDocumentProxy 类型，这里从 getDocumentProxy 的返回值反推 */
type PDFDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** 取某年的索引（缓存 6 小时；1 月时当年索引可能很空，所以同时看上一年的） */
async function loadIndexYear(year: number): Promise<HouseFilingRow[]> {
  const result = await cached(`congress:index:${year}`, CACHE_SECONDS, 86400, async () => {
    const response = await fetch(`${CLERK_BASE}/financial-pdfs/${year}FD.xml`, {
      headers: CLERK_HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`众议院披露索引不可用（${response.status}）`);
    return parseHouseIndex(await response.text(), year);
  });
  return result.value;
}

/** 某位议员的 PTR 申报（新→旧） */
export async function listCongressFilings(investor: SuperInvestor): Promise<CongressFiling[]> {
  const congress = investor.congress;
  if (!congress) throw new Error("缺少国会成员信息（congress）");
  const currentYear = new Date().getUTCFullYear();
  const indexes = await Promise.all(
    [currentYear, currentYear - 1].map((year) =>
      loadIndexYear(year).catch(() => [] as HouseFilingRow[]),
    ),
  );

  const last = congress.last.toLowerCase();
  const first = congress.first.toLowerCase();
  const stateDst = congress.stateDst.toLowerCase();
  const seen = new Set<string>();
  const filings: CongressFiling[] = [];

  for (const row of indexes.flat()) {
    if (row.filingType !== "P") continue;
    if (row.last.toLowerCase() !== last) continue;
    if (!row.first.toLowerCase().startsWith(first)) continue;
    if (stateDst && row.stateDst.toLowerCase() !== stateDst) continue;
    if (seen.has(row.docId)) continue;
    seen.add(row.docId);
    filings.push({
      docId: row.docId,
      filedAt: row.filedAt,
      url: `${CLERK_BASE}/ptr-pdfs/${row.year}/${row.docId}.pdf`,
    });
  }

  return filings
    .sort((left, right) => (left.filedAt < right.filedAt ? 1 : left.filedAt > right.filedAt ? -1 : 0))
    .slice(0, MAX_FILINGS);
}

/** 抽取 PDF 全部文本项（带页码与坐标）；扫描件 PDF 没有文本层，会得到空数组 */
async function readPtrItems(pdf: PDFDocument): Promise<PtrTextItem[]> {
  const items: PtrTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      items.push({
        page: pageNumber,
        x: item.transform[4],
        y: item.transform[5],
        text: item.str,
      });
    }
    page.cleanup();
  }
  return items;
}

/** 下载并解析一份 PTR（Clerk 的加密 PDF 都是空口令，pdfjs 可直接打开） */
export async function fetchPtrTrades(filing: CongressFiling): Promise<CongressTrade[]> {
  const response = await fetch(filing.url, {
    headers: CLERK_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`PTR 下载失败（${response.status}）`);

  const data = new Uint8Array(await response.arrayBuffer());
  const pdf = await getDocumentProxy(data);
  try {
    const items = await readPtrItems(pdf);
    if (items.length === 0) throw new Error("PTR 没有文本层（可能是扫描件）");
    return parsePtrTrades(items, { docId: filing.docId, filedAt: filing.filedAt });
  } finally {
    await pdf.cleanup();
  }
}

/** 国会披露详情 / 总览摘要共用的缓存 key */
export function congressCacheKey(investor: SuperInvestor): string {
  return `congress:${investor.id}`;
}

/**
 * 拉取某位议员的 PTR 并聚合成与 13F 相同结构的结果：
 * `holdings` 恒为空（PTR 没有持仓），`quarters` 按交易日期所在季度汇总。
 */
export async function getCongressResult(
  investor: SuperInvestor,
): Promise<ThirteenFResult & { cached: boolean }> {
  const result = await cached(congressCacheKey(investor), CACHE_SECONDS, 86400, async () => {
    const filings = await listCongressFilings(investor);
    if (filings.length === 0) {
      throw new Error("众议院 Clerk 索引里没有找到该议员的 PTR 申报");
    }
    const trades: CongressTrade[] = [];
    let parsedFilings = 0;
    let failedFilings = 0;

    // 分批下载 + 解析，控制并发，避免一次性打满内存 / CPU
    for (let index = 0; index < filings.length; index += PDF_CONCURRENCY) {
      const chunk = filings.slice(index, index + PDF_CONCURRENCY);
      const settled = await Promise.all(
        chunk.map((filing) => fetchPtrTrades(filing).catch(() => null)),
      );
      for (const item of settled) {
        if (item === null) {
          failedFilings += 1;
          continue;
        }
        parsedFilings += 1;
        trades.push(...item);
      }
    }

    trades.sort((left, right) => {
      if (left.tradeDate !== right.tradeDate) return left.tradeDate < right.tradeDate ? 1 : -1;
      return (right.amountMid ?? 0) - (left.amountMid ?? 0);
    });

    if (trades.length === 0 && failedFilings > 0) {
      throw new Error("PTR 解析失败（可能是扫描件或表格格式变更）");
    }

    const quarters = buildCongressQuarters(trades);

    return {
      investor,
      entityName: investor.fund,
      filedAt: filings[0]?.filedAt ?? null,
      period: quarters[0]?.quarter ?? null,
      holdings: [],
      totalPositions: trades.length,
      totalValue: 0,
      quarters,
      latestChanges: [],
      fetchedAt: new Date().toISOString(),
      source: "congress" as const,
      trades,
      filings,
      parsedFilings,
      failedFilings,
    };
  });

  return { ...result.value, cached: result.cached };
}
