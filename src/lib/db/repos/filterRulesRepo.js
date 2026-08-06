import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";

// Real-time emitter (survives Next.js hot-reload). Same pattern as statsEmitter.
if (!global._filterRulesEmitter) {
  global._filterRulesEmitter = new EventEmitter();
  global._filterRulesEmitter.setMaxListeners(50);
}
export const filterRulesEmitter = global._filterRulesEmitter;

export function emitFilterRulesUpdate() {
  try {
    filterRulesEmitter.emit("update");
  } catch {
    /* never let notification break a mutation */
  }
}

// Adapted from etteum-pool's PUDIDIL_FILTERS (enowxai's pudidil filter
// template). Order matters: broad regex rules FIRST, then exact strings.
// All defaults are inactive (opt-in) — the user enables the ones they want.
const PUDIDIL_DEFAULTS = [
  // ── PHASE 1: broad regex ───────────────────────────────────────────────
  { ruleId: "remove_billing_header_regex", pattern: "x-(?:anthropic-)?billing-header:?\\s*[^\\n]*", replacement: "", isRegex: true },
  { ruleId: "remove_cc_entrypoint_any", pattern: "cc_entrypoint=\\w+", replacement: "", isRegex: true },
  { ruleId: "remove_cc_version_any", pattern: "cc_version=[\\w.]+", replacement: "", isRegex: true },
  { ruleId: "remove_cch_hash", pattern: "c?ch=[a-f0-9]+", replacement: "", isRegex: true },
  { ruleId: "remove_claude_code_github", pattern: "https?://github\\.com/anthropics/claude-code[^\\s]*", replacement: "", isRegex: true },
  { ruleId: "remove_claude_code_identity_variations", pattern: "I'?m Claude Code[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_anthropic_cli_ref", pattern: "Anthropic'?s official (?:CLI|tool|agent)[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "remove_anxthxropic_ref", pattern: "Anxthxropic'?s official[^.]*\\.?", replacement: "", isRegex: true },
  { ruleId: "remove_cursor_identity", pattern: "I'?m Cursor[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_windsurf_identity", pattern: "I'?m Windsurf[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_cline_identity", pattern: "I'?m Cline[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_mcp_ref", pattern: "Model Context Protocol[^.]*\\.", replacement: "", isRegex: true },
  { ruleId: "remove_ai_coding_agent_ref", pattern: "AI(?:-| )?coding agent[^.]*\\.", replacement: "", isRegex: true },
  // ── PHASE 2: exact strings ─────────────────────────────────────────────
  { ruleId: "remove_feedback_line", pattern: "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues", replacement: "", isRegex: false },
  { ruleId: "remove_powerful_ai_agent", pattern: "powerful AI coding agent", replacement: "", isRegex: false },
  { ruleId: "remove_claude_code_identity", pattern: "I'm Claude Code", replacement: "", isRegex: false },
  { ruleId: "remove_claude_code_mention", pattern: "the assistant", replacement: "the assistant", isRegex: false },
];

function rowToRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    ruleId: row.ruleId,
    pattern: row.pattern,
    replacement: row.replacement ?? "",
    isActive: row.isActive === 1 || row.isActive === true,
    isRegex: row.isRegex === 1 || row.isRegex === true,
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getFilterRules() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM filterRules ORDER BY sortOrder ASC, createdAt ASC`);
  return rows.map(rowToRule);
}

export async function getActiveFilterRules() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM filterRules WHERE isActive = 1 ORDER BY sortOrder ASC`);
  return rows.map(rowToRule);
}

export async function getFilterRuleById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM filterRules WHERE id = ?`, [id]);
  return rowToRule(row);
}

export async function createFilterRule(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let sortOrder = data.sortOrder;
  if (sortOrder === undefined || sortOrder === null) {
    const max = db.get(`SELECT MAX(sortOrder) AS m FROM filterRules`);
    sortOrder = (max?.m ?? -1) + 1;
  }
  const rule = {
    id: uuidv4(),
    ruleId: (data.ruleId && String(data.ruleId).trim()) || `rule_${uuidv4().slice(0, 8)}`,
    pattern: data.pattern,
    replacement: data.replacement ?? "",
    isActive: data.isActive !== false,
    isRegex: data.isRegex === true,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO filterRules(id, ruleId, pattern, replacement, isActive, isRegex, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rule.id,
      rule.ruleId,
      rule.pattern,
      rule.replacement,
      rule.isActive ? 1 : 0,
      rule.isRegex ? 1 : 0,
      rule.sortOrder,
      rule.createdAt,
      rule.updatedAt,
    ]
  );
  emitFilterRulesUpdate();
  return rule;
}

export async function updateFilterRule(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM filterRules WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToRule(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE filterRules SET ruleId = ?, pattern = ?, replacement = ?, isActive = ?, isRegex = ?, sortOrder = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.ruleId,
        merged.pattern,
        merged.replacement,
        merged.isActive ? 1 : 0,
        merged.isRegex ? 1 : 0,
        merged.sortOrder,
        merged.updatedAt,
        id,
      ]
    );
    result = merged;
  });
  emitFilterRulesUpdate();
  return result;
}

export async function deleteFilterRule(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM filterRules WHERE id = ?`, [id]);
  const deleted = (res?.changes ?? 0) > 0;
  if (deleted) emitFilterRulesUpdate();
  return deleted;
}

// Persist a new ordering. `orderedIds` is the full list of rule ids in the desired order.
export async function reorderFilterRules(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return false;
  const db = await getAdapter();
  db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      db.run(`UPDATE filterRules SET sortOrder = ?, updatedAt = ? WHERE id = ?`, [
        i,
        new Date().toISOString(),
        orderedIds[i],
      ]);
    }
  });
  emitFilterRulesUpdate();
  return true;
}

// Seed default rules on first boot when the table is empty. Rules are opt-in
// (isActive=0) — user enables the ones they want. Accepts an optional adapter
// so it can run inside runMigrationOnce without re-entering getAdapter (which
// would deadlock the init promise).
export async function seedFilterRulesIfEmpty(adapter) {
  const db = adapter || (await getAdapter());
  const count = db.get(`SELECT COUNT(*) AS c FROM filterRules`);
  if (count?.c > 0) return false;

  const now = new Date().toISOString();
  PUDIDIL_DEFAULTS.forEach((d, i) => {
    db.run(
      `INSERT INTO filterRules(id, ruleId, pattern, replacement, isActive, isRegex, sortOrder, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), d.ruleId, d.pattern, d.replacement, 0, d.isRegex ? 1 : 0, i, now, now]
    );
  });
  return true;
}

// Additive backfill: insert any PUDIDIL default whose ruleId is not yet present.
// Idempotent — safe to run on every boot. Existing rules (including the 3-rule
// seed from an earlier version) are left untouched; new rules are appended after
// the current max sortOrder, inactive (opt-in). Returns the number of rules added.
export async function ensurePudidilDefaults(adapter) {
  const db = adapter || (await getAdapter());
  let tableExists = true;
  try {
    db.get(`SELECT 1 FROM filterRules LIMIT 1`);
  } catch {
    tableExists = false;
  }
  if (!tableExists) return 0;

  const existing = new Set(db.all(`SELECT ruleId FROM filterRules`).map((r) => r.ruleId));
  const maxSort = db.get(`SELECT MAX(sortOrder) AS m FROM filterRules`);
  let sortOrder = (maxSort?.m ?? -1) + 1;
  const now = new Date().toISOString();
  let added = 0;

  for (const d of PUDIDIL_DEFAULTS) {
    if (existing.has(d.ruleId)) continue;
    db.run(
      `INSERT INTO filterRules(id, ruleId, pattern, replacement, isActive, isRegex, sortOrder, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), d.ruleId, d.pattern, d.replacement, 0, d.isRegex ? 1 : 0, sortOrder, now, now]
    );
    sortOrder += 1;
    added += 1;
  }
  return added;
}
