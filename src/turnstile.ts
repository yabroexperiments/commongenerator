/**
 * Cloudflare Turnstile verification — server-side helper.
 *
 * Cloudflare Turnstile is free for unlimited use (no monthly cap, no
 * paid Cloudflare plan required). It's a privacy-respecting bot
 * defense that gives the user a (usually invisible) challenge and
 * returns a token. The token must be verified server-side against
 * Cloudflare's siteverify endpoint before it's trusted.
 *
 * Pairs with createGenerateRoute's `verifyTurnstile?:` option, which
 * extracts the token from the request body, calls this helper, and
 * returns 403 on failure. Apps wanting to verify on other endpoints
 * (e.g. /api/email-bypass) can call verifyTurnstileToken directly.
 *
 * Required env: TURNSTILE_SECRET_KEY (server-side; do not expose).
 *   - Production secret obtained from
 *     https://dash.cloudflare.com/?to=/:account/turnstile
 *   - For local dev, use the always-passes test secret:
 *       TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
 *     and the always-passes test site key on the frontend:
 *       NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
 *
 * Bypass surface: a determined attacker with a CAPTCHA-solving
 * service (~$1-3 per 1000 challenges) can defeat Turnstile, same as
 * any CAPTCHA. The defense is meant to raise the cost of automation
 * (scripted bypasses), not to stop a human at a keyboard. Pair with
 * the per-user rate limit (createRateLimit) for layered defense.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerifyResult = {
  success: boolean;
  /** Cloudflare returns specific error codes ("missing-input-secret",
   *  "invalid-input-response", "timeout-or-duplicate", etc.) — bubble
   *  them up so callers can log/branch if useful. */
  errorCodes?: string[];
  /** Hostname the challenge was solved for. Useful for logging if a
   *  token is replayed across domains. */
  hostname?: string;
  /** When the challenge was solved, ISO8601. */
  challengeTimestamp?: string;
};

export type VerifyTurnstileOpts = {
  /** Defaults to process.env.TURNSTILE_SECRET_KEY. Override for tests
   *  or multi-secret deployments. */
  secretKey?: string;
  /** Optional client IP for additional fraud signals. Pass the
   *  request's CF-Connecting-IP / X-Forwarded-For header value. */
  remoteIp?: string;
};

export async function verifyTurnstileToken(
  token: string,
  opts: VerifyTurnstileOpts = {},
): Promise<TurnstileVerifyResult> {
  const secret = opts.secretKey ?? process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is not set in environment.",
    );
  }
  if (!token || typeof token !== "string") {
    return { success: false, errorCodes: ["missing-input-response"] };
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (opts.remoteIp) form.set("remoteip", opts.remoteIp);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      // Cloudflare's siteverify is fast (<200ms) — short timeout is
      // safe and prevents hanging the route.
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("[commongenerator] Turnstile siteverify network error", err);
    // Fail-closed on network error: don't accept tokens we couldn't
    // verify. The route should return 403 (or whatever 4xx makes
    // sense in context).
    return { success: false, errorCodes: ["network-error"] };
  }

  if (!res.ok) {
    return {
      success: false,
      errorCodes: [`siteverify-http-${res.status}`],
    };
  }

  const json = (await res.json().catch(() => null)) as
    | {
        success: boolean;
        "error-codes"?: string[];
        hostname?: string;
        challenge_ts?: string;
      }
    | null;
  if (!json) {
    return { success: false, errorCodes: ["malformed-siteverify-response"] };
  }

  return {
    success: !!json.success,
    errorCodes: json["error-codes"],
    hostname: json.hostname,
    challengeTimestamp: json.challenge_ts,
  };
}
