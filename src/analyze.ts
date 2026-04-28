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
};

export async function analyzeImage<T = unknown>(
  opts: AnalyzeImageOpts,
): Promise<T | string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set in environment.");

  const model = opts.model ?? "gpt-4o-mini";
  const json = opts.json ?? true;

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
    throw new Error(`OpenAI vision failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const respJson = await res.json();
  const content: string | undefined = respJson.choices?.[0]?.message?.content;
  if (!content) return null;

  if (json) {
    try {
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
  return content;
}
