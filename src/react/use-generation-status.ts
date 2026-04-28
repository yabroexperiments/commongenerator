"use client";

/**
 * React hook for polling /api/status/[id] until terminal.
 *
 * Usage:
 *
 *   const { status, imageUrl, error, originalImageUrl, metadata } =
 *     useGenerationStatus(generationId, { intervalMs: 2500 });
 *
 *   if (status === "completed") return <img src={imageUrl} />;
 *
 * Polls every `intervalMs` (default 2500). Stops on completed/failed.
 * Caller can override the endpoint path via `endpoint`; default is
 * `/api/status/${id}`.
 */

import { useEffect, useState } from "react";
import type { GenerationStatus } from "../types";

export type UseGenerationStatusOpts = {
  /** Override the polling endpoint. Default `/api/status/${id}`. */
  endpoint?: (id: string) => string;
  /** Polling interval in ms. Default 2500. */
  intervalMs?: number;
  /** Hard timeout — after this long, give up and surface an error.
   *  Default 300_000 (5 min). Set to 0 to disable. */
  timeoutMs?: number;
};

export type UseGenerationStatusResult = {
  status: GenerationStatus;
  imageUrl: string | null;
  error: string | null;
  originalImageUrl: string | null;
  metadata: Record<string, unknown> | null;
};

export function useGenerationStatus(
  id: string | null | undefined,
  opts: UseGenerationStatusOpts = {},
): UseGenerationStatusResult {
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const endpoint = opts.endpoint ?? ((rid: string) => `/api/status/${rid}`);

  const [status, setStatus] = useState<GenerationStatus>("processing");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    const startedAt = Date.now();

    async function tick() {
      if (cancelled) return;
      try {
        const res = await fetch(endpoint(id!), { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = await res.json();
        if (cancelled) return;

        if (json.original_image_url) setOriginalImageUrl(json.original_image_url);
        if (json.metadata) setMetadata(json.metadata);

        if (json.status === "completed") {
          setImageUrl(json.image_url ?? null);
          setStatus("completed");
          return;
        }
        if (json.status === "failed") {
          setError(json.error ?? "Generation failed");
          setStatus("failed");
          return;
        }
        // still processing — schedule next poll
        if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
          setError("Generation timed out");
          setStatus("failed");
          return;
        }
        setTimeout(tick, intervalMs);
      } catch (err) {
        if (cancelled) return;
        // Transient error — keep polling, but log
        console.warn("[commongenerator] status poll failed", err);
        setTimeout(tick, intervalMs);
      }
    }

    tick();

    return () => {
      cancelled = true;
    };
  }, [id, intervalMs, timeoutMs, endpoint]);

  return { status, imageUrl, error, originalImageUrl, metadata };
}
