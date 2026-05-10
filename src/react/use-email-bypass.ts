/**
 * useEmailBypass — React hook for the email-bypass form.
 *
 * Pairs with createEmailBypassRoute on the server. The hook owns the
 * submit / loading / error / success state; the consuming app owns
 * the modal markup, copy, and styling.
 *
 * Typical usage:
 *
 *   const { submit, status, error, reset } = useEmailBypass();
 *   ...
 *   <form onSubmit={async e => {
 *     e.preventDefault();
 *     const ok = await submit(emailInput);
 *     if (ok) {
 *       closeModal();
 *       retryGenerate();
 *     }
 *   }}>
 *     {status === "submitting" ? "Saving…" : "Continue"}
 *     {error && <p>{error}</p>}
 *   </form>
 */

"use client";

import { useCallback, useState } from "react";

export type EmailBypassStatus = "idle" | "submitting" | "success" | "error";

export type UseEmailBypassOpts = {
  /** Endpoint to POST. Default "/api/email-bypass". */
  endpoint?: string;
};

export function useEmailBypass(opts: UseEmailBypassOpts = {}) {
  const endpoint = opts.endpoint ?? "/api/email-bypass";
  const [status, setStatus] = useState<EmailBypassStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (email: string): Promise<boolean> => {
      setStatus("submitting");
      setError(null);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ email }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !json.ok) {
          const msg = humanizeError(json.error, json.detail, res.status);
          setError(msg);
          setStatus("error");
          return false;
        }
        setStatus("success");
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error");
        setStatus("error");
        return false;
      }
    },
    [endpoint],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return { submit, status, error, reset };
}

function humanizeError(
  code: string | undefined,
  detail: string | undefined,
  status: number,
): string {
  if (code === "invalid_email") return "That doesn't look like a valid email.";
  if (code === "no_session") {
    return "Session not found. Please refresh the page and try again.";
  }
  if (code === "save_failed") return detail ?? "Couldn't save email. Try again.";
  return detail ?? `Request failed (${status})`;
}
