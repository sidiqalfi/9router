import { NextResponse } from "next/server";
import {
  getFilterRules,
  createFilterRule,
} from "@/lib/localDb";
import { invalidateFilterCache } from "@/lib/filterRules/index.js";

export const dynamic = "force-dynamic";

function validateRegex(pattern, isRegex) {
  if (isRegex) {
    try {
      new RegExp(pattern, "gi");
    } catch (e) {
      return e?.message || "Invalid regex";
    }
  }
  return null;
}

// GET /api/filter-rules - List all rules
export async function GET() {
  try {
    const rules = await getFilterRules();
    const activeCount = rules.filter((r) => r.isActive).length;
    return NextResponse.json({ count: rules.length, activeCount, rules });
  } catch (error) {
    console.log("Error fetching filter rules:", error);
    return NextResponse.json({ error: "Failed to fetch filter rules" }, { status: 500 });
  }
}

// POST /api/filter-rules - Create a rule
export async function POST(request) {
  try {
    const body = await request.json();
    const pattern = typeof body?.pattern === "string" ? body.pattern : "";
    if (!pattern) {
      return NextResponse.json({ error: "Pattern is required" }, { status: 400 });
    }
    const isRegex = body?.isRegex === true;
    const regexError = validateRegex(pattern, isRegex);
    if (regexError) {
      return NextResponse.json({ error: `Invalid regex: ${regexError}` }, { status: 400 });
    }

    const rule = await createFilterRule({
      ruleId: body.ruleId,
      pattern,
      replacement: typeof body?.replacement === "string" ? body.replacement : "",
      isActive: body?.isActive === undefined ? false : body.isActive === true,
      isRegex,
      sortOrder: body.sortOrder,
    });

    invalidateFilterCache();
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    console.log("Error creating filter rule:", error);
    return NextResponse.json({ error: "Failed to create filter rule" }, { status: 500 });
  }
}
