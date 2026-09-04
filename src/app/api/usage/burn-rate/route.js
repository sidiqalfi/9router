import { NextResponse } from "next/server";
import { getDailyRequestCountsByConnection } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/burn-rate?days=30
 *
 * Returns per-connection daily request counts over the last `days` days so
 * the quota tracker can compute a burn-rate projection (percentile range).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const daysParam = searchParams.get("days") || "30";
    const days = Number.parseInt(daysParam, 10);

    if (!Number.isFinite(days) || days < 1 || days > 60) {
      return NextResponse.json({ error: "Invalid days (expected 1-60)" }, { status: 400 });
    }

    const data = await getDailyRequestCountsByConnection(days);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get burn-rate data:", error);
    return NextResponse.json({ error: "Failed to fetch burn-rate data" }, { status: 500 });
  }
}
