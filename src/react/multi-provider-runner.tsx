"use client";

/**
 * <MultiProviderRunner /> — admin testbench primitive.
 *
 * Submits the same generation request to N providers in parallel,
 * polls each independently, renders side-by-side result panels with
 * elapsed timers, and (optionally) wires a "Save prompt" button on
 * each successful result.
 *
 * The app owns:
 *   - The form for editing prompts / variables / styles (whatever its
 *     project schema needs)
 *   - The `buildBody` callback that turns "this provider" into the
 *     POST request body for /api/generate
 *   - The `onSave` callback that persists the saved prompt
 *
 * The engine owns:
 *   - The submit-N-in-parallel logic
 *   - Polling + status tracking
 *   - Result panel layout, loading states, error display, timers
 *   - Provider/family labels
 *
 * Recommended pattern for the app's `onSave` callback: persist by
 * **model family** (gpt-image-2 / nano-banana) rather than by
 * specific provider name — same model behaves the same across
 * gateways. Use `getModelFamily(provider)` to bucket.
 *
 * Usage (from gogo-gallery's /admin/test, conceptually):
 *
 *   <MultiProviderRunner
 *     providers={["wavespeed-gpt-image-2", "wavespeed-nano-banana-pro"]}
 *     buildBody={(provider) => ({
 *       upload_url: imageUrl,
 *       style: selectedStyle,
 *       provider,
 *       prompt_override: promptForFamily(getModelFamily(provider)),
 *     })}
 *     onSave={async (provider) => {
 *       const family = getModelFamily(provider);
 *       await fetch("/api/admin/save-prompt", {
 *         method: "POST",
 *         body: JSON.stringify({
 *           style: selectedStyle,
 *           family,
 *           prompt_text: promptForFamily(family),
 *         }),
 *       });
 *     }}
 *   />
 */

import { useEffect, useRef, useState } from "react";
import { getModelFamily, type ModelFamily } from "../model-families";
import type { ProviderName } from "../types";
import { useGenerationStatus } from "./use-generation-status";

export type MultiProviderRunnerProps = {
  /** Providers to test in parallel. 1-4 recommended for UX. */
  providers: ProviderName[];
  /** Returns the request body for a given provider. App owns the
   *  shape — gogo-gallery sends {upload_url, style, provider,
   *  prompt_override}; DogRating might send different fields. */
  buildBody: (provider: ProviderName) => Record<string, unknown>;
  /** POST endpoint. Default "/api/generate". */
  endpoint?: string;
  /** Optional save handler. If provided, each successful result panel
   *  shows a "Save prompt" button that calls this with the provider.
   *  App's handler reads its own form state to know what to save. */
  onSave?: (provider: ProviderName) => Promise<void> | void;
  /** Optional render-prop for arbitrary actions per result panel. */
  resultActions?: (ctx: {
    provider: ProviderName;
    resultUrl: string;
  }) => React.ReactNode;
  /** Polling interval. Default 2000ms (snappier than the default 2.5s
   *  for testbench UX). */
  pollIntervalMs?: number;
  /** Optional: precheck before running (e.g. validate that a photo
   *  has been uploaded). Return false / throw to abort. */
  onBeforeRun?: () => boolean | Promise<boolean>;
  /** Optional className on the outer wrapper (for Tailwind etc.). */
  className?: string;
};

export function MultiProviderRunner(props: MultiProviderRunnerProps) {
  const {
    providers,
    buildBody,
    endpoint = "/api/generate",
    onSave,
    resultActions,
    pollIntervalMs = 2000,
    onBeforeRun,
    className = "",
  } = props;

  const [genIds, setGenIds] = useState<Partial<Record<ProviderName, string>>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAll() {
    setError(null);
    if (onBeforeRun) {
      try {
        const ok = await onBeforeRun();
        if (!ok) return;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setSubmitting(true);
    setGenIds({});

    try {
      const submissions = providers.map(async (provider) => {
        const body = buildBody(provider);
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            json.error ?? json.detail ?? `${provider} HTTP ${res.status}`,
          );
        }
        return [provider, json.generation_id as string] as const;
      });
      const results = await Promise.all(submissions);
      const idsMap: Partial<Record<ProviderName, string>> = {};
      for (const [p, id] of results) idsMap[p] = id;
      setGenIds(idsMap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={className}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button
          type="button"
          onClick={runAll}
          disabled={submitting}
          style={{
            padding: "10px 20px",
            borderRadius: 8,
            background: submitting ? "#9ca3af" : "#111827",
            color: "white",
            fontWeight: 600,
            cursor: submitting ? "wait" : "pointer",
            border: "none",
          }}
        >
          {submitting
            ? "Submitting…"
            : `Run all (${providers.length} ${providers.length === 1 ? "provider" : "providers"})`}
        </button>
        {error && (
          <span style={{ color: "#dc2626", fontSize: 14 }}>⚠️ {error}</span>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(providers.length, 4)}, minmax(0, 1fr))`,
          gap: 16,
        }}
      >
        {providers.map((p) => (
          <ResultPanel
            key={p}
            provider={p}
            genId={genIds[p] ?? null}
            pollIntervalMs={pollIntervalMs}
            onSave={onSave}
            resultActions={resultActions}
          />
        ))}
      </div>
    </div>
  );
}

/* ───────── Result panel ───────── */

type ResultPanelProps = {
  provider: ProviderName;
  genId: string | null;
  pollIntervalMs: number;
  onSave?: (provider: ProviderName) => Promise<void> | void;
  resultActions?: (ctx: {
    provider: ProviderName;
    resultUrl: string;
  }) => React.ReactNode;
};

function ResultPanel({
  provider,
  genId,
  pollIntervalMs,
  onSave,
  resultActions,
}: ResultPanelProps) {
  const family: ModelFamily = getModelFamily(provider);
  const status = useGenerationStatus(genId, { intervalMs: pollIntervalMs });

  // Track elapsed time from the moment a genId is set until terminal.
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number>(0);
  useEffect(() => {
    if (!genId) {
      setElapsed(0);
      return;
    }
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();
    if (status.status === "completed" || status.status === "failed") return;
    const i = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
    return () => clearInterval(i);
  }, [genId, status.status]);

  // Reset start tracker when genId clears (between runs)
  useEffect(() => {
    if (!genId) startedAtRef.current = 0;
  }, [genId]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        overflow: "hidden",
        background: "white",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          background: "#f9fafb",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>
          {provider}
        </div>
        <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
          family: {family}
        </div>
      </div>

      <div
        style={{
          aspectRatio: "1 / 1",
          background: "#f3f4f6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#9ca3af",
          fontSize: 13,
          textAlign: "center",
          padding: 16,
        }}
      >
        {!genId && <span>Idle — click "Run all" to start</span>}
        {genId && status.status === "processing" && (
          <span>
            Generating… <strong>{elapsed}s</strong>
          </span>
        )}
        {genId && status.status === "failed" && (
          <span style={{ color: "#dc2626" }}>
            Failed: {status.error ?? "unknown"}
          </span>
        )}
        {genId && status.status === "completed" && status.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={status.imageUrl}
            alt={`${provider} result`}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        )}
      </div>

      {genId && status.status === "completed" && (
        <div
          style={{
            padding: "10px 12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            borderTop: "1px solid #e5e7eb",
          }}
        >
          <span style={{ fontSize: 11, color: "#6b7280" }}>
            ⏱ {elapsed}s
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {resultActions && status.imageUrl && (
              <>{resultActions({ provider, resultUrl: status.imageUrl })}</>
            )}
            {onSave && (
              <button
                type="button"
                disabled={saving || saved}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await onSave(provider);
                    setSaved(true);
                  } finally {
                    setSaving(false);
                  }
                }}
                style={{
                  padding: "6px 12px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #e5e7eb",
                  background: saved ? "#dcfce7" : "white",
                  color: saved ? "#166534" : "#111827",
                  cursor: saving || saved ? "default" : "pointer",
                  fontWeight: 500,
                }}
              >
                {saved
                  ? "Saved ✓"
                  : saving
                    ? "Saving…"
                    : `Save for ${family}`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
