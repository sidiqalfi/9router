// Aggregate quota total across every connection of a provider (or all
// providers), respecting the dashboard's account-status filter.
//
// The Quota Tracker page only fetches quota for the connections on the current
// page, so a client-side sum would miss accounts on other pages. This endpoint
// enumerates the matching connections server-side, fetches each account's
// quota (reusing the exact per-connection path), and sums the countable rows.
import { NextResponse } from "next/server";
import "open-sse/index.js";

import { getProviderConnections, getSettings } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import {
  parseQuotaData,
  filterQuotasByVisibility,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 60_000; // align with the dashboard auto-refresh cadence
const MAX_CONCURRENCY = 5;

// Survive Next.js hot reload — one cache per server process.
const g = (global.__usageSummaryCache ??= { entries: new Map() });

function isUsageEligible(connection) {
  return (
    USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) &&
    (connection.authType === "oauth" ||
      USAGE_APIKEY_PROVIDERS.includes(connection.provider))
  );
}

// Sum the countable quota rows of one account. Mirrors the per-card "Account
// Total" math (skip unlimited / no-capacity rows) but without the card's
// ">= 2 rows" gate, so a single-quota account still contributes to the total.
function sumQuotas(quotas) {
  let used = 0;
  let total = 0;
  let counted = 0;
  for (const quota of quotas || []) {
    const rowTotal = Number(quota?.total);
    if (!Number.isFinite(rowTotal) || rowTotal <= 0) continue; // unlimited / no capacity
    used += Number(quota?.used) || 0;
    total += rowTotal;
    counted += 1;
  }
  if (counted === 0 || total <= 0) return null;
  const remaining = Math.max(0, total - used);
  return {
    used,
    total,
    remaining,
    remainingPercentage: Math.round(
      Math.max(0, Math.min(100, (remaining / total) * 100)),
    ),
  };
}

// Run `fn` over items with a bounded number of in-flight calls; a failed item
// resolves to null instead of rejecting the whole batch.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index]);
        } catch {
          results[index] = null;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function fetchConnectionQuotas(connection, quotaVisibility, force) {
  const proxyConfig = await resolveConnectionProxyConfig(
    connection.providerSpecificData,
  );
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };

  // Refresh OAuth credentials first (same as the per-connection usage route).
  let conn = connection;
  if (conn.authType === "oauth") {
    try {
      conn = (await refreshAndUpdateCredentials(conn, false, proxyOptions))
        .connection;
    } catch {
      // Keep the existing token; the usage call may still succeed.
    }
  }

  const usage = await getUsageForProvider(conn, proxyOptions, { force });
  if (!usage || usage.message) return null;

  const normalized = parseQuotaData(conn.provider, usage);
  const visible = filterQuotasByVisibility(
    conn.provider,
    normalized,
    quotaVisibility,
  );
  return sumQuotas(visible);
}

/**
 * GET /api/usage/summary?provider=<id|all>&accountStatus=<all|active|inactive>[&force=1]
 * Returns the summed remaining/total across every matching connection.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "all";
    const accountStatus = searchParams.get("accountStatus") || "all";
    const force = searchParams.get("force") === "1";

    const settings = await getSettings();
    const quotaVisibility = settings?.quotaVisibility || {};

    const cacheKey = `${provider}:${accountStatus}`;
    const cached = g.entries.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
    }

    const allConnections = await getProviderConnections();
    const targets = allConnections.filter((conn) => {
      if (!isUsageEligible(conn)) return false;
      if (provider !== "all" && conn.provider !== provider) return false;
      if (accountStatus === "active") return conn.isActive ?? true;
      if (accountStatus === "inactive") return !(conn.isActive ?? true);
      return true;
    });

    const perConnection = await mapWithConcurrency(
      targets,
      MAX_CONCURRENCY,
      (conn) => fetchConnectionQuotas(conn, quotaVisibility, force),
    );

    let used = 0;
    let total = 0;
    let countedConnections = 0;
    let errorCount = 0;
    for (const row of perConnection) {
      if (!row) {
        errorCount += 1;
        continue;
      }
      used += row.used;
      total += row.total;
      countedConnections += 1;
    }

    const remaining = Math.max(0, total - used);
    const payload = {
      provider,
      accountStatus,
      connectionCount: targets.length,
      countedConnections,
      errorCount,
      available: countedConnections > 0 && total > 0,
      used,
      total,
      remaining,
      remainingPercentage:
        total > 0
          ? Math.round(Math.max(0, Math.min(100, (remaining / total) * 100)))
          : 0,
    };

    g.entries.set(cacheKey, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (error) {
    console.error("[API] Failed to compute usage summary:", error);
    return NextResponse.json(
      { error: "Failed to compute usage summary" },
      { status: 500 },
    );
  }
}
