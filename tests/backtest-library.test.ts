import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_SYMBOLS_ID,
  MAX_BACKTEST_GROUPS,
  MAX_BACKTEST_GROUP_NAME,
  MAX_BACKTEST_SYMBOLS,
  UNGROUPED_SYMBOLS_ID,
  addSymbol,
  assignSymbol,
  createGroup,
  deleteGroup,
  emptyLibrary,
  groupSections,
  libraryFromHistory,
  removeSymbol,
  renameGroup,
  sanitizeLibrary,
  symbolsOf,
  type BacktestLibrary,
} from "@/lib/backtest-library";
import {
  buildBatchError,
  buildBatchRow,
  chunkSymbols,
  mapWithConcurrency,
  sortBatchRows,
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
  return { symbols, groups: [], assignment: {} };
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
  assert.deepEqual(library.assignment, { AAPL: "g1" });
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
  library = { ...library, groups: [{ id: "g1", name: "组" }], assignment: { S39: "g1" } };

  const next = addSymbol(library, "NEW");
  assert.equal(next.symbols.length, MAX_BACKTEST_SYMBOLS);
  assert.equal(next.symbols[0], "NEW");
  assert.equal(next.symbols.includes("S39"), false);
  assert.equal(next.assignment.S39, undefined);
});

test("removeSymbol：同时清掉分组归属", () => {
  let library = libraryWith(["AAPL", "MSFT"]);
  library = { ...library, groups: [{ id: "g1", name: "科技" }], assignment: { AAPL: "g1" } };
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

  const assigned = assignSymbol({ ...library, symbols: ["AAPL"] }, "AAPL", index.id);
  const removed = deleteGroup(assigned, index.id);
  assert.equal(removed.groups.length, 1);
  assert.deepEqual(removed.assignment, {});
  assert.equal(deleteGroup(removed, "missing"), removed);
});

test("assignSymbol：未分组 / 非法分组 / 不在库中的代码", () => {
  let library = createGroup(libraryWith(["AAPL"]), "科技")!.library;
  const groupId = library.groups[0].id;

  library = assignSymbol(library, "AAPL", groupId);
  assert.deepEqual(library.assignment, { AAPL: groupId });

  assert.deepEqual(assignSymbol(library, "AAPL", "nope").assignment, { AAPL: groupId });
  assert.deepEqual(assignSymbol(library, "NVDA", groupId).assignment, { AAPL: groupId });
  assert.deepEqual(assignSymbol(library, "AAPL", null).assignment, {});
});

test("groupSections / symbolsOf：分组切段与过滤", () => {
  let library = libraryWith(["AAPL", "MSFT", "NVDA", "SPY"]);
  library = { ...library, groups: [{ id: "a", name: "科技" }, { id: "b", name: "指数" }] };
  library = assignSymbol(library, "MSFT", "a");
  library = assignSymbol(library, "AAPL", "a");
  library = assignSymbol(library, "SPY", "b");

  const sections = groupSections(library);
  assert.deepEqual(
    sections.map((section) => [section.id, section.symbols]),
    [
      ["a", ["AAPL", "MSFT"]],
      ["b", ["SPY"]],
      [UNGROUPED_SYMBOLS_ID, ["NVDA"]],
    ],
  );

  assert.deepEqual(symbolsOf(library, "a"), ["AAPL", "MSFT"]);
  assert.deepEqual(symbolsOf(library, UNGROUPED_SYMBOLS_ID), ["NVDA"]);
  assert.deepEqual(symbolsOf(library, ALL_SYMBOLS_ID), library.symbols);
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
