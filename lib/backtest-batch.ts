/**
 * 组合回测（一次跑一个分组）的纯工具：
 *   - 把单只回测结果压缩成表格行
 *   - 表格排序（空值 / 失败的标的始终排在最后）
 *   - 分批 + 并发控制（前端一次拉多只标的的走势）
 */

import type { BacktestResult } from "@/lib/backtest";

export interface BatchBacktestRow {
  symbol: string;
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
  "totalReturn",
  "benchmarkReturn",
  "excessReturn",
  "maxDrawdown",
  "sharpe",
  "tradeCount",
] as const;

export type BatchSortKey = (typeof BATCH_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export function buildBatchRow(symbol: string, result: BacktestResult): BatchBacktestRow {
  const { stats } = result;
  const excessReturn =
    stats.totalReturn === null || stats.benchmarkReturn === null
      ? null
      : stats.totalReturn - stats.benchmarkReturn;

  return {
    symbol,
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

export function buildBatchError(symbol: string, message: string): BatchBacktestRow {
  return {
    symbol,
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
