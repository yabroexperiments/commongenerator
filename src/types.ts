/**
 * Shared types — re-exported from src/index.ts.
 */

export type ProviderName =
  | "wavespeed-gpt-image-2"
  | "wavespeed-nano-banana-pro"
  | "wavespeed-nano-banana-fast"
  | "fal-gpt-image-2"
  | "openai-gpt-image-2";

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
  /** Anonymous cookie UUID of the visitor who triggered this gen.
   *  Set by createRateLimit; null when the route doesn't rate-limit. */
  user_id: string | null;
  /** Normalized email when the visitor entered one to unlock the
   *  email-tier quota. NULL until they bypass. Counted alongside
   *  user_id in subsequent rate-limit checks. */
  user_email: string | null;
};

/** Input to startGeneration. */
export type StartGenerationInput = {
  imageUrl: string;
  /** Optional extra reference images. Forwarded to providers that
   *  support multi-image input (currently openai-gpt-image-2 via
   *  /v1/images/edits `image[]` repeated form fields, up to 16). The
   *  engine persists these in `metadata.additional_image_urls` on the
   *  generations row so post-completion hooks can still see them.
   *  Cap: keep total images ≤ 5 to stay within reasonable upstream
   *  payload limits. */
  additionalImageUrls?: string[];
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
  /** Quality tier. See SubmitOpts.quality for per-provider defaults. */
  quality?: "low" | "medium" | "high";
  /** Free-form tag for the generation. App-specific. */
  kind?: string;
  /** Free-form jsonb the app wants stored alongside the row. */
  metadata?: Record<string, unknown>;
  /** Anonymous cookie UUID for rate-limit attribution. Usually set by
   *  the route factory after a successful createRateLimit check; apps
   *  that bypass the route factory can pass it directly. */
  userId?: string;
  /** Normalized email when the visitor has bypassed the free tier
   *  quota. Same source as userId. */
  userEmail?: string | null;
  /** When false, the openai-gpt-image-2 provider does NOT rewrite
   *  Cloudinary source URLs with the `f_jpg,q_auto,c_limit,w_2048`
   *  transform. Set false when you pass private / already-signed
   *  (authenticated) Cloudinary URLs, or non-Cloudinary signed URLs
   *  (e.g. a private Supabase bucket) whose signature an appended
   *  transform would break. Default (undefined / true) keeps the
   *  current rewrite behavior — safe because consumers already
   *  compress client-side to sRGB JPEG, so the transform is
   *  vestigial. Only the openai provider reads this; gateways ignore. */
  rewriteCloudinarySource?: boolean;
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
  /** Anonymous cookie UUID of the visitor who created this generation
   *  (mirrors GenerationRow.user_id). Surfaced so an HTTP layer can
   *  decide ownership — e.g. createStatusRoute's ownerGate compares it
   *  to the caller's rate-limit cookie before returning the source
   *  photo / prompt / metadata. Null when the row was created without
   *  rate-limit attribution. */
  userId?: string | null;
};
