/**
 * Factory for a Next.js POST /api/generate route handler.
 *
 * Usage in a consuming app (src/app/api/generate/route.ts):
 *
 *   import { createGenerateRoute } from "commongenerator/routes";
 *   import { getServerSupabase } from "@/lib/supabase";
 *
 *   export const runtime = "nodejs";
 *   export const POST = createGenerateRoute({
 *     getSupabase: () => getServerSupabase(),
 *     // optional: rewrite/validate the inputs before they hit the engine
 *     buildPrompt: async ({ body }) => ({
 *       imageUrl: body.upload_url,
 *       prompt: lookupPromptFor(body.style),
 *       provider: body.provider,
 *       kind: body.style,
 *       metadata: { style: body.style },
 *     }),
 *   });
 *
 * The handler returns `{ generation_id }` on success.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { startGeneration } from "../generate";
import { isValidProvider } from "../providers";
import type { ProviderName, StartGenerationInput } from "../types";

export type CreateGenerateRouteOpts = {
  /** Server-side Supabase client factory (uses service-role key). */
  getSupabase: () => SupabaseClient;
  /**
   * Map the raw POST body to engine inputs. Apps own prompt selection
   * and any pre-validation. Throw to short-circuit with a 400.
   *
   * Receives the parsed JSON body; should return a fully-resolved
   * StartGenerationInput (imageUrl + prompt + provider + kind + metadata).
   */
  buildPrompt: (ctx: {
    body: Record<string, unknown>;
    request: Request;
  }) => Promise<StartGenerationInput> | StartGenerationInput;
  /** Default provider if `buildPrompt` returns no provider field. */
  defaultProvider?: ProviderName;
};

export function createGenerateRoute(opts: CreateGenerateRouteOpts) {
  return async function POST(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    let input: StartGenerationInput;
    try {
      input = await opts.buildPrompt({ body, request });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, 400);
    }

    const provider = input.provider ?? opts.defaultProvider ?? "wavespeed-gpt-image-2";
    if (!isValidProvider(provider)) {
      return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);
    }

    try {
      const sb = opts.getSupabase();
      const { generationId } = await startGeneration({
        sb,
        imageUrl: input.imageUrl,
        prompt: input.prompt,
        provider,
        size: input.size,
        kind: input.kind,
        metadata: input.metadata,
      });
      return jsonResponse({ generation_id: generationId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[commongenerator] /generate failed", err);
      return jsonResponse(
        { error: "Image generation failed to start", detail: message },
        502,
      );
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
