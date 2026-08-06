import { NextResponse } from "next/server";
import { previewFilterRule } from "@/lib/filterRules/index.js";

export const dynamic = "force-dynamic";

// POST /api/filter-rules/preview - Test a pattern against sample text (no persistence)
// Body: { pattern, replacement, isRegex, sample }
export async function POST(request) {
  try {
    const body = await request.json();
    const result = previewFilterRule({
      pattern: typeof body?.pattern === "string" ? body.pattern : "",
      replacement: typeof body?.replacement === "string" ? body.replacement : "",
      isRegex: body?.isRegex === true,
      sample: typeof body?.sample === "string" ? body.sample : "",
    });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error previewing filter rule:", error);
    return NextResponse.json({ error: "Failed to preview" }, { status: 500 });
  }
}
