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
 *     deferSubmit: true,  // recommended — see below
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
 *
 * **deferSubmit (recommended)**: when true, the route inserts the
 * generations row synchronously (~50ms), kicks off the slow
 * provider.submit() in `next/server` `after()`, and returns the
 * generation_id immediately. Without it, the client waits 5-15s for
 * Wavespeed/Fal to acknowledge the POST before the loading page can
 * render. With it, the client navigates to the result page in <500ms
 * and watches the row transition from "queued" → "processing"
 * → "completed" via the status endpoint.
 *
 * Cost: client may briefly see a row with no provider_task_id yet
 * (status="processing"). The status endpoint handles that case
 * gracefully — returns "processing" without error.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import {
  insertGenerationRow,
  startGeneration,
  submitGenerationToProvider,
} from "../generate";
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
  /**
   * If true, insert the row synchronously then run provider.submit() in
   * `after()` and return generation_id immediately (~500ms total).
   * Recommended — drops 5-15s of perceived wait on the client. Default
   * false to preserve existing behavior for apps that depend on
   * provider.submit completing before the response.
   */
  deferSubmit?: boolean;
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

    const sb = opts.getSupabase();
    const enginePayload = {
      sb,
      imageUrl: input.imageUrl,
      prompt: input.prompt,
      provider,
      fallbackProviders: input.fallbackProviders,
      size: input.size,
      kind: input.kind,
      metadata: input.metadata,
    };

    // Deferred path: insert row, kick off submit in after(), return now.
    if (opts.deferSubmit) {
      let id: string;
      try {
        id = await insertGenerationRow(enginePayload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[commongenerator] /generate insert failed", err);
        return jsonResponse(
          { error: "Failed to record generation", detail: message },
          500,
        );
      }
      // Provider.submit may take 5-15s. Run it after the response is sent.
      // Errors mark the row as failed via submitGenerationToProvider's
      // own error handling — the client sees them via /api/status.
      after(async () => {
        try {
          await submitGenerationToProvider({ ...enginePayload, id });
        } catch (err) {
          console.error(
            `[commongenerator] deferred submit failed for ${id}`,
            err,
          );
        }
      });
      return jsonResponse({ generation_id: id });
    }

    // Synchronous path: existing behavior.
    try {
      const { generationId } = await startGeneration(enginePayload);
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
