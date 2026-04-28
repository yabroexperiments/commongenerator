/**
 * OpenAI gpt-image-2 image-edit provider, routed through Fal.ai's queue.
 *
 * Why through Fal:
 *   - OpenAI direct requires org verification (currently blocked for us)
 *   - Fal sync mode takes 90-180s, exceeding Vercel Hobby's 60s cap
 *   - Fal queue mode returns a request_id in <1s; we poll like Wavespeed
 *
 * If/when our OpenAI org gets verified, swap this for a direct provider.
 *
 * Required env in the consuming app: FAL_API_KEY.
 */

import type { ImageProvider, PollResult, SubmitOpts } from "./index";

// Fal's URL convention is asymmetric:
//   submit → https://queue.fal.run/openai/gpt-image-2/edit
//   status → https://queue.fal.run/openai/gpt-image-2/requests/{id}/status
//   result → https://queue.fal.run/openai/gpt-image-2/requests/{id}
const FAL_SUBMIT_URL = "https://queue.fal.run/openai/gpt-image-2/edit";
const FAL_STATUS_URL = (id: string) =>
  `https://queue.fal.run/openai/gpt-image-2/requests/${id}/status`;
const FAL_RESULT_URL = (id: string) =>
  `https://queue.fal.run/openai/gpt-image-2/requests/${id}`;

function getFalKey(): string {
  const key = process.env.FAL_API_KEY;
  if (!key) {
    throw new Error(
      "FAL_API_KEY is not set. The OpenAI provider routes through Fal.ai.",
    );
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

async function submit(opts: SubmitOpts): Promise<{ taskId: string }> {
  const body = {
    prompt: opts.prompt,
    image_urls: [opts.imageUrl],
    image_size: mapSizeToFal(opts.size),
    quality: "high",
    num_images: 1,
    output_format: "png",
  };
  const res = await fetch(FAL_SUBMIT_URL, {
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

async function pollResult(taskId: string): Promise<PollResult> {
  const statusRes = await fetch(FAL_STATUS_URL(taskId), {
    headers: { Authorization: `Key ${getFalKey()}` },
    cache: "no-store",
  });
  if (!statusRes.ok) {
    return { status: "processing" };
  }
  const statusJson = await statusRes.json();
  const fStatus: string = statusJson.status;

  if (fStatus === "COMPLETED") {
    const resRes = await fetch(FAL_RESULT_URL(taskId), {
      headers: { Authorization: `Key ${getFalKey()}` },
      cache: "no-store",
    });
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
}

export const openaiProvider: ImageProvider = {
  name: "openai",
  submit,
  pollResult,
};
