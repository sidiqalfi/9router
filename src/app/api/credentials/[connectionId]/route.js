import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { checkAndRefreshToken } from "@/sse/services/tokenRefresh.js";

const CREDENTIAL_FIELDS = ["apiKey", "accessToken", "refreshToken", "idToken"];

/**
 * GET /api/credentials/[connectionId] - Export one connection's stored credentials.
 *
 * SECURITY: this endpoint intentionally returns raw provider credentials — the
 * only dashboard route that does. Every other providers API strips
 * apiKey/accessToken/refreshToken before responding. It is therefore listed in
 * ALWAYS_PROTECTED (src/dashboardGuard.js), which requires a dashboard JWT or
 * CLI token even when requireLogin=false (the default local mode that leaves
 * the rest of /api/* open).
 *
 * One connection per call (no bulk export). Responses are never cached and the
 * payload is never logged.
 */
export async function GET(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const payload = {
      connectionId: connection.id,
      provider: connection.provider,
      authType: connection.authType,
      name: connection.name || null,
      email: connection.email || null,
      expiresAt: connection.expiresAt || connection.tokenExpiresAt || null,
      tokenType: connection.tokenType || null,
      projectId: connection.projectId || null,
      lastRefreshAt: connection.lastRefreshAt || null,
      providerSpecificData: connection.providerSpecificData || null,
      exportedAt: new Date().toISOString(),
    };

    let hasCredential = false;
    for (const field of CREDENTIAL_FIELDS) {
      if (connection[field]) {
        payload[field] = connection[field];
        hasCredential = true;
      }
    }

    // Free no-auth connections store nothing — there is nothing to export.
    if (!hasCredential) {
      return NextResponse.json(
        { error: "No credentials stored for this connection" },
        { status: 404 }
      );
    }

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log("Error exporting connection credentials:", error);
    return NextResponse.json({ error: "Failed to export credentials" }, { status: 500 });
  }
}

/**
 * POST /api/credentials/[connectionId] - Force-refresh an OAuth connection's
 * token now (skips the proactive-refresh expiry check via options.force).
 *
 * Persistence happens inside checkAndRefreshToken (updateProviderCredentials),
 * so this handler never writes the DB itself. On failure the service returns
 * the original credentials unchanged — detected by comparing the mutable
 * fields — and the caller gets an honest 502 instead of a fake success.
 */
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    if (connection.authType !== "oauth" || !connection.refreshToken) {
      return NextResponse.json(
        { error: "Not an OAuth connection (or no refresh token) — nothing to refresh" },
        { status: 400 }
      );
    }

    const before = {
      accessToken: connection.accessToken,
      apiKey: connection.apiKey,
      expiresAt: connection.expiresAt,
      lastRefreshAt: connection.lastRefreshAt,
    };

    // force=true skips the expiry check. Provider refresh handlers may throw on
    // network errors — caught by the outer try below.
    const refreshed = await checkAndRefreshToken(connection.provider, connection, { force: true });

    const changed =
      refreshed.accessToken !== before.accessToken ||
      refreshed.apiKey !== before.apiKey ||
      String(refreshed.expiresAt || "") !== String(before.expiresAt || "") ||
      String(refreshed.lastRefreshAt || "") !== String(before.lastRefreshAt || "");

    if (!changed) {
      return NextResponse.json(
        { refreshed: false, error: "Refresh failed — re-authenticate this connection" },
        { status: 502 }
      );
    }

    return NextResponse.json({ refreshed: true, expiresAt: refreshed.expiresAt || null });
  } catch (error) {
    console.log("Error refreshing connection credentials:", error);
    return NextResponse.json(
      {
        refreshed: false,
        error: error?.message || "Refresh failed — re-authenticate this connection",
      },
      { status: 502 }
    );
  }
}

// Dashboard-only route; never cache
export const dynamic = "force-dynamic";

/**
 * Handle CORS preflight (mirror /api/models/playground)
 */
export async function OPTIONS() {
  return NextResponse.json({ ok: true });
}
