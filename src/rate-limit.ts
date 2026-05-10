/**
 * Per-user rate limiting for createGenerateRoute.
 *
 * Identity model:
 *   - First visit: middleware/route issues an anonymous UUID cookie
 *     (httpOnly, 1 year). All subsequent generations bind to this ID.
 *   - User can optionally enter an email to unlock a higher quota.
 *     The email is bound to their cookie ID in `user_emails`. Future
 *     generations count by email so cookie-clearing within the same
 *     email doesn't reset the quota.
 *
 * Counting:
 *   - Has email → count `generations.user_email = email_normalized`.
 *   - No email → count `generations.user_id = cookie_uuid`.
 *   - Window: rolling N days from now (default 1).
 *
 * Bypass surface (documented honestly):
 *   - VPN alone: blocked (we don't use IP).
 *   - Incognito alone: bypasses (fresh cookie). Mitigated only by
 *     entering email — a determined attacker has to keep coming up
 *     with new fake emails. Pair with a Turnstile challenge for
 *     anti-automation defense.
 *   - Incognito + new email: bypasses (~1min friction per session).
 *     Accept this for free viral tools; layer phone OTP if abuse
 *     becomes real.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Outcome of a rate-limit check. */
export type RateLimitResult =
  | {
      ok: true;
      /** The cookie UUID (existing or newly issued). */
      userId: string;
      /** Normalized email if the user has bypassed via email. */
      userEmail: string | null;
      /** Set-Cookie header value to attach to the response, if a new
       *  cookie was issued this request. Undefined when the cookie
       *  was already present. */
      cookieHeader?: string;
    }
  | {
      ok: false;
      /** Human-readable reason to show the user. */
      reason: string;
      /** True if the user has not yet provided an email. The frontend
       *  uses this to decide whether to show the email prompt vs. the
       *  "come back tomorrow" message. */
      requireEmail: boolean;
      /** Effective limit that was hit (e.g. 3 or 10). */
      limit: number;
      /** Set-Cookie header value to attach (so even rejected requests
       *  bind a UUID to the visitor for future lookups). */
      cookieHeader?: string;
    };

export type RateLimitContext = {
  request: Request;
  sb: SupabaseClient;
};

export type RateLimitFn = (ctx: RateLimitContext) => Promise<RateLimitResult>;

export type CreateRateLimitOpts = {
  /** Cookie name for the anonymous UUID. Per-app (e.g. "dograting_uid"). */
  cookieName: string;
  /** Free quota for users without an email. Default 3. */
  freeLimitPerWindow?: number;
  /** Quota for users who have entered an email. Default 10. */
  emailBypassLimitPerWindow?: number;
  /** Window length in days. Default 1 (daily reset). */
  windowDays?: number;
  /** Cookie max-age (seconds). Default 31536000 = 1 year. */
  cookieMaxAgeSeconds?: number;
  /** Custom message when a user without an email hits the cap. */
  exceededMessageFree?: string;
  /** Custom message when a user with an email hits the email-tier cap. */
  exceededMessageEmail?: string;
  /** Optional: skip the rate limit when this admin cookie's value
   *  equals the ADMIN_SECRET env var. Use to keep /admin/test runs
   *  from counting against any quota. */
  skipForAdminCookie?: string;
};

const DEFAULT_FREE = 3;
const DEFAULT_EMAIL = 10;
const DEFAULT_WINDOW_DAYS = 1;
const DEFAULT_COOKIE_AGE_S = 60 * 60 * 24 * 365;
const DEFAULT_MSG_FREE =
  "Please enter your email to keep using";
const DEFAULT_MSG_EMAIL =
  "You've reached today's limit. Please come back tomorrow.";

/** Snapshot of a visitor's quota state. Used internally by
 *  createRateLimit and exposed via createQuotaRoute so frontends can
 *  render an "X of N used today" badge. */
export type QuotaState = {
  userId: string;
  userEmail: string | null;
  used: number;
  limit: number;
  /** Convenience flag: true when the user has not yet bypassed via
   *  email AND is at-or-over the free-tier cap (i.e. entering an
   *  email would unlock more). False once they've bypassed. */
  requireEmail: boolean;
  /** True if the visitor is using the admin bypass — quota count is
   *  not tracked, displayed as Infinity. Frontends typically hide
   *  the badge in this case. */
  isAdmin: boolean;
  /** Cookie header to attach to the response if a new UUID was minted. */
  cookieHeader?: string;
};

/** Read the visitor's quota state — issues a UUID cookie if missing,
 *  looks up email-bypass status, counts rows in the window. Pure
 *  read; no side effects beyond the cookie mint. Shared between
 *  createRateLimit (decides allow/deny) and createQuotaRoute (just
 *  returns the state to the frontend). */
export async function checkQuota(
  ctx: RateLimitContext,
  opts: CreateRateLimitOpts,
): Promise<QuotaState> {
  const free = opts.freeLimitPerWindow ?? DEFAULT_FREE;
  const bypass = opts.emailBypassLimitPerWindow ?? DEFAULT_EMAIL;
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cookieMaxAge = opts.cookieMaxAgeSeconds ?? DEFAULT_COOKIE_AGE_S;

  // Admin shortcut — still issues a UUID for attribution but doesn't count.
  if (opts.skipForAdminCookie) {
    const adminVal = getCookie(ctx.request, opts.skipForAdminCookie);
    const adminSecret = process.env.ADMIN_SECRET;
    if (adminVal && adminSecret && adminVal === adminSecret) {
      let userId = getCookie(ctx.request, opts.cookieName);
      let cookieHeader: string | undefined;
      if (!userId) {
        userId = crypto.randomUUID();
        cookieHeader = buildCookie(opts.cookieName, userId, cookieMaxAge);
      }
      return {
        userId,
        userEmail: null,
        used: 0,
        limit: Number.POSITIVE_INFINITY,
        requireEmail: false,
        isAdmin: true,
        cookieHeader,
      };
    }
  }

  // Read-or-mint the anonymous cookie UUID.
  let userId = getCookie(ctx.request, opts.cookieName);
  let cookieHeader: string | undefined;
  if (!userId) {
    userId = crypto.randomUUID();
    cookieHeader = buildCookie(opts.cookieName, userId, cookieMaxAge);
  }

  // Look up email-bypass status for this cookie.
  const { data: emailRow } = await ctx.sb
    .from("user_emails")
    .select("email_normalized")
    .eq("user_id", userId)
    .maybeSingle<{ email_normalized: string }>();
  const userEmail = emailRow?.email_normalized ?? null;
  const limit = userEmail ? bypass : free;

  // Count generations in window.
  const since = new Date(
    Date.now() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  let countQuery = ctx.sb
    .from("generations")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  if (userEmail) {
    countQuery = countQuery.eq("user_email", userEmail);
  } else {
    countQuery = countQuery.eq("user_id", userId);
  }
  const { count, error: countErr } = await countQuery;
  if (countErr) {
    // Fail-open: if we can't count, treat as 0 used. The rateLimit
    // wrapper will then allow the request rather than hard-blocking
    // on infra failures. Identity (userId, cookieHeader) still flows.
    console.error("[commongenerator] checkQuota count failed", countErr);
    return {
      userId,
      userEmail,
      used: 0,
      limit,
      requireEmail: false,
      isAdmin: false,
      cookieHeader,
    };
  }

  const used = count ?? 0;
  return {
    userId,
    userEmail,
    used,
    limit,
    requireEmail: !userEmail && used >= free,
    isAdmin: false,
    cookieHeader,
  };
}

export function createRateLimit(opts: CreateRateLimitOpts): RateLimitFn {
  const msgFree = opts.exceededMessageFree ?? DEFAULT_MSG_FREE;
  const msgEmail = opts.exceededMessageEmail ?? DEFAULT_MSG_EMAIL;

  return async function rateLimit(
    ctx: RateLimitContext,
  ): Promise<RateLimitResult> {
    const state = await checkQuota(ctx, opts);

    // Admin or under cap — allow.
    if (state.isAdmin || state.used < state.limit) {
      return {
        ok: true,
        userId: state.userId,
        userEmail: state.userEmail,
        cookieHeader: state.cookieHeader,
      };
    }

    return {
      ok: false,
      reason: state.userEmail ? msgEmail : msgFree,
      requireEmail: state.requireEmail,
      limit: state.limit,
      cookieHeader: state.cookieHeader,
    };
  };
}

/* ------------------------ Email helpers ------------------------ */

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  if (email.length > 254) return false;
  return EMAIL_RX.test(email.trim());
}

/** Normalize emails so common bypass patterns collapse to one canonical
 *  form. Drops case + trims; strips Gmail-style "+aliases"; for
 *  Gmail/Googlemail also strips dots in the local part since Gmail
 *  treats `foo.bar@gmail.com` and `foobar@gmail.com` as the same. */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const beforePlus = local.split("+")[0]!;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${beforePlus.replace(/\./g, "")}@gmail.com`;
  }
  return `${beforePlus}@${domain}`;
}

/* ------------------------ Cookie helpers ------------------------ */

/** Read a cookie value from a Request's Cookie header. Exported because
 *  consuming apps occasionally need it (e.g. /api/email-bypass route). */
export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Build a Set-Cookie header value with sane defaults: HttpOnly,
 *  SameSite=Lax, root path. We deliberately omit the `Secure` flag so
 *  this also works on http://localhost during dev — Vercel-hosted
 *  prod is HTTPS-only anyway, and the cookie carries no secrets (just
 *  a UUID), so the missing Secure flag isn't a real risk. */
export function buildCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
