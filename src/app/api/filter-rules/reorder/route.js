import { NextResponse } from "next/server";
import { reorderFilterRules } from "@/lib/localDb";
import { invalidateFilterCache } from "@/lib/filterRules/index.js";

export const dynamic = "force-dynamic";

// PATCH /api/filter-rules/reorder - Persist new ordering
// Body: { order: ["<id>", "<id>", ...] } — full list in desired order.
export async function PATCH(request) {
  try {
    const body = await request.json();
    const order = Array.isArray(body?.order) ? body.order.filter((x) => typeof x === "string") : [];
    if (order.length === 0) {
      return NextResponse.json({ error: "order array is required" }, { status: 400 });
    }
    await reorderFilterRules(order);
    invalidateFilterCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.log("Error reordering filter rules:", error);
    return NextResponse.json({ error: "Failed to reorder filter rules" }, { status: 500 });
  }
}
