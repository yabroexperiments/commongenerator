/**
 * Image-generation provider abstraction.
 *
 * Each provider turns a (imageUrl, prompt) into a final imageUrl.
 * They differ in the underlying model + gateway, but all expose the
 * same submit/poll pair so the engine treats them uniformly.
 *
 * Naming convention: `{gateway}-{model}` so apps and ops can tell
 * exactly what's being used. Both gateway and model are visible in
 * the `generations.provider` column for analytics + retry-debugging.
 *
 * Available providers:
 *   - wavespeed-gpt-image-2      (OpenAI gpt-image-2 via Wavespeed.ai)
 *   - wavespeed-nano-banana-pro  (Google Nano Banana Pro via Wavespeed)
 *   - wavespeed-nano-banana-fast (faster/cheaper Nano Banana tier)
 *   - fal-gpt-image-2            (OpenAI gpt-image-2 via Fal.ai queue)
 *   - openai-gpt-image-2         (OpenAI gpt-image-2 direct, no gateway)
 *
 * To add a new provider: implement ImageProvider, register it in
 * REGISTRY below, add its name to ProviderName in ../types.ts.
 */

import type { ProviderName } from "../types";

export type SubmitOpts = {
  imageUrl: string;
  /** Optional extra reference images. Models that accept multiple
   *  inputs (notably OpenAI gpt-image-2 via /v1/images/edits with
   *  repeated `image[]` form fields, up to 16) use them as additional
   *  visual context. Providers that don't support multi-image silently
   *  ignore this field and use `imageUrl` alone. Cap: callers should
   *  keep total images ≤ 5 to stay within reasonable upstream limits. */
  additionalImageUrls?: string[];
  prompt: string;
  /** Optional output size hint. Each provider normalizes to its own
   *  preferred format (Wavespeed: "1024*1024" or aspect_ratio enum;
   *  Fal: preset enum; OpenAI direct: "1024x1024" / "1024x1536" /
   *  "1536x1024"). */
  size?: string;
  /** Quality tier. Big speed/cost lever — gpt-image-2 reports
   *  ~5-10s @ low, 15-30s @ medium, 40-90s @ high. Defaults differ
   *  per provider:
   *    - gpt-image-2 (Wavespeed + Fal + direct OpenAI): "medium"
   *    - nano-banana variants: "high" (already a fast tier by name)
   *  Admin/test pages should expose this so the operator can pick the
   *  speed/fidelity tradeoff that fits the product. */
  quality?: "low" | "medium" | "high";
  /** Optional row ID — passed by the engine. Used by synchronous
   *  providers (e.g. openai-gpt-image-2) that persist the result to
   *  Supabase Storage at a deterministic path so a downstream archive
   *  step doesn't create a duplicate. Async gateways ignore it. */
  generationId?: string;
  /** Background transparency hint. Only honored by openai-gpt-image-2
   *  today — passed as the `background` form field on
   *  /v1/images/edits. Values:
   *    - "transparent" — output PNG has a proper alpha channel.
   *                       Most reliable way to get see-through stickers.
   *    - "opaque"      — output is solid (default in most prompts).
   *    - "auto"        — model decides based on the prompt (OpenAI default).
   *  Other providers (wavespeed, fal, nano-banana) silently ignore;
   *  use prompt-side instructions for them. */
  background?: "transparent" | "opaque" | "auto";
  /** When false, openai-gpt-image-2 skips the Cloudinary source-URL
   *  rewrite (`f_jpg,q_auto,c_limit,w_2048`). Set false for private /
   *  already-signed Cloudinary or Supabase URLs whose signature an
   *  appended transform segment would invalidate. Default (undefined /
   *  true) keeps the rewrite. Threaded from StartGenerationInput; other
   *  providers ignore it. */
  rewriteCloudinarySource?: boolean;
};

export type PollResult =
  | { status: "processing" }
  | { status: "completed"; imageUrl: string }
  | { status: "failed"; error: string };

/** Token usage reported by the provider for one image-generation call.
 *  Currently populated only by openai-gpt-image-2 (the /v1/images/edits
 *  response carries a `usage` object). Other providers leave it
 *  undefined. Consumers use this to compute the real per-call cost
 *  from OpenAI's published per-token rates. */
export type SubmitUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    text_tokens?: number;
    image_tokens?: number;
  };
};

export type SubmitResult = {
  taskId: string;
  /** Present when the provider reports per-call token usage. */
  usage?: SubmitUsage;
};

export interface ImageProvider {
  name: ProviderName;
  /** Submit and return a provider-specific task ID for later polling. */
  submit(opts: SubmitOpts): Promise<SubmitResult>;
  /** Poll the provider for current state. */
  pollResult(taskId: string): Promise<PollResult>;
}

import {
  wavespeedGptImage2,
  wavespeedNanoBananaPro,
  wavespeedNanoBananaFast,
} from "./wavespeed";
import { falGptImage2 } from "./fal";
import { openaiGptImage2 } from "./openai";

const REGISTRY: Record<ProviderName, ImageProvider> = {
  "wavespeed-gpt-image-2": wavespeedGptImage2,
  "wavespeed-nano-banana-pro": wavespeedNanoBananaPro,
  "wavespeed-nano-banana-fast": wavespeedNanoBananaFast,
  "fal-gpt-image-2": falGptImage2,
  "openai-gpt-image-2": openaiGptImage2,
};

export function getProvider(name: ProviderName): ImageProvider {
  const p = REGISTRY[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

export const ALL_PROVIDERS: ProviderName[] = [
  "wavespeed-gpt-image-2",
  "wavespeed-nano-banana-pro",
  "wavespeed-nano-banana-fast",
  "fal-gpt-image-2",
  "openai-gpt-image-2",
];

/**
 * The canonical left-to-right order for the admin testbench compare
 * panels. Every consumer's <MultiProviderRunner /> should pass this
 * (or spread from it) so the side-by-side order stays consistent
 * across all 狗仔 sister apps (gogo-gallery, dograting, future ones).
 *
 * Order rationale (best → fast):
 *   1. openai-gpt-image-2         — best raw quality, "no proxy" reference
 *   2. wavespeed-nano-banana-pro  — best identity preservation, fast
 *   3. wavespeed-nano-banana-fast — speed/cost tier baseline
 *
 * Proxy duplicates of #1 (`fal-gpt-image-2`, `wavespeed-gpt-image-2`)
 * are intentionally NOT in the default — they're meant for production
 * fallback chains, not testbench head-to-head. Apps that want a 4-up
 * compare can spread them in:
 *   `[...DEFAULT_COMPARE_ORDER, "fal-gpt-image-2"]`
 */
export const DEFAULT_COMPARE_ORDER: ProviderName[] = [
  "openai-gpt-image-2",
  "wavespeed-nano-banana-pro",
  "wavespeed-nano-banana-fast",
];

export function isValidProvider(name: string): name is ProviderName {
  return (ALL_PROVIDERS as string[]).includes(name);
}
