/**
 * Fal.ai-routed providers.
 *
 * `fal-gpt-image-2`: OpenAI's gpt-image-2 image-edit, served via Fal's
 * queue. Used because OpenAI's direct API requires org verification
 * (currently blocked for the yabroexperiments account); when that
 * lands, we can add a direct provider and demote this to fallback.
 *
 * Fal's queue URL convention is asymmetric:
 *   submit → POST   https://queue.fal.run/<endpoint>/edit
 *   status → GET    https://queue.fal.run/<endpoint>/requests/{id}/status
 *   result → GET    https://queue.fal.run/<endpoint>/requests/{id}
 * (the trailing /edit is dropped on the status + result paths)
 *
 * Required env: FAL_API_KEY.
 */

import type { ImageProvider, PollResult, SubmitOpts } from "./index";

const FAL_BASE = "https://queue.fal.run";

function getFalKey(): string {
  const key = process.env.FAL_API_KEY;
  if (!key) {
    throw new Error("FAL_API_KEY is not set.");
  }
  return key;
}

/** Map "1024*1024" / "1024x1024" notation → Fal's preset enum. */
function mapSizeToFal(size: string | undefined): string {
  if (!size) return "square_hd";
  const m = size.match(/^(\d+)[*x](\d+)$/);
  if (!m) return "square_hd";
  const w = parseInt(m[1]!, 10);
  const h = parseInt(m[2]!, 10);
  if (h > w) return "portrait_4_3";
  if (w > h) return "landscape_4_3";
  return "square_hd";
}

async function submitFal(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ taskId: string }> {
  const res = await fetch(`${FAL_BASE}/${endpoint}/edit`, {
    method: "POST",
    headers: {
      Authorization: `Key ${getFalKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fal queue submit ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  if (!json.request_id) {
    throw new Error(
      `Fal returned no request_id: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { taskId: json.request_id as string };
}

function makeFalPoll(endpoint: string) {
  return async function pollFal(taskId: string): Promise<PollResult> {
    const statusRes = await fetch(
      `${FAL_BASE}/${endpoint}/requests/${taskId}/status`,
      { headers: { Authorization: `Key ${getFalKey()}` }, cache: "no-store" },
    );
    if (!statusRes.ok) return { status: "processing" };
    const statusJson = await statusRes.json();
    const fStatus: string = statusJson.status;

    if (fStatus === "COMPLETED") {
      const resRes = await fetch(
        `${FAL_BASE}/${endpoint}/requests/${taskId}`,
        { headers: { Authorization: `Key ${getFalKey()}` }, cache: "no-store" },
      );
      if (!resRes.ok) {
        return { status: "failed", error: `Fal response ${resRes.status}` };
      }
      const result = await resRes.json();
      const imageUrl = result.images?.[0]?.url;
      if (!imageUrl) {
        return {
          status: "failed",
          error: `Fal completed but no image URL: ${JSON.stringify(result).slice(0, 200)}`,
        };
      }
      return { status: "completed", imageUrl: imageUrl as string };
    }

    if (fStatus === "FAILED" || fStatus === "ERROR" || statusJson.error) {
      return {
        status: "failed",
        error:
          statusJson.error?.message ??
          statusJson.error ??
          `Fal status: ${fStatus}`,
      };
    }

    return { status: "processing" };
  };
}

/* ---------- Concrete provider ---------- */

const GPT_IMAGE_2_ENDPOINT = "openai/gpt-image-2";

export const falGptImage2: ImageProvider = {
  name: "fal-gpt-image-2",
  submit: (opts: SubmitOpts) =>
    submitFal(GPT_IMAGE_2_ENDPOINT, {
      prompt: opts.prompt,
      image_urls: [opts.imageUrl],
      image_size: mapSizeToFal(opts.size),
      quality: "high",
      num_images: 1,
      output_format: "png",
    }),
  pollResult: makeFalPoll(GPT_IMAGE_2_ENDPOINT),
};
