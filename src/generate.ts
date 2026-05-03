/**
 * The two main engine functions:
 *   - startGeneration: insert a row, submit to provider (with optional
 *     fallback chain), return the row ID
 *   - getGenerationStatus: read the row; if still processing, poll the
 *     provider once and update the row; return the latest state
 *
 * Long-running image edits don't fit in a single Vercel function call
 * (Hobby is 60s, generations take 30-180s). So we split: start returns
 * fast with an ID; the client polls the status endpoint every 2-3s.
 *
 * Both functions take a SupabaseClient — credentials are 100% per-app.
 *
 * Two extra exports for advanced flow control:
 *   - insertGenerationRow: just the DB insert. Fast, <100ms.
 *   - submitGenerationToProvider: walks the fallback chain.
 *     Slow (provider POSTs typically 5-15s).
 *
 * These exist so `createGenerateRoute` can defer the slow submit to
 * Next.js `after()` while still returning the generation ID
 * immediately — see deferSubmit option there.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getGeneration,
  insertGeneration,
  setCompleted,
  setFailed,
  setProvider,
  setProviderTaskId,
} from "./db";
import { getProvider } from "./providers";
import type {
  GenerationStatusResponse,
  ProviderName,
  StartGenerationInput,
} from "./types";

export type StartGenerationOpts = StartGenerationInput & {
  sb: SupabaseClient;
  /** Pre-generated generation ID — if omitted, a UUID is created here.
   *  Useful when the app wants to know the ID before insert (e.g. to
   *  return it from /api/generate before awaiting Supabase). */
  id?: string;
};

export type StartGenerationResult = {
  generationId: string;
  /** Which provider in the chain actually accepted the job. Equal to
   *  `provider` (the primary) on the happy path; differs when fallback
   *  was used. */
  acceptedBy: ProviderName;
};

/* ─────────── Granular building blocks (advanced) ─────────── */

export type InsertGenerationRowOpts = StartGenerationInput & {
  sb: SupabaseClient;
  id?: string;
};

/** Insert the tracking row only — no provider call. Returns the row ID.
 *  Use when you want to return a generationId fast and run the slow
 *  provider.submit() asynchronously (e.g. inside Next.js `after()`). */
export async function insertGenerationRow(
  opts: InsertGenerationRowOpts,
): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const primary = opts.provider ?? "wavespeed-gpt-image-2";
  await insertGeneration(opts.sb, {
    id,
    kind: opts.kind,
    original_image_url: opts.imageUrl,
    prompt: opts.prompt,
    provider: primary,
    metadata: opts.metadata,
  });
  return id;
}

export type SubmitGenerationToProviderOpts = StartGenerationInput & {
  sb: SupabaseClient;
  id: string;
};

/** Walk the provider fallback chain on an EXISTING row. Updates the row
 *  with the provider task ID on success, or marks status=failed on
 *  total chain exhaustion. Designed to be called from inside `after()`
 *  by the route factory's deferSubmit path. */
export async function submitGenerationToProvider(
  opts: SubmitGenerationToProviderOpts,
): Promise<StartGenerationResult> {
  const primary = opts.provider ?? "wavespeed-gpt-image-2";
  const chain: ProviderName[] = [primary, ...(opts.fallbackProviders ?? [])];

  let lastError: Error | undefined;
  for (let i = 0; i < chain.length; i++) {
    const providerName = chain[i]!;
    const provider = getProvider(providerName);
    try {
      const { taskId } = await provider.submit({
        imageUrl: opts.imageUrl,
        prompt: opts.prompt,
        size: opts.size,
        quality: opts.quality,
      });
      if (providerName !== primary) {
        await setProvider(opts.sb, opts.id, providerName);
      }
      await setProviderTaskId(opts.sb, opts.id, taskId);
      return { generationId: opts.id, acceptedBy: providerName };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (isHardError(e)) break;
      console.warn(
        `[commongenerator] ${providerName} submit failed; trying fallback`,
        e.message,
      );
    }
  }

  const message = lastError?.message ?? "all providers failed without error";
  await setFailed(opts.sb, opts.id, message);
  throw new Error(`Provider chain exhausted: ${message}`);
}

/* ─────────── High-level convenience ─────────── */

export async function startGeneration(
  opts: StartGenerationOpts,
): Promise<StartGenerationResult> {
  const id = await insertGenerationRow(opts);
  return await submitGenerationToProvider({ ...opts, id });
}

/* ─────────── Helpers ─────────── */

/** Heuristic: is this error from a config / programmer mistake (don't
 *  retry/fallback) vs a transient infrastructure issue (do retry)? */
function isHardError(err: Error): boolean {
  const m = err.message;
  // 401, 403 → auth/permissions
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(m)) return true;
  // Missing API key thrown by getApiKey() — config error, no point retrying
  if (/is not set/i.test(m)) return true;
  // Other 4xx are hard except 408 + 429 which are retryable
  const codeMatch = m.match(/\b(4\d\d)\b/);
  if (codeMatch) {
    const code = parseInt(codeMatch[1]!, 10);
    if (code === 408 || code === 429) return false;
    if (code >= 400 && code < 500) return true;
  }
  return false;
}

export type GetGenerationStatusOpts = {
  sb: SupabaseClient;
  id: string;
  /** Optional: archive the upstream image to Supabase Storage on
   *  completion. Provider URLs (e.g. Wavespeed CDN) may expire; pass
   *  a bucket name and the engine will copy + return a Storage URL.
   *  If omitted, the upstream URL is returned as-is. */
  archive?: { bucket: string };
};

export async function getGenerationStatus(
  opts: GetGenerationStatusOpts,
): Promise<GenerationStatusResponse> {
  const row = await getGeneration(opts.sb, opts.id);
  if (!row) {
    throw new Error(`Generation not found: ${opts.id}`);
  }

  // Already terminal — just return what's persisted
  if (row.status === "completed" || row.status === "failed") {
    return {
      status: row.status,
      imageUrl: row.result_image_url,
      error: row.error_message,
      originalImageUrl: row.original_image_url,
      prompt: row.prompt,
      metadata: row.metadata,
    };
  }

  // No task ID yet — submit must still be in flight
  if (!row.provider_task_id) {
    return {
      status: "processing",
      imageUrl: null,
      error: null,
      originalImageUrl: row.original_image_url,
      prompt: row.prompt,
      metadata: row.metadata,
    };
  }

  // Poll the provider once
  const provider = getProvider(row.provider);
  let pollResult;
  try {
    pollResult = await provider.pollResult(row.provider_task_id);
  } catch (err) {
    // Transient — let the next poll try again
    console.error(`[commongenerator] ${row.provider} poll failed`, err);
    return {
      status: "processing",
      imageUrl: null,
      error: null,
      originalImageUrl: row.original_image_url,
      prompt: row.prompt,
      metadata: row.metadata,
    };
  }

  if (pollResult.status === "completed") {
    let imageUrl = pollResult.imageUrl;

    // Optionally archive to Supabase Storage so we own the asset
    if (opts.archive) {
      const archived = await archiveToStorage(
        opts.sb,
        opts.archive.bucket,
        `${opts.id}.png`,
        pollResult.imageUrl,
      );
      if (archived) imageUrl = archived;
    }

    await setCompleted(opts.sb, opts.id, imageUrl);
    return {
      status: "completed",
      imageUrl,
      error: null,
      originalImageUrl: row.original_image_url,
      prompt: row.prompt,
      metadata: row.metadata,
      // Row was processing when we started this call; we just flipped
      // it to completed. Caller can fire one-time post-completion hooks.
      justCompleted: true,
    };
  }

  if (pollResult.status === "failed") {
    await setFailed(opts.sb, opts.id, pollResult.error);
    return {
      status: "failed",
      imageUrl: null,
      error: pollResult.error,
      originalImageUrl: row.original_image_url,
      prompt: row.prompt,
      metadata: row.metadata,
    };
  }

  return {
    status: "processing",
    imageUrl: null,
    error: null,
    originalImageUrl: row.original_image_url,
    prompt: row.prompt,
    metadata: row.metadata,
  };
}

/** Copy a remote image URL to Supabase Storage. Returns the public URL,
 *  or null if archiving fails (caller falls back to the upstream URL). */
async function archiveToStorage(
  sb: SupabaseClient,
  bucket: string,
  path: string,
  upstreamUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(upstreamUrl);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buffer = await res.arrayBuffer();
    const { error } = await sb.storage.from(bucket).upload(path, buffer, {
      contentType: "image/png",
      upsert: true,
      cacheControl: "31536000",
    });
    if (error) throw error;
    const { data } = sb.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("[commongenerator] archive to storage failed", err);
    return null;
  }
}
