import { NextResponse } from "next/server";
import { getNews } from "@/lib/news";
import { cacheHeaders, errorStatus, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 市场新闻聚合（美国大公司 + 国际市场）
 *
 *  - `?q=关键词`：跨源搜索（Google News 走 7 天窗口，SEC 走全文检索）
 *  - `?refresh=1`：丢弃缓存，强制重新抓取全部源
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const query = (searchParams.get("q") ?? "").slice(0, 80);
    const refresh = searchParams.get("refresh") === "1";
    const data = await getNews({ query, refresh });
    return NextResponse.json(data, {
      headers: { ...cacheHeaders(90, 600), "X-Data-Source": "mixed" },
    });
  } catch (error) {
    const { status, message, code } = errorStatus(error);
    return jsonError(message, status, code);
  }
}
