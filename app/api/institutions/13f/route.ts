import { NextRequest } from "next/server";
import {
  QUARTER_CHANGES_SUMMARY_LIMIT,
  SUPER_INVESTORS,
  findInvestor,
  get13F,
  thirteenFCacheKey,
  type ThirteenFSummary,
} from "@/lib/institutions";
import { congressCacheKey, getCongressResult } from "@/lib/congress";
import { dropCache } from "@/lib/cache";
import { cacheHeaders, errorStatus, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 超级投资者的最新 13F：
 *  - ?investor=berkshire            完整持仓
 *  - ?investor=berkshire&summary=1  总览用精简摘要（不含持仓明细）
 *  - &refresh=1                     绕过服务端 6 小时缓存，重新拉取 SEC
 *  - 不带 investor 参数时返回可选列表
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("investor");
  const summary = request.nextUrl.searchParams.get("summary") === "1";
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";

  if (!id) {
    return Response.json({ investors: SUPER_INVESTORS }, { headers: cacheHeaders(3600, 86400) });
  }

  const investor = findInvestor(id);
  if (!investor) {
    return jsonError("未知的投资者，可选值见 /api/institutions/13f", 400, "invalid_request");
  }

  // 国会成员没有 13F，走众议院 Clerk 的 PTR（交易披露）
  if (investor.source === "congress") {
    if (refresh) dropCache(congressCacheKey(investor));
    try {
      const data = await getCongressResult(investor);
      // 摘要只要最近几个披露文件，交易明细留在详情接口，避免总览把 29 份响应撑大
      const payload = summary
        ? { ...data, trades: undefined, filings: (data.filings ?? []).slice(0, 4) }
        : data;
      return Response.json(payload, { headers: cacheHeaders(21600, 86400) });
    } catch (error) {
      const { status, message, code } = errorStatus(error);
      return jsonError(message, status, code);
    }
  }

  if (refresh) dropCache(thirteenFCacheKey(investor));

  try {
    const data = await get13F(investor);
    if (summary) {
      const payload: ThirteenFSummary = {
        investor: data.investor,
        entityName: data.entityName,
        filedAt: data.filedAt,
        period: data.period,
        totalPositions: data.totalPositions,
        totalValue: data.totalValue,
        // 总览需要按季度切换：每季保留加仓 / 减仓前 20 条（卡片只展示第 1 条，
        // 跨机构 Top 10 由这些明细聚合），既够用又不把 29 人的响应撑大。
        quarters: data.quarters.map((quarter) => ({
          ...quarter,
          buys: quarter.buys.slice(0, QUARTER_CHANGES_SUMMARY_LIMIT),
          sells: quarter.sells.slice(0, QUARTER_CHANGES_SUMMARY_LIMIT),
        })),
        fetchedAt: data.fetchedAt,
      };
      return Response.json(
        { ...payload, cached: data.cached },
        { headers: cacheHeaders(21600, 86400) },
      );
    }
    return Response.json(data, { headers: cacheHeaders(21600, 86400) });
  } catch (error) {
    const { status, message, code } = errorStatus(error);
    return jsonError(message, status, code);
  }
}
