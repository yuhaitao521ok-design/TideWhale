import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectPtrColumns,
  groupPtrRows,
  parseHouseIndex,
  parsePtrAmount,
  parsePtrRows,
  parsePtrTrades,
  ptrDateToIso,
  type PtrTextItem,
} from "@/lib/congress-parse";
import { buildCongressQuarters, quarterEndOf } from "@/lib/institutions";

/* ---------------------------------------------------------------- */
/*                  众议院 PTR：索引 / 列 / 行 / 金额                 */
/* ---------------------------------------------------------------- */

test("parseHouseIndex：解析 Member 列表并把 1/23/2026 转成 ISO", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix />
    <Last>Pelosi</Last>
    <First>Nancy</First>
    <Suffix />
    <FilingType>P</FilingType>
    <StateDst>CA11</StateDst>
    <Year>2026</Year>
    <FilingDate>1/23/2026</FilingDate>
    <DocID>20033725</DocID>
  </Member>
  <Member>
    <Last>Pelosi</Last>
    <First>Nancy</First>
    <FilingType>O</FilingType>
    <StateDst>CA11</StateDst>
    <FilingDate>5/15/2026</FilingDate>
    <DocID>10075701</DocID>
  </Member>
  <Member>
    <Last>Smith</Last>
    <First>Adrian</First>
    <FilingType>P</FilingType>
    <StateDst>CA20</StateDst>
    <FilingDate>7/27/2026</FilingDate>
    <DocID>20035067</DocID>
  </Member>
</FinancialDisclosure>`;

  const rows = parseHouseIndex(xml, 2026);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    last: "Pelosi",
    first: "Nancy",
    stateDst: "CA11",
    filingType: "P",
    filedAt: "2026-01-23",
    docId: "20033725",
    year: 2026,
  });
  assert.equal(parseHouseIndex("", 2026).length, 0);
});

test("detectPtrColumns：按表头 x 推列；缺表头返回 null", () => {
  const header: [number, string][] = [
    [25, "ID"],
    [66, "Owner"],
    [105, "Asset"],
    [262, "Transaction"],
    [327, "Date"],
    [382, "Notification"],
    [446, "Amount"],
    [525, "Cap."],
  ];
  const columns = detectPtrColumns(header);
  assert.ok(columns);
  const byKey = new Map(columns!.map((column) => [column.key, column.x]));
  assert.equal(byKey.get("owner"), 66);
  assert.equal(byKey.get("asset"), 105);
  assert.equal(byKey.get("type"), 262);
  assert.equal(byKey.get("tradeDate"), 327);
  assert.equal(byKey.get("notifyDate"), 382);
  assert.equal(byKey.get("amount"), 446);
  assert.equal(detectPtrColumns([[10, "Name:"], [80, "Hon. Nancy Pelosi"]]), null);
});

test("parsePtrAmount：区间 / 单值 / 非法输入", () => {
  assert.deepEqual(parsePtrAmount("$50,001 - $100,000"), {
    min: 50001,
    max: 100000,
    mid: 75000.5,
  });
  assert.deepEqual(parsePtrAmount("$1,000,001 -"), {
    min: 1000001,
    max: 1000001,
    mid: 1000001,
  });
  assert.deepEqual(parsePtrAmount("$100,000"), { min: 100000, max: 100000, mid: 100000 });
  assert.deepEqual(parsePtrAmount("$15.00"), { min: 15, max: 15, mid: 15 });
  assert.equal(parsePtrAmount("no amount"), null);
});

test("ptrDateToIso：补零并拒绝非法格式", () => {
  assert.equal(ptrDateToIso("1/2/2026"), "2026-01-02");
  assert.equal(ptrDateToIso("12/31/2025"), "2025-12-31");
  assert.equal(ptrDateToIso("2026-01-02"), null);
  assert.equal(ptrDateToIso(undefined), null);
});

const HEADER: PtrTextItem[] = [
  { page: 1, x: 25, y: 503, text: "ID" },
  { page: 1, x: 66, y: 503, text: "Owner" },
  { page: 1, x: 105, y: 503, text: "Asset" },
  { page: 1, x: 262, y: 503, text: "Transaction" },
  { page: 1, x: 327, y: 503, text: "Date" },
  { page: 1, x: 382, y: 503, text: "Notification" },
  { page: 1, x: 446, y: 503, text: "Amount" },
  { page: 1, x: 525, y: 503, text: "Cap." },
  { page: 1, x: 262, y: 492, text: "Type" },
  { page: 1, x: 382, y: 492, text: "Date" },
];

test("groupPtrRows + parsePtrRows：两行资产名 / 跨行金额 / 备注行不干扰", () => {
  const items: PtrTextItem[] = [
    ...HEADER,
    { page: 1, x: 66, y: 459, text: "SP" },
    { page: 1, x: 105, y: 459, text: "Warner Bros. Discovery, Inc. - Series" },
    { page: 1, x: 262, y: 459, text: "S" },
    { page: 1, x: 327, y: 459, text: "10/07/2026" },
    { page: 1, x: 381, y: 459, text: "10/07/2026" },
    { page: 1, x: 446, y: 459, text: "$50,001 -" },
    { page: 1, x: 105, y: 449, text: "A Common Stock (WBD) [ST]" },
    { page: 1, x: 446, y: 449, text: "$100,000" },
    { page: 1, x: 105, y: 431, text: "F S: New" },
    { page: 1, x: 105, y: 419, text: "D: Cash proceeds from merger." },
  ];

  const trades = parsePtrTrades(items, { docId: "20035780", filedAt: "2026-11-06" });
  assert.equal(trades.length, 1);
  const [trade] = trades;
  assert.equal(trade.tradeDate, "2026-10-07");
  assert.equal(trade.notifyDate, "2026-10-07");
  assert.equal(trade.side, "sell");
  assert.equal(trade.ticker, "WBD");
  assert.equal(trade.assetType, "ST");
  assert.equal(trade.owner, "SP");
  assert.equal(
    trade.asset,
    "Warner Bros. Discovery, Inc. - Series A Common Stock (WBD)",
  );
  assert.equal(trade.amountMin, 50001);
  assert.equal(trade.amountMax, 100000);
  assert.equal(trade.docId, "20035780");
  assert.equal(trade.filedAt, "2026-11-06");
});

test("parsePtrRows：跨页续行（页间表头会被跳过）", () => {
  const items: PtrTextItem[] = [
    ...HEADER,
    { page: 1, x: 66, y: 120, text: "JT" },
    { page: 1, x: 105, y: 120, text: "Tempus AI, Inc. - Class A Common" },
    { page: 1, x: 262, y: 120, text: "P" },
    { page: 1, x: 327, y: 120, text: "01/16/2026" },
    { page: 1, x: 381, y: 120, text: "01/16/2026" },
    { page: 1, x: 446, y: 120, text: "$50,001 -" },
    // 第 2 页：先出现表头，再出现续行
    ...HEADER.map((item) => ({ ...item, page: 2 })),
    { page: 2, x: 105, y: 620, text: "Stock (TEM) [ST]" },
    { page: 2, x: 446, y: 620, text: "$100,000" },
  ];

  const trades = parsePtrTrades(items, { docId: "20033725", filedAt: "2026-01-23" });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].ticker, "TEM");
  assert.equal(trades[0].asset, "Tempus AI, Inc. - Class A Common Stock (TEM)");
  assert.equal(trades[0].amountMin, 50001);
  assert.equal(trades[0].amountMax, 100000);
  assert.equal(trades[0].partial, false);
});

test("parsePtrRows：S (partial) 标为部分卖出，E 类型归为 exchange", () => {
  const items: PtrTextItem[] = [
    ...HEADER,
    { page: 1, x: 66, y: 300, text: "DC" },
    { page: 1, x: 105, y: 300, text: "Alphabet Inc. - Class A Common Stock (GOOGL)" },
    { page: 1, x: 262, y: 300, text: "S (partial)" },
    { page: 1, x: 327, y: 300, text: "12/30/2025" },
    { page: 1, x: 381, y: 300, text: "12/30/2025" },
    { page: 1, x: 446, y: 300, text: "$1,000,001 - $5,000,000" },
    { page: 1, x: 66, y: 260, text: "SP" },
    { page: 1, x: 105, y: 260, text: "Versant Media Group, Inc. (VSNT)" },
    { page: 1, x: 262, y: 260, text: "E" },
    { page: 1, x: 327, y: 260, text: "01/02/2026" },
    { page: 1, x: 381, y: 260, text: "01/02/2026" },
    { page: 1, x: 446, y: 260, text: "$15.00" },
  ];

  const trades = parsePtrTrades(items, { docId: "x", filedAt: "2026-01-23" });
  assert.equal(trades.length, 2);
  assert.equal(trades[0].side, "sell");
  assert.equal(trades[0].partial, true);
  assert.equal(trades[1].side, "exchange");
  assert.equal(trades[1].amountMid, 15);
});

/* ---------------------------------------------------------------- */
/*                     国会交易 → 季度汇总（复用 13F 结构）             */
/* ---------------------------------------------------------------- */

const trade = (over: Partial<Parameters<typeof buildCongressQuarters>[0][number]>) => ({
  tradeDate: "2026-01-05",
  notifyDate: "2026-01-05",
  filedAt: "2026-01-23",
  docId: "20033725",
  side: "buy" as const,
  partial: false,
  owner: null,
  ticker: "AAPL",
  assetType: "ST",
  asset: "Apple Inc. (AAPL)",
  amountMin: 100000,
  amountMax: 100000,
  amountMid: 100000,
  amountText: "$100,000",
  ...over,
});

test("quarterEndOf：按月份落到季度末", () => {
  assert.equal(quarterEndOf("2026-01-16"), "2026-03-31");
  assert.equal(quarterEndOf("2026-04-01"), "2026-06-30");
  assert.equal(quarterEndOf("2026-12-31"), "2026-12-31");
  assert.equal(quarterEndOf("bad"), "bad");
});

test("buildCongressQuarters：同季同标的合并、跳过置换与无金额交易", () => {
  const trades = [
    trade({ tradeDate: "2026-01-05", ticker: "AAPL", asset: "Apple Inc. (AAPL)" }),
    trade({ tradeDate: "2026-02-05", ticker: "AAPL", amountMid: 50000, amountText: "$50,001 - $100,000" }),
    trade({
      tradeDate: "2026-03-10",
      side: "sell",
      ticker: "MSFT",
      asset: "Microsoft Corp (MSFT)",
      amountMid: 30000,
    }),
    trade({ tradeDate: "2026-01-02", side: "exchange", ticker: "VSNT", amountMid: 15 }),
    trade({ tradeDate: "2026-03-02", ticker: "PRIV", amountMid: null, amountMin: null, amountMax: null }),
  ];

  const quarters = buildCongressQuarters(trades);
  assert.equal(quarters.length, 1);
  const [q1] = quarters;
  assert.equal(q1.quarter, "2026-03-31");
  assert.equal(q1.previousQuarter, "2025-12-31");
  assert.equal(q1.buys.length, 1);
  assert.equal(q1.buys[0].issuer, "Apple Inc. (AAPL)");
  assert.equal(q1.buys[0].value, 150000);
  assert.equal(q1.buysValue, 150000);
  assert.equal(q1.sells.length, 1);
  assert.equal(q1.sells[0].value, 30000);
  assert.equal(q1.sells[0].valueChange, -30000);
  assert.equal(q1.sellsValue, 30000);
  assert.equal(q1.positions, 2);
  // 国会披露没有股数 / 比例
  assert.equal(q1.buys[0].shares, null);
  assert.equal(q1.buys[0].changePercent, null);
});

test("buildCongressQuarters：按季度新→旧排序并限制条数", () => {
  const trades = [
    trade({ tradeDate: "2025-11-01", ticker: "A" }),
    trade({ tradeDate: "2026-01-05", ticker: "B" }),
    trade({ tradeDate: "2026-08-05", ticker: "C" }),
  ];
  assert.deepEqual(
    buildCongressQuarters(trades).map((quarter) => quarter.quarter),
    ["2026-09-30", "2026-03-31", "2025-12-31"],
  );
  assert.equal(buildCongressQuarters(trades, 2).length, 2);
});
