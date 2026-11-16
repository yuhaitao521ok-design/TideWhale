import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFearGreed,
  normalizeFearGreedRating,
  parseFearGreed,
} from "@/lib/fear-greed";

test("classifyFearGreed：五档边界（0 / 25 / 45 / 55 / 75 / 100）", () => {
  assert.equal(classifyFearGreed(0), "extreme-fear");
  assert.equal(classifyFearGreed(24.99), "extreme-fear");
  assert.equal(classifyFearGreed(25), "fear");
  assert.equal(classifyFearGreed(44.99), "fear");
  assert.equal(classifyFearGreed(45), "neutral");
  assert.equal(classifyFearGreed(54.99), "neutral");
  assert.equal(classifyFearGreed(55), "greed");
  assert.equal(classifyFearGreed(74.99), "greed");
  assert.equal(classifyFearGreed(75), "extreme-greed");
  assert.equal(classifyFearGreed(100), "extreme-greed");
  // 越界与非法值做兜底
  assert.equal(classifyFearGreed(-5), "extreme-fear");
  assert.equal(classifyFearGreed(150), "extreme-greed");
  assert.equal(classifyFearGreed(Number.NaN), "neutral");
});

test("normalizeFearGreedRating：兼容 CNN 的 rating 文案，未知时按分数归档", () => {
  assert.equal(normalizeFearGreedRating("extreme fear", 10), "extreme-fear");
  assert.equal(normalizeFearGreedRating("Fear", 30), "fear");
  assert.equal(normalizeFearGreedRating("NEUTRAL", 50), "neutral");
  assert.equal(normalizeFearGreedRating("greed", 60), "greed");
  assert.equal(normalizeFearGreedRating("extreme greed", 90), "extreme-greed");
  assert.equal(normalizeFearGreedRating("unknown", 60), "greed");
  assert.equal(normalizeFearGreedRating(null, 12), "extreme-fear");
});

test("parseFearGreed：解析当前分数 / 对比值 / 近 30 日走势", () => {
  const payload = {
    fear_and_greed: {
      score: 31.0190476190476,
      rating: "fear",
      timestamp: "2026-11-16T21:29:39+00:00",
      previous_close: 38.6,
      previous_1_week: 31.5142857142857,
      previous_1_month: 18.214285714285715,
      previous_1_year: 22.057142857142853,
    },
    fear_and_greed_historical: {
      data: [
        // 超过 30 天，应被过滤
        { x: Date.UTC(2026, 9, 1), y: 10, rating: "extreme fear" },
        { x: Date.UTC(2026, 10, 10), y: 20, rating: "extreme fear" },
        { x: Date.UTC(2026, 10, 16), y: 31, rating: "fear" },
        // 同一天的最后一个点优先
        { x: Date.UTC(2026, 10, 16) + 3_600_000, y: 32, rating: "fear" },
      ],
    },
  };

  const parsed = parseFearGreed(payload);
  assert.equal(parsed.score, 31.0190476190476);
  assert.equal(parsed.rating, "fear");
  assert.equal(parsed.updatedAt, "2026-11-16T21:29:39.000Z");
  assert.equal(parsed.previousClose, 38.6);
  assert.equal(parsed.previousWeek, 31.5142857142857);
  assert.equal(parsed.previousMonth, 18.214285714285715);
  assert.equal(parsed.previousYear, 22.057142857142853);

  assert.deepEqual(parsed.history, [
    { date: "2026-11-10", score: 20, rating: "extreme-fear" },
    { date: "2026-11-16", score: 32, rating: "fear" },
  ]);
});

test("parseFearGreed：缺失走势 / 非法对比值 / 格式异常", () => {
  const minimal = parseFearGreed({ fear_and_greed: { score: 50, rating: "neutral" } });
  assert.equal(minimal.rating, "neutral");
  assert.equal(minimal.previousClose, null);
  assert.equal(minimal.updatedAt, null);
  assert.deepEqual(minimal.history, []);

  // 分数必须存在
  assert.throws(() => parseFearGreed({}), /格式异常/);
  assert.throws(() => parseFearGreed(null), /格式异常/);
  assert.throws(() => parseFearGreed({ fear_and_greed: { score: "n/a" } }), /格式异常/);
});
