import type { ChartPoint } from "@/lib/types";

/** 量化统计：全部在本地用日线计算，不引入第三方库。 */

export interface RiskMetrics {
  /** 区间总收益（%） */
  totalReturn: number | null;
  /** 年化收益（%） */
  annualReturn: number | null;
  /** 年化波动（%） */
  volatility: number | null;
  /** 年化下行波动（%） */
  downside: number | null;
  /** 夏普（无风险利率默认 0） */
  sharpe: number | null;
  /** 索提诺：只惩罚下行波动 */
  sortino: number | null;
  /** 卡玛：年化收益 / 最大回撤 */
  calmar: number | null;
  /** 最大回撤（%，负值） */
  maxDrawdown: number | null;
  /** 回撤画像（深度 / 时长 / 修复） */
  drawdown: DrawdownProfile;
  /** 历史 95% VaR（%，正数代表损失） */
  var95: number | null;
  /** 历史 95% CVaR（%，正数代表尾部平均损失） */
  cvar95: number | null;
  /** 偏度 */
  skew: number | null;
  /** 超额峰度 */
  kurtosis: number | null;
  /** 上涨天数占比（%） */
  winRate: number | null;
  bestDay: number | null;
  worstDay: number | null;
  /** 年化波动之外的简单动量 */
  momentum: { d20: number | null; d60: number | null; d120: number | null };
}

const TRADING_DAYS = 252;

/** 相关性最小样本数：不足 20 个共同交易日的配对噪声过大，直接不展示 */
export const MIN_CORRELATION_SAMPLES = 20;

/** 日收益率序列（小数） */
export function dailyReturns(points: ChartPoint[]): number[] {
  const returns: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].close;
    const current = points[index].close;
    if (previous > 0 && current > 0) returns.push(current / previous - 1);
  }
  return returns;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** 从窗口起点开始的简单动量（%） */
export function momentum(points: ChartPoint[], lookback: number): number | null {
  if (points.length <= lookback) return null;
  const start = points[points.length - 1 - lookback].close;
  const end = points[points.length - 1].close;
  if (start <= 0) return null;
  return (end / start - 1) * 100;
}

/** 最大回撤（%，负值） */
export function maxDrawdown(points: ChartPoint[]): number | null {
  if (points.length < 2) return null;
  let peak = points[0].close;
  let worst = 0;
  for (const point of points) {
    if (point.close > peak) peak = point.close;
    if (peak > 0) {
      const drawdown = (point.close / peak - 1) * 100;
      if (drawdown < worst) worst = drawdown;
    }
  }
  return worst;
}

/** 汇总风险指标 */
export function riskMetrics(points: ChartPoint[]): RiskMetrics {
  const returns = dailyReturns(points);
  const totalReturn =
    points.length >= 2 && points[0].close > 0
      ? (points[points.length - 1].close / points[0].close - 1) * 100
      : null;

  const years = returns.length / TRADING_DAYS;
  const annualReturn =
    totalReturn === null || years <= 0
      ? null
      : ((1 + totalReturn / 100) ** (1 / years) - 1) * 100;

  const volatility = annualizedVolatility(returns);
  const sharpe =
    volatility === null || volatility === 0
      ? null
      : (mean(returns) * TRADING_DAYS * 100) / volatility;

  const wins = returns.filter((value) => value > 0).length;
  const profile = drawdownProfile(points);
  const tail = valueAtRisk(returns);

  return {
    totalReturn,
    annualReturn,
    volatility,
    downside: downsideDeviation(returns),
    sharpe,
    sortino: sortinoRatio(returns),
    calmar: calmarRatio(annualReturn, profile.max),
    maxDrawdown: profile.max,
    drawdown: profile,
    var95: tail.var,
    cvar95: tail.cvar,
    skew: skewness(returns),
    kurtosis: excessKurtosis(returns),
    winRate: returns.length > 0 ? (wins / returns.length) * 100 : null,
    bestDay: returns.length > 0 ? Math.max(...returns) * 100 : null,
    worstDay: returns.length > 0 ? Math.min(...returns) * 100 : null,
    momentum: {
      d20: momentum(points, 20),
      d60: momentum(points, 60),
      d120: momentum(points, 120),
    },
  };
}

/** 两个收益序列的相关系数（按较短长度对齐，取最近的样本） */
export function correlation(a: number[], b: number[]): number | null {
  const length = Math.min(a.length, b.length);
  if (length < 8) return null;
  const left = a.slice(a.length - length);
  const right = b.slice(b.length - length);

  const meanLeft = mean(left);
  const meanRight = mean(right);
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;

  for (let index = 0; index < length; index += 1) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }

  if (varianceLeft <= 0 || varianceRight <= 0) return null;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/* -------------------------------------------------------------------------- */
/*                        研究扩展指标：风险 / 收益 / 相关性                     */
/* -------------------------------------------------------------------------- */

export interface DrawdownProfile {
  /** 最大回撤（%，负值） */
  max: number | null;
  /** 当前回撤（%，负值；0 表示正处于历史新高） */
  current: number | null;
  /** 最长回撤占用（自然日，含尚未修复的回撤） */
  longestDays: number | null;
  /** 最大回撤从高点到谷底的交易日数 */
  dropDays: number | null;
  /** 最大回撤修复（重新创新高）所需交易日数；尚未修复为 null */
  recoveryDays: number | null;
}

/** 回撤画像：深度 + 持续时间 + 修复速度 */
export function drawdownProfile(points: ChartPoint[]): DrawdownProfile {
  if (points.length < 2) {
    return { max: null, current: null, longestDays: null, dropDays: null, recoveryDays: null };
  }

  let peakValue = points[0].close;
  let peakIndex = 0;
  let peakTime = points[0].t;

  let worst = 0;
  let worstPeakIndex = 0;
  let worstTroughIndex = 0;

  let longestSeconds = 0;
  let underwaterStart: number | null = points[0].t;

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.close >= peakValue) {
      if (underwaterStart !== null) {
        longestSeconds = Math.max(longestSeconds, point.t - underwaterStart);
        underwaterStart = null;
      }
      peakValue = point.close;
      peakIndex = index;
      peakTime = point.t;
      continue;
    }
    if (underwaterStart === null) underwaterStart = peakTime;
    if (peakValue <= 0) continue;
    const drawdown = (point.close / peakValue - 1) * 100;
    if (drawdown < worst) {
      worst = drawdown;
      worstPeakIndex = peakIndex;
      worstTroughIndex = index;
    }
  }

  // 还在水下：把进行中的回撤算到最后一个样本
  if (underwaterStart !== null) {
    longestSeconds = Math.max(longestSeconds, points[points.length - 1].t - underwaterStart);
  }

  let recoveryIndex: number | null = null;
  for (let index = worstTroughIndex + 1; index < points.length; index += 1) {
    if (points[index].close >= points[worstPeakIndex].close) {
      recoveryIndex = index;
      break;
    }
  }

  let lastPeak = points[0].close;
  for (const point of points) {
    if (point.close > lastPeak) lastPeak = point.close;
  }
  const lastClose = points[points.length - 1].close;

  return {
    max: Number(worst.toFixed(3)),
    current: lastPeak > 0 ? Number(((lastClose / lastPeak - 1) * 100).toFixed(3)) : null,
    longestDays: Math.round(longestSeconds / 86_400),
    dropDays: Math.max(0, worstTroughIndex - worstPeakIndex),
    recoveryDays: recoveryIndex === null ? null : recoveryIndex - worstTroughIndex,
  };
}

/** 回撤水下图序列（<= 0） */
export function drawdownSeries(points: ChartPoint[]): { t: number; value: number }[] {
  let peak = 0;
  const output: { t: number; value: number }[] = [];
  for (const point of points) {
    if (point.close > peak) peak = point.close;
    if (peak <= 0) continue;
    output.push({ t: point.t, value: Number(((point.close / peak - 1) * 100).toFixed(3)) });
  }
  return output;
}

function annualizedVolatility(returns: number[]): number | null {
  const deviation = stdDev(returns);
  return deviation > 0 ? deviation * Math.sqrt(TRADING_DAYS) * 100 : null;
}

/** 年化下行波动（%，只统计低于目标的收益，目标默认 0） */
export function downsideDeviation(returns: number[], target = 0): number | null {
  if (returns.length < 2) return null;
  let sum = 0;
  for (const value of returns) {
    const shortfall = Math.min(0, value - target);
    sum += shortfall * shortfall;
  }
  const daily = Math.sqrt(sum / returns.length);
  return daily > 0 ? daily * Math.sqrt(TRADING_DAYS) * 100 : null;
}

/** 索提诺比率：只惩罚下行波动的夏普（无风险利率默认 0） */
export function sortinoRatio(returns: number[], target = 0): number | null {
  const downside = downsideDeviation(returns, target);
  if (downside === null || downside === 0) return null;
  const excessAnnual = (mean(returns) - target) * TRADING_DAYS * 100;
  return Number((excessAnnual / downside).toFixed(3));
}

/** 卡玛比率：年化收益 / 最大回撤深度 */
export function calmarRatio(annualReturn: number | null, maxDrawdown: number | null): number | null {
  if (annualReturn === null || maxDrawdown === null || maxDrawdown >= 0) return null;
  return Number((annualReturn / Math.abs(maxDrawdown)).toFixed(3));
}

/** 历史 VaR / CVaR（%，正数代表损失幅度） */
export function valueAtRisk(
  returns: number[],
  confidence = 0.95,
): { var: number | null; cvar: number | null } {
  if (returns.length < 20) return { var: null, cvar: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((1 - confidence) * sorted.length)),
  );
  const cut = sorted[index];
  const tail = sorted.slice(0, index + 1);
  const tailMean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  return {
    var: Number((-cut * 100).toFixed(3)),
    cvar: Number((-tailMean * 100).toFixed(3)),
  };
}

/** 偏度：>0 右偏（偶发大涨），<0 左偏（偶发大跌） */
export function skewness(returns: number[]): number | null {
  const n = returns.length;
  if (n < 20) return null;
  const avg = mean(returns);
  const deviation = stdDev(returns);
  if (deviation === 0) return null;
  const sum = returns.reduce((total, value) => total + ((value - avg) / deviation) ** 3, 0);
  return Number(((n / ((n - 1) * (n - 2))) * sum).toFixed(3));
}

/** 超额峰度：>0 肥尾（极端行情比正态分布更多） */
export function excessKurtosis(returns: number[]): number | null {
  const n = returns.length;
  if (n < 20) return null;
  const avg = mean(returns);
  const deviation = stdDev(returns);
  if (deviation === 0) return null;
  const m4 = returns.reduce((total, value) => total + ((value - avg) / deviation) ** 4, 0);
  const value = (n * (n + 1) * m4) / ((n - 1) * (n - 2) * (n - 3));
  const adjust = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return Number((value - adjust).toFixed(3));
}

/** 月度收益（%，按自然月取最后一个收盘价） */
export function monthlyReturns(points: ChartPoint[]): {
  key: string;
  year: number;
  month: number;
  value: number;
}[] {
  if (points.length < 2) return [];

  const buckets = new Map<string, { year: number; month: number; first: number; last: number }>();
  for (const point of points) {
    const date = new Date(point.t * 1000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.last = point.close;
    else buckets.set(key, { year, month, first: point.close, last: point.close });
  }

  const output: { key: string; year: number; month: number; value: number }[] = [];
  let previous: number | null = null;
  for (const key of [...buckets.keys()].sort()) {
    const bucket = buckets.get(key)!;
    const base = previous ?? bucket.first;
    if (base > 0 && bucket.last > 0) {
      output.push({
        key,
        year: bucket.year,
        month: bucket.month,
        value: Number(((bucket.last / base - 1) * 100).toFixed(3)),
      });
    }
    previous = bucket.last;
  }
  return output;
}

/** 归一化序列（保留时间戳，用于等权组合 / 相对强弱） */
export function normalizedSeries(points: ChartPoint[], base = 100): { t: number; value: number }[] {
  const first = points[0]?.close ?? 0;
  if (first <= 0) return [];
  return points.map((point) => ({
    t: point.t,
    value: Number(((point.close / first) * base).toFixed(4)),
  }));
}

/**
 * 等权组合净值：标的池内每只按相同金额配置、每日再平衡。
 * 交易日取「至少 minCoverage 比例标的都有成交」的日期，避免不同市场假期把序列截断。
 */
export function equallyWeightedSeries(
  series: { symbol: string; points: ChartPoint[] }[],
  minCoverage = 0.6,
  base = 100,
): { t: number; value: number }[] {
  if (series.length === 0) return [];

  const daily = series.map((item) => {
    const map = new Map<number, number>();
    for (const entry of timedReturns(item.points)) map.set(entry.t, entry.r);
    return map;
  });

  const timestamps = new Set<number>();
  for (const map of daily) for (const t of map.keys()) timestamps.add(t);

  const required = Math.max(1, Math.ceil(series.length * minCoverage));
  const output: { t: number; value: number }[] = [];
  let level = base;

  for (const t of [...timestamps].sort((a, b) => a - b)) {
    const values: number[] = [];
    for (const map of daily) {
      const value = map.get(t);
      if (value !== undefined) values.push(value);
    }
    if (values.length < required) continue;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    level *= 1 + average;
    output.push({ t, value: Number(level.toFixed(4)) });
  }

  return output;
}

export interface TrendStructure {
  price: number | null;
  ma20: number | null;
  ma60: number | null;
  /** 距区间内最高收盘价的百分比（<= 0） */
  fromHigh: number | null;
  /** 价格 > MA20 */
  aboveMa20: boolean;
  /** 价格 > MA60 */
  aboveMa60: boolean;
  /** 20 日动量 > 0 */
  momentum1M: boolean;
  /** 120 日动量 > 0 */
  momentum6M: boolean;
  /** 共振分 0–4（上面四项各 1 分） */
  score: number;
}

/** 趋势结构：价格、均线与动量的方向是否一致 */
export function trendStructure(points: ChartPoint[]): TrendStructure {
  const last = points[points.length - 1]?.close ?? null;
  const ma = (window: number): number | null => {
    if (points.length < window) return null;
    const slice = points.slice(points.length - window);
    return slice.reduce((sum, point) => sum + point.close, 0) / slice.length;
  };
  const ma20 = ma(20);
  const ma60 = ma(60);
  let high = 0;
  for (const point of points) if (point.close > high) high = point.close;

  const aboveMa20 = last !== null && ma20 !== null && last > ma20;
  const aboveMa60 = last !== null && ma60 !== null && last > ma60;
  const momentum1M = (momentum(points, 20) ?? 0) > 0;
  const momentum6M = (momentum(points, 120) ?? 0) > 0;

  return {
    price: last,
    ma20,
    ma60,
    fromHigh: last !== null && high > 0 ? Number(((last / high - 1) * 100).toFixed(2)) : null,
    aboveMa20,
    aboveMa60,
    momentum1M,
    momentum6M,
    score: [aboveMa20, aboveMa60, momentum1M, momentum6M].filter(Boolean).length,
  };
}

/**
 * 相关矩阵的「聚类排序」：average-linkage 层次聚类 + 最优叶序。
 * - 距离 = 1 − 相关系数；缺失值（样本不足）用该行有效相关性中位数代替，不当作 0
 * - 合并后按「子节点边界相关性最大」决定左右方向，让相似资产连续成块
 */
export function seriateCorrelation(matrix: (number | null)[][]): number[] {
  const size = matrix.length;
  if (size === 0) return [];
  if (size === 1) return [0];

  const value = (a: number, b: number): number | null => {
    const candidate = matrix[a]?.[b];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  };

  // 缺失值用该行有效相关性中位数填充：混合数据源 / 新上市标的不会被当成「完全不相关」
  const fallback = Array.from({ length: size }, (_, row) => {
    const values: number[] = [];
    for (let column = 0; column < size; column += 1) {
      if (column === row) continue;
      const candidate = value(row, column);
      if (candidate !== null) values.push(candidate);
    }
    if (values.length === 0) return 0;
    values.sort((x, y) => x - y);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 0
      ? (values[middle - 1] + values[middle]) / 2
      : values[middle];
  });

  const similarity = (a: number, b: number): number => {
    if (a === b) return 1;
    const candidate = value(a, b) ?? value(b, a);
    return candidate ?? (fallback[a] + fallback[b]) / 2;
  };

  interface Cluster {
    members: number[];
    left?: Cluster;
    right?: Cluster;
  }

  let clusters: Cluster[] = Array.from({ length: size }, (_, index) => ({ members: [index] }));

  while (clusters.length > 1) {
    let bestA = 0;
    let bestB = 1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        let total = 0;
        for (const left of clusters[a].members) {
          for (const right of clusters[b].members) total += 1 - similarity(left, right);
        }
        const distance = total / (clusters[a].members.length * clusters[b].members.length);
        if (distance < bestDistance - 1e-12) {
          bestDistance = distance;
          bestA = a;
          bestB = b;
        }
      }
    }

    const merged: Cluster = {
      members: [...clusters[bestA].members, ...clusters[bestB].members].sort((x, y) => x - y),
      left: clusters[bestA],
      right: clusters[bestB],
    };
    clusters = clusters.filter((_, index) => index !== bestA && index !== bestB);
    clusters.push(merged);
  }

  /** 递归输出叶子顺序：左右子树各有两种方向，取边界相关性最大的组合 */
  const orderLeaves = (cluster: Cluster): number[] => {
    if (!cluster.left || !cluster.right) return cluster.members;
    const left = orderLeaves(cluster.left);
    const right = orderLeaves(cluster.right);
    const split = left.length;
    const candidates = [
      [...left, ...right],
      [...left].reverse().concat(right),
      left.concat([...right].reverse()),
      [...left].reverse().concat([...right].reverse()),
    ];

    let best = candidates[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
      const score = similarity(candidate[split - 1], candidate[split]);
      if (score > bestScore + 1e-12) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  };

  const order = orderLeaves(clusters[0]);
  // 防御：极端输入下也返回 0..size-1 的完整排列
  const seen = new Set(order);
  for (let index = 0; index < size; index += 1) {
    if (!seen.has(index)) order.push(index);
  }
  return order;
}

/** 归一化到基准 100（用于相对强弱对比） */
export function normalizeToBase(points: ChartPoint[], base = 100): number[] {
  if (points.length === 0) return [];
  const first = points[0].close;
  if (first <= 0) return [];
  return points.map((point) => (point.close / first) * base);
}

/** 日收益直方图分桶 */
export function returnHistogram(
  returns: number[],
  buckets = 9,
): { from: number; to: number; count: number }[] {
  if (returns.length === 0) return [];
  const percent = returns.map((value) => value * 100);
  const min = Math.min(...percent);
  const max = Math.max(...percent);
  const span = max - min || 0.01;

  const bins = Array.from({ length: buckets }, (_, index) => ({
    from: min + (span / buckets) * index,
    to: min + (span / buckets) * (index + 1),
    count: 0,
  }));

  for (const value of percent) {
    const position = Math.min(buckets - 1, Math.floor(((value - min) / span) * buckets));
    bins[position].count += 1;
  }

  return bins;
}

/* -------------------------------------------------------------------------- */
/*                          相对基准：alpha / beta                              */
/* -------------------------------------------------------------------------- */

export interface TimedReturn {
  /** 秒级时间戳（对齐用） */
  t: number;
  /** 日收益率（小数） */
  r: number;
}

export interface AlphaBeta {
  /** OLS 斜率：标的对基准的敏感度 */
  beta: number | null;
  /** 年化 alpha（%）：剥离基准收益后的超额 */
  alphaAnnualized: number | null;
  /** 样本对齐后的相关系数 */
  correlation: number | null;
  /** 年化跟踪误差（%）：与基准收益差的波动 */
  trackingError: number | null;
  /** 信息比率：年化超额 / 跟踪误差 */
  informationRatio: number | null;
  /** 上涨捕获（%）：基准上涨日，标的平均涨幅占基准的比例 */
  upCapture: number | null;
  /** 下跌捕获（%）：基准下跌日，标的平均跌幅占基准的比例（越小越抗跌） */
  downCapture: number | null;
  /** 对齐后样本数 */
  samples: number;
}

/** 带时间戳的日收益率序列（用于跨标的对齐） */
export function timedReturns(points: ChartPoint[]): TimedReturn[] {
  const output: TimedReturn[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].close;
    const current = points[index].close;
    // 价格缺失（0 / 负数）会产生假收益率，直接跳过
    if (previous <= 0 || current <= 0) continue;
    output.push({ t: points[index].t, r: current / previous - 1 });
  }
  return output;
}

/**
 * 统一到「UTC 交易日」：Yahoo 日线的时间戳是交易所开盘时间（美股 13:30/14:30 UTC），
 * Nasdaq 兜底是午夜（00:00 UTC），两者必须归一到同一天才能对齐。
 */
function tradingDay(t: number): number {
  return Math.floor(t / 86_400);
}

export interface AlignedReturns {
  /** 与 b 对齐后的 a 收益（按时间升序） */
  a: number[];
  /** 与 a 对齐后的 b 收益（按时间升序） */
  b: number[];
  /** 对齐后每个样本的交易日时间戳（取 a 侧的原值，供图表横轴使用） */
  t: number[];
}

/**
 * 按交易日取两条收益序列的交集（不同市场休市日不同、不同数据源时间戳不同，
 * 不能按秒级时间戳或下标硬对齐）。同一天有多条时保留最后一条。
 */
export function alignReturns(a: TimedReturn[], b: TimedReturn[]): AlignedReturns {
  const left = new Map<number, TimedReturn>();
  for (const item of a) left.set(tradingDay(item.t), item);
  const right = new Map<number, TimedReturn>();
  for (const item of b) right.set(tradingDay(item.t), item);

  const days = [...left.keys()].filter((day) => right.has(day)).sort((x, y) => x - y);
  const aligned: AlignedReturns = { a: [], b: [], t: [] };
  for (const day of days) {
    const itemA = left.get(day)!;
    const itemB = right.get(day)!;
    aligned.a.push(itemA.r);
    aligned.b.push(itemB.r);
    aligned.t.push(itemA.t);
  }
  return aligned;
}

/**
 * 简单 OLS 回归：stock ~ alpha + beta * benchmark。
 * alpha 为日均超额，按 252 个交易日年化；样本过少或基准无波动时返回 null。
 */
export function alphaBeta(stock: TimedReturn[], benchmark: TimedReturn[]): AlphaBeta {
  const aligned = alignReturns(stock, benchmark);
  const n = aligned.a.length;
  const empty: AlphaBeta = {
    beta: null,
    alphaAnnualized: null,
    correlation: null,
    trackingError: null,
    informationRatio: null,
    upCapture: null,
    downCapture: null,
    samples: n,
  };
  if (n < 20) return empty;

  const meanA = aligned.a.reduce((sum, value) => sum + value, 0) / n;
  const meanB = aligned.b.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceB = 0;
  let varianceA = 0;
  for (let index = 0; index < n; index += 1) {
    const da = aligned.a[index] - meanA;
    const db = aligned.b[index] - meanB;
    covariance += da * db;
    varianceB += db * db;
    varianceA += da * da;
  }
  if (varianceB <= 0 || varianceA <= 0) return empty;

  const beta = covariance / varianceB;
  const alphaDaily = meanA - beta * meanB;
  const corr = covariance / Math.sqrt(varianceA * varianceB);

  // 跟踪误差 / 信息比率：收益差（主动收益）的波动与均值
  let diffSum = 0;
  let diffSquare = 0;
  let upStock = 0;
  let upBench = 0;
  let downStock = 0;
  let downBench = 0;
  let upCount = 0;
  let downCount = 0;
  for (let index = 0; index < n; index += 1) {
    const diff = aligned.a[index] - aligned.b[index];
    diffSum += diff;
    diffSquare += diff * diff;
    if (aligned.b[index] > 0) {
      upStock += aligned.a[index];
      upBench += aligned.b[index];
      upCount += 1;
    } else if (aligned.b[index] < 0) {
      downStock += aligned.a[index];
      downBench += aligned.b[index];
      downCount += 1;
    }
  }
  const diffMean = diffSum / n;
  const diffStd = Math.sqrt(Math.max(0, (diffSquare - n * diffMean * diffMean) / (n - 1)));
  const trackingError = Number((diffStd * Math.sqrt(TRADING_DAYS) * 100).toFixed(2));
  const informationRatio =
    trackingError > 0 ? Number(((diffMean * TRADING_DAYS * 100) / trackingError).toFixed(3)) : null;

  return {
    beta: Number(beta.toFixed(3)),
    alphaAnnualized: Number((alphaDaily * TRADING_DAYS * 100).toFixed(2)),
    correlation: Number(corr.toFixed(3)),
    trackingError,
    informationRatio,
    upCapture: upCount > 0 && upBench > 0 ? Number(((upStock / upBench) * 100).toFixed(1)) : null,
    downCapture:
      downCount > 0 && downBench < 0 ? Number(((downStock / downBench) * 100).toFixed(1)) : null,
    samples: n,
  };
}

/** 按交易日对齐的两只标的的相关系数（样本不足 20 个交易日返回 null） */
export function correlationByTime(a: TimedReturn[], b: TimedReturn[]): number | null {
  const aligned = alignReturns(a, b);
  if (aligned.a.length < MIN_CORRELATION_SAMPLES) return null;
  const value = correlation(aligned.a, aligned.b);
  return value === null ? null : Number(value.toFixed(3));
}

export interface TimedSeries {
  symbol: string;
  returns: TimedReturn[];
}

/** 两两相关性（按交易日对齐） */
export function pairwiseCorrelations(
  series: TimedSeries[],
): { a: string; b: string; value: number | null; samples: number }[] {
  const output: { a: string; b: string; value: number | null; samples: number }[] = [];
  for (let i = 0; i < series.length; i += 1) {
    for (let j = i + 1; j < series.length; j += 1) {
      const aligned = alignReturns(series[i].returns, series[j].returns);
      output.push({
        a: series[i].symbol,
        b: series[j].symbol,
        value: correlationByTime(series[i].returns, series[j].returns),
        samples: aligned.a.length,
      });
    }
  }
  return output;
}

/**
 * Fisher z 平均：tanh(mean(atanh(r)))。
 * 相关系数不在线性尺度上，算术平均会低估 |r|，求平均时应先做 z 变换。
 */
export function fisherAverageCorrelation(values: number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  const z =
    usable.reduce(
      (sum, value) => sum + Math.atanh(Math.max(-0.9999, Math.min(0.9999, value))),
      0,
    ) / usable.length;
  return Number(Math.tanh(z).toFixed(3));
}

/**
 * 标的池的平均两两相关性（越接近 1 越像同一只股票）。
 * - 只统计样本达标的配对（≥ MIN_CORRELATION_SAMPLES）
 * - 用 Fisher z 平均（tanh(mean(atanh(r)))），避免算术平均低估 |r|
 */
export function averageCorrelation(series: TimedSeries[]): number | null {
  const pairs = pairwiseCorrelations(series).filter(
    (pair): pair is { a: string; b: string; value: number; samples: number } =>
      pair.value !== null && pair.samples >= MIN_CORRELATION_SAMPLES,
  );
  return fisherAverageCorrelation(pairs.map((pair) => pair.value));
}

/**
 * 滚动相关性（默认 60 个交易日），按交易日对齐。
 * 返回的时间戳取对齐后的样本日期（缺失日会被跳过，不能直接用原始序列下标）。
 */
export function rollingCorrelation(
  stock: TimedReturn[],
  benchmark: TimedReturn[],
  window = 60,
): { t: number; value: number }[] {
  const aligned = alignReturns(stock, benchmark);
  const output: { t: number; value: number }[] = [];
  if (window < 8) return output;
  for (let index = window; index <= aligned.a.length; index += 1) {
    const value = correlation(
      aligned.a.slice(index - window, index),
      aligned.b.slice(index - window, index),
    );
    if (value === null) continue;
    output.push({ t: aligned.t[index - 1], value: Number(value.toFixed(4)) });
  }
  return output;
}
