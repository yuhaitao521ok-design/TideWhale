import type { Metadata } from "next";
import NewsDashboard from "@/components/news/NewsDashboard";

export const metadata: Metadata = {
  title: "市场快讯 · TideWhale",
  description: "美国大公司突发消息、SEC 8-K 备案与国际要闻聚合，实时更新",
};

export default function Page() {
  return <NewsDashboard />;
}
