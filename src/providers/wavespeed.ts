/**
 * Wavespeed.ai → Google Nano Banana Pro provider.
 *
 * Submit returns a task ID immediately; pollResult queries Wavespeed
 * via its `/predictions/{id}/result` endpoint.
 *
 * Required env in the consuming app: WAVESPEED_API_KEY.
 */

import type { ImageProvider, PollResult, SubmitOpts } from "./index";

const BASE_URL = "https://api.wavespeed.ai/api/v3";

function getApiKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error("WAVESPEED_API_KEY is not set in environment.");
  return key;
}

async function submit(opts: SubmitOpts): Promise<{ taskId: string }> {
  const size = opts.size ?? "1024*1024";
  const res = await fetch(`${BASE_URL}/google/nano-banana-pro/edit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      images: [opts.imageUrl],
      prompt: opts.prompt,
      size,
      quality: "high",
    }),
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

async function pollResult(taskId: string): Promise<PollResult> {
  const res = await fetch(`${BASE_URL}/predictions/${taskId}/result`, {
    headers: { Authorization: `Bearer ${getApiKey()}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return { status: "processing" };
  }
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

export const wavespeedProvider: ImageProvider = {
  name: "wavespeed",
  submit,
  pollResult,
};
