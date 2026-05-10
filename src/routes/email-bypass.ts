/**
 * Factory for a Next.js POST /api/email-bypass route handler.
 *
 * Companion to createRateLimit. When a user hits their free-tier
 * cap, the frontend prompts for an email; the email is POSTed here
 * to bind it to their cookie UUID and unlock the email-tier quota.
 *
 * Usage:
 *   import { createEmailBypassRoute } from "commongenerator/routes";
 *   import { getServerSupabase } from "@/lib/supabase";
 *
 *   export const runtime = "nodejs";
 *   export const POST = createEmailBypassRoute({
 *     getSupabase: () => getServerSupabase(),
 *     cookieName: "dograting_uid",
 *   });
 *
 * Request body: { email: string }
 * Response: 200 { ok: true } | 4xx { error: string }
 *
 * v1 does NOT verify the email (no magic link). The user types it,
 * we trust it. They can fake it, but they pay the friction cost of
 * remembering a different fake email per session — adequate for
 * casual abuse defense. Add magic-link verification in v2 if needed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getCookie, isValidEmail, normalizeEmail } from "../rate-limit";

export type CreateEmailBypassRouteOpts = {
  getSupabase: () => SupabaseClient;
  /** Same cookie name passed to createRateLimit (e.g. "dograting_uid"). */
  cookieName: string;
};

export function createEmailBypassRoute(opts: CreateEmailBypassRouteOpts) {
  return async function POST(request: Request): Promise<Response> {
    const userId = getCookie(request, opts.cookieName);
    if (!userId) {
      return jsonResponse(
        {
          error: "no_session",
          detail:
            "No anonymous session cookie. Hit /api/generate at least once first to receive one.",
        },
        400,
      );
    }

    let body: { email?: unknown };
    try {
      body = (await request.json()) as { email?: unknown };
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!isValidEmail(email)) {
      return jsonResponse({ error: "invalid_email" }, 400);
    }

    const normalized = normalizeEmail(email);
    const sb = opts.getSupabase();

    // Upsert by user_id so re-submitting the form (e.g. user changes
    // their mind on an email) updates rather than duplicating.
    const { error } = await sb
      .from("user_emails")
      .upsert(
        {
          user_id: userId,
          email,
          email_normalized: normalized,
        },
        { onConflict: "user_id" },
      );

    if (error) {
      console.error("[commongenerator] email-bypass upsert failed", error);
      return jsonResponse(
        { error: "save_failed", detail: error.message },
        500,
      );
    }

    return jsonResponse({ ok: true });
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
