// /api/usage/summary sums quota across every connection matching the provider
// and account-status filter (all pages), so the header total is accurate even
// when the page shows only a slice of the accounts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  getUsageForProvider: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_SUPPORTED_PROVIDERS: ["codebuddy-cn", "codebuddy-intl"],
  USAGE_APIKEY_PROVIDERS: [],
}));

function conn(id, { isActive = true, provider = "codebuddy-cn" } = {}) {
  return {
    id,
    provider,
    authType: "oauth",
    isActive,
    accessToken: `tok_${id}`,
    providerSpecificData: {},
  };
}

// One refill pack + one bonus pack, so the codebuddy parser keeps both.
function codebuddyUsage(monthlyUsed, monthlyTotal, bonusUsed, bonusTotal) {
  return {
    plan: "CodeBuddy CN",
    quotas: {
      Monthly: { used: monthlyUsed, total: monthlyTotal, recurring: true },
      "Bonus Pack 1": { used: bonusUsed, total: bonusTotal, recurring: false },
    },
  };
}

async function callSummary(query) {
  const { GET } = await import("../../src/app/api/usage/summary/route.js");
  const response = await GET(
    new Request(`http://localhost/api/usage/summary?${query}`),
  );
  return { response, body: await response.json() };
}

describe("/api/usage/summary", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // The route caches on a global that survives module reloads — reset it so
    // each test starts cold.
    global.__usageSummaryCache = { entries: new Map() };
    mocks.getSettings.mockResolvedValue({ quotaVisibility: {} });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.refreshAndUpdateCredentials.mockImplementation(async (c) => ({ connection: c }));
  });

  it("sums countable rows across every active connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn("c1"),
      conn("c2"),
      conn("c3", { isActive: false }), // excluded by accountStatus=active
    ]);
    mocks.getUsageForProvider.mockImplementation(async (c) => {
      if (c.id === "c1") return codebuddyUsage(100, 500, 0, 100); // used 100 / total 600
      if (c.id === "c2") return codebuddyUsage(200, 500, 0, 0); // bonus total 0 → skipped
      return codebuddyUsage(0, 0, 0, 0);
    });

    const { body } = await callSummary("provider=codebuddy-cn&accountStatus=active");

    expect(body.connectionCount).toBe(2);
    expect(body.countedConnections).toBe(2);
    expect(body.used).toBe(300); // 100 + 200
    expect(body.total).toBe(1100); // (500+100) + 500
    expect(body.remaining).toBe(800);
    expect(body.remainingPercentage).toBe(73); // round(800/1100*100)
    expect(body.available).toBe(true);
    // Inactive c3 must never be fetched.
    expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it("counts only inactive connections when accountStatus=inactive", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn("active1"),
      conn("off1", { isActive: false }),
      conn("off2", { isActive: false }),
    ]);
    mocks.getUsageForProvider.mockResolvedValue(codebuddyUsage(50, 100, 0, 0));

    const { body } = await callSummary("provider=codebuddy-cn&accountStatus=inactive");

    expect(body.connectionCount).toBe(2);
    expect(body.used).toBe(100); // 50 + 50
    expect(body.total).toBe(200);
  });

  it("skips connections whose usage returns a message and reports errorCount", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("ok"), conn("bad")]);
    mocks.getUsageForProvider.mockImplementation(async (c) => {
      if (c.id === "bad") return { message: "credential invalid or expired" };
      return codebuddyUsage(0, 100, 0, 0);
    });

    const { body } = await callSummary("provider=codebuddy-cn&accountStatus=all");

    expect(body.connectionCount).toBe(2);
    expect(body.countedConnections).toBe(1);
    expect(body.errorCount).toBe(1);
    expect(body.total).toBe(100);
  });

  it("caches the result until force=1", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("c1")]);
    mocks.getUsageForProvider.mockResolvedValue(codebuddyUsage(10, 100, 0, 0));

    await callSummary("provider=codebuddy-cn&accountStatus=all");
    await callSummary("provider=codebuddy-cn&accountStatus=all"); // served from cache

    expect(mocks.getProviderConnections).toHaveBeenCalledTimes(1);

    await callSummary("provider=codebuddy-cn&accountStatus=all&force=1");
    expect(mocks.getProviderConnections).toHaveBeenCalledTimes(2);
  });

  it("returns available:false when nothing countable matches", async () => {
    mocks.getProviderConnections.mockResolvedValue([conn("c1")]);
    mocks.getUsageForProvider.mockResolvedValue({ message: "no package found" });

    const { body } = await callSummary("provider=codebuddy-cn&accountStatus=all");

    expect(body.available).toBe(false);
    expect(body.total).toBe(0);
    expect(body.remainingPercentage).toBe(0);
  });
});
