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
 *     postCompletion: async ({ sb, id, imageUrl, metadata }) => {
 *       // Run after the image is delivered to the client. Fire-and-
 *       // forget; doesn't block the response. Common uses:
 *       // - Vision-extract data from the rendered image
 *       // - Send delivery emails
 *       // - Update analytics counters
 *     },
 *   });
 *
 * The client polls this endpoint every 2-3s. Returns:
 *   { status, image_url, error, original_image_url, prompt, metadata }
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { after } from "next/server";
import { getGenerationStatus } from "../generate";

export type PostCompletionContext = {
  sb: SupabaseClient;
  id: string;
  imageUrl: string;
  metadata: Record<string, unknown> | null;
};

export type CreateStatusRouteOpts = {
  getSupabase: () => SupabaseClient;
  /** Optional: archive provider URLs into Supabase Storage on
   *  completion. Recommended — provider CDN URLs can expire. */
  archive?: { bucket: string };
  /** Optional: one-time hook fired the FIRST time a row transitions
   *  from processing → completed. Runs in next/server `after()` so it
   *  doesn't block the client-facing response. Use for vision data
   *  extraction, delivery emails, analytics — anything that should
   *  happen "after the user has seen the result". */
  postCompletion?: (ctx: PostCompletionContext) => Promise<void> | void;
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

      // Fire post-completion hook on the FIRST transition only.
      // The justCompleted flag is set by getGenerationStatus when this
      // call was the one that flipped the row from processing → completed.
      if (
        opts.postCompletion &&
        result.justCompleted &&
        result.imageUrl
      ) {
        const hook = opts.postCompletion;
        const imageUrl = result.imageUrl;
        const metadata = result.metadata;
        after(async () => {
          try {
            await hook({ sb, id, imageUrl, metadata });
          } catch (err) {
            console.error(
              `[commongenerator] postCompletion hook failed for ${id}`,
              err,
            );
          }
        });
      }

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
      const status = /not found/i.test(message) ? 404 : 500;
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
