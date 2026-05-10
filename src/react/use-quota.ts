/**
 * useQuota — React hook for fetching the visitor's current rate-limit
 * state, for "X of N used today" badges on upload pages.
 *
 * Pairs with createQuotaRoute on the server. Auto-fetches on mount;
 * exposes a `refresh()` for manual re-fetches (e.g. after a
 * generation completes or after the email-bypass succeeds and the
 * limit jumps).
 *
 * Typical usage:
 *
 *   const { used, limit, hasEmail, isAdmin, refresh } = useQuota();
 *   ...
 *   {!isAdmin && limit !== null && (
 *     <span>{used} / {limit} today</span>
 *   )}
 */

"use client";

import { useCallback, useEffect, useState } from "react";

export type QuotaSnapshot = {
  used: number;
  /** Number of generations allowed in the current window. -1 / null
   *  means unlimited (admin). */
  limit: number | null;
  hasEmail: boolean;
  requireEmail: boolean;
  isAdmin: boolean;
};

export type UseQuotaOpts = {
  /** Endpoint to GET. Default "/api/quota". */
  endpoint?: string;
  /** Optional polling interval in ms. Omit (default) for fetch-once-
   *  on-mount; the consuming app can also call refresh() manually. */
  refreshIntervalMs?: number;
};

export function useQuota(opts: UseQuotaOpts = {}) {
  const endpoint = opts.endpoint ?? "/api/quota";
  const refreshIntervalMs = opts.refreshIntervalMs;

  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        used: number;
        limit: number;
        limit_unlimited: boolean;
        has_email: boolean;
        require_email: boolean;
        is_admin: boolean;
      };
      setSnapshot({
        used: json.used,
        limit: json.limit_unlimited ? null : json.limit,
        hasEmail: json.has_email,
        requireEmail: json.require_email,
        isAdmin: json.is_admin,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    fetchOnce();
    if (!refreshIntervalMs) return;
    const t = setInterval(fetchOnce, refreshIntervalMs);
    return () => clearInterval(t);
  }, [fetchOnce, refreshIntervalMs]);

  return {
    used: snapshot?.used ?? 0,
    limit: snapshot?.limit ?? null,
    hasEmail: snapshot?.hasEmail ?? false,
    requireEmail: snapshot?.requireEmail ?? false,
    isAdmin: snapshot?.isAdmin ?? false,
    loading,
    error,
    refresh: fetchOnce,
  };
}
