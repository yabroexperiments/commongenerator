/**
 * Optional vision pre-step: call OpenAI's gpt-4o-mini with an image
 * + a custom instruction prompt, return the model's response (text or
 * parsed JSON).
 *
 * Most workflows skip this. gogo-gallery uses it to detect whether a
 * photo is a person, a pet, or both — picking which master prompt to
 * apply. Other workflows might use it for content moderation, breed
 * identification, etc.
 *
 * Retries automatically on transient failures (429, 5xx, network
 * errors, and the specific "invalid_image_url / Timeout while
 * downloading" 400 OpenAI returns when their image fetcher can't
 * reach the source URL in time).
 *
 * Required env in the consuming app: OPENAI_API_KEY.
 */

export type AnalyzeImageOpts = {
  imageUrl: string;
  /** The instruction/system-prompt for the analysis. */
  prompt: string;
  /** Default "gpt-4o-mini". */
  model?: string;
  /** Default 200. */
  maxTokens?: number;
  /** If true, returns the parsed JSON. If false, returns raw text.
   *  Default true (sets response_format=json_object on the API call). */
  json?: boolean;
  /** Total attempts including the first. Default 3 (one initial + 2 retries). */
  maxAttempts?: number;
  /** Base backoff in ms (exponential: base, base*2, base*4, …). Default 800. */
  retryBaseMs?: number;
};

export async function analyzeImage<T = unknown>(
  opts: AnalyzeImageOpts,
): Promise<T | string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in environment.");

  const model = opts.model ?? "gpt-4o-mini";
  const json = opts.json ?? true;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.retryBaseMs ?? 800;

  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: opts.prompt },
          { type: "image_url", image_url: { url: opts.imageUrl } },
        ],
      },
    ],
    max_tokens: opts.maxTokens ?? 200,
  };
  if (json) body.response_format = { type: "json_object" };

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `OpenAI vision failed: ${res.status} ${text.slice(0, 500)}`,
        );
        if (attempt < maxAttempts && isRetryable(res.status, text)) {
          lastError = err;
          await sleep(baseMs * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }

      const respJson = await res.json();
      const content: string | undefined =
        respJson.choices?.[0]?.message?.content;
      if (!content) return null;

      if (json) {
        try {
          return JSON.parse(content) as T;
        } catch {
          return null;
        }
      }
      return content;
    } catch (err) {
      // Network / fetch-level failure — retry if attempts remain.
      if (attempt < maxAttempts && isNetworkError(err)) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(baseMs * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("analyzeImage exhausted retries");
}

function isRetryable(status: number, body: string): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  // OpenAI returns 400 with code "invalid_image_url" when their fetcher
  // can't download the source image in time — transient, worth retrying.
  if (status === 400 && /invalid_image_url|Timeout while downloading/i.test(body)) {
    return true;
  }
  return false;
}

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string; message?: string };
  if (e.name === "AbortError") return true;
  if (e.name === "FetchError" || e.name === "TypeError") return true;
  if (typeof e.code === "string" && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/.test(e.code)) {
    return true;
  }
  if (typeof e.message === "string" && /fetch failed|network|socket/i.test(e.message)) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
