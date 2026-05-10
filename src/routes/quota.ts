/**
 * Factory for a Next.js GET /api/quota route handler.
 *
 * Returns the visitor's current rate-limit state without consuming a
 * generation. Frontends use this to render an "X of N used today"
 * badge on the upload form so users know upfront how many free
 * generations they have left.
 *
 * Usage in a consuming app (src/app/api/quota/route.ts):
 *
 *   import { createQuotaRoute } from "commongenerator/routes";
 *   import { getServerSupabase } from "@/lib/supabase";
 *
 *   export const runtime = "nodejs";
 *   export const GET = createQuotaRoute({
 *     getSupabase: () => getServerSupabase(),
 *     // Same options you pass to createRateLimit on /api/generate.
 *     // Extracting these to a shared module is recommended so the
 *     // two stay in sync; see DogRating for the pattern.
 *     cookieName: "dograting_uid",
 *     freeLimitPerWindow: 3,
 *     emailBypassLimitPerWindow: 10,
 *     windowDays: 1,
 *     skipForAdminCookie: "dograting_admin",
 *   });
 *
 * Response (200):
 *   {
 *     used: 2,
 *     limit: 3,
 *     has_email: false,
 *     require_email: false,    // true if !has_email && used >= free limit
 *     is_admin: false,
 *     limit_unlimited: false   // true for admin (limit is Infinity)
 *   }
 *
 * Always sets the anonymous cookie if missing (same as /api/generate),
 * so calling /api/quota on first paint is enough to bind the
 * visitor's UUID before they ever hit /api/generate.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkQuota, type CreateRateLimitOpts } from "../rate-limit";

export type CreateQuotaRouteOpts = CreateRateLimitOpts & {
  getSupabase: () => SupabaseClient;
};

export function createQuotaRoute(opts: CreateQuotaRouteOpts) {
  return async function GET(request: Request): Promise<Response> {
    const sb = opts.getSupabase();
    const state = await checkQuota({ request, sb }, opts);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Quota is per-user — never cache.
      "Cache-Control": "no-store",
    };
    if (state.cookieHeader) headers["Set-Cookie"] = state.cookieHeader;

    const limitUnlimited = !Number.isFinite(state.limit);
    return new Response(
      JSON.stringify({
        used: state.used,
        // JSON can't serialize Infinity — emit -1 + the flag instead.
        limit: limitUnlimited ? -1 : state.limit,
        limit_unlimited: limitUnlimited,
        has_email: !!state.userEmail,
        require_email: state.requireEmail,
        is_admin: state.isAdmin,
      }),
      { status: 200, headers },
    );
  };
}
