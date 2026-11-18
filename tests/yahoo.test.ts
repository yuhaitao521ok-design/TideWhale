import { test } from "node:test";
import assert from "node:assert/strict";

import { chartPointsFrom } from "@/lib/yahoo";

test("chartPointsFrom：解析复权收盘价，缺失项回退 null", () => {
  const points = chartPointsFrom({
    timestamp: [1000, 2000, 3000],
    indicators: {
      quote: [
        {
          open: [10, 11, 12],
          high: [10.5, 11.5, 12.5],
          low: [9.5, 10.5, 11.5],
          close: [10, 11, 12],
          volume: [100, 200, 300],
        },
      ],
      adjclose: [{ adjclose: [9.5, 10.45, null] }],
    },
  });

  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((point) => point.adjClose),
    [9.5, 10.45, null],
  );
  assert.equal(points[0].close, 10);
  assert.equal(points[2].adjClose, null);
});

test("chartPointsFrom：没有 adjclose（Nasdaq 兜底）时 adjClose 为 null", () => {
  const points = chartPointsFrom({
    timestamp: [1000],
    indicators: { quote: [{ close: [10] }] },
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].adjClose, null);
});
