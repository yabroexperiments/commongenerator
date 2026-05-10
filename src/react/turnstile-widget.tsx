/**
 * <TurnstileWidget /> — drop-in Cloudflare Turnstile widget.
 *
 * Loads the Turnstile script once, renders the widget div, captures
 * the token via a ref-managed callback, and notifies the parent so
 * the parent can include the token in form submits.
 *
 * Usage:
 *
 *   const [token, setToken] = useState<string | null>(null);
 *
 *   <TurnstileWidget
 *     siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!}
 *     onVerify={setToken}
 *     onExpire={() => setToken(null)}
 *   />
 *
 *   // include `token` in your /api/generate body
 *
 * Site keys for local dev (always pass / always fail):
 *   1x00000000000000000000AA  — always passes
 *   2x00000000000000000000AB  — always fails
 *   3x00000000000000000000FF  — always blocks (forces interaction)
 *
 * Use the always-passes test key in development; swap to the real
 * production site key on Vercel via NEXT_PUBLIC_TURNSTILE_SITE_KEY.
 */

"use client";

import { useEffect, useRef } from "react";

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__turnstileOnLoad&render=explicit";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: (err: unknown) => void;
          theme?: "light" | "dark" | "auto";
          size?: "normal" | "compact" | "invisible" | "flexible";
          appearance?: "always" | "execute" | "interaction-only";
          action?: string;
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId?: string) => void;
    };
    __turnstileOnLoad?: () => void;
  }
}

let scriptLoaded = false;
const onLoadCallbacks: Array<() => void> = [];

function loadScript() {
  if (scriptLoaded) return;
  if (typeof window === "undefined") return;
  if (document.querySelector(`script[src^="${SCRIPT_URL.split("?")[0]}"]`)) {
    scriptLoaded = true;
    return;
  }
  window.__turnstileOnLoad = () => {
    scriptLoaded = true;
    for (const cb of onLoadCallbacks.splice(0)) cb();
  };
  const script = document.createElement("script");
  script.src = SCRIPT_URL;
  script.async = true;
  script.defer = true;
  document.body.appendChild(script);
}

function whenLoaded(cb: () => void) {
  if (scriptLoaded && window.turnstile) cb();
  else onLoadCallbacks.push(cb);
}

export type TurnstileWidgetProps = {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (err: unknown) => void;
  /** "managed" / "interactive" / "invisible" — see Cloudflare docs.
   *  Default "flexible" (managed). */
  size?: "normal" | "compact" | "invisible" | "flexible";
  /** "always" (visible badge), "execute" (challenge runs but no
   *  visible badge), "interaction-only" (badge only when an
   *  interactive challenge is required). Default "always". */
  appearance?: "always" | "execute" | "interaction-only";
  theme?: "light" | "dark" | "auto";
  /** Optional analytics tag — Cloudflare logs this with each
   *  challenge so you can attribute volume to specific forms. */
  action?: string;
  className?: string;
};

export function TurnstileWidget(props: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    loadScript();
    let cancelled = false;
    whenLoaded(() => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: props.siteKey,
        callback: props.onVerify,
        "expired-callback": props.onExpire,
        "error-callback": props.onError,
        size: props.size ?? "flexible",
        appearance: props.appearance ?? "always",
        theme: props.theme ?? "auto",
        action: props.action,
      });
    });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore — widget may already be torn down
        }
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.siteKey]);

  return <div ref={containerRef} className={props.className} />;
}
