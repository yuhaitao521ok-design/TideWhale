import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_SYMBOLS_ID,
  MAX_BACKTEST_GROUPS,
  MAX_BACKTEST_GROUP_NAME,
  MAX_BACKTEST_SYMBOLS,
  MAX_WEIGHT_PERCENT,
  UNGROUPED_SYMBOLS_ID,
  addSymbol,
  allocationOf,
  clearAllocation,
  clearSymbolGroups,
  clearSymbols,
  createGroup,
  deleteGroup,
  emptyLibrary,
  groupSections,
  groupsOfSymbol,
  libraryFromHistory,
  moveGroup,
  removeSymbol,
  renameGroup,
  sanitizeLibrary,
  setSymbolWeight,
  symbolsOf,
  toggleSymbolGroup,
  weightOf,
  type BacktestLibrary,
} from "@/lib/backtest-library";
import {
  buildBatchError,
  buildBatchRow,
  chunkSymbols,
  mapWithConcurrency,
  sortBatchRows,
  weightedBatchSummary,
  type BatchBacktestRow,
} from "@/lib/backtest-batch";
import type { BacktestResult } from "@/lib/backtest";

function stats(patch: Partial<BacktestResult["stats"]> = {}): BacktestResult["stats"] {
  return {
    initialCapital: 10_000,
    finalValue: 12_000,
    profit: 2_000,
    totalReturn: 20,
    benchmarkReturn: 12,
    cagr: 8,
    maxDrawdown: -6,
    maxDrawdownDays: 30,
    sharpe: 1.2,
    winRate: 55,
    tradeCount: 4,
    avgDays: 12,
    exposure: 70,
    ...patch,
  };
}

function result(patch: Partial<BacktestResult["stats"]> = {}): BacktestResult {
  return { equity: [], benchmark: [], price: [], drawdown: [], trades: [], stats: stats(patch) };
}

function libraryWith(symbols: string[]): BacktestLibrary {
  return { symbols, groups: [], assignment: {}, weights: {} };
}

/* ------------------------------ 标的库 ------------------------------ */

test("sanitizeLibrary：清理非法代码、重名分组与悬空归属", () => {
  const raw = {
    symbols: ["aapl", "AAPL", "bad symbol!", "MSFT", 42, ""],
    groups: [
      { id: "g1", name: "科技" },
      { id: "g2", name: "科技" },
      { id: "g3", name: `${"很长".repeat(MAX_BACKTEST_GROUP_NAME)}` },
      { id: "", name: "空 id" },
      { id: "g4", name: "   " },
    ],
    assignment: { AAPL: "g1", MSFT: "missing", NVDA: "g1" },
  };

  const library = sanitizeLibrary(raw);
  assert.deepEqual(library.symbols, ["AAPL", "MSFT"]);
  assert.equal(library.groups.length, 2);
  assert.equal(library.groups[0].name, "科技");
  assert.ok(library.groups[1].name.length <= MAX_BACKTEST_GROUP_NAME);
  assert.deepEqual(library.assignment, { AAPL: ["g1"] });
});

test("sanitizeLibrary：v1 单分组字符串升级为数组，并去重", () => {
  const raw = {
    symbols: ["AAPL"],
    groups: [{ id: "g1", name: "科技" }, { id: "g2", name: "指数" }],
    assignment: { AAPL: ["g1", "g1", "g2", "missing"] },
  };
  assert.deepEqual(sanitizeLibrary(raw).assignment, { AAPL: ["g1", "g2"] });

  const legacy = sanitizeLibrary({ ...raw, assignment: { AAPL: "g2" } });
  assert.deepEqual(legacy.assignment, { AAPL: ["g2"] });
});

test("sanitizeLibrary：非对象输入返回空库", () => {
  for (const raw of [null, undefined, "x", 42, []]) {
    assert.deepEqual(sanitizeLibrary(raw), emptyLibrary());
  }
});

test("libraryFromHistory：迁移旧版列表并去重、截断", () => {
  const raw = Array.from({ length: MAX_BACKTEST_SYMBOLS + 5 }, (_, i) => `S${i}`).concat([
    "S0",
    "bad!",
  ]);
  const library = libraryFromHistory(raw);
  assert.equal(library.symbols.length, MAX_BACKTEST_SYMBOLS);
  assert.deepEqual(library.groups, []);
  assert.deepEqual(library.assignment, {});
});

test("addSymbol：去重、移到最前、非法代码忽略、保留分组", () => {
  const base = libraryWith(["AAPL", "MSFT"]);
  const moved = addSymbol(base, "msft");
  assert.deepEqual(moved.symbols, ["MSFT", "AAPL"]);
  assert.equal(addSymbol(moved, "bad symbol!").symbols.length, 2);
});

test("addSymbol：超过上限时丢弃最旧标的及其分组", () => {
  const symbols = Array.from({ length: MAX_BACKTEST_SYMBOLS }, (_, i) => `S${i}`);
  let library = libraryWith(symbols);
  library = { ...library, groups: [{ id: "g1", name: "组" }], assignment: { S39: ["g1"] } };

  const next = addSymbol(library, "NEW");
  assert.equal(next.symbols.length, MAX_BACKTEST_SYMBOLS);
  assert.equal(next.symbols[0], "NEW");
  assert.equal(next.symbols.includes("S39"), false);
  assert.equal(next.assignment.S39, undefined);
});

test("removeSymbol：同时清掉分组归属", () => {
  let library = libraryWith(["AAPL", "MSFT"]);
  library = { ...library, groups: [{ id: "g1", name: "科技" }], assignment: { AAPL: ["g1"] } };
  const next = removeSymbol(library, "AAPL");
  assert.deepEqual(next.symbols, ["MSFT"]);
  assert.deepEqual(next.assignment, {});
  assert.equal(removeSymbol(next, "NVDA"), next);
});

test("createGroup：命名、重名、上限与空名称", () => {
  const created = createGroup(emptyLibrary(), "  科技  ", 1_700_000_000_000);
  assert.ok(created);
  assert.equal(created.group.name, "科技");

  assert.equal(createGroup(created.library, "科技"), null);
  assert.equal(createGroup(created.library, "   "), null);

  let full = created.library;
  for (let i = 1; i < MAX_BACKTEST_GROUPS; i += 1) {
    const next = createGroup(full, `组${i}`, 1_700_000_000_000 + i);
    assert.ok(next);
    full = next.library;
  }
  assert.equal(full.groups.length, MAX_BACKTEST_GROUPS);
  assert.equal(createGroup(full, "再来一个"), null);
});

test("renameGroup / deleteGroup：重名拒绝，删除后标的回到未分组", () => {
  let library = createGroup(emptyLibrary(), "科技")!.library;
  const tech = library.groups[0];
  library = createGroup(library, "指数")!.library;
  const index = library.groups[1];

  assert.equal(renameGroup(library, tech.id, "指数"), null);
  const renamed = renameGroup(library, tech.id, "成长");
  assert.ok(renamed);
  assert.equal(renamed.groups[0].name, "成长");
  assert.equal(renameGroup(library, "missing", "X"), null);

  const assigned = toggleSymbolGroup({ ...library, symbols: ["AAPL"] }, "AAPL", index.id);
  const removed = deleteGroup(assigned, index.id);
  assert.equal(removed.groups.length, 1);
  assert.deepEqual(removed.assignment, {});
  assert.equal(deleteGroup(removed, "missing"), removed);
});

test("toggleSymbolGroup：同一标的可属于多个分组，也可以逐一取消", () => {
  let library = libraryWith(["AAPL"]);
  library = { ...library, groups: [{ id: "a", name: "科技" }, { id: "b", name: "成长" }] };

  library = toggleSymbolGroup(library, "AAPL", "a");
  library = toggleSymbolGroup(library, "AAPL", "b");
  assert.deepEqual(library.assignment, { AAPL: ["a", "b"] });
  assert.deepEqual(
    groupsOfSymbol(library, "AAPL").map((group) => group.name),
    ["科技", "成长"],
  );

  library = toggleSymbolGroup(library, "AAPL", "a");
  assert.deepEqual(library.assignment, { AAPL: ["b"] });

  assert.deepEqual(toggleSymbolGroup(library, "AAPL", "nope").assignment, { AAPL: ["b"] });
  assert.deepEqual(toggleSymbolGroup(library, "NVDA", "b").assignment, { AAPL: ["b"] });

  assert.deepEqual(clearSymbolGroups(library, "AAPL").assignment, {});
  assert.equal(clearSymbolGroups(library, "NVDA"), library);
});

test("groupSections / symbolsOf：分组切段与过滤", () => {
  let library = libraryWith(["AAPL", "MSFT", "NVDA", "SPY"]);
  library = { ...library, groups: [{ id: "a", name: "科技" }, { id: "b", name: "指数" }] };
  library = toggleSymbolGroup(library, "MSFT", "a");
  library = toggleSymbolGroup(library, "AAPL", "a");
  library = toggleSymbolGroup(library, "SPY", "b");
  // AAPL 同时属于两个分组：两个分段里都应出现，且不再算未分组
  library = toggleSymbolGroup(library, "AAPL", "b");

  const sections = groupSections(library);
  assert.deepEqual(
    sections.map((section) => [section.id, section.symbols]),
    [
      ["a", ["AAPL", "MSFT"]],
      ["b", ["AAPL", "SPY"]],
      [UNGROUPED_SYMBOLS_ID, ["NVDA"]],
    ],
  );

  assert.deepEqual(symbolsOf(library, "a"), ["AAPL", "MSFT"]);
  assert.deepEqual(symbolsOf(library, "b"), ["AAPL", "SPY"]);
  assert.deepEqual(symbolsOf(library, UNGROUPED_SYMBOLS_ID), ["NVDA"]);
  assert.deepEqual(symbolsOf(library, ALL_SYMBOLS_ID), library.symbols);
});

test("moveGroup：拖动调整分组顺序，越界不动", () => {
  let library = libraryWith([]);
  library = {
    ...library,
    groups: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
  };

  assert.deepEqual(
    moveGroup(library, 0, 2).groups.map((group) => group.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    moveGroup(library, 2, 0).groups.map((group) => group.id),
    ["c", "a", "b"],
  );
  assert.equal(moveGroup(library, 1, 1), library);
  assert.equal(moveGroup(library, -1, 0), library);
  assert.equal(moveGroup(library, 0, 9), library);
});

/* ------------------------------ 仓位分配 ------------------------------ */

test("allocationOf：分组口径只统计成员，未分配部分按现金计", () => {
  let library = libraryWith(["AAPL", "MSFT", "SPY"]);
  library = {
    ...library,
    groups: [
      { id: "a", name: "科技" },
      { id: "b", name: "指数" },
    ],
  };
  library = toggleSymbolGroup(library, "AAPL", "a");
  library = toggleSymbolGroup(library, "MSFT", "a");
  library = toggleSymbolGroup(library, "SPY", "b");

  library = setSymbolWeight(library, "a", "AAPL", 25);
  library = setSymbolWeight(library, "a", "MSFT", 25);

  const tech = allocationOf(library, "a");
  assert.deepEqual(tech.members, ["AAPL", "MSFT"]);
  assert.equal(tech.invested, 50);
  assert.equal(tech.cash, 50);
  assert.deepEqual(tech.percentOf, { AAPL: 25, MSFT: 25 });

  // 其它口径互不影响：不是成员 / 没设置过就是 0，现金 100%
  assert.equal(weightOf(library, "a", "SPY"), 0);
  assert.equal(allocationOf(library, "b").invested, 0);
  assert.equal(allocationOf(library, "b").cash, MAX_WEIGHT_PERCENT);
  assert.equal(allocationOf(library, ALL_SYMBOLS_ID).invested, 0);
});

test("setSymbolWeight：按剩余额度封顶、支持下调与清零、忽略非法输入", () => {
  let library = libraryWith(["AAPL", "MSFT", "NVDA"]);
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "AAPL", 40);
  // 剩余 60%：写到 70 会被封顶到 60
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "MSFT", 70);
  assert.equal(weightOf(library, ALL_SYMBOLS_ID, "AAPL"), 40);
  assert.equal(weightOf(library, ALL_SYMBOLS_ID, "MSFT"), 60);
  assert.equal(allocationOf(library, ALL_SYMBOLS_ID).invested, MAX_WEIGHT_PERCENT);
  assert.equal(allocationOf(library, ALL_SYMBOLS_ID).cash, 0);

  // 下调自己的仓位会释放额度，现金随之回来
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "AAPL", 10);
  assert.equal(allocationOf(library, ALL_SYMBOLS_ID).invested, 70);
  assert.equal(allocationOf(library, ALL_SYMBOLS_ID).cash, 30);

  // 1 位小数 + 负数清零
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "NVDA", 12.34);
  assert.equal(weightOf(library, ALL_SYMBOLS_ID, "NVDA"), 12.3);
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "NVDA", -5);
  assert.equal(weightOf(library, ALL_SYMBOLS_ID, "NVDA"), 0);

  // 非成员 / 非数字 / 未变化时原样返回
  assert.equal(setSymbolWeight(library, "missing", "AAPL", 10), library);
  assert.equal(setSymbolWeight(library, ALL_SYMBOLS_ID, "AAPL", Number.NaN), library);
  assert.equal(setSymbolWeight(library, ALL_SYMBOLS_ID, "AAPL", 10), library);
});

test("sanitizeLibrary：仓位超 100% 截断、非法值 / 非成员 / 失效口径丢弃", () => {
  const library = sanitizeLibrary({
    symbols: ["AAPL", "MSFT"],
    groups: [{ id: "a", name: "科技" }],
    assignment: { AAPL: ["a"] },
    weights: {
      [ALL_SYMBOLS_ID]: { AAPL: 70, MSFT: 70, NVDA: 10 },
      a: { AAPL: 50, MSFT: 40 },
      missing: { AAPL: 10 },
    },
  });

  // 按标的库顺序累加：AAPL 70 + MSFT 30（剩余额度），NVDA 不是成员
  assert.deepEqual(library.weights[ALL_SYMBOLS_ID], { AAPL: 70, MSFT: 30 });
  // 分组 a 只有 AAPL
  assert.deepEqual(library.weights.a, { AAPL: 50 });
  assert.equal(library.weights.missing, undefined);
});

test("仓位随归属 / 删除分组 / 移除标的 / 清空标的库同步清理", () => {
  let library = libraryWith(["AAPL", "MSFT"]);
  library = {
    ...library,
    groups: [
      { id: "a", name: "科技" },
      { id: "b", name: "指数" },
    ],
  };

  library = toggleSymbolGroup(library, "AAPL", "a");
  library = setSymbolWeight(library, "a", "AAPL", 100);
  assert.equal(allocationOf(library, "a").cash, 0);

  // 移出分组：该分组仓位一起清掉
  library = toggleSymbolGroup(library, "AAPL", "a");
  assert.equal(allocationOf(library, "a").invested, 0);
  assert.equal(library.weights.a, undefined);

  // 删除分组：该分组仓位一起清掉
  library = toggleSymbolGroup(library, "AAPL", "b");
  library = setSymbolWeight(library, "b", "AAPL", 60);
  library = deleteGroup(library, "b");
  assert.equal(library.weights.b, undefined);

  // 移除标的：各口径的仓位都清掉
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "AAPL", 30);
  library = removeSymbol(library, "AAPL");
  assert.equal(library.weights[ALL_SYMBOLS_ID], undefined);
  assert.deepEqual(library.symbols, ["MSFT"]);

  // clearAllocation / clearSymbols
  library = setSymbolWeight(library, ALL_SYMBOLS_ID, "MSFT", 40);
  const cleared = clearAllocation(library, ALL_SYMBOLS_ID);
  assert.equal(cleared.weights[ALL_SYMBOLS_ID], undefined);
  assert.equal(clearAllocation(cleared, ALL_SYMBOLS_ID), cleared);

  assert.deepEqual(clearSymbols(library), {
    symbols: [],
    groups: library.groups,
    assignment: {},
    weights: {},
  });
});

test("clearSymbolGroups：回到未分组时清掉分组仓位", () => {
  let library = libraryWith(["AAPL"]);
  library = { ...library, groups: [{ id: "a", name: "科技" }] };
  library = toggleSymbolGroup(library, "AAPL", "a");
  library = setSymbolWeight(library, "a", "AAPL", 80);

  const cleared = clearSymbolGroups(library, "AAPL");
  assert.deepEqual(cleared.assignment, {});
  assert.equal(cleared.weights.a, undefined);
  assert.equal(allocationOf(cleared, UNGROUPED_SYMBOLS_ID).cash, 100);
});

/* ------------------------------ 组合回测 ------------------------------ */

test("buildBatchRow：收益 / 超额与空值", () => {
  const row = buildBatchRow("AAPL", result());
  assert.equal(row.symbol, "AAPL");
  assert.equal(row.totalReturn, 20);
  assert.equal(row.excessReturn, 8);

  const empty = buildBatchRow("MSFT", result({ totalReturn: null, benchmarkReturn: null }));
  assert.equal(empty.excessReturn, null);
});

test("sortBatchRows：失败行垫底，空值排在有效值之后", () => {
  const rows: BatchBacktestRow[] = [
    buildBatchError("BAD", "boom"),
    buildBatchRow("A", result({ totalReturn: 5 })),
    buildBatchRow("B", result({ totalReturn: 30 })),
    buildBatchRow("C", result({ totalReturn: null })),
  ];

  const desc = sortBatchRows(rows, "totalReturn", "desc");
  assert.deepEqual(
    desc.map((row) => row.symbol),
    ["B", "A", "C", "BAD"],
  );
  const asc = sortBatchRows(rows, "totalReturn", "asc");
  assert.deepEqual(
    asc.map((row) => row.symbol),
    ["A", "B", "C", "BAD"],
  );
});

test("weightedBatchSummary：按仓位加权，现金按 0% 计", () => {
  const rows = [
    buildBatchRow("AAPL", result({ totalReturn: 50, benchmarkReturn: 10 }), 60),
    buildBatchRow("MSFT", result({ totalReturn: -10, benchmarkReturn: 10 }), 30),
    buildBatchError("BAD", "boom", 10),
  ];

  const summary = weightedBatchSummary(rows);
  assert.equal(summary.invested, 100);
  assert.equal(summary.cash, 0);
  // 0.6 × 50 + 0.3 × (−10) + 0.1 × 0 = 27
  assert.equal(summary.totalReturn, 27);
  assert.equal(summary.benchmarkReturn, 9);
  assert.equal(summary.excessReturn, 18);
  assert.equal(summary.tradeCount, 8);

  // 只分配 40%：剩下 60% 是现金，贡献 0
  const partial = weightedBatchSummary([
    buildBatchRow("AAPL", result({ totalReturn: 20, benchmarkReturn: 5 }), 40),
  ]);
  assert.equal(partial.invested, 40);
  assert.equal(partial.cash, 60);
  assert.equal(partial.totalReturn, 8);
  assert.equal(partial.benchmarkReturn, 2);
  assert.equal(partial.excessReturn, 6);

  // 没有仓位时不产生「加权收益」
  const empty = weightedBatchSummary([buildBatchRow("AAPL", result())]);
  assert.equal(empty.invested, 0);
  assert.equal(empty.cash, 100);
  assert.equal(empty.totalReturn, null);
  assert.equal(empty.excessReturn, null);
  assert.equal(weightedBatchSummary([]).invested, 0);
});

test("sortBatchRows：支持按仓位排序", () => {
  const rows = [
    buildBatchRow("A", result(), 10),
    buildBatchRow("B", result(), 60),
    buildBatchRow("C", result(), 30),
  ];
  assert.deepEqual(
    sortBatchRows(rows, "weight", "desc").map((row) => row.symbol),
    ["B", "C", "A"],
  );
  assert.deepEqual(
    sortBatchRows(rows, "weight", "asc").map((row) => row.symbol),
    ["A", "C", "B"],
  );
});

test("chunkSymbols / mapWithConcurrency：分批与并发上限", async () => {
  assert.deepEqual(chunkSymbols(["A", "B", "C", "D", "E"], 2), [["A", "B"], ["C", "D"], ["E"]]);
  assert.deepEqual(chunkSymbols([], 3), []);

  let active = 0;
  let peak = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 10;
  });

  assert.deepEqual(output, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2);

  const single = await mapWithConcurrency(["x"], 0, async (item) => item.toUpperCase());
  assert.deepEqual(single, ["X"]);
});
