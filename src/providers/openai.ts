/**
 * OpenAI direct provider — calls /v1/images/edits with model=gpt-image-2.
 *
 * Unlike the Wavespeed/Fal gateways (which expose async submit/poll
 * endpoints), OpenAI's image-edits API is synchronous: a single POST
 * blocks for the full inference time (15-90s depending on quality)
 * and returns the result inline as base64.
 *
 * To fit the engine's submit/poll abstraction, this provider does ALL
 * of the work inside `submit()`:
 *   1. Download the source image URL into a Buffer.
 *   2. Multipart-POST to OpenAI's /v1/images/edits.
 *   3. Decode the b64_json response into a PNG Buffer.
 *   4. Upload the PNG to Supabase Storage at `<generationId>.png`.
 *   5. Return the public Storage URL as the synthetic taskId.
 *
 * `pollResult()` is then a no-op: it just unwraps the URL and reports
 * completed. This means the provider's "submit" really takes 15-90s,
 * which is fine when called from `next/server` after() inside a route
 * with `maxDuration` ≥ 60s.
 *
 * Required env:
 *   - OPENAI_API_KEY                 (account must have gpt-image-2 access)
 *   - NEXT_PUBLIC_SUPABASE_URL  (or  SUPABASE_URL)
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional env:
 *   - OPENAI_PROVIDER_BUCKET         storage bucket name; default "results"
 *
 * Vercel timeout caveat: gpt-image-2 at quality="high" can take
 * 40-90s. Set `maxDuration = 60` (or higher) on the calling route OR
 * default `quality` to "medium" (15-30s).
 */

import { createClient } from "@supabase/supabase-js";
import type {
  ImageProvider,
  PollResult,
  SubmitOpts,
  SubmitResult,
} from "./index";
import type { FetchLike } from "../types";

const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";

function getRequiredEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? (fallback ? process.env[fallback] : undefined);
  if (!v) throw new Error(`${name} is not set in environment.`);
  return v;
}

/** Map the engine's "WxH" / "W*H" size hint → an OpenAI-accepted enum.
 *  gpt-image-2 accepts "1024x1024" | "1024x1536" | "1536x1024" | "auto". */
function mapSize(size: string | undefined): string {
  const m = (size ?? "1024x1024").match(/^(\d+)[*x](\d+)$/);
  if (!m) return "1024x1024";
  const w = parseInt(m[1]!, 10);
  const h = parseInt(m[2]!, 10);
  if (h > w) return "1024x1536";
  if (w > h) return "1536x1024";
  return "1024x1024";
}

/** Cloudinary serves uploaded files as-is by default. iPhone photos
 *  arrive as wide-gamut Display P3 JPEGs which OpenAI's gpt-image-2
 *  endpoint rejects with "invalid_image_file" / "Invalid image file
 *  or mode". Inserting `f_jpg,q_auto,c_limit,w_2048` after `/upload/`
 *  makes Cloudinary re-encode in sRGB JPEG, capped at 2048px wide,
 *  with auto quality — the safe input shape for OpenAI.
 *
 *  This is a no-op for non-Cloudinary URLs and a no-op when the URL
 *  already has transforms applied. */
function normalizeImageUrlForOpenAi(url: string): string {
  const m = url.match(
    /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.+)$/,
  );
  if (!m) return url;
  const [, prefix, rest] = m;
  // First segment after /upload/ — if it looks like a transform string
  // (contains commas, or starts with `<letter>_`), the caller already
  // applied transforms, don't double-insert.
  const firstSeg = rest!.split("/")[0]!;
  if (firstSeg.includes(",") || /^[a-z]_/.test(firstSeg)) {
    return url;
  }
  return `${prefix}f_jpg,q_auto,c_limit,w_2048/${rest}`;
}

async function downloadSourceImage(
  url: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch source image ${res.status}`);
  }
  const blob = await res.blob();
  // OpenAI accepts PNG/JPEG/WebP. After the Cloudinary transform above
  // we always get JPEG; for non-Cloudinary URLs trust the response
  // Content-Type. Rename the multipart filename so OpenAI's content
  // sniffing is happy.
  const ct = blob.type || "image/jpeg";
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  return { blob, filename: `input.${ext}` };
}

/** How many times to attempt the Supabase Storage upload. The
 *  OpenAI inference is already complete + paid for by the time we
 *  reach this step; we just need to persist the result. Transient
 *  flakes (concurrent-upload throttling at the Storage gateway,
 *  reported as `400 Bad Request` rather than `429`) are common when
 *  several sticker generations finish at once and all try to upload
 *  in parallel. Retry rather than throw away an already-billed
 *  inference. */
const UPLOAD_MAX_ATTEMPTS = 3;
/** Base delay (ms) for exponential backoff between upload attempts.
 *  Sequence at base=2000: ~2s, ~4s + jitter. Total worst-case wait
 *  before final throw: ~6s. */
const UPLOAD_RETRY_BASE_MS = 2000;

async function uploadResultToSupabase(
  pngBuffer: Buffer,
  path: string,
  fetchImpl?: FetchLike,
): Promise<string> {
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bucket = process.env.OPENAI_PROVIDER_BUCKET ?? "results";

  // Use the supabase-js SDK rather than raw fetch + Bearer auth.
  // The new `sb_secret_*` key format Supabase rolled out is NOT a JWT,
  // so a raw `Authorization: Bearer sb_secret_…` request to Storage
  // gets rejected with "Invalid Compact JWS". The SDK knows how to
  // negotiate auth correctly for both legacy JWT and new sb_* keys.
  //
  // When the caller passed a fetch (SubmitOpts.supabaseFetch), inject
  // it so this write goes through the consumer's guard; otherwise omit
  // `global` entirely and the SDK uses the global fetch (unchanged).
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
    const { error } = await sb.storage.from(bucket).upload(
      path,
      new Uint8Array(pngBuffer),
      {
        contentType: "image/png",
        upsert: true,
        cacheControl: "31536000",
      },
    );
    if (!error) {
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return data.publicUrl;
    }
    lastError = error.message;
    if (attempt === UPLOAD_MAX_ATTEMPTS) break;
    const sleepMs =
      UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.random() * 500;
    console.warn(
      `[openai-gpt-image-2] storage upload attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS} failed (${error.message}); retrying in ${Math.round(sleepMs)}ms path=${path}`,
    );
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  throw new Error(
    `Supabase Storage upload failed after ${UPLOAD_MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

async function submitOpenAi(opts: SubmitOpts): Promise<SubmitResult> {
  const apiKey = getRequiredEnv("OPENAI_API_KEY");

  // OpenAI's /v1/images/edits accepts repeated `image[]` form fields
  // for multi-image input (up to 16). The model uses all of them as
  // visual reference — first photo is the "primary", extras add more
  // identity / pose context. We treat opts.imageUrl as the primary
  // and append opts.additionalImageUrls (if any) in order.
  // The Cloudinary sRGB-JPEG rewrite is on by default. Callers pass
  // rewriteCloudinarySource:false when their source URLs are private /
  // already-signed (Cloudinary authenticated delivery, or a signed
  // Supabase bucket URL) — appending a transform segment there would
  // break the signature and 401 the download.
  const applyRewrite = opts.rewriteCloudinarySource !== false; // default true
  const prep = (u: string) => (applyRewrite ? normalizeImageUrlForOpenAi(u) : u);
  const primarySource = prep(opts.imageUrl);
  const extraSources = (opts.additionalImageUrls ?? []).map(prep);
  const allSources = [primarySource, ...extraSources];

  const downloads = await Promise.all(
    allSources.map((url) => downloadSourceImage(url)),
  );

  const fd = new FormData();
  fd.append("model", "gpt-image-2");
  // Single-image: use the `image` field name (back-compat with previous
  // single-image behavior). Multi-image: use repeated `image[]` fields
  // per OpenAI's documented multi-input form for gpt-image-2.
  if (downloads.length === 1) {
    fd.append("image", downloads[0]!.blob, downloads[0]!.filename);
  } else {
    downloads.forEach((d, i) => {
      fd.append("image[]", d.blob, `input-${i}.${d.filename.split(".").pop()}`);
    });
  }
  fd.append("prompt", opts.prompt);
  fd.append("size", mapSize(opts.size));
  // Default "medium" — same speed/fidelity tradeoff as the Wavespeed/Fal
  // gpt-image-2 providers. Override per-call via opts.quality.
  fd.append("quality", opts.quality ?? "medium");
  fd.append("n", "1");
  // Background transparency — only added when explicitly requested.
  // OpenAI's default is "auto" (model decides). Setting "transparent"
  // forces a real alpha channel in the output PNG — way more reliable
  // than asking the model nicely in the prompt and post-processing.
  // Caller is responsible for keeping output_format=png (default) so
  // the alpha channel survives encoding.
  if (opts.background) {
    fd.append("background", opts.background);
  }

  const aiRes = await fetch(OPENAI_EDITS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!aiRes.ok) {
    const text = await aiRes.text();
    throw new Error(
      `OpenAI gpt-image-2 ${aiRes.status}: ${text.slice(0, 500)}`,
    );
  }
  const json = (await aiRes.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { text_tokens?: number; image_tokens?: number };
    };
  };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(
      `OpenAI returned no image data: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  const buffer = Buffer.from(b64, "base64");
  // Persist at a deterministic path so the consuming app's archive step
  // (if any) overwrites in place rather than creating a duplicate.
  const path = opts.generationId
    ? `${opts.generationId}.png`
    : `openai-${crypto.randomUUID()}.png`;
  const publicUrl = await uploadResultToSupabase(buffer, path, opts.supabaseFetch);

  // Surface the per-call token usage so consumers can compute the real
  // cost of this generation (text-in + image-in + image-out tokens).
  return { taskId: publicUrl, usage: json.usage };
}

async function pollOpenAi(taskId: string): Promise<PollResult> {
  // submit() did the work and returned the public URL as the taskId.
  if (!taskId) return { status: "failed", error: "missing taskId" };
  return { status: "completed", imageUrl: taskId };
}

export const openaiGptImage2: ImageProvider = {
  name: "openai-gpt-image-2",
  submit: submitOpenAi,
  pollResult: pollOpenAi,
};
