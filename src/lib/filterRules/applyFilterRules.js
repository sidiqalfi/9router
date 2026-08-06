// Content sanitization engine: applies user-defined filter rules to a request
// body IN-PLACE before it is forwarded to the upstream provider. Format-aware
// (OpenAI Chat / Responses, Claude, Gemini, Kiro-via-OpenAI). Fail-open: any
// error returns the body untouched — sanitization must never break a request.
//
// Adapted from etteum-pool's applyPudidilFilters, following open-sse/rtk
// conventions (safeApply, never-empty-never-grow, in-place mutation + stats).
import { getFilterRulesCached } from "./cache.js";

function applyRulesToText(text, rules, stats) {
  if (typeof text !== "string" || text.length === 0 || rules.length === 0) return text;
  let out = text;
  for (const rule of rules) {
    try {
      let matched = false;
      if (rule.isRegex) {
        const re = new RegExp(rule.pattern, "gi");
        const before = out;
        out = out.replace(re, rule.replacement ?? "");
        matched = out !== before;
      } else {
        // Exact-string: replace all occurrences (case-sensitive, like etteum-pool).
        const needle = rule.pattern;
        if (needle && out.includes(needle)) {
          matched = true;
          out = out.split(needle).join(rule.replacement ?? "");
        }
      }
      if (matched) stats.hits.push(rule.ruleId || rule.id);
    } catch (err) {
      // Bad regex / pattern — skip this rule, keep going. Fail-open.
      stats.errors.push({ ruleId: rule.ruleId || rule.id, message: err?.message || String(err) });
    }
  }
  return out;
}

// Apply rules to a content value that may be a plain string or an array of
// parts: [{ type: "text", text }, { type: "input_text", text }, ...].
function applyToContent(content, rules, stats) {
  if (typeof content === "string") {
    return applyRulesToText(content, rules, stats);
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        part.text = applyRulesToText(part.text, rules, stats);
      }
    }
  }
  return content;
}

function applyToMessages(items, rules, stats) {
  if (!Array.isArray(items)) return;
  for (const msg of items) {
    if (!msg) continue;
    // OpenAI Responses: function_call_output with string/array output
    if (msg.type === "function_call_output") {
      if (typeof msg.output === "string") {
        msg.output = applyRulesToText(msg.output, rules, stats);
      } else if (Array.isArray(msg.output)) {
        for (const part of msg.output) {
          if (part && typeof part.text === "string") {
            part.text = applyRulesToText(part.text, rules, stats);
          }
        }
      }
      continue;
    }
    if (msg.content !== undefined) {
      msg.content = applyToContent(msg.content, rules, stats);
    }
    // Claude tool_result blocks live inside content arrays as
    // { type:"tool_result", content: string | [{type:"text",text}] }.
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === "tool_result" && part.content !== undefined) {
          part.content = applyToContent(part.content, rules, stats);
        }
      }
    }
  }
}

function applyToGeminiContents(contents, rules, stats) {
  if (!Array.isArray(contents)) return;
  for (const item of contents) {
    if (!item || !Array.isArray(item.parts)) continue;
    for (const part of item.parts) {
      if (part && typeof part.text === "string") {
        part.text = applyRulesToText(part.text, rules, stats);
      }
    }
  }
}

// Sanitize a body in-place. `enabled` gates the whole pass (master + per-path
// flag). `format` (optional) helps pick the right shape; absent format falls
// back to auto-detect. Returns stats; never throws.
export function applyFilterRules(body, { enabled = true, format = null } = {}) {
  const stats = { applied: false, hits: [], errors: [], bytesBefore: 0, bytesAfter: 0 };
  if (!enabled || !body || typeof body !== "object") return stats;

  const rules = getFilterRulesCached();
  if (!rules || rules.length === 0) return stats;
  stats.applied = true;
  stats.bytesBefore = JSON.stringify(body).length;

  try {
    // Kiro (CodeWhisperer conversationState) — handled separately, but in the
    // MITM path Kiro is converted to OpenAI messages before reaching here, so
    // the messages branch below covers it.
    if (Array.isArray(body.conversationState?.history)) {
      applyToMessages(body.conversationState.history, rules, stats);
      const cm = body.conversationState.currentMessage;
      if (cm && Array.isArray(cm.messages)) applyToMessages(cm.messages, rules, stats);
    }

    // OpenAI Chat / Claude messages
    if (Array.isArray(body.messages)) applyToMessages(body.messages, rules, stats);

    // OpenAI Responses input[]
    if (Array.isArray(body.input)) applyToMessages(body.input, rules, stats);

    // OpenAI Responses top-level instructions
    if (typeof body.instructions === "string") {
      body.instructions = applyRulesToText(body.instructions, rules, stats);
    }

    // Claude system (string or array of text parts)
    if (body.system !== undefined) {
      body.system = applyToContent(body.system, rules, stats);
    }

    // Gemini contents[] + system_instruction (and request.systemInstruction wrapper)
    if (Array.isArray(body.contents)) applyToGeminiContents(body.contents, rules, stats);
    if (body.system_instruction !== undefined) {
      body.system_instruction = applyToContent(body.system_instruction, rules, stats);
    }
    if (body.systemInstruction !== undefined) {
      body.systemInstruction = applyToContent(body.systemInstruction, rules, stats);
    }
    if (body.request?.systemInstruction !== undefined) {
      body.request.systemInstruction = applyToContent(body.request.systemInstruction, rules, stats);
    }

    stats.bytesAfter = JSON.stringify(body).length;
  } catch (err) {
    // Fail-open: never let sanitization corrupt the request.
    stats.errors.push({ ruleId: "__engine__", message: err?.message || String(err) });
  }
  return stats;
}

// Format a log line from stats (mirrors formatRtkLog style). Returns null if noop.
// Lists the ruleIds that matched so you can see which rules fired.
export function formatFilterRulesLog(stats) {
  if (!stats || !stats.applied) return null;
  const unique = [...new Set(stats.hits || [])];
  const delta = stats.bytesBefore - stats.bytesAfter;
  const deltaStr = `${delta >= 0 ? "-" : "+"}${Math.abs(delta)}B`;
  const errStr = stats.errors?.length ? `|${stats.errors.length}err` : "";

  if (unique.length === 0) {
    if (stats.errors?.length) return `FILTER:skipped(0hit,${stats.errors.length}err)`;
    return null; // applied but nothing matched — stay quiet
  }
  // e.g. FILTER:2rules|-62B[remove_cc_version_any,remove_billing_header_regex]
  const list = unique.length <= 3 ? `[${unique.join(",")}]` : `[${unique.slice(0, 3).join(",")}+${unique.length - 3}]`;
  return `FILTER:${unique.length}rule${unique.length > 1 ? "s" : ""}|${deltaStr}${errStr} ${list}`;
}

// Run rules against a sample text without persisting anything (preview feature).
export function previewFilterRule({ pattern, replacement = "", isRegex = false, sample = "" }) {
  // Validate regex up front so the API can return a clean error.
  if (isRegex) {
    try {
      new RegExp(pattern, "gi");
    } catch (err) {
      return { result: sample, matched: false, error: err?.message || String(err) };
    }
  }
  const rule = { ruleId: "preview", pattern, replacement, isRegex };
  const stats = { hits: [], errors: [] };
  const result = applyRulesToText(sample, [rule], stats);
  return { result, matched: stats.hits.length > 0, error: stats.errors[0]?.message || null };
}
