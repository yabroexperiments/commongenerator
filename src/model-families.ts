/**
 * Model-family mapping.
 *
 * Multiple providers route to the same underlying model:
 *   - wavespeed-gpt-image-2  ─┐
 *   - fal-gpt-image-2        ─┴─→ family "gpt-image-2"
 *   - wavespeed-nano-banana-pro  ─┐
 *   - wavespeed-nano-banana-fast ─┴─→ family "nano-banana"
 *
 * Apps that store ONE prompt per model family (rather than per
 * specific provider) use `getModelFamily(p)` to bucket them. That's
 * the recommended pattern for prompt libraries: same prompt works
 * across all gateways for the same model.
 *
 * To add a new provider: register it in PROVIDER_FAMILY here, in
 * addition to types.ts and providers/index.ts.
 */

import type { ProviderName } from "./types";

export type ModelFamily =
  | "gpt-image-2"
  | "nano-banana"
  | "seedream"
  | "flux";

export const PROVIDER_FAMILY: Record<ProviderName, ModelFamily> = {
  "wavespeed-gpt-image-2": "gpt-image-2",
  "fal-gpt-image-2": "gpt-image-2",
  "wavespeed-nano-banana-pro": "nano-banana",
  "wavespeed-nano-banana-fast": "nano-banana",
};

export function getModelFamily(provider: ProviderName): ModelFamily {
  return PROVIDER_FAMILY[provider];
}

/** All providers belonging to a given family — useful for "show me
 *  every gateway routing to gpt-image-2" type lookups. */
export function providersInFamily(family: ModelFamily): ProviderName[] {
  return (Object.keys(PROVIDER_FAMILY) as ProviderName[]).filter(
    (p) => PROVIDER_FAMILY[p] === family,
  );
}
