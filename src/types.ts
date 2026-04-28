/**
 * Shared types — re-exported from src/index.ts.
 */

export type ProviderName =
  | "wavespeed-gpt-image-2"
  | "wavespeed-nano-banana-pro"
  | "wavespeed-nano-banana-fast"
  | "fal-gpt-image-2";

export type GenerationStatus = "processing" | "completed" | "failed";

/** A single async image generation job, tracked in the `generations` table. */
export type GenerationRow = {
  id: string;
  /** Free-form opaque tag — e.g. "rating", "gallery-renaissance",
   *  "stickers-action-3". The engine never parses this; consuming
   *  apps use it for filtering / analytics. */
  kind: string | null;
  original_image_url: string;
  result_image_url: string | null;
  prompt: string;
  /** Reflects which provider actually accepted the job (after any
   *  fallback chain). Useful for analytics + retry-debugging. */
  provider: ProviderName;
  /** Provider task ID (Wavespeed prediction ID, Fal request ID, etc).
   *  Used by `getGenerationStatus` to poll the upstream provider. */
  provider_task_id: string | null;
  status: GenerationStatus;
  error_message: string | null;
  /** Free-form jsonb for app-specific data (dog name, score JSON,
   *  style key, etc.) — engine doesn't read it, just stores/returns. */
  metadata: Record<string, unknown> | null;
  created_at: string;
};

/** Input to startGeneration. */
export type StartGenerationInput = {
  imageUrl: string;
  prompt: string;
  /** Primary provider. Default "wavespeed-gpt-image-2". */
  provider?: ProviderName;
  /** Optional fallback chain. If the primary provider's submit fails
   *  with a transient error (network, 5xx, 429), the engine tries
   *  these in order. Hard 4xx (auth, malformed) skip the fallback
   *  and surface immediately — config errors aren't transient. Once
   *  a provider accepts the job, polling sticks with that provider. */
  fallbackProviders?: ProviderName[];
  /** "1024*1024" / "1024x1024" — providers normalize internally. */
  size?: string;
  /** Free-form tag for the generation. App-specific. */
  kind?: string;
  /** Free-form jsonb the app wants stored alongside the row. */
  metadata?: Record<string, unknown>;
};

/** Response from getGenerationStatus. */
export type GenerationStatusResponse = {
  status: GenerationStatus;
  imageUrl: string | null;
  error: string | null;
  /** The original input + metadata, returned for convenience so the
   *  result page can power "再來一張" without extra DB reads. */
  originalImageUrl: string;
  prompt: string;
  metadata: Record<string, unknown> | null;
  /** True if THIS call was the one that flipped the row from
   *  processing → completed. Use to fire one-time post-completion
   *  hooks (e.g. extract data from the result image, send a
   *  notification email). False if the row was already terminal. */
  justCompleted?: boolean;
};
