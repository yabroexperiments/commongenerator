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
import type { ImageProvider, PollResult, SubmitOpts } from "./index";

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

async function downloadSourceImage(
  url: string,
): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to fetch source image ${res.status}`);
  }
  const blob = await res.blob();
  // OpenAI accepts PNG/JPEG/WebP. Cloudinary often serves JPEG; rename
  // the multipart filename so OpenAI's content-type sniffing is happy.
  const ct = blob.type || "image/jpeg";
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  return { blob, filename: `input.${ext}` };
}

async function uploadResultToSupabase(
  pngBuffer: Buffer,
  path: string,
): Promise<string> {
  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const serviceKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const bucket = process.env.OPENAI_PROVIDER_BUCKET ?? "results";

  // Use the supabase-js SDK rather than raw fetch + Bearer auth.
  // The new `sb_secret_*` key format Supabase rolled out is NOT a JWT,
  // so a raw `Authorization: Bearer sb_secret_…` request to Storage
  // gets rejected with "Invalid Compact JWS". The SDK knows how to
  // negotiate auth correctly for both legacy JWT and new sb_* keys.
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await sb.storage.from(bucket).upload(
    path,
    new Uint8Array(pngBuffer),
    {
      contentType: "image/png",
      upsert: true,
      cacheControl: "31536000",
    },
  );
  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

async function submitOpenAi(opts: SubmitOpts): Promise<{ taskId: string }> {
  const apiKey = getRequiredEnv("OPENAI_API_KEY");

  const { blob, filename } = await downloadSourceImage(opts.imageUrl);

  const fd = new FormData();
  fd.append("model", "gpt-image-2");
  fd.append("image", blob, filename);
  fd.append("prompt", opts.prompt);
  fd.append("size", mapSize(opts.size));
  // Default "medium" — same speed/fidelity tradeoff as the Wavespeed/Fal
  // gpt-image-2 providers. Override per-call via opts.quality.
  fd.append("quality", opts.quality ?? "medium");
  fd.append("n", "1");

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
  const publicUrl = await uploadResultToSupabase(buffer, path);

  return { taskId: publicUrl };
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
