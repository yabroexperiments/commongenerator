/**
 * Wavespeed.ai-routed providers.
 *
 * All Wavespeed models share:
 *   - The same auth header (Bearer WAVESPEED_API_KEY)
 *   - The same poll endpoint (/predictions/{id}/result)
 *   - The same response envelope ({ data: { id, status, outputs } })
 *
 * They differ in:
 *   - Submit URL path (per-model)
 *   - Request body shape (nano-banana uses size+quality;
 *     gpt-image-2 uses aspect_ratio+resolution+quality)
 *
 * `submitWavespeed` and `pollWavespeed` are shared. Each model is a
 * thin wrapper specifying its path + body builder.
 *
 * Required env: WAVESPEED_API_KEY.
 */

import type { ImageProvider, PollResult, SubmitOpts } from "./index";

const BASE_URL = "https://api.wavespeed.ai/api/v3";

function getApiKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error("WAVESPEED_API_KEY is not set in environment.");
  return key;
}

async function submitWavespeed(
  modelPath: string,
  body: Record<string, unknown>,
): Promise<{ taskId: string }> {
  const res = await fetch(`${BASE_URL}/${modelPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wavespeed submit ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  const data = json.data ?? json;
  if (!data?.id) {
    throw new Error(
      `Wavespeed submit returned no ID: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { taskId: data.id };
}

async function pollWavespeed(taskId: string): Promise<PollResult> {
  const res = await fetch(`${BASE_URL}/predictions/${taskId}/result`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
  });
  if (!res.ok) return { status: "processing" };
  const json = await res.json();
  const data = json.data ?? json;
  if (data.status === "completed" && data.outputs?.[0]) {
    return { status: "completed", imageUrl: data.outputs[0] as string };
  }
  if (data.status === "failed") {
    return {
      status: "failed",
      error: data.error ?? "Wavespeed: unknown failure",
    };
  }
  return { status: "processing" };
}

/* ---------- Body builders ---------- */

function buildNanoBananaBody(opts: SubmitOpts): Record<string, unknown> {
  return {
    images: [opts.imageUrl],
    prompt: opts.prompt,
    size: opts.size ?? "1024*1024",
    quality: "high",
  };
}

/** gpt-image-2 takes aspect_ratio + resolution instead of size.
 *  Translate the engine's "WxH" / "W*H" notation into Wavespeed's enums. */
function buildGptImage2Body(opts: SubmitOpts): Record<string, unknown> {
  const m = (opts.size ?? "1024*1024").match(/^(\d+)[*x](\d+)$/);
  let aspect_ratio: "1:1" | "3:2" | "2:3" = "1:1";
  let resolution: "1k" | "2k" | "4k" = "1k";
  if (m) {
    const w = parseInt(m[1]!, 10);
    const h = parseInt(m[2]!, 10);
    if (w > h) aspect_ratio = "3:2";
    else if (h > w) aspect_ratio = "2:3";
    const longest = Math.max(w, h);
    if (longest >= 4000) resolution = "4k";
    else if (longest >= 2000) resolution = "2k";
  }
  return {
    images: [opts.imageUrl],
    prompt: opts.prompt,
    aspect_ratio,
    resolution,
    quality: "high",
  };
}

/* ---------- Concrete providers ---------- */

export const wavespeedNanoBananaPro: ImageProvider = {
  name: "wavespeed-nano-banana-pro",
  submit: (opts) =>
    submitWavespeed("google/nano-banana-pro/edit", buildNanoBananaBody(opts)),
  pollResult: pollWavespeed,
};

export const wavespeedNanoBananaFast: ImageProvider = {
  name: "wavespeed-nano-banana-fast",
  submit: (opts) =>
    submitWavespeed(
      "google/nano-banana-2/edit-fast",
      buildNanoBananaBody(opts),
    ),
  pollResult: pollWavespeed,
};

export const wavespeedGptImage2: ImageProvider = {
  name: "wavespeed-gpt-image-2",
  submit: (opts) =>
    submitWavespeed("openai/gpt-image-2/edit", buildGptImage2Body(opts)),
  pollResult: pollWavespeed,
};
