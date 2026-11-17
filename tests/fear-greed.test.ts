import { test } from "node:test";
import assert from "node:assert/strict";

import { CnnError } from "@/lib/cnn";
import {
  FEAR_GREED_BANDS,
  clampFearGreedScore,
  classifyFearGreed,
  fearGreedBand,
  normalizeFearGreedRating,
  parseFearGreed,
} from "@/lib/fear-greed";

test("恐惧贪婪：五档边界与 CNN 官方刻度一致（0 / 25 / 45 / 55 / 75 / 100）", () => {
  const cases: [number, string][] = [
    [0, "extreme-fear"],
    [24.99, "extreme-fear"],
    [25, "fear"],
    [44.99, "fear"],
    [45, "neutral"],
    [54.99, "neutral"],
    [55, "greed"],
    [74.99, "greed"],
    [75, "extreme-greed"],
    [100, "extreme-greed"],
  ];

  for (const [score, expected] of cases) {
    assert.equal(classifyFearGreed(score), expected, `${score} 分应属于 ${expected}`);
  }

  // 越界夹紧；非法值落「中性」，不能把脏数据说成极度恐惧
  assert.equal(classifyFearGreed(-5), "extreme-fear");
  assert.equal(classifyFearGreed(150), "extreme-greed");
  assert.equal(classifyFearGreed(Number.NaN), "neutral");
});

test("恐惧贪婪：五档首尾相接覆盖 0-100，且每档都有配色", () => {
  assert.equal(FEAR_GREED_BANDS[0].min, 0);
  assert.equal(FEAR_GREED_BANDS[FEAR_GREED_BANDS.length - 1].max, 100);

  for (let index = 0; index < FEAR_GREED_BANDS.length; index += 1) {
    const band = FEAR_GREED_BANDS[index];
    assert.ok(band.max > band.min, `${band.rating} 区间应为正`);
    assert.ok(band.color.length > 0, `${band.rating} 缺少配色`);
    if (index > 0) assert.equal(band.min, FEAR_GREED_BANDS[index - 1].max, "档位之间不能有缝");
  }

  assert.equal(fearGreedBand(0).rating, "extreme-fear");
  assert.equal(fearGreedBand(100).rating, "extreme-greed");
  assert.equal(fearGreedBand(Number.NaN).rating, "extreme-fear");
});

test("恐惧贪婪：clampFearGreedScore 只服务展示，不改变 0-100 语义", () => {
  assert.equal(clampFearGreedScore(-20), 0);
  assert.equal(clampFearGreedScore(37.8), 37.8);
  assert.equal(clampFearGreedScore(180), 100);
  assert.equal(clampFearGreedScore(Number.NaN), 0);
});

test("恐惧贪婪：normalizeFearGreedRating 兼容 CNN 文案，未知时按分数归档", () => {
  assert.equal(normalizeFearGreedRating("extreme fear", 10), "extreme-fear");
  assert.equal(normalizeFearGreedRating("extreme-fear", 10), "extreme-fear");
  assert.equal(normalizeFearGreedRating("Fear", 30), "fear");
  assert.equal(normalizeFearGreedRating("NEUTRAL", 50), "neutral");
  assert.equal(normalizeFearGreedRating("greed", 60), "greed");
  assert.equal(normalizeFearGreedRating("extreme greed", 90), "extreme-greed");
  assert.equal(normalizeFearGreedRating("unknown", 60), "greed");
  assert.equal(normalizeFearGreedRating(null, 12), "extreme-fear");
  assert.equal(normalizeFearGreedRating(undefined, Number.NaN), "neutral");
});

test("恐惧贪婪：解析当前分数 / 对比值 / 近 30 日走势（脏行 / 乱序 / 同日去重）", () => {
  const payload = {
    fear_and_greed: {
      score: "31.0190476190476",
      rating: "fear",
      timestamp: "2026-11-16T21:29:39+00:00",
      previous_close: 38.6,
      previous_1_week: "31.5142857142857",
      previous_1_month: null,
      previous_1_year: 22.057142857142853,
    },
    fear_and_greed_historical: {
      data: [
        // 超过 30 天，应被过滤
        { x: Date.UTC(2026, 9, 1), y: 10, rating: "extreme fear" },
        { x: Date.UTC(2026, 10, 16), y: 31, rating: "fear" },
        // 乱序点
        { x: Date.UTC(2026, 10, 10), y: 20, rating: "extreme fear" },
        // 同一天的最后一个点优先
        { x: Date.UTC(2026, 10, 16) + 3_600_000, y: 32, rating: "fear" },
        // 脏行：缺 x / 缺 y
        { x: null, y: 50 },
        { x: Date.UTC(2026, 10, 11), y: null },
        // 字符串分数 + 没有 rating，按分数归档
        { x: Date.UTC(2026, 10, 12), y: "25" },
      ],
    },
  };

  const parsed = parseFearGreed(payload);

  assert.equal(parsed.score, 31.0190476190476);
  assert.equal(parsed.rating, "fear");
  assert.equal(parsed.updatedAt, "2026-11-16T21:29:39.000Z");
  assert.equal(parsed.previousClose, 38.6);
  assert.equal(parsed.previousWeek, 31.5142857142857);
  assert.equal(parsed.previousMonth, null);
  assert.equal(parsed.previousYear, 22.057142857142853);
  assert.ok(parsed.fetchedAt.length > 0);

  assert.deepEqual(parsed.history, [
    { date: "2026-11-10", score: 20, rating: "extreme-fear" },
    { date: "2026-11-12", score: 25, rating: "fear" },
    { date: "2026-11-16", score: 32, rating: "fear" },
  ]);
});

test("恐惧贪婪：缺少走势 / 非法对比值 / 格式异常", () => {
  const minimal = parseFearGreed({ fear_and_greed: { score: 50, rating: "neutral" } });
  assert.equal(minimal.rating, "neutral");
  assert.equal(minimal.previousClose, null);
  assert.equal(minimal.updatedAt, null);
  assert.deepEqual(minimal.history, []);

  assert.throws(() => parseFearGreed({}), /格式异常/);
  assert.throws(() => parseFearGreed(null), /格式异常/);
  assert.throws(() => parseFearGreed({ fear_and_greed: { score: "n/a" } }), /格式异常/);
});

test("恐惧贪婪：CnnError 带状态码与错误码，路由可原样转成 HTTP 响应", () => {
  const upstream = new CnnError("boom");
  assert.equal(upstream.name, "CnnError");
  assert.equal(upstream.status, 502);
  assert.equal(upstream.code, "upstream_error");

  const parseFailure = new CnnError("bad payload", 502, "parse_error");
  assert.equal(parseFailure.status, 502);
  assert.equal(parseFailure.code, "parse_error");

  const notFound = new CnnError("gone", 404);
  assert.equal(notFound.status, 404);
});
