"use client";

import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import { formatNumber, formatPercent } from "@/lib/format";
import {
  sortBatchRows,
  weightedBatchSummary,
  type BatchBacktestRow,
  type BatchSortKey,
  type SortDirection,
} from "@/lib/backtest-batch";

interface BatchResultsProps {
  groupName: string;
  rows: BatchBacktestRow[];
  running: boolean;
  done: number;
  total: number;
  rangeLabel: string;
  intervalLabel: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}

const COLUMNS: { key: BatchSortKey; label: string; align: "left" | "right" }[] = [
  { key: "symbol", label: "标的", align: "left" },
  { key: "weight", label: "仓位", align: "right" },
  { key: "totalReturn", label: "策略收益", align: "right" },
  { key: "benchmarkReturn", label: "买入持有", align: "right" },
  { key: "excessReturn", label: "超额收益", align: "right" },
  { key: "maxDrawdown", label: "最大回撤", align: "right" },
  { key: "sharpe", label: "夏普", align: "right" },
  { key: "tradeCount", label: "交易次数", align: "right" },
];

function toneClass(tone: boolean | null): string {
  if (tone === null) return "text-foreground";
  return tone ? "text-positive-text" : "text-negative-text";
}

/** 组合回测结果表：按收益 / 回撤 / 夏普排序，点行切换标的 */
export default function BatchResults({
  groupName,
  rows,
  running,
  done,
  total,
  rangeLabel,
  intervalLabel,
  onSelect,
  onClose,
}: BatchResultsProps) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState<BatchSortKey>("totalReturn");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const sorted = sortBatchRows(rows, sortKey, direction);
  const validRows = rows.filter((row) => !row.error && row.totalReturn !== null);
  /** 按仓位加权的组合贡献（未分配部分按现金、收益 0% 计） */
  const weighted = weightedBatchSummary(rows);
  const average = (pick: (row: BatchBacktestRow) => number | null): number | null => {
    const values = validRows
      .map((row) => pick(row))
      .filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };

  function toggleSort(key: BatchSortKey) {
    if (key === sortKey) {
      setDirection((prev) => (prev === "desc" ? "asc" : "desc"));
      return;
    }
    setSortKey(key);
    setDirection(key === "symbol" ? "asc" : "desc");
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-[13px] font-medium">
          {t("组合回测")}
          <span className="rounded border border-accent/25 bg-accent-soft px-1.5 py-0.5 text-[10px] font-normal text-accent">
            {groupName}
          </span>
          <span className="num text-[10px] font-normal text-muted-foreground">
            {rangeLabel} · {intervalLabel}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {running ? (
            <span className="num inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent border-t-transparent" />
              {t("回测中")} {done}/{total}
            </span>
          ) : (
            <span className="num text-[10px] text-muted-foreground">
              {t("共")} {rows.length} {t("只")}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            {t("关闭")}
          </button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-auto scroll-thin">
        <table className="w-full min-w-[720px] text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
            <tr className="text-[10px] text-muted-foreground">
              {COLUMNS.map((column) => {
                const active = sortKey === column.key;
                return (
                  <th
                    key={column.key}
                    className={`px-3 py-1.5 font-medium ${
                      column.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      aria-label={`${t(column.label)} ${t("排序")}`}
                      title={`${t(column.label)} ${t("排序")}`}
                      className={`inline-flex items-center gap-0.5 transition-colors hover:text-foreground ${
                        active ? "text-accent" : ""
                      }`}
                    >
                      {t(column.label)}
                      {active && <span aria-hidden="true">{direction === "desc" ? "↓" : "↑"}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.symbol}
                onClick={() => onSelect(row.symbol)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(row.symbol);
                  }
                }}
                className="cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/60"
              >
                <td className="num px-3 py-1.5 font-medium">
                  {row.symbol}
                  {row.error && (
                    <span className="ml-1.5 rounded bg-negative-soft px-1 py-0.5 text-[9px] text-negative-text">
                      {t("失败")}
                    </span>
                  )}
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {row.weight > 0 ? `${formatNumber(row.weight, 1)}%` : "—"}
                </td>
                {row.error ? (
                  <td
                    className="px-3 py-1.5 text-[10px] text-muted-foreground"
                    colSpan={COLUMNS.length - 1}
                  >
                    {row.error}
                  </td>
                ) : (
                  <>
                    <td className={`num px-3 py-1.5 text-right ${toneClass((row.totalReturn ?? 0) >= 0)}`}>
                      {formatPercent(row.totalReturn)}
                    </td>
                    <td
                      className={`num px-3 py-1.5 text-right ${toneClass(
                        (row.benchmarkReturn ?? 0) >= 0,
                      )}`}
                    >
                      {formatPercent(row.benchmarkReturn)}
                    </td>
                    <td
                      className={`num px-3 py-1.5 text-right ${toneClass(
                        (row.excessReturn ?? 0) >= 0,
                      )}`}
                    >
                      {formatPercent(row.excessReturn)}
                    </td>
                    <td className="num px-3 py-1.5 text-right text-negative-text">
                      {formatPercent(row.maxDrawdown)}
                    </td>
                    <td className="num px-3 py-1.5 text-right">{formatNumber(row.sharpe, 2)}</td>
                    <td className="num px-3 py-1.5 text-right text-muted-foreground">
                      {row.tradeCount}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {!running && rows.length > 0 && weighted.invested > 0 && weighted.cash > 0 && (
              <tr className="border-t border-dashed border-border/70 bg-muted/20 text-[11px]">
                <td className="px-3 py-1.5">
                  <span className="rounded bg-muted px-1 py-0.5 text-[9.5px] text-muted-foreground">
                    {t("现金")}
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {formatNumber(weighted.cash, 1)}%
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">0.00%</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">0.00%</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">0.00%</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">0.00%</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">—</td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">0</td>
              </tr>
            )}
            {running && rows.length === 0 && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-4 text-center text-[11px] text-muted-foreground"
                >
                  {t("正在加载组合行情")}…
                </td>
              </tr>
            )}
          </tbody>
          {!running && validRows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30 text-[10.5px]">
                <td className="px-3 py-1.5 font-medium">{t("组合平均")}</td>
                <td
                  className="num px-3 py-1.5 text-right text-muted-foreground"
                  title={t("已分配仓位合计")}
                >
                  {formatNumber(weighted.invested, 1)}%
                </td>
                <td className="num px-3 py-1.5 text-right">
                  {formatPercent(average((row) => row.totalReturn))}
                </td>
                <td className="num px-3 py-1.5 text-right">
                  {formatPercent(average((row) => row.benchmarkReturn))}
                </td>
                <td className="num px-3 py-1.5 text-right">
                  {formatPercent(average((row) => row.excessReturn))}
                </td>
                <td className="num px-3 py-1.5 text-right">
                  {formatPercent(average((row) => row.maxDrawdown))}
                </td>
                <td className="num px-3 py-1.5 text-right">
                  {formatNumber(average((row) => row.sharpe), 2)}
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {rows.reduce((sum, row) => sum + row.tradeCount, 0)}
                </td>
              </tr>
              {weighted.invested > 0 && (
                <tr
                  className="border-t border-border bg-accent-soft/40 text-[10.5px]"
                  title={t("Σ(仓位 × 单只收益) + 现金 × 0%；回撤与夏普无法由单只结果加权")}
                >
                  <td className="px-3 py-1.5 font-medium text-accent">
                    {t("仓位加权（含现金）")}
                  </td>
                  <td className="num px-3 py-1.5 text-right text-accent">100%</td>
                  <td className="num px-3 py-1.5 text-right font-medium">
                    {formatPercent(weighted.totalReturn)}
                  </td>
                  <td className="num px-3 py-1.5 text-right">
                    {formatPercent(weighted.benchmarkReturn)}
                  </td>
                  <td className="num px-3 py-1.5 text-right">
                    {formatPercent(weighted.excessReturn)}
                  </td>
                  <td className="num px-3 py-1.5 text-right text-muted-foreground">—</td>
                  <td className="num px-3 py-1.5 text-right text-muted-foreground">—</td>
                  <td className="num px-3 py-1.5 text-right text-muted-foreground">
                    {weighted.tradeCount}
                  </td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      <p className="border-t border-border/60 px-4 py-2 text-[10px] leading-4 text-muted-foreground">
        {t("点击表头排序，点击任意一行切换为当前回测标的；结果使用当前区间 / 周期 / 策略参数")}
      </p>
      {weighted.invested > 0 && (
        <p className="px-4 pb-2 text-[10px] leading-4 text-muted-foreground">
          {t("仓位在标的库分配，未分配部分按现金（收益 0%）计；回撤与夏普无法由单只结果加权")}
        </p>
      )}
    </section>
  );
}
