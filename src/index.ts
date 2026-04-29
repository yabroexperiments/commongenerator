/**
 * commongenerator — public API.
 *
 * Three primitives (plus the provider abstraction underneath them):
 *   - analyzeImage          (optional vision pre-step)
 *   - startGeneration       (kick off async image edit, returns ID)
 *   - getGenerationStatus   (poll for completion)
 *   - applyCloudinaryTransform  (post-processing utility)
 *
 * Next.js route factories live at `commongenerator/routes`.
 * React hook lives at `commongenerator/react`.
 */

export { analyzeImage } from "./analyze";
export type { AnalyzeImageOpts } from "./analyze";

export { renderPrompt } from "./render-prompt";
export type { PromptVars, RenderPromptOpts } from "./render-prompt";

export {
  getModelFamily,
  providersInFamily,
  PROVIDER_FAMILY,
} from "./model-families";
export type { ModelFamily } from "./model-families";

export { startGeneration, getGenerationStatus } from "./generate";
export type {
  StartGenerationOpts,
  StartGenerationResult,
  GetGenerationStatusOpts,
} from "./generate";

export {
  applyCloudinaryTransform,
  buildWatermarkTransform,
  BG_REMOVAL_TRANSFORM,
} from "./cloudinary";
export type { ApplyCloudinaryTransformOpts } from "./cloudinary";

export { getProvider, ALL_PROVIDERS, isValidProvider } from "./providers";
export type { ImageProvider, SubmitOpts, PollResult } from "./providers";

export type {
  ProviderName,
  GenerationStatus,
  GenerationRow,
  StartGenerationInput,
  GenerationStatusResponse,
} from "./types";
