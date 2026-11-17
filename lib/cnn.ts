import { cached } from "@/lib/cache";
import { parseFearGreed, type FearGreedData } from "@/lib/fear-greed";

/**
 * CNN Business 恐惧贪婪指数适配器（无需 Key）。
 *
 *  - 接口：https://production.dataviz.cnn.io/index/fearandgreed/graphdata
 *  - CNN 对缺少浏览器特征的请求会返回 418，这里固定一套 UA / Referer / Origin
 *  - 指数在美股盘中每隔几分钟更新一次：缓存 60s，旧值最多保留 1 小时（stale-while-revalidate）
 *  - 独立接口：失败只影响右栏这一张卡片，不影响行情 / 市场面板
 */

const ENDPOINT = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.cnn.com/markets/fear-and-greed",
  Origin: "https://www.cnn.com",
};

export class CnnError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
    readonly code: "upstream_error" | "parse_error" = "upstream_error",
  ) {
    super(message);
    this.name = "CnnError";
  }
}

export interface FearGreedResult extends FearGreedData {
  provider: "cnn";
  cached: boolean;
  stale: boolean;
}

/** 拉取并解析 CNN graphdata（失败抛出 CnnError，带状态码与错误码） */
export async function fetchFearGreed(): Promise<FearGreedData> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new CnnError(
      `CNN 恐惧贪婪指数请求失败（${(error as Error)?.message || "网络错误"}）`,
      502,
      "upstream_error",
    );
  }

  if (!response.ok) {
    throw new CnnError(
      `CNN 恐惧贪婪指数暂时不可用（${response.status}）`,
      response.status === 404 ? 404 : 502,
      "upstream_error",
    );
  }

  const payload = await response.json().catch(() => null);
  try {
    return parseFearGreed(payload);
  } catch (error) {
    throw new CnnError((error as Error).message || "CNN 恐惧贪婪数据格式异常", 502, "parse_error");
  }
}

/** 右栏「恐惧贪婪指数」：拉取 + 解析 + 缓存 */
export async function getFearGreed(): Promise<FearGreedResult> {
  const result = await cached("fear-greed:cnn", 60, 3600, fetchFearGreed);
  return { ...result.value, provider: "cnn", cached: result.cached, stale: result.stale };
}
