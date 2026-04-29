"use client";

/**
 * <AdminLoginForm /> — drop-in form that accepts a secret and POSTs
 * it to the consuming app's login endpoint. On success, redirects to
 * the page the user was originally trying to reach (via ?from=) or
 * to `redirectTo`.
 *
 * Designed to be used by a simple consuming-app login page:
 *
 *   // src/app/admin/login/page.tsx
 *   import { AdminLoginForm } from "commongenerator/react";
 *   export default function Page() {
 *     return <AdminLoginForm title="My App admin" />;
 *   }
 */

import { useState } from "react";

export type AdminLoginFormProps = {
  /** Default redirect after login if no ?from= param. Default "/admin". */
  redirectTo?: string;
  /** POST endpoint. Default "/api/admin/login". */
  endpoint?: string;
  /** Page title. */
  title?: string;
  /** Optional className on the outer wrapper. */
  className?: string;
};

export function AdminLoginForm({
  redirectTo = "/admin",
  endpoint = "/api/admin/login",
  title = "Admin Login",
  className = "",
}: AdminLoginFormProps) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret }),
      });
      if (res.ok) {
        const params = new URLSearchParams(window.location.search);
        const from = params.get("from") ?? redirectTo;
        window.location.href = from;
      } else {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <main
      className={className}
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "#fafaf9",
      }}
    >
      <form
        onSubmit={submit}
        style={{
          maxWidth: 360,
          width: "100%",
          padding: 24,
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          background: "white",
        }}
      >
        <h1
          style={{
            fontSize: 18,
            fontWeight: 600,
            marginBottom: 16,
            color: "#111827",
          }}
        >
          {title}
        </h1>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Admin secret"
          required
          autoFocus
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            marginBottom: 12,
            fontSize: 14,
            boxSizing: "border-box",
          }}
        />
        <button
          type="submit"
          disabled={submitting || !secret}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 8,
            background: submitting || !secret ? "#9ca3af" : "#111827",
            color: "white",
            border: "none",
            fontWeight: 600,
            cursor: submitting || !secret ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        {error && (
          <p
            style={{
              color: "#dc2626",
              fontSize: 13,
              marginTop: 12,
              marginBottom: 0,
            }}
          >
            ⚠️ {error}
          </p>
        )}
      </form>
    </main>
  );
}
