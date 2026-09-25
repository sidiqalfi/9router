import "open-sse/index.js";

import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { getProviderCredentials, clearAccountError } from "@/sse/services/auth.js";
import { checkAndRefreshToken, updateProviderCredentials } from "@/sse/services/tokenRefresh.js";
import { getModelInfo } from "@/sse/services/model.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { clearAntigravityStrikes } from "@/sse/services/antigravityQuota.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { initTranslators } from "open-sse/translator/index.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import * as log from "@/sse/utils/logger.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * POST /api/models/playground - Dashboard-only model test endpoint.
 *
 * Runs a single streaming chat request through the same engine as /api/v1
 * (handleChatCore), but deliberately WITHOUT the production safety nets so a
 * test surfaces the chosen account's real error:
 *   - no multi-account fallback / markAccountUnavailable retry loop
 *   - no bypass handler, no capacity-adapter substitution
 * Optional connection pinning via getProviderCredentials preferredConnectionId.
 *
 * Auth: dashboard session cookie / CLI token via src/dashboardGuard.js (no
 * per-route check needed — deny-by-default for /api/*).
 *
 * Timeout: chatCore has an internal stream stall guard (~360s); the practical
 * cap is client-side (AbortController in ModelTestCard, 120s).
 *
 * Note: requests here are recorded in usage stats like any other gateway
 * request (intentional — playground traffic is real traffic).
 *
 * Request body:
 *   model: "alias/modelId" or "alias/modelId(level)" (thinking suffix allowed)
 *   messages: [{ role, content }]  (OpenAI format)
 *   connectionId: string | null    (null or "auto" → normal routing strategy)
 *   maxTokens: number              (optional, default 1024, clamped [1,4096])
 *
 * Responses:
 *   success → SSE Response (text/event-stream), passed through verbatim
 *   error   → JSON Response (errorResponse / provider status), passed through
 */
export async function POST(request) {
  await ensureInitialized();

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const { model: modelStr, messages, connectionId = null, maxTokens } = body || {};
  if (!modelStr || typeof modelStr !== "string") {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing or invalid model");
  }
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every((m) => m?.role && m?.content != null)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages[] required (OpenAI format)");
  }
  const maxTokensClamped = Math.min(Math.max(Number(maxTokens) || 1024, 1), 4096);

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo?.provider) {
    return errorResponse(HTTP_STATUS.NOT_FOUND, `Unknown model: ${modelStr}`);
  }
  const { provider, model } = modelInfo;

  // Single-shot: surface the picked account's real error verbatim. No
  // exclude/retry loop, no markAccountUnavailable — a 429 must be visible.
  const preferredConnectionId = connectionId && connectionId !== "auto" ? connectionId : null;
  const credentials = await getProviderCredentials(provider, null, model, { preferredConnectionId });
  if (!credentials || credentials.allRateLimited) {
    const msg = credentials?.lastError || `No active credentials for provider: ${provider}`;
    const status = credentials?.allRateLimited ? HTTP_STATUS.SERVICE_UNAVAILABLE : HTTP_STATUS.NOT_FOUND;
    log.warn("PLAYGROUND", `[${provider}/${model}] ${msg}`);
    return errorResponse(status, `[${provider}/${model}] ${msg}`);
  }

  const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

  // Ensure real project ID is available for providers that need it (cold miss).
  // Playground stays read-only wrt this state: resolved in-memory only.
  if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
    const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
    if (pid) refreshedCredentials.projectId = pid;
  }

  const chatSettings = await getSettings();
  const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
  const result = await handleChatCore({
    body: {
      model: `${provider}/${model}`,
      messages,
      stream: true,
      max_tokens: maxTokensClamped,
    },
    modelInfo: { provider, model },
    credentials: refreshedCredentials,
    log,
    connectionId: credentials.connectionId,
    // Fixed UA: bypassHandler gates on claude-cli UA — playground must never
    // trigger the warmup/bypass path even if the user types "Warmup"/"count".
    userAgent: "9router-playground",
    clientRawRequest: {
      endpoint: "/api/models/playground",
      body,
      headers: { "user-agent": "9router-playground" },
      accept: "text/event-stream",
    },
    apiKey: null,
    ccFilterNaming: !!chatSettings.ccFilterNaming,
    rtkEnabled: !!chatSettings.rtkEnabled,
    headroomEnabled: !!chatSettings.headroomEnabled,
    headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
    headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
    headroomTimeoutMs: chatSettings.headroomTimeoutMs,
    cavemanEnabled: !!chatSettings.cavemanEnabled,
    cavemanLevel: chatSettings.cavemanLevel || "full",
    ponytailEnabled: !!chatSettings.ponytailEnabled,
    ponytailLevel: chatSettings.ponytailLevel || "full",
    pxpipeEnabled: !!chatSettings.pxpipeEnabled,
    pxpipeMinChars: chatSettings.pxpipeMinChars,
    pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
    // Lazily warms the in-process module on first use; null when not installed (fail-open)
    pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
    onPxpipeEvent: appendPxpipeEvent,
    providerThinking,
    filterRulesEnabled: !!chatSettings.filterRulesEnabled,
    // Not a wire endpoint — detectFormat(body) resolves "openai" naturally
    sourceFormatOverride: null,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        ...newCreds,
        existingProviderSpecificData: credentials.providerSpecificData,
        testStatus: "active"
      });
    },
    onRequestSuccess: async () => {
      await clearAccountError(credentials.connectionId, credentials, model);
      clearAntigravityStrikes(credentials.connectionId, model);
    },
    // Streaming cleanup is handled internally by chatCore's stream controller
    onDisconnect: async () => {},
  });

  // Success → SSE Response; failure → JSON error Response with provider status.
  // Pass through either way (same contract as handleChat, minus the fallback).
  return result.response;
}

// Dashboard-only route; never cache
export const dynamic = "force-dynamic";

/**
 * Handle CORS preflight (mirror /api/models/test)
 */
export async function OPTIONS() {
  return NextResponse.json({ ok: true });
}
