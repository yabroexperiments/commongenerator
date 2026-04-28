/**
 * Factory for a Next.js GET /api/status/[id] route handler.
 *
 * Usage in a consuming app (src/app/api/status/[id]/route.ts):
 *
 *   import { createStatusRoute } from "commongenerator/routes";
 *   import { getServerSupabase } from "@/lib/supabase";
 *
 *   export const runtime = "nodejs";
 *   export const GET = createStatusRoute({
 *     getSupabase: () => getServerSupabase(),
 *     archive: { bucket: "results" }, // optional
 *   });
 *
 * The client polls this endpoint every 2-3s. Returns:
 *   { status, image_url, error, original_image_url, prompt, metadata }
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getGenerationStatus } from "../generate";

export type CreateStatusRouteOpts = {
  getSupabase: () => SupabaseClient;
  /** Optional: archive provider URLs into Supabase Storage on
   *  completion. Recommended — provider CDN URLs can expire. */
  archive?: { bucket: string };
};

export function createStatusRoute(opts: CreateStatusRouteOpts) {
  return async function GET(
    _request: Request,
    ctx: { params: Promise<{ id: string }> },
  ): Promise<Response> {
    const { id } = await ctx.params;

    try {
      const sb = opts.getSupabase();
      const result = await getGenerationStatus({
        sb,
        id,
        archive: opts.archive,
      });
      return new Response(
        JSON.stringify({
          status: result.status,
          image_url: result.imageUrl,
          error: result.error,
          original_image_url: result.originalImageUrl,
          prompt: result.prompt,
          metadata: result.metadata,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 404 if the generation doesn't exist; 500 otherwise
      const status = /not found/i.test(message) ? 404 : 500;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
