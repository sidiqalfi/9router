// In-memory cache of active filter rules for the hot-path sanitization engine.
// Mirrors etteum-pool's filter-cache pattern. The DB is read once (or on
// invalidation); the proxy path reads this synchronously per-request.
import { getActiveFilterRules } from "@/lib/db/index.js";

let cache = [];
let loaded = false;
let loadingPromise = null;

export async function loadFilterCache() {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      cache = await getActiveFilterRules();
      loaded = true;
    } catch (err) {
      console.warn("[filterRules] cache load failed:", err?.message || err);
      cache = [];
      loaded = false;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

// Synchronous read for the hot path. Triggers a background load if cold.
export function getFilterRulesCached() {
  if (!loaded && !loadingPromise) {
    loadFilterCache().catch(() => {});
  }
  return cache;
}

export function isFilterCacheLoaded() {
  return loaded;
}

// Drop the cache; a reload is triggered in the background so the next request
// sees fresh rules without blocking.
export function invalidateFilterCache() {
  loaded = false;
  cache = [];
  loadFilterCache().catch(() => {});
}
