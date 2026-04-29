/**
 * Single-secret admin auth via Next.js middleware.
 *
 * Use case: solo-founder admin pages (prompt playground, settings).
 * Not designed for multi-tenant or per-user RBAC.
 *
 * Mechanism:
 *   - User visits /admin/* → middleware checks for the cookie.
 *   - Cookie missing or wrong → redirect to /admin/login.
 *   - User submits the secret to /api/admin/login (createAdminLoginRoute).
 *   - That route sets an httpOnly cookie whose VALUE is the secret.
 *   - Subsequent /admin/* requests pass; future visits stay logged in
 *     for `maxAgeSeconds` (default 30 days).
 *
 * Tradeoff vs JWT/session-store: leaking the cookie = leaking the
 * secret. Acceptable for solo-founder admin pages where the alternative
 * is no auth at all. Cookie is httpOnly + SameSite=Lax + Secure in
 * production so it's not trivially stealable from the client.
 *
 * Consuming app's `src/middleware.ts`:
 *
 *   import { createAdminMiddleware } from "commongenerator/auth";
 *
 *   export const middleware = createAdminMiddleware({
 *     cookieName: "myapp_admin",  // unique per app to avoid collisions
 *   });
 *
 *   export const config = {
 *     matcher: ["/admin/:path*", "/api/admin/:path*"],
 *   };
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export type AdminMiddlewareConfig = {
  /** Env var holding the secret. Default "ADMIN_SECRET". */
  envVar?: string;
  /** Cookie name. Pick a unique-per-app value to avoid collisions when
   *  multiple apps share a domain (e.g. via Vercel's *.vercel.app).
   *  Default "admin_session". */
  cookieName?: string;
  /** Path of the login page. Default "/admin/login". */
  loginPath?: string;
  /** Paths that should be allowed through without auth, in addition to
   *  loginPath. Defaults to including /api/admin/login (the login
   *  endpoint must be reachable while logged-out). */
  allowPaths?: string[];
};

export function createAdminMiddleware(config: AdminMiddlewareConfig = {}) {
  const envVar = config.envVar ?? "ADMIN_SECRET";
  const cookieName = config.cookieName ?? "admin_session";
  const loginPath = config.loginPath ?? "/admin/login";
  const allowList = new Set([
    loginPath,
    "/api/admin/login",
    "/api/admin/logout",
    ...(config.allowPaths ?? []),
  ]);

  return function middleware(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;

    // Always-allow paths (login itself, logout, anything the app
    // explicitly exposes pre-auth)
    if (allowList.has(pathname)) {
      return NextResponse.next();
    }

    const expected = process.env[envVar];

    // Refuse to operate without a configured secret. Better to surface
    // a clear 503 than to silently allow or silently deny.
    if (!expected) {
      return new NextResponse(
        JSON.stringify({
          error: `${envVar} env var is not set on this deployment`,
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const token = request.cookies.get(cookieName)?.value;
    if (token === expected) {
      return NextResponse.next();
    }

    // Unauth'd. APIs get 401 (machines should handle JSON); pages
    // redirect to login with `from` so post-login can return them home.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const loginUrl = new URL(loginPath, request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  };
}
