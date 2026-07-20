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
import { getCookie } from "../rate-limit";

export type PostCompletionContext = {
  sb: SupabaseClient;
  id: string;
  imageUrl: string;
  metadata: Record<string, unknown> | null;
};

/** Owner-gate config for createStatusRoute. When provided, the route
 *  only returns the PRIVATE fields (the source photo `original_image_url`,
 *  the `prompt`, and the `metadata` blob — which typically carries user
 *  PII like pet name / notes / additional source URLs) to the visitor
 *  who created the generation, or an admin. Everyone else still gets the
 *  intentionally-shareable public fields (status, the result `image_url`,
 *  and `error`) but the private fields come back null.
 *
 *  This closes the IDOR where anyone holding a generation UUID (leaked via
 *  a share link, referrer, etc.) could pull the uploader's original photo
 *  and PII from the polling endpoint. It is OPT-IN: omit `ownerGate` and
 *  the route behaves exactly as before (returns everything). */
export type StatusOwnerGate = {
  /** Cookie name carrying the visitor's anonymous UUID — pass the SAME
   *  `cookieName` you gave createRateLimit. The route compares this
   *  cookie's value to the row's `user_id` to decide ownership. */
  cookieName: string;
  /** Optional admin bypass. If the request carries this cookie with a
   *  value equal to `secret`, the caller gets full access regardless of
   *  `user_id` — same shared-secret model as createAdminMiddleware. */
  adminCookie?: { name: string; secret: string };
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
  /** Optional: restrict the private fields (original_image_url / prompt /
   *  metadata) to the generation's owner or an admin. See StatusOwnerGate.
   *  Strongly recommended for any app that stores user photos or PII.
   *  Omit for backwards-compatible "return everything" behavior. */
  ownerGate?: StatusOwnerGate;
};

export function createStatusRoute(opts: CreateStatusRouteOpts) {
  return async function GET(
    request: Request,
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

      // Ownership gate: when configured, only the creating visitor (or an
      // admin) receives the private fields. Everyone else gets the public,
      // intentionally-shareable subset (status + result image_url + error).
      // Absent ownerGate → return everything (backwards compatible).
      let showPrivate = true;
      if (opts.ownerGate) {
        const viewerId = getCookie(request, opts.ownerGate.cookieName);
        const isAdmin =
          !!opts.ownerGate.adminCookie &&
          getCookie(request, opts.ownerGate.adminCookie.name) ===
            opts.ownerGate.adminCookie.secret;
        const isOwner =
          result.userId != null &&
          viewerId != null &&
          result.userId === viewerId;
        showPrivate = isAdmin || isOwner;
      }

      return new Response(
        JSON.stringify({
          status: result.status,
          image_url: result.imageUrl,
          error: result.error,
          original_image_url: showPrivate ? result.originalImageUrl : null,
          prompt: showPrivate ? result.prompt : null,
          metadata: showPrivate ? result.metadata : null,
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
