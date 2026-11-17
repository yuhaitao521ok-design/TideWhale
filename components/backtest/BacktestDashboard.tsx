"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PageShell from "@/components/PageShell";
import DrawdownChart from "@/components/backtest/DrawdownChart";
import EquityChart from "@/components/backtest/EquityChart";
import BatchResults from "@/components/backtest/BatchResults";
import StrategyPicker from "@/components/backtest/StrategyPicker";
import SymbolLibrary from "@/components/backtest/SymbolLibrary";
import SymbolPicker from "@/components/backtest/SymbolPicker";
import { useI18n } from "@/lib/i18n";
import { formatNumber, formatPercent, formatPrice } from "@/lib/format";
import {
  DEFAULT_PARAMS,
  computeSignalDuties,
  runBacktest,
  strategyEntryText,
  strategyExitText,
  type BacktestParams,
} from "@/lib/backtest";
import { STRATEGY_MAP } from "@/lib/backtest-catalog";
import {
  addSnapshot,
  buildSnapshot,
  loadSnapshots,
  removeSnapshot,
  MAX_COMPARE,
  type BacktestSnapshot,
} from "@/lib/backtest-snapshot";
import {
  BACKTEST_RANGES,
  defaultBacktestInterval,
  estimateBars,
  intervalsForBacktest,
} from "@/lib/backtest-frame";
import {
  ALL_SYMBOLS_ID,
  LEGACY_HISTORY_KEY,
  LEGACY_LIBRARY_KEY,
  LIBRARY_KEY,
  MAX_BACKTEST_GROUPS,
  addSymbol,
  clearSymbolGroups,
  createGroup,
  deleteGroup,
  emptyLibrary,
  libraryFromHistory,
  moveGroup,
  removeSymbol,
  renameGroup,
  sanitizeLibrary,
  symbolsOf,
  toggleSymbolGroup,
  type BacktestLibrary,
} from "@/lib/backtest-library";
import {
  buildBatchError,
  buildBatchRow,
  mapWithConcurrency,
  type BatchBacktestRow,
} from "@/lib/backtest-batch";
import {
  DEFAULT_WATCHLIST,
  INTERVAL_CONFIG,
  RANGE_CONFIG,
  type ChartPoint,
  type IntervalKey,
  type RangeKey,
} from "@/lib/types";

const SYMBOL_RE = /^[A-Z0-9.^=-]{1,12}$/;

const CAPITALS = [1_000, 10_000, 100_000];

export default function BacktestDashboard() {
  const { t } = useI18n();
  const [symbol, setSymbol] = useState<string>(DEFAULT_WATCHLIST[0]);
  const [draft, setDraft] = useState<string>(DEFAULT_WATCHLIST[0]);
  const [library, setLibrary] = useState<BacktestLibrary>(() => ({
    ...emptyLibrary(),
    symbols: [DEFAULT_WATCHLIST[0]],
  }));
  const [libraryReady, setLibraryReady] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string>(ALL_SYMBOLS_ID);
  const [batch, setBatch] = useState<{
    groupName: string;
    range: RangeKey;
    interval: IntervalKey;
    rows: BatchBacktestRow[];
    running: boolean;
    done: number;
    total: number;
  } | null>(null);
  const batchRef = useRef(0);
  const batchAbortRef = useRef<AbortController | null>(null);
  const [range, setRange] = useState<RangeKey>("5Y");
  const [interval, setIntervalKey] = useState<IntervalKey>(defaultBacktestInterval("5Y"));
  const [params, setParams] = useState<BacktestParams>(DEFAULT_PARAMS);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const [snapshots, setSnapshots] = useState<BacktestSnapshot[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const urlSyncedRef = useRef(false);

  // 读取标的库（没有新键时把旧版「最近回测」迁移过来）
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LIBRARY_KEY);
      if (raw) {
        const stored = sanitizeLibrary(JSON.parse(raw));
        if (stored.symbols.length > 0) {
          setLibrary(stored);
          return;
        }
      }
      // v1 的归属是单个分组字符串，sanitizeLibrary 会统一升级成数组
      const legacyLibrary = window.localStorage.getItem(LEGACY_LIBRARY_KEY);
      if (legacyLibrary) {
        const migrated = sanitizeLibrary(JSON.parse(legacyLibrary));
        if (migrated.symbols.length > 0) {
          setLibrary(migrated);
          return;
        }
      }
      const legacyHistory = window.localStorage.getItem(LEGACY_HISTORY_KEY);
      if (legacyHistory) {
        const migrated = libraryFromHistory(JSON.parse(legacyHistory));
        if (migrated.symbols.length > 0) setLibrary(migrated);
      }
    } catch {
      // 忽略
    } finally {
      // 读完（或确认没有存档）后再允许写回，避免首帧把存档覆盖成默认值
      setLibraryReady(true);
    }
  }, []);

  useEffect(() => {
    if (!libraryReady) return;
    try {
      window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch {
      // 忽略
    }
  }, [library, libraryReady]);

  // 只有合法代码才请求（避免删除输入时 404 报错）
  const load = useCallback(
    async (nextSymbol: string, nextRange: RangeKey, nextInterval: IntervalKey) => {
      if (!SYMBOL_RE.test(nextSymbol)) return;
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/chart?symbol=${encodeURIComponent(nextSymbol)}&range=${nextRange}&interval=${nextInterval}`,
          { cache: "no-store" },
        );
        if (requestId !== requestRef.current) return;
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `加载失败（${response.status}）`);
        }
        const data = (await response.json()) as { points: ChartPoint[]; currency: string };
        if (requestId !== requestRef.current) return;
        setPoints(data.points ?? []);
        setCurrency(data.currency ?? "USD");
      } catch (err) {
        if (requestId !== requestRef.current) return;
        setPoints([]);
        setError(err instanceof Error ? err.message : "加载失败");
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(symbol, range, interval);
  }, [symbol, range, interval, load]);

  const result = useMemo(
    () => (points.length > 0 ? runBacktest(points, params, interval) : null),
    [points, params, interval],
  );

  /** 各策略看多占比：让「联动」效果可见，也能看出某策略是不是几乎不触发 */
  const strategyDuties = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of computeSignalDuties(points, params)) map[item.key] = item.duty;
    return map;
  }, [points, params]);

  // —— 快照：读取本地保存的对比记录 ——
  useEffect(() => {
    setSnapshots(loadSnapshots());
  }, []);

  // —— URL 同步：首次用 URL 里的配置覆盖默认值，之后把配置写回 query（可分享 / 收藏）——
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const readNumber = (key: string, min: number, max: number): number | null => {
      const raw = Number.parseFloat(query.get(key) ?? "");
      return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : null;
    };

    const urlSymbol = (query.get("symbol") ?? "").toUpperCase();
    if (SYMBOL_RE.test(urlSymbol)) {
      setSymbol(urlSymbol);
      setDraft(urlSymbol);
      setLibrary((prev) => addSymbol(prev, urlSymbol));
    }

    const validRange = BACKTEST_RANGES.find((item) => item === query.get("range"));
    const nextRange = validRange ?? null;
    if (validRange) setRange(validRange);

    const allowed = intervalsForBacktest(validRange ?? "5Y");
    const validInterval = allowed.find((item) => item === query.get("interval"));
    if (validInterval) setIntervalKey(validInterval);

    const strategies = (query.get("strategies") ?? "")
      .split(",")
      .filter((item) => item in STRATEGY_MAP);
    const combine = query.get("combine");

    const patch: Partial<BacktestParams> = {};
    const mapping: Array<[string, keyof BacktestParams, number, number]> = [
      ["capital", "initialCapital", 100, 100_000_000],
      ["fast", "fast", 2, 100],
      ["slow", "slow", 2, 200],
      ["oversold", "oversold", 5, 45],
      ["overbought", "overbought", 55, 95],
      ["multiplier", "multiplier", 1, 4],
      ["signal", "signal", 2, 50],
      ["exitLookback", "exitLookback", 2, 60],
      ["threshold", "threshold", 1, 60],
      ["feeBps", "feeBps", 0, 50],
    ];
    for (const [queryKey, paramKey, min, max] of mapping) {
      const value = readNumber(queryKey, min, max);
      if (value !== null) (patch as Record<string, number>)[paramKey] = value;
    }
    setParams((prev) => ({
      ...prev,
      ...patch,
      ...(strategies.length > 0 ? { strategies } : {}),
      ...(combine === "all" || combine === "any" ? { combineMode: combine } : {}),
    }));

    urlSyncedRef.current = true;
  }, []);

  // 配置变化 → 写回 URL（replaceState 不污染历史记录）
  useEffect(() => {
    if (!urlSyncedRef.current) return;
    const query = new URLSearchParams();
    query.set("symbol", symbol);
    query.set("range", range);
    query.set("interval", interval);
    query.set("strategies", params.strategies.join(","));
    query.set("combine", params.combineMode);
    query.set("capital", String(params.initialCapital));
    for (const key of [
      "fast",
      "slow",
      "oversold",
      "overbought",
      "multiplier",
      "signal",
      "exitLookback",
      "threshold",
      "feeBps",
    ] as const) {
      query.set(key, String(params[key]));
    }
    window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
  }, [symbol, range, interval, params]);

  /** 叠加对比的快照（最多 MAX_COMPARE 条） */
  const compareOverlays = useMemo(() => {
    const colors = ["var(--chart-series-2)", "var(--chart-series-3)", "var(--chart-series-4)"];
    return compareIds
      .map((id) => snapshots.find((item) => item.id === id))
      .filter((item): item is BacktestSnapshot => Boolean(item))
      .map((item, index) => ({
        label: item.label,
        equity: item.equity,
        color: colors[index % colors.length],
      }));
  }, [compareIds, snapshots]);

  function toggleCompare(id: string) {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(-MAX_COMPARE),
    );
  }

  function deleteSnapshot(id: string) {
    setSnapshots((prev) => removeSnapshot(prev, id));
    setCompareIds((prev) => prev.filter((item) => item !== id));
  }

  function saveCurrentSnapshot() {
    if (!result) return;
    const label = `${symbol} · ${selectedStrategies[0] ?? ""}${
      selectedStrategies.length > 1 ? ` +${selectedStrategies.length - 1}` : ""
    }`;
    const snapshot = buildSnapshot({
      id: `${Date.now()}-${symbol}`,
      label,
      symbol,
      range,
      interval,
      params,
      equity: result.equity,
      stats: {
        initialCapital: result.stats.initialCapital,
        totalReturn: result.stats.totalReturn,
        benchmarkReturn: result.stats.benchmarkReturn,
        cagr: result.stats.cagr,
        maxDrawdown: result.stats.maxDrawdown,
        maxDrawdownDays: result.stats.maxDrawdownDays,
        sharpe: result.stats.sharpe,
        tradeCount: result.stats.tradeCount,
      },
    });
    setSnapshots((prev) => addSnapshot(prev, snapshot));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时忽略
    }
  }

  function commitSymbol(next: string) {
    if (!SYMBOL_RE.test(next)) return;
    // 新代码不在当前分组里时切回「所有标的」，否则用户会觉得刚搜的代码没进列表
    if (!symbolsOf(library, activeGroupId).includes(next)) setActiveGroupId(ALL_SYMBOLS_ID);
    setSymbol(next);
    setLibrary((prev) => addSymbol(prev, next));
  }

  /* ------------------------------- 标的库分组 ------------------------------ */

  function createLibraryGroup(name: string): string | null {
    const result = createGroup(library, name);
    if (!result) {
      return library.groups.length >= MAX_BACKTEST_GROUPS
        ? `${t("最多")} ${MAX_BACKTEST_GROUPS} ${t("个分组")}`
        : t("分组名称为空或已存在");
    }
    setLibrary(result.library);
    setActiveGroupId(result.group.id);
    return null;
  }

  function renameLibraryGroup(groupId: string, name: string): string | null {
    const next = renameGroup(library, groupId, name);
    if (!next) return t("分组名称为空或已存在");
    setLibrary(next);
    return null;
  }

  function deleteLibraryGroup(groupId: string) {
    setLibrary((prev) => deleteGroup(prev, groupId));
    setActiveGroupId((prev) => (prev === groupId ? ALL_SYMBOLS_ID : prev));
  }

  function removeLibrarySymbol(target: string) {
    setLibrary((prev) => removeSymbol(prev, target));
  }

  function toggleLibraryGroup(target: string, groupId: string) {
    setLibrary((prev) => toggleSymbolGroup(prev, target, groupId));
  }

  function clearLibraryGroups(target: string) {
    setLibrary((prev) => clearSymbolGroups(prev, target));
  }

  function moveLibraryGroup(fromId: string, toId: string) {
    setLibrary((prev) => {
      const from = prev.groups.findIndex((group) => group.id === fromId);
      const to = prev.groups.findIndex((group) => group.id === toId);
      return moveGroup(prev, from, to);
    });
  }

  function clearLibrary() {
    setLibrary((prev) => ({ ...prev, symbols: [], assignment: {} }));
    setActiveGroupId(ALL_SYMBOLS_ID);
    batchRef.current += 1;
    batchAbortRef.current?.abort();
    setBatch(null);
  }

  /* ------------------------------- 组合回测 ------------------------------- */

  async function runBatch(groupId: string) {
    const members = symbolsOf(library, groupId);
    const groupName = library.groups.find((group) => group.id === groupId)?.name ?? groupId;
    if (members.length === 0) return;

    batchAbortRef.current?.abort();
    const controller = new AbortController();
    batchAbortRef.current = controller;
    const ticket = ++batchRef.current;
    const total = members.length;
    let done = 0;
    setBatch({ groupName, range, interval, rows: [], running: true, done: 0, total });

    const rows = await mapWithConcurrency(members, 3, async (member) => {
      let row: BatchBacktestRow;
      if (controller.signal.aborted) return buildBatchError(member, t("已取消"));
      try {
        const response = await fetch(
          `/api/chart?symbol=${encodeURIComponent(member)}&range=${range}&interval=${interval}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { points?: ChartPoint[] };
        const series = data.points ?? [];
        if (series.length === 0) throw new Error(t("数据点不足，无法回测"));
        row = buildBatchRow(member, runBacktest(series, params, interval));
      } catch (err) {
        row = buildBatchError(member, err instanceof Error ? err.message : t("加载失败"));
      }

      done += 1;
      if (batchRef.current === ticket) {
        setBatch((prev) => (prev ? { ...prev, done, rows: [...prev.rows, row] } : prev));
      }
      return row;
    });

    if (batchRef.current !== ticket || controller.signal.aborted) return;
    setBatch({ groupName, range, interval, rows, running: false, done: total, total });
  }

  /** 切换区间时，若当前 K 线周期在该区间不可用，自动落到默认周期 */
  function changeRange(next: RangeKey) {
    setRange(next);
    const allowed = intervalsForBacktest(next);
    setIntervalKey((prev) =>
      allowed.includes(prev) ? prev : defaultBacktestInterval(next),
    );
  }

  const update = (patch: Partial<BacktestParams>) => setParams((prev) => ({ ...prev, ...patch }));

  const allowedIntervals = useMemo(() => intervalsForBacktest(range), [range]);
  const bars = estimateBars(range, interval);
  const frameLabel = `${t(INTERVAL_CONFIG[interval].label)} · ${t(RANGE_CONFIG[range].label)}`;
  const selectedStrategies = params.strategies
    .map((key) => STRATEGY_MAP[key]?.label)
    .filter((label): label is string => Boolean(label));

  const field = (
    key: keyof Pick<
      BacktestParams,
      "fast" | "slow" | "oversold" | "overbought" | "multiplier" | "signal" | "exitLookback" | "threshold" | "feeBps"
    >,
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">{t(label)}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={params[key]}
        onChange={(event) => {
          const value = Number.parseFloat(event.target.value);
          if (!Number.isFinite(value)) return;
          update({ [key]: Math.min(max, Math.max(min, value)) } as Partial<BacktestParams>);
        }}
        aria-label={t(label)}
        className="num h-7 w-[76px] rounded-md border border-border bg-card px-2 text-right text-[12px] outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
      />
    </label>
  );

  /** 当前所选策略需要展示的参数（多个策略取并集，按固定顺序） */
  const activeFields = useMemo(() => {
    const order = ["fast", "slow", "oversold", "overbought", "multiplier", "signal", "exitLookback", "threshold"] as const;
    const needed = new Set<string>();
    for (const key of params.strategies) {
      const meta = STRATEGY_MAP[key];
      for (const item of meta?.fields ?? []) needed.add(item);
    }
    return order.filter((item) => needed.has(item));
  }, [params.strategies]);

  function renderField(key: (typeof activeFields)[number]) {
    switch (key) {
      case "fast":
        return field("fast", "快线周期", 2, 100);
      case "slow":
        return field("slow", "慢线周期", 2, 200);
      case "oversold":
        return field("oversold", "买入阈值", 5, 45);
      case "overbought":
        return field("overbought", "卖出阈值", 55, 95);
      case "multiplier":
        return field("multiplier", "标准差倍数", 1, 4, 0.1);
      case "signal":
        return field("signal", "MACD 信号", 2, 50);
      case "exitLookback":
        return field("exitLookback", "出场回看", 2, 60);
      case "threshold":
        return field("threshold", "阈值", 1, 60);
    }
  }

  return (
    <PageShell
      title={t("策略回测")}
      description={t("多策略自由组合 · 日线 / 周线 / 月线可选 · 本地回测，含手续费")}
      actions={
        <>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-hover hover:text-foreground"
          >
            {copied ? t("已复制") : t("复制链接")}
          </button>
          <button
            type="button"
            onClick={() => void load(symbol, range, interval)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-hover hover:text-foreground"
          >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t("刷新")}
        </button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3">
          <section className="rounded-xl border border-border bg-card p-3 shadow-[0_1px_2px_rgba(9,9,11,0.04)]">
            <p className="mb-2 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
              {t("标的与区间")}
              <span className="num rounded bg-muted px-1.5 py-0.5 text-[9.5px] font-normal text-muted-foreground/80">
                {frameLabel}
              </span>
            </p>
            <SymbolPicker
              value={symbol}
              onChange={commitSymbol}
              onDraft={setDraft}
              invalid={draft.length > 0 && !SYMBOL_RE.test(draft)}
            />

            <div className="mt-3 space-y-2">
              <div>
                <p className="mb-1 text-[10.5px] text-muted-foreground">{t("回测区间")}</p>
                <div className="flex gap-1">
                  {BACKTEST_RANGES.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => changeRange(item)}
                      aria-pressed={range === item}
                      className={`num h-6 flex-1 rounded-md border text-[10.5px] transition-colors ${
                        range === item
                          ? "border-accent/50 bg-accent-soft font-medium text-accent"
                          : "border-border text-muted-foreground hover:border-accent/30 hover:bg-hover hover:text-foreground"
                      }`}
                    >
                      {t(RANGE_CONFIG[item].label)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
                  {t("K 线周期")}
                  <span className="text-[10px] text-muted-foreground/70">
                    ≈ {bars.toLocaleString("en-US")} {t("根 K 线")}
                  </span>
                </p>
                <div className="flex gap-1">
                  {allowedIntervals.map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setIntervalKey(item)}
                      aria-pressed={interval === item}
                      className={`h-6 flex-1 rounded-md border text-[10.5px] transition-colors ${
                        interval === item
                          ? "border-accent/50 bg-accent-soft font-medium text-accent"
                          : "border-border text-muted-foreground hover:border-accent/30 hover:bg-hover hover:text-foreground"
                      }`}
                    >
                      {t(INTERVAL_CONFIG[item].label)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <SymbolLibrary
            library={library}
            activeGroupId={activeGroupId}
            onActiveGroupChange={setActiveGroupId}
            currentSymbol={symbol}
            onSelect={commitSymbol}
            onRemove={removeLibrarySymbol}
            onCreateGroup={createLibraryGroup}
            onRenameGroup={renameLibraryGroup}
            onDeleteGroup={deleteLibraryGroup}
            onToggleGroup={toggleLibraryGroup}
            onClearGroups={clearLibraryGroups}
            onMoveGroup={moveLibraryGroup}
            onClear={clearLibrary}
            onBatchBacktest={(groupId) => void runBatch(groupId)}
            batch={batch}
          />

          <section className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground">
              {t("初始资金（USD）")}
            </p>
            <input
              type="number"
              min={100}
              step={1000}
              value={params.initialCapital}
              onChange={(event) => {
                const value = Number.parseFloat(event.target.value);
                if (!Number.isFinite(value)) return;
                update({ initialCapital: Math.max(100, value) });
              }}
              aria-label={t("初始资金（USD）")}
              className="num h-7 w-full rounded-md border border-border bg-card px-2 text-right text-[12px] outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            />
            <div className="mt-1.5 flex gap-1">
              {CAPITALS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => update({ initialCapital: value })}
                  className={`num flex-1 rounded border px-1 py-0.5 text-[10px] transition-colors ${
                    params.initialCapital === value
                      ? "border-accent/40 bg-accent-soft text-accent"
                      : "border-border text-muted-foreground hover:bg-hover hover:text-foreground"
                  }`}
                >
                  {value >= 1000 ? `${value / 1000}k` : value}
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[11px] font-medium text-muted-foreground">{t("策略")}</p>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                {params.strategies.length} {t("个已选")}
              </span>
            </div>
            <StrategyPicker params={params} onChange={update} duties={strategyDuties} />

            <div className="mt-3 space-y-1.5 border-t border-border pt-2">
              {activeFields.map((key) => renderField(key))}
              {field("feeBps", "手续费 bp", 0, 50)}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
              {t("回测粒度建议")}
            </p>
            <ul className="space-y-1 text-[10.5px] leading-4 text-muted-foreground">
              <li>{t("日线是最常用的回测粒度：数据完整、信号稳定，适合大多数中长线策略。")}</li>
              <li>{t("5 年以上的长线可切到周线或月线：噪音更少、交易更少，但信号更滞后。")}</li>
              <li>{t("3–6 个月的短线可用小时线：噪音和滑点更大，结论仅供参考。")}</li>
            </ul>
          </section>
        </aside>

        <section className="min-w-0 space-y-3" aria-busy={loading}>
          {batch && (
            <BatchResults
              groupName={batch.groupName}
              rows={batch.rows}
              running={batch.running}
              done={batch.done}
              total={batch.total}
              rangeLabel={t(RANGE_CONFIG[batch.range].label)}
              intervalLabel={t(INTERVAL_CONFIG[batch.interval].label)}
              onSelect={commitSymbol}
              onClose={() => {
                batchRef.current += 1;
                batchAbortRef.current?.abort();
                setBatch(null);
              }}
            />
          )}

          {error ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <p className="text-[12px] text-negative-text">{error}</p>
              <button
                type="button"
                onClick={() => void load(symbol, range, interval)}
                className="mt-2 h-7 rounded-md border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                {t("重试")}
              </button>
            </div>
          ) : loading && !result ? (
            <div className="space-y-3">
              <div className="skeleton h-[76px] rounded-xl" />
              <div className="skeleton h-[360px] rounded-xl" />
            </div>
          ) : !result ? (
            <p className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-[12px] text-muted-foreground">
              {t("数据点不足，无法回测")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border bg-card px-3 py-2 text-[10.5px] text-muted-foreground">
                <span className="num text-[12.5px] font-medium tracking-wide text-foreground">
                  {symbol}
                </span>
                <span className="num rounded bg-muted px-1.5 py-0.5">{frameLabel}</span>
                {selectedStrategies.map((label) => (
                  <span
                    key={label}
                    className="rounded border border-accent/25 bg-accent-soft px-1.5 py-0.5 text-accent"
                  >
                    {t(label)}
                  </span>
                ))}
                <span className="num ml-auto inline-flex items-center gap-1.5">
                  {loading && (
                    <span className="h-2.5 w-2.5 animate-spin rounded-full border border-accent border-t-transparent" />
                  )}
                  {t("按收盘价成交，含手续费")}
                </span>
              </div>

              <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {[
                  { label: t("最终市值"), value: result.stats.finalValue === null ? "--" : formatPrice(result.stats.finalValue, currency), tone: (result.stats.profit ?? 0) >= 0 },
                  { label: t("盈亏"), value: result.stats.profit === null ? "--" : formatPrice(result.stats.profit, currency), tone: (result.stats.profit ?? 0) >= 0 },
                  { label: t("策略收益"), value: formatPercent(result.stats.totalReturn), tone: (result.stats.totalReturn ?? 0) >= 0 },
                  { label: t("买入持有"), value: formatPercent(result.stats.benchmarkReturn), tone: (result.stats.benchmarkReturn ?? 0) >= 0 },
                  {
                    label: t("超额收益"),
                    value:
                      result.stats.totalReturn === null || result.stats.benchmarkReturn === null
                        ? "--"
                        : formatPercent(result.stats.totalReturn - result.stats.benchmarkReturn),
                    tone: (result.stats.totalReturn ?? 0) - (result.stats.benchmarkReturn ?? 0) >= 0,
                  },
                  { label: t("年化收益"), value: formatPercent(result.stats.cagr), tone: (result.stats.cagr ?? 0) >= 0 },
                  { label: t("最大回撤"), value: formatPercent(result.stats.maxDrawdown), tone: false },
                  { label: t("夏普"), value: formatNumber(result.stats.sharpe, 2), tone: null },
                  { label: t("胜率"), value: formatPercent(result.stats.winRate, 1).replace("+", ""), tone: null },
                  { label: t("交易次数"), value: String(result.stats.tradeCount), tone: null },
                  { label: t("平均持仓"), value: result.stats.avgDays === null ? "--" : `${formatNumber(result.stats.avgDays, 0)} ${t("天")}`, tone: null },
                  { label: t("持仓占比"), value: formatPercent(result.stats.exposure, 1).replace("+", ""), tone: null },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="bg-card px-3.5 py-2.5 transition-colors hover:bg-muted/50"
                  >
                    <p className="text-[10.5px] text-muted-foreground">{item.label}</p>
                    <p
                      className={`num mt-0.5 text-[13.5px] font-medium ${
                        item.tone === null
                          ? "text-foreground"
                          : item.tone
                            ? "text-positive-text"
                            : "text-negative-text"
                      }`}
                    >
                      {item.value}
                    </p>
                  </div>
                ))}
              </section>

              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <h2 className="text-[13px] font-medium">{t("净值曲线")}</h2>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={saveCurrentSnapshot}
                      className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[10px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-hover hover:text-foreground"
                    >
                      ＋ {t("保存快照")}
                    </button>
                    <span className="num text-[10px] text-muted-foreground">
                      {symbol} · {frameLabel}
                    </span>
                  </div>
                </div>

                {snapshots.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
                    <span className="text-[10px] text-muted-foreground">{t("对比快照")}</span>
                    {snapshots.map((item) => {
                      const active = compareIds.includes(item.id);
                      return (
                        <span
                          key={item.id}
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                            active
                              ? "border-accent/50 bg-accent-soft text-accent"
                              : "border-border text-muted-foreground hover:bg-hover"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleCompare(item.id)}
                            aria-pressed={active}
                            className="num"
                          >
                            {item.label}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteSnapshot(item.id)}
                            aria-label={t("删除")}
                            title={t("删除")}
                            className="text-muted-foreground transition-colors hover:text-negative-text"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                    <span className="ml-auto text-[9.5px] text-muted-foreground/70">
                      {t("最多同时对比 3 组")}
                    </span>
                  </div>
                )}

                <EquityChart
                  equity={result.equity}
                  benchmark={result.benchmark}
                  price={result.price}
                  trades={result.trades}
                  currency={currency}
                  overlays={compareOverlays}
                  labels={{
                    strategy: t("策略净值"),
                    benchmark: t("买入持有"),
                    price: t("股价"),
                    empty: t("暂无数据"),
                    buy: t("买入"),
                    sell: t("卖出"),
                    initial: t("初始资金"),
                  }}
                />
              </section>

              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <h2 className="text-[13px] font-medium">{t("回撤水下图")}</h2>
                  <span className="num text-[10px] text-muted-foreground">
                    {t("最长回撤")}{" "}
                    {result.stats.maxDrawdownDays === null
                      ? "--"
                      : `${formatNumber(result.stats.maxDrawdownDays, 0)} ${t("天")}`}
                  </span>
                </div>
                <DrawdownChart
                  drawdown={result.drawdown}
                  label={t("回撤")}
                  empty={t("暂无数据")}
                />
                <div className="space-y-0.5 border-t border-border/60 px-4 py-2 text-[10px] leading-4 text-muted-foreground">
                  <p>{t("回撤 = 净值距历史高点的回落幅度，0% 线即历史新高")}</p>
                  <p>{t("水下越深、停留越久，说明策略的回撤风险越大")}</p>
                  <p>
                    {t(
                      "最长回撤 = 从历史高点回落到重新创新高经历的自然日；未收复则算到今天。深度看风险承受，时长看资金占用",
                    )}
                  </p>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <h2 className="text-[13px] font-medium">
                    {t("交易明细")}
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                      {result.trades.length}
                    </span>
                  </h2>
                  <span className="text-[10px] text-muted-foreground">
                    {t("按收盘价成交，含手续费")}
                  </span>
                </div>
                {result.trades.length === 0 ? (
                  <p className="px-4 py-4 text-[11.5px] text-muted-foreground">
                    {t("该参数区间内没有完整交易")}
                  </p>
                ) : (
                  <div className="max-h-[380px] overflow-auto scroll-thin">
                    <table className="w-full min-w-[680px] text-[11.5px]">
                      <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                        <tr className="text-[10px] text-muted-foreground">
                          <th className="px-3 py-1.5 text-left font-medium">{t("买入")}</th>
                          <th className="px-3 py-1.5 text-left font-medium">{t("卖出")}</th>
                          <th className="px-3 py-1.5 text-right font-medium">{t("股数")}</th>
                          <th className="px-3 py-1.5 text-right font-medium">{t("盈亏")}</th>
                          <th className="px-3 py-1.5 text-right font-medium">{t("收益率")}</th>
                          <th className="px-3 py-1.5 text-right font-medium">{t("持有天数")}</th>
                          <th className="px-3 py-1.5 text-left font-medium">{t("进场原因")}</th>
                          <th className="px-3 py-1.5 text-left font-medium">{t("出场原因")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.map((trade) => (
                          <tr
                            key={`${trade.entryDate}-${trade.exitDate}`}
                            className="border-t border-border/60 transition-colors hover:bg-muted/40"
                          >
                            <td className="num px-3 py-1.5">
                              {formatDay(trade.entryDate)} · {formatPrice(trade.entryPrice, currency)}
                            </td>
                            <td className="num px-3 py-1.5">
                              {formatDay(trade.exitDate)} · {formatPrice(trade.exitPrice, currency)}
                            </td>
                            <td className="num px-3 py-1.5 text-right text-muted-foreground">
                              {formatNumber(trade.shares, 2)}
                            </td>
                            <td
                              className={`num px-3 py-1.5 text-right ${
                                trade.pnl >= 0 ? "text-positive-text" : "text-negative-text"
                              }`}
                            >
                              {formatPrice(trade.pnl, currency)}
                            </td>
                            <td
                              className={`num px-3 py-1.5 text-right ${
                                trade.pnlPercent >= 0 ? "text-positive-text" : "text-negative-text"
                              }`}
                            >
                              {formatPercent(trade.pnlPercent)}
                            </td>
                            <td className="num px-3 py-1.5 text-right text-muted-foreground">
                              {trade.days}
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">
                                {trade.entryKeys
                                  .slice(0, 2)
                                  .map((key) => t(strategyEntryText(key)))
                                  .join(" / ")}
                                {trade.entryKeys.length > 2
                                  ? ` +${trade.entryKeys.length - 2}`
                                  : ""}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {trade.exitKeys
                                  .slice(0, 2)
                                  .map((key) => t(strategyExitText(key)))
                                  .join(" / ")}
                                {trade.exitKeys.length > 2
                                  ? ` +${trade.exitKeys.length - 2}`
                                  : ""}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      </div>
    </PageShell>
  );
}

function formatDay(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(
    new Date(timestamp * 1000),
  );
}
