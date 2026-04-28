/**
 * Image-generation provider abstraction.
 *
 * Each provider turns a (imageUrl, prompt) into a final imageUrl. They
 * differ in how the work happens — sync API, async queue with task ID,
 * background continuation, etc. — but all expose the same submit/poll
 * pair so the engine treats them uniformly.
 *
 * To add a new provider: implement ImageProvider, register it in
 * REGISTRY below, add its name to ProviderName in ../types.ts.
 */

import type { ProviderName } from "../types";

export type SubmitOpts = {
  imageUrl: string;
  prompt: string;
  /** Optional output size hint. Each provider normalizes to its own
   *  preferred format (Wavespeed: "1024*1024", Fal: preset enum). */
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

import { wavespeedProvider } from "./wavespeed";
import { openaiProvider } from "./openai-fal";

const REGISTRY: Record<ProviderName, ImageProvider> = {
  wavespeed: wavespeedProvider,
  openai: openaiProvider,
};

export function getProvider(name: ProviderName): ImageProvider {
  const p = REGISTRY[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}

export const ALL_PROVIDERS: ProviderName[] = ["wavespeed", "openai"];

export function isValidProvider(name: string): name is ProviderName {
  return (ALL_PROVIDERS as string[]).includes(name);
}
