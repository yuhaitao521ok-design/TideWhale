import { NextResponse } from "next/server";
import { getFearGreed } from "@/lib/fear-greed";
import { cacheHeaders, errorStatus, jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 市场全景：CNN Business 恐惧贪婪指数（独立路由，失败只影响本卡片） */
export async function GET() {
  try {
    const data = await getFearGreed();
    return NextResponse.json(data, { headers: cacheHeaders(60, 300) });
  } catch (error) {
    const { status, message, code } = errorStatus(error);
    return jsonError(message, status, code);
  }
}
