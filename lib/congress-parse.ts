/**
 * 国会披露（STOCK Act）解析：
 *   1. 众议院 Clerk 的年度索引 XML（2026FD.xml）→ 按姓名筛出 PTR 申报
 *   2. PTR PDF 抽取出来的文本行 → 交易明细
 *
 * 说明：国会成员**不提交 13F**，没有季度持仓快照，只有交易披露（PTR），
 * 金额也是区间（如 `$50,001 - $100,000`）而不是精确市值。
 * 本文件保持纯函数 / 类型（客户端会 import 类型），取数与 PDF 解析放在 lib/congress.ts。
 */

export type CongressSide = "buy" | "sell" | "exchange";

/** 一笔国会交易（来自某份 PTR） */
export interface CongressTrade {
  /** 交易日期（YYYY-MM-DD） */
  tradeDate: string;
  /** 表格里的 Notification Date（YYYY-MM-DD） */
  notifyDate: string | null;
  /** PTR 提交日（YYYY-MM-DD） */
  filedAt: string;
  /** PTR 文件 ID（Clerk 的 DocID） */
  docId: string;
  side: CongressSide;
  /** 是否「部分卖出」（表格类型为 `S (partial)`） */
  partial: boolean;
  /** 持有人代码：SP（配偶）/ JT（共同）/ DC（受抚养子女）/ null（本人） */
  owner: string | null;
  ticker: string | null;
  /** 资产类型代码：ST（股票）/ OP（期权）/ AB（年金）… */
  assetType: string | null;
  /** 资产名称（去掉类型代码与 ticker 括号） */
  asset: string;
  amountMin: number | null;
  amountMax: number | null;
  /** 区间中值：仅用于排序与汇总估算，不是真实成交额 */
  amountMid: number | null;
  /** 原始金额文本，前端可原样展示区间 */
  amountText: string;
}

/** 一份 PTR 披露文件 */
export interface CongressFiling {
  docId: string;
  filedAt: string;
  url: string;
}

/** PDF 文本项（来自 pdfjs 的 getTextContent，已归一化） */
export interface PtrTextItem {
  page: number;
  x: number;
  y: number;
  text: string;
}

/** 按 y 聚成一行、再按 x 分列后的表格行 */
export interface PtrRow {
  page: number;
  y: number;
  cells: Record<string, string>;
}

const COLUMN_KEYS = [
  "id",
  "owner",
  "asset",
  "type",
  "tradeDate",
  "notifyDate",
  "amount",
  "gains",
] as const;

type ColumnKey = (typeof COLUMN_KEYS)[number];

interface Column {
  key: ColumnKey;
  x: number;
}

/** 表头缺失时的兜底列起点（House PTR 模板固定，比例基本一致） */
const FALLBACK_COLUMNS: Column[] = [
  { key: "id", x: 0 },
  { key: "owner", x: 45 },
  { key: "asset", x: 100 },
  { key: "type", x: 250 },
  { key: "tradeDate", x: 315 },
  { key: "notifyDate", x: 372 },
  { key: "amount", x: 435 },
  { key: "gains", x: 515 },
];

/** 清除 PDF 里常见的空字符（字母间距标题会插 \u0000）并压缩空白 */
export function cleanPtrText(value: string): string {
  return value.replace(/[\u0000\ufffd]/g, "").replace(/\s+/g, " ").trim();
}

function columnAt(x: number, columns: Column[]): ColumnKey {
  let key = columns[0].key;
  for (const column of columns) if (x >= column.x - 3) key = column.key;
  return key;
}


/**
 * 从表头行推算列起点：不同 PDF 的页面缩放不同（同一模板 x 会差几十点），
 * 不能写死坐标；找不到表头时退回兜底列。
 */
export function detectPtrColumns(items: [number, string][]): Column[] | null {
  const find = (label: string) => items.find(([, text]) => text === label)?.[0] ?? null;
  const owner = find("Owner");
  const asset = find("Asset");
  const amount = find("Amount");
  const type = find("Transaction") ?? find("Type");
  const notification = find("Notification");
  const dates = items
    .filter(([, text]) => text === "Date")
    .map(([x]) => x)
    .sort((left, right) => left - right);
  if (owner === null || asset === null || amount === null || type === null || dates.length === 0) {
    return null;
  }
  return [
    { key: "id", x: 0 },
    { key: "owner", x: owner },
    { key: "asset", x: asset },
    { key: "type", x: type },
    { key: "tradeDate", x: dates[0] },
    { key: "notifyDate", x: notification ?? dates[1] ?? amount },
    { key: "amount", x: amount },
    { key: "gains", x: find("Cap.") ?? amount + 80 },
  ];
}

/** 把文本项按页、按 y 聚行（容差 2.5pt，同一行的轻微基线差异会合并） */
export function groupPtrRows(items: PtrTextItem[]): PtrRow[] {
  const pages = new Map<number, PtrTextItem[]>();
  for (const item of items) {
    const text = cleanPtrText(item.text);
    if (!text) continue;
    const list = pages.get(item.page);
    if (list) list.push(item);
    else pages.set(item.page, [item]);
  }

  const rows: PtrRow[] = [];
  for (const page of [...pages.keys()].sort((left, right) => left - right)) {
    const buckets: { y: number; items: [number, string][] }[] = [];
    for (const item of pages.get(page) ?? []) {
      const text = cleanPtrText(item.text);
      const bucket = buckets.find((candidate) => Math.abs(candidate.y - item.y) <= 2.5);
      if (bucket) bucket.items.push([item.x, text]);
      else buckets.push({ y: item.y, items: [[item.x, text]] });
    }
    buckets.sort((left, right) => right.y - left.y);

    // 每页都带表头，用第一行能识别出列的头行定列
    let columns: Column[] | null = null;
    for (const bucket of buckets) {
      columns = detectPtrColumns(bucket.items);
      if (columns) break;
    }
    const resolved = columns ?? FALLBACK_COLUMNS;
    for (const bucket of buckets) {
      const cells: Record<string, string> = {};
      for (const [x, text] of bucket.items) {
        const key = columnAt(x, resolved);
        cells[key] = cells[key] ? `${cells[key]} ${text}` : text;
      }
      rows.push({ page, y: bucket.y, cells });
    }
  }
  return rows;
}

/** `$1,000,001 - $5,000,000` / `$50,001 - $100,000` / `$15.00` → 区间数值 */
export function parsePtrAmount(
  text: string,
): { min: number; max: number; mid: number } | null {
  const toNumber = (value: string) => Number.parseFloat(value.replace(/,/g, ""));
  const range = /\$\s*([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (range) {
    const min = toNumber(range[1]);
    const max = toNumber(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) return { min, max, mid: (min + max) / 2 };
  }
  const single = /\$\s*([\d,]+(?:\.\d+)?)/.exec(text);
  if (single) {
    const value = toNumber(single[1]);
    if (Number.isFinite(value)) return { min: value, max: value, mid: value };
  }
  return null;
}

/** `01/16/2026` → `2026-01-16` */
export function ptrDateToIso(text: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((text ?? "").trim());
  if (!match) return null;
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  return `${match[3]}-${month}-${day}`;
}

const COMMENT_ROW = /^(F\s*S|D)\s*:/;
const HEADER_CELL = /^(ID|Owner|Asset|Transaction|Type)$/;

/**
 * 交易行解析：
 *   主行 = 带 `P/S/E` 类型 + 两个日期 + 金额（金额与资产名可能续到下一行，甚至跨页）；
 *   续行 = 资产名第 2 行、金额第 2 行；遇到 `F S:` / `D:` 备注行或下一条交易即停止。
 *   页与页之间的表头行会被跳过，所以跨页续行也能拼接。
 */
export function parsePtrRows(
  rows: PtrRow[],
  meta: { docId: string; filedAt: string },
): CongressTrade[] {
  const trades: CongressTrade[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const tradeDate = ptrDateToIso(row.cells.tradeDate);
    const notifyDate = ptrDateToIso(row.cells.notifyDate);
    if (!tradeDate || !notifyDate) continue;

    const typeText = (row.cells.type ?? "").trim();
    if (!/^(P|S|E)\b/i.test(typeText)) continue;

    let asset = row.cells.asset ?? "";
    let amountText = row.cells.amount ?? "";
    let appended = 0;
    for (let next = index + 1; next < rows.length && next < index + 10 && appended < 3; next += 1) {
      const candidate = rows[next];
      if (ptrDateToIso(candidate.cells.tradeDate)) break;
      const assetPart = candidate.cells.asset ?? "";
      const isHeader = HEADER_CELL.test(assetPart) || (candidate.cells.owner ?? "") === "Owner";
      if (isHeader) continue;
      if (COMMENT_ROW.test(assetPart)) break;
      if (!assetPart && !candidate.cells.amount) continue;
      if (assetPart) {
        asset += ` ${assetPart}`;
        appended += 1;
      }
      if (candidate.cells.amount) amountText = `${amountText} ${candidate.cells.amount}`;
    }

    const amount = parsePtrAmount(amountText);
    const ticker = /\(([A-Z][A-Z0-9.\-]{0,7})\)/.exec(asset)?.[1] ?? null;
    const assetType = /\[([A-Z]{1,3})\]/.exec(asset)?.[1] ?? null;
    const side: CongressSide = /^P/i.test(typeText)
      ? "buy"
      : /^S/i.test(typeText)
        ? "sell"
        : "exchange";

    trades.push({
      tradeDate,
      notifyDate,
      filedAt: meta.filedAt,
      docId: meta.docId,
      side,
      partial: /\(partial\)/i.test(typeText),
      owner: (row.cells.owner ?? "").trim() || null,
      ticker,
      assetType,
      asset: cleanPtrText(asset.replace(/\s*\[[A-Z]{1,3}\]\s*$/, "")),
      amountMin: amount?.min ?? null,
      amountMax: amount?.max ?? null,
      amountMid: amount?.mid ?? null,
      amountText: cleanPtrText(amountText),
    });
  }

  return trades;
}

/** 一次性完成「文本项 → 交易列表」 */
export function parsePtrTrades(
  items: PtrTextItem[],
  meta: { docId: string; filedAt: string },
): CongressTrade[] {
  return parsePtrRows(groupPtrRows(items), meta);
}

export interface HouseFilingRow {
  last: string;
  first: string;
  stateDst: string;
  filingType: string;
  /** 提交日（YYYY-MM-DD） */
  filedAt: string;
  docId: string;
  year: number;
}

/** `1/23/2026` → `2026-01-23` */
function indexDateToIso(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function tagValue(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

/**
 * 年度索引 XML（`<Member>` 列表）→ 规范化行。
 * 索引包含全部申报类型：P=PTR、O=原始年度报告、A=修正、W=候选人声明…
 */
export function parseHouseIndex(xml: string, year: number): HouseFilingRow[] {
  const rows: HouseFilingRow[] = [];
  const blocks = xml.match(/<Member>[\s\S]*?<\/Member>/g) ?? [];
  for (const block of blocks) {
    const filedAt = indexDateToIso(tagValue(block, "FilingDate"));
    const docId = tagValue(block, "DocID");
    if (!filedAt || !docId) continue;
    rows.push({
      last: tagValue(block, "Last"),
      first: tagValue(block, "First"),
      stateDst: tagValue(block, "StateDst"),
      filingType: tagValue(block, "FilingType"),
      filedAt,
      docId,
      year,
    });
  }
  return rows;
}


