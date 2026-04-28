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
 *   - wavespeed-gpt-image-2     (OpenAI gpt-image-2 via Wavespeed.ai)
 *   - wavespeed-nano-banana-pro (Google Nano Banana Pro via Wavespeed)
 *   - wavespeed-nano-banana-fast (faster/cheaper Nano Banana tier)
 *   - fal-gpt-image-2           (OpenAI gpt-image-2 via Fal.ai queue)
 *
 * To add a new provider: implement ImageProvider, register it in
 * REGISTRY below, add its name to ProviderName in ../types.ts.
 */

import type { ProviderName } from "../types";

export type SubmitOpts = {
  imageUrl: string;
  prompt: string;
  /** Optional output size hint. Each provider normalizes to its own
   *  preferred format (Wavespeed: "1024*1024" or aspect_ratio enum;
   *  Fal: preset enum). */
  size?: string;
};

export type PollResult =
  | { status: "processing" }
  | { status: "completed"; imageUrl: string }
  | { status: "failed"; error: string };

export interface ImageProvider {
  name: ProviderName;
  /** Submit and return a provider-specific task ID for later polling. */
  submit(opts: SubmitOpts): Promise<{ taskId: string }>;
  /** Poll the provider for current state. */
  pollResult(taskId: string): Promise<PollResult>;
}

import {
  wavespeedGptImage2,
  wavespeedNanoBananaPro,
  wavespeedNanoBananaFast,
} from "./wavespeed";
import { falGptImage2 } from "./fal";

const REGISTRY: Record<ProviderName, ImageProvider> = {
  "wavespeed-gpt-image-2": wavespeedGptImage2,
  "wavespeed-nano-banana-pro": wavespeedNanoBananaPro,
  "wavespeed-nano-banana-fast": wavespeedNanoBananaFast,
  "fal-gpt-image-2": falGptImage2,
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
];

export function isValidProvider(name: string): name is ProviderName {
  return (ALL_PROVIDERS as string[]).includes(name);
}
