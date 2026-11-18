/**
 * 组合回测（一次跑一个分组）的纯工具：
 *   - 把单只回测结果压缩成表格行
 *   - 表格排序（空值 / 失败的标的始终排在最后）
 *   - 分批 + 并发控制（前端一次拉多只标的的走势）
 */

import type { BacktestResult } from "@/lib/backtest";

export interface BatchBacktestRow {
  symbol: string;
  /** 仓位百分比（0–100）：该标的占本组总资金的比例；未设置时为 0 */
  weight: number;
  totalReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  cagr: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  winRate: number | null;
  tradeCount: number;
  /** 拉取 / 计算失败时的原因（此时其它指标为 null） */
  error?: string;
}

export const BATCH_SORT_KEYS = [
  "symbol",
  "weight",
  "totalReturn",
  "benchmarkReturn",
  "excessReturn",
  "maxDrawdown",
  "sharpe",
  "tradeCount",
] as const;

export type BatchSortKey = (typeof BATCH_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export function buildBatchRow(
  symbol: string,
  result: BacktestResult,
  weight = 0,
): BatchBacktestRow {
  const { stats } = result;
  const excessReturn =
    stats.totalReturn === null || stats.benchmarkReturn === null
      ? null
      : stats.totalReturn - stats.benchmarkReturn;

  return {
    symbol,
    weight,
    totalReturn: stats.totalReturn,
    benchmarkReturn: stats.benchmarkReturn,
    excessReturn,
    cagr: stats.cagr,
    maxDrawdown: stats.maxDrawdown,
    sharpe: stats.sharpe,
    winRate: stats.winRate,
    tradeCount: stats.tradeCount,
  };
}

export function buildBatchError(symbol: string, message: string, weight = 0): BatchBacktestRow {
  return {
    symbol,
    weight,
    totalReturn: null,
    benchmarkReturn: null,
    excessReturn: null,
    cagr: null,
    maxDrawdown: null,
    sharpe: null,
    winRate: null,
    tradeCount: 0,
    error: message,
  };
}

/**
 * 表格排序：失败行永远垫底；数值为空的行排在有效行之后。
 * 同值时保持原顺序（sort 稳定），方便用户对照原始分组顺序。
 */
export function sortBatchRows(
  rows: BatchBacktestRow[],
  key: BatchSortKey,
  direction: SortDirection,
): BatchBacktestRow[] {
  const sign = direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    if (a.error && b.error) return 0;

    if (key === "symbol") return a.symbol.localeCompare(b.symbol) * sign;

    const left = a[key];
    const right = b[key];
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return 0;
    return (left - right) * sign;
  });
}

export interface BatchWeightedSummary {
  /** 参与加权的仓位合计（0–100） */
  invested: number;
  /** 未分配部分，按现金处理（0–100，收益记 0%） */
  cash: number;
  /** Σ(仓位 ÷ 100 × 单只收益)；没有任何仓位时为 null */
  totalReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  /** 有效行的交易次数合计 */
  tradeCount: number;
}

/**
 * 仓位加权的组合贡献：每只标的按自己的仓位贡献「仓位 × 收益」，
 * 未分配部分按现金（收益 0%）计。取数失败的标的按 0 收益计入（资金闲置），
 * 这样合计始终是「相对总资金」的贡献，而不是单只收益的平均。
 */
export function weightedBatchSummary(rows: BatchBacktestRow[]): BatchWeightedSummary {
  let invested = 0;
  for (const row of rows) {
    if (Number.isFinite(row.weight) && row.weight > 0) invested += row.weight;
  }
  invested = Math.round(Math.min(100, invested) * 10) / 10;

  const contribute = (pick: (row: BatchBacktestRow) => number | null): number =>
    rows.reduce((sum, row) => {
      const weight = Number.isFinite(row.weight) ? Math.max(0, row.weight) : 0;
      if (weight <= 0) return sum;
      return sum + (weight / 100) * (pick(row) ?? 0);
    }, 0);

  const totalReturn = invested > 0 ? Math.round(contribute((row) => row.totalReturn) * 100) / 100 : null;
  const benchmarkReturn =
    invested > 0 ? Math.round(contribute((row) => row.benchmarkReturn) * 100) / 100 : null;
  const excessReturn =
    totalReturn === null || benchmarkReturn === null
      ? null
      : Math.round((totalReturn - benchmarkReturn) * 100) / 100;

  return {
    invested,
    cash: Math.round((100 - invested) * 10) / 10,
    totalReturn,
    benchmarkReturn,
    excessReturn,
    tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
  };
}

/** 把代码列表切成固定大小的小批（顺序不变） */
export function chunkSymbols(symbols: string[], size: number): string[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += step) {
    chunks.push(symbols.slice(index, index + step));
  }
  return chunks;
}

/**
 * 限制并发的 map：返回顺序与输入一致（不依赖完成顺序）。
 * `limit` 小于 1 时按 1 处理。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit), items.length || 1));
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()));
  return output;
}
