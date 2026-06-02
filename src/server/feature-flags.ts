/**
 * Feature flag subsystem (P8-07).
 *
 * v0.3 minimal: env-var based only. Operators set
 * OMNI_FEATURE_<NAME>=1 to enable, anything else (unset, "0", "false",
 * "no") means disabled. Boolean only — no rollouts, no user-targeting.
 *
 * Usage:
 *   import { isFeatureEnabled } from "./feature-flags.js";
 *   if (isFeatureEnabled("new_command_shape")) { ... }
 *
 * v0.4+ deferred features:
 * - Per-user / per-tenant flag evaluation
 * - Runtime toggling via /api/admin/features (with auth)
 * - Flag evaluation metrics
 * - Default-on / default-off / kill-switch semantics
 *
 * Convention: flag names are lowercase_snake_case. They map to env
 * vars as OMNI_FEATURE_<UPPERCASE_NAME>.
 */

const cache = new Map<string, boolean>();

function flagEnvName(flag: string): string {
  return `OMNI_FEATURE_${flag.toUpperCase()}`;
}

function envValue(envName: string): string | undefined {
  if (cache.has(envName)) {
    // already normalized
    return cache.get(envName) ? "1" : "0";
  }
  return process.env[envName];
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes" || v.toLowerCase() === "on";
}

/**
 * Check whether a feature flag is enabled. The first lookup for a given
 * flag reads from the environment and caches the result, so repeated
 * calls are O(1).
 */
export function isFeatureEnabled(flag: string): boolean {
  if (cache.has(flag)) {
    return cache.get(flag)!;
  }
  const v = isTruthy(process.env[flagEnvName(flag)]);
  cache.set(flag, v);
  return v;
}

/**
 * Force-set a feature flag at runtime. Useful for tests and the
 * future admin endpoint. Bypasses env.
 */
export function setFeatureEnabled(flag: string, enabled: boolean): void {
  cache.set(flag, enabled);
}

/**
 * Clear the cache. Re-reads env on next isFeatureEnabled call.
 * Useful when env is mutated (rare).
 */
export function resetFeatureFlags(): void {
  cache.clear();
}

/**
 * List all known flags. For v0.3 we don't have a registry, so this
 * scans process.env for OMNI_FEATURE_* keys.
 */
export function listFeatureFlags(): Array<{ name: string; enabled: boolean; envVar: string }> {
  const seen = new Set<string>();
  // Add cached
  for (const k of cache.keys()) seen.add(k);
  // Add from env
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("OMNI_FEATURE_")) {
      const flag = k.slice("OMNI_FEATURE_".length).toLowerCase();
      seen.add(flag);
    }
  }
  return Array.from(seen).sort().map((flag) => ({
    enabled: isFeatureEnabled(flag),
    envVar: flagEnvName(flag),
    name: flag,
  }));
}
