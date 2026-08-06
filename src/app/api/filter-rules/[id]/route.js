import { NextResponse } from "next/server";
import {
  deleteFilterRule,
  getFilterRuleById,
  updateFilterRule,
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

// GET /api/filter-rules/[id] - Get single rule
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const rule = await getFilterRuleById(id);
    if (!rule) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }
    return NextResponse.json({ rule });
  } catch (error) {
    console.log("Error fetching filter rule:", error);
    return NextResponse.json({ error: "Failed to fetch filter rule" }, { status: 500 });
  }
}

// PUT /api/filter-rules/[id] - Update rule (partial)
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existing = await getFilterRuleById(id);
    if (!existing) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }

    const updateData = {};
    if (body.ruleId !== undefined) updateData.ruleId = body.ruleId;
    if (body.pattern !== undefined) updateData.pattern = body.pattern;
    if (body.replacement !== undefined) updateData.replacement = body.replacement;
    if (body.isActive !== undefined) updateData.isActive = body.isActive === true;
    if (body.isRegex !== undefined) updateData.isRegex = body.isRegex === true;
    if (body.sortOrder !== undefined) updateData.sortOrder = body.sortOrder;

    // Validate regex against the merged state.
    const effectivePattern = updateData.pattern ?? existing.pattern;
    const effectiveIsRegex = updateData.isRegex ?? existing.isRegex;
    const regexError = validateRegex(effectivePattern, effectiveIsRegex);
    if (regexError) {
      return NextResponse.json({ error: `Invalid regex: ${regexError}` }, { status: 400 });
    }

    const updated = await updateFilterRule(id, updateData);
    invalidateFilterCache();
    return NextResponse.json({ rule: updated });
  } catch (error) {
    console.log("Error updating filter rule:", error);
    return NextResponse.json({ error: "Failed to update filter rule" }, { status: 500 });
  }
}

// DELETE /api/filter-rules/[id] - Delete rule
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteFilterRule(id);
    if (!deleted) {
      return NextResponse.json({ error: "Rule not found" }, { status: 404 });
    }
    invalidateFilterCache();
    return NextResponse.json({ message: "Rule deleted successfully" });
  } catch (error) {
    console.log("Error deleting filter rule:", error);
    return NextResponse.json({ error: "Failed to delete filter rule" }, { status: 500 });
  }
}
