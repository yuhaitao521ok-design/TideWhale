import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjustedClose,
  alignReturns,
  alphaBeta,
  correlationByTime,
  rollingCorrelation,
  timedReturns,
} from "@/lib/quant";
import type { TimedReturn } from "@/lib/quant";
import type { ChartPoint } from "@/lib/types";

const DAY = 86_400;
/** 2026-10-19 00:00 UTC */
const DAY_ZERO = Date.UTC(2026, 9, 19) / 1000;

function series(values: number[], step = 86_400): ChartPoint[] {
  return values.map((close, index) => ({
    t: 1_600_000_000 + index * step,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));
}

test("alignReturns：按交易日取交集，忽略不匹配的日期", () => {
  const a: TimedReturn[] = [
    { t: DAY_ZERO, r: 0.01 },
    { t: DAY_ZERO + DAY, r: 0.02 },
    { t: DAY_ZERO + 2 * DAY, r: 0.03 },
  ];
  const b: TimedReturn[] = [
    { t: DAY_ZERO + DAY, r: -0.01 },
    { t: DAY_ZERO + 2 * DAY, r: -0.02 },
    { t: DAY_ZERO + 3 * DAY, r: -0.03 },
  ];

  const aligned = alignReturns(a, b);
  assert.deepEqual(aligned.a, [0.02, 0.03]);
  assert.deepEqual(aligned.b, [-0.01, -0.02]);
  assert.deepEqual(aligned.t, [DAY_ZERO + DAY, DAY_ZERO + 2 * DAY]);
});

test("alignReturns：Yahoo 13:30 与 Nasdaq 00:00 的同一天也能对齐", () => {
  // Yahoo 日线时间戳是开盘时间（13:30 UTC），Nasdaq 兜底是 00:00 UTC
  const yahoo: TimedReturn[] = Array.from({ length: 40 }, (_, index) => ({
    t: DAY_ZERO + index * DAY + 13.5 * 3600,
    r: Math.sin(index / 4) * 0.01,
  }));
  const nasdaq: TimedReturn[] = yahoo.map((item) => ({
    t: Math.floor(item.t / DAY) * DAY,
    r: item.r,
  }));

  const aligned = alignReturns(yahoo, nasdaq);
  assert.equal(aligned.a.length, 40);
  assert.equal(aligned.t[0], yahoo[0].t);
  assert.equal(correlationByTime(yahoo, nasdaq), 1);

  // alphaBeta 也不再因为时间戳不同而返回 null
  const beta = alphaBeta(yahoo, nasdaq);
  assert.equal(beta.samples, 40);
  assert.equal(beta.beta, 1);
});

test("alignReturns：同一天有多条时保留最后一条", () => {
  const a: TimedReturn[] = [
    { t: DAY_ZERO, r: 0.01 },
    { t: DAY_ZERO + 3600, r: 0.02 },
    { t: DAY_ZERO + DAY, r: 0.03 },
  ];
  const b: TimedReturn[] = [
    { t: DAY_ZERO, r: 0.05 },
    { t: DAY_ZERO + DAY, r: 0.06 },
  ];

  const aligned = alignReturns(a, b);
  assert.deepEqual(aligned.a, [0.02, 0.03]);
  assert.deepEqual(aligned.b, [0.05, 0.06]);
});

test("rollingCorrelation：缺失日会让时间戳跟着跳过，不会错位", () => {
  const stock: TimedReturn[] = Array.from({ length: 80 }, (_, index) => ({
    t: DAY_ZERO + index * DAY,
    r: Math.sin(index / 5) * 0.01,
  }));
  // 基准缺第 20、40 个交易日
  const benchmark = stock.filter((_, index) => index !== 20 && index !== 40);

  const output = rollingCorrelation(stock, benchmark, 60);
  // 对齐后 78 个样本 → 78 - 60 + 1 个窗口
  assert.equal(output.length, 19);
  // 第一个窗口结束于对齐序列第 60 个样本 → 原序列第 61 个交易日（跳过 20 / 40）
  assert.equal(output[0].t, DAY_ZERO + 61 * DAY);
  assert.equal(output[output.length - 1].t, DAY_ZERO + 79 * DAY);
});


test("alphaBeta：标的 = 2 倍基准 → beta≈2、alpha≈0", () => {
  const bench: TimedReturn[] = [];
  const stock: TimedReturn[] = [];
  for (let index = 0; index < 120; index += 1) {
    const r = Math.sin(index / 5) * 0.01;
    bench.push({ t: DAY_ZERO + index * DAY, r });
    stock.push({ t: DAY_ZERO + index * DAY, r: r * 2 });
  }
  const result = alphaBeta(stock, bench);
  assert.ok(result.beta !== null && Math.abs(result.beta - 2) < 0.01);
  assert.ok(result.alphaAnnualized !== null && Math.abs(result.alphaAnnualized) < 0.5);
  assert.ok(result.samples === 120);
});

test("alphaBeta：标的每天多涨 1% → 年化 alpha 为正且接近 252%", () => {
  const bench: TimedReturn[] = [];
  const stock: TimedReturn[] = [];
  for (let index = 0; index < 120; index += 1) {
    const r = Math.sin(index / 7) * 0.012;
    bench.push({ t: DAY_ZERO + index * DAY, r });
    stock.push({ t: DAY_ZERO + index * DAY, r: r + 0.01 });
  }
  const result = alphaBeta(stock, bench);
  assert.ok(result.alphaAnnualized !== null);
  assert.ok(result.alphaAnnualized! > 240 && result.alphaAnnualized! < 265);
});

test("alphaBeta：样本不足或基准无波动时返回 null", () => {
  const few: TimedReturn[] = Array.from({ length: 5 }, (_, index) => ({
    t: DAY_ZERO + index * DAY,
    r: 0.01,
  }));
  assert.equal(alphaBeta(few, few).beta, null);

  const flat: TimedReturn[] = Array.from({ length: 60 }, (_, index) => ({
    t: DAY_ZERO + index * DAY,
    r: 0,
  }));
  const moving: TimedReturn[] = Array.from({ length: 60 }, (_, index) => ({
    t: DAY_ZERO + index * DAY,
    r: Math.sin(index / 4) * 0.01,
  }));
  assert.equal(alphaBeta(moving, flat).beta, null);
});

test("adjustedClose：优先复权价，缺失 / 非法值回退原始收盘价", () => {
  assert.equal(adjustedClose({ close: 100, adjClose: 71.2 }), 71.2);
  assert.equal(adjustedClose({ close: 100 }), 100);
  assert.equal(adjustedClose({ close: 100, adjClose: null }), 100);
  assert.equal(adjustedClose({ close: 100, adjClose: Number.NaN }), 100);
  assert.equal(adjustedClose({ close: 100, adjClose: 0 }), 100);
});

test("timedReturns：跳过零价样本并保留时间戳", () => {
  const points = series([100, 110, 0, 121]);
  const returns = timedReturns(points);
  // 第 3 根 close=0 → 该样本与下一根（分母为 0）都被跳过
  assert.equal(returns.length, 1);
  assert.equal(returns[0].t, points[1].t);
  assert.ok(Math.abs(returns[0].r - 0.1) < 1e-9);
});