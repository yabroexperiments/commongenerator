/**
 * POST /api/admin/login route handler factory.
 *
 * Validates a submitted secret against the configured env var and
 * sets the auth cookie on success. Pair with createAdminMiddleware()
 * which checks for the same cookie on protected paths.
 *
 * Consuming app's `src/app/api/admin/login/route.ts`:
 *
 *   import { createAdminLoginRoute } from "commongenerator/auth";
 *
 *   export const runtime = "nodejs";
 *   export const POST = createAdminLoginRoute({
 *     cookieName: "myapp_admin",  // must match middleware
 *   });
 */

import { NextResponse } from "next/server";

export type AdminLoginRouteConfig = {
  envVar?: string;
  cookieName?: string;
  /** Cookie max-age in seconds. Default 30 days. */
  maxAgeSeconds?: number;
};

export function createAdminLoginRoute(config: AdminLoginRouteConfig = {}) {
  const envVar = config.envVar ?? "ADMIN_SECRET";
  const cookieName = config.cookieName ?? "admin_session";
  const maxAge = config.maxAgeSeconds ?? 60 * 60 * 24 * 30;

  return async function POST(req: Request): Promise<Response> {
    let body: { secret?: string };
    try {
      body = (await req.json()) as { secret?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const expected = process.env[envVar];
    if (!expected) {
      return NextResponse.json(
        { error: `${envVar} not set on this deployment` },
        { status: 503 },
      );
    }
    if (!body.secret || body.secret !== expected) {
      return NextResponse.json({ error: "Wrong secret" }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set({
      name: cookieName,
      value: expected,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge,
      path: "/",
    });
    return res;
  };
}

/** Companion factory for POST /api/admin/logout — clears the cookie. */
export function createAdminLogoutRoute(
  config: { cookieName?: string } = {},
) {
  const cookieName = config.cookieName ?? "admin_session";
  return async function POST(): Promise<Response> {
    const res = NextResponse.json({ ok: true });
    res.cookies.delete(cookieName);
    return res;
  };
}
