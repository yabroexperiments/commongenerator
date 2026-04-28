# commongenerator — Integration Guide

A detailed reference for using `commongenerator` in a new Next.js project.
Pair with the README (TL;DR) and the actual source code (truth).

---

## 1. Mental model

`commongenerator` is a thin platform that handles the boring,
repeated parts of any "upload an image, send to AI, get a generated
image back" workflow. Each consuming project (gogo-gallery,
DogRating, LINE Stickers, future projects) is a thick client that
owns its own:

- UI / branding / form
- Prompt content + per-project prompt schema
- Database (its own Supabase project, its own credentials)
- Result-page UX (display, share buttons, payment gates, etc.)
- Workflow-specific orchestration (1 image, 12 images, with/without
  watermark, score cards, sticker packs, etc.)

The engine never reads project-specific business logic. It is
**credential-agnostic** — the consuming app injects its own
SupabaseClient and reads its own env vars.

### The 3 primitives

```
analyzeImage(imageUrl, prompt)
  → optional vision pre-step. OpenAI gpt-4o-mini reads the image
    and your instruction prompt, returns text or parsed JSON.
    Used for things like subject detection, content moderation,
    breed identification.

startGeneration({ imageUrl, prompt, provider, ... })
  → submit one image-edit task to a provider (Wavespeed or
    OpenAI-via-Fal), persist a tracking row, return a generation_id.

getGenerationStatus({ id, archive? })
  → read the tracking row. If still processing, poll the upstream
    provider once and update the row. Return the latest state.
    Optionally archive the result image to Supabase Storage on
    completion (provider CDN URLs can expire).
```

Plus utilities: `renderPrompt`, `applyCloudinaryTransform`,
`buildWatermarkTransform`, and the React hook
`useGenerationStatus`.

### Why split into start + status?

Vercel functions time out (60s on Hobby, 800s on Pro). AI
generations take 30-180s. Splitting into "start fast, poll until
done" lets the engine work within those limits. The client browser
calls `POST /api/generate` (returns instantly with an ID) then polls
`GET /api/status/[id]` every ~2.5s until terminal.

---

## 2. Repo structure

```
commongenerator/
├── package.json              # name, exports, peer deps
├── tsconfig.json
├── README.md                 # TL;DR
├── INTEGRATION_GUIDE.md      # this file
├── sql/
│   └── 0001_generations.sql  # apply once per consuming Supabase project
└── src/
    ├── index.ts              # public exports for `commongenerator`
    ├── types.ts              # ProviderName, GenerationRow, etc.
    ├── analyze.ts            # analyzeImage (with retry)
    ├── generate.ts           # startGeneration + getGenerationStatus
    ├── render-prompt.ts      # renderPrompt utility
    ├── cloudinary.ts         # applyCloudinaryTransform helpers
    ├── db.ts                 # internal Supabase generations-table CRUD
    ├── providers/
    │   ├── index.ts          # ImageProvider interface + registry
    │   ├── wavespeed.ts      # Wavespeed (Google Nano Banana Pro)
    │   └── openai-fal.ts     # OpenAI gpt-image-2 via Fal.ai queue
    ├── routes/
    │   ├── index.ts          # public exports for `commongenerator/routes`
    │   ├── generate.ts       # createGenerateRoute factory
    │   └── status.ts         # createStatusRoute factory
    └── react/
        ├── index.ts          # public exports for `commongenerator/react`
        └── use-generation-status.ts   # polling hook
```

### Subpath imports

```ts
import { startGeneration, analyzeImage } from "commongenerator";
import { createGenerateRoute, createStatusRoute } from "commongenerator/routes";
import { useGenerationStatus } from "commongenerator/react";
```

---

## 3. Public API reference

### `analyzeImage<T>(opts) → Promise<T | string | null>`

Optional vision pre-step. Sends image + instruction prompt to
OpenAI's gpt-4o-mini, returns parsed JSON (default) or raw text.

| Option | Default | Notes |
|---|---|---|
| `imageUrl` | required | Public HTTPS URL OpenAI can fetch |
| `prompt` | required | Instruction text |
| `model` | `"gpt-4o-mini"` | Override for higher-quality analysis |
| `maxTokens` | 200 | Tighten for short JSON, raise for prose |
| `json` | `true` | If true, sets `response_format=json_object` and parses |
| `maxAttempts` | 3 | Total tries (one initial + retries) |
| `retryBaseMs` | 800 | Exponential backoff: 800ms, 1600ms, 3200ms |

Retries automatically on:
- HTTP 408, 429, 5xx
- HTTP 400 with `invalid_image_url` / "Timeout while downloading"
  (OpenAI's image fetcher flake — common when source URL is slow)
- Network errors (ECONNRESET, ETIMEDOUT, "fetch failed", etc.)

**Env required:** `OPENAI_API_KEY`.

### `startGeneration(opts) → Promise<{ generationId }>`

Submit one image-edit task to a provider. Inserts a row into the
`generations` table, calls `provider.submit()`, stores the upstream
task ID, returns the row ID.

| Option | Default | Notes |
|---|---|---|
| `sb` | required | Server-side SupabaseClient (service-role key) |
| `imageUrl` | required | Source image (public URL) |
| `prompt` | required | Already-rendered prompt text (use `renderPrompt` first) |
| `provider` | `"wavespeed"` | `"wavespeed"` or `"openai"` |
| `size` | provider default | `"1024*1024"`, `"1024x1024"`, etc. |
| `kind` | null | Free-form tag — `"rating"`, `"gallery-renaissance"`, etc. |
| `metadata` | null | Free-form jsonb — engine never reads it |
| `id` | random UUID | Pre-generate if you need the ID before insert |

**Env required:** depends on provider. `WAVESPEED_API_KEY` or
`FAL_API_KEY`. Always need `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` for the SupabaseClient.

### `getGenerationStatus(opts) → Promise<GenerationStatusResponse>`

Read the tracking row. If still processing, poll the upstream
provider once and update the row. Returns the latest state.

| Option | Default | Notes |
|---|---|---|
| `sb` | required | Server-side SupabaseClient |
| `id` | required | The generation_id from startGeneration |
| `archive` | optional | `{ bucket: "results" }` — copies the upstream image into Supabase Storage on completion. Provider CDN URLs can expire; archiving means you own the asset. |

Returns:
```ts
{
  status: "processing" | "completed" | "failed",
  imageUrl: string | null,
  error: string | null,
  originalImageUrl: string,
  prompt: string,
  metadata: Record<string, unknown> | null,
}
```

### `renderPrompt(template, vars, opts?) → string`

Substitutes `{name}` placeholders in a prompt template.

```ts
renderPrompt(
  "幫 {dog_name} 評分。年紀 {age} 歲，{breed}。",
  { dog_name: "Milou", age: 5, breed: "迷你雪納瑞" }
)
// → "幫 Milou 評分。年紀 5 歲，迷你雪納瑞。"
```

| Opt | Default | Notes |
|---|---|---|
| `strict` | `true` | Missing variables throw. Set false to leave `{name}` placeholders in output. |

### `applyCloudinaryTransform(opts) → string`

Builds a Cloudinary delivery URL with a transformation applied.
Cloudinary fetches the source on demand; no upload step needed.

```ts
applyCloudinaryTransform({
  sourceUrl: "https://example.com/image.png",
  transform: "l_text:Arial_36_bold:goober.tw,o_80,g_south_east,x_30,y_30",
});
// → "https://res.cloudinary.com/<cloud>/image/fetch/.../<encoded_url>"
```

**Env required:** `CLOUDINARY_CLOUD_NAME` (or pass `cloudName` per call).

Helpers:
- `buildWatermarkTransform({ text, fontSize?, color?, opacity?, gravity?, padding? })` →  returns the transform string
- `BG_REMOVAL_TRANSFORM` constant (`"e_background_removal"`)

### `useGenerationStatus(id, opts?) → React state`

Client hook. Polls `/api/status/[id]` until terminal. Stops itself
on `completed` / `failed` / timeout.

```ts
const { status, imageUrl, error, originalImageUrl, metadata } =
  useGenerationStatus(generationId);
```

| Opt | Default | Notes |
|---|---|---|
| `intervalMs` | 2500 | Poll cadence |
| `timeoutMs` | 300_000 (5 min) | Hard cap; 0 disables |
| `endpoint` | `(id) => /api/status/${id}` | Override route path |

### Route factories

`createGenerateRoute(opts)` and `createStatusRoute(opts)` are Next.js
App-Router route handler factories. See section 5 below.

---

## 4. Provider abstraction

```ts
interface ImageProvider {
  name: ProviderName;
  submit(opts: SubmitOpts): Promise<{ taskId: string }>;
  pollResult(taskId: string): Promise<PollResult>;
}
```

Two providers ship today:

| Provider | Underlying API | Why use it |
|---|---|---|
| `wavespeed` | Wavespeed.ai → Google Nano Banana Pro | Fastest at preserving pet/person identity. Default. |
| `openai` | OpenAI gpt-image-2 routed through Fal.ai queue | Better at text-rich and multilingual scenes. Routes through Fal because direct OpenAI requires org verification (currently blocked). |

Both use the same async submit/poll pattern. The status endpoint
polls; results are archived to Supabase Storage when an `archive`
bucket is configured.

### Adding a new provider (e.g. Replicate, Stability)

1. Create `src/providers/<name>.ts` exporting an `ImageProvider`
2. Add the provider name to the `ProviderName` union in `src/types.ts`
3. Register it in `src/providers/index.ts` `REGISTRY`
4. Update the SQL migration's `check (provider in (...))` constraint
5. Bump consuming apps' `commongenerator` git ref

### Choosing a provider per request

`createGenerateRoute` accepts an optional `provider` field on the
request body. Apps can also expose an admin setting (gogo-gallery
keeps its own `settings` table with a `default_provider` row that
its local `resolveProvider` consults).

---

## 5. Wiring it into a Next.js app

### Step-by-step recipe

1. **Install:**
   ```bash
   npm install github:yabroexperiments/commongenerator#main
   ```
   Pin to a SHA for stability: `commongenerator#abc1234`. Bump the
   ref to pull updates.

2. **Add env vars** (`.env.local` and Vercel project settings):
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   OPENAI_API_KEY=
   WAVESPEED_API_KEY=     # if using Wavespeed
   FAL_API_KEY=           # if using OpenAI provider
   CLOUDINARY_CLOUD_NAME= # if calling applyCloudinaryTransform
   ```

3. **Apply the SQL migration** to your project's Supabase:
   ```bash
   psql "$DATABASE_URL" -f node_modules/commongenerator/sql/0001_generations.sql
   ```
   Or paste it into the Supabase SQL editor.

4. **Create a Supabase Storage bucket** (recommended):
   - Name: `results` (or anything; pass it via `archive: { bucket }`)
   - Public read access if you want to share result URLs directly
   - Plus an `uploads` bucket for incoming photos

5. **Wire the API routes** — `src/app/api/generate/route.ts`:

   ```ts
   import { createGenerateRoute } from "commongenerator/routes";
   import { renderPrompt } from "commongenerator";
   import { createClient } from "@supabase/supabase-js";

   export const runtime = "nodejs";
   export const maxDuration = 60;

   const getSupabase = () =>
     createClient(
       process.env.NEXT_PUBLIC_SUPABASE_URL!,
       process.env.SUPABASE_SERVICE_ROLE_KEY!,
       { auth: { persistSession: false } },
     );

   export const POST = createGenerateRoute({
     getSupabase,
     buildPrompt: async ({ body }) => {
       // App-specific: pull a template from your prompts table,
       // substitute variables, return the engine inputs.
       const template = await fetchTemplate(body.kind);
       const prompt = renderPrompt(template, body.vars);
       return {
         imageUrl: body.upload_url,
         prompt,
         provider: body.provider,
         kind: body.kind,
         metadata: body.vars,
       };
     },
     defaultProvider: "wavespeed",
   });
   ```

   And `src/app/api/status/[id]/route.ts`:

   ```ts
   import { createStatusRoute } from "commongenerator/routes";
   import { createClient } from "@supabase/supabase-js";

   export const runtime = "nodejs";

   export const GET = createStatusRoute({
     getSupabase: () =>
       createClient(
         process.env.NEXT_PUBLIC_SUPABASE_URL!,
         process.env.SUPABASE_SERVICE_ROLE_KEY!,
         { auth: { persistSession: false } },
       ),
     archive: { bucket: "results" },
   });
   ```

6. **Wire the result page** — `src/app/result/[id]/page.tsx` (client
   component):

   ```tsx
   "use client";
   import { useGenerationStatus } from "commongenerator/react";

   export default function Page({ params }: { params: { id: string } }) {
     const { status, imageUrl, error } = useGenerationStatus(params.id);

     if (status === "failed") return <p>失敗：{error}</p>;
     if (status === "completed") return <img src={imageUrl ?? ""} />;
     return <p>生成中…</p>;
   }
   ```

7. **Upload UI** — handle the photo upload separately. Direct upload
   from the browser to Supabase Storage (signed URL) or Cloudinary
   (signed upload preset). The engine doesn't do uploads — it
   accepts whatever public URL you already have.

---

## 6. Workflow patterns

### Pattern A — single image (gogo-gallery)

Frontend POSTs `{ upload_url, style }` to `/api/generate`.
buildPrompt looks up the prompt by `style + subject_type`, calls
the engine. One row, one image. Result page polls one status.

### Pattern B — multi-image with intermediate scoring (DogRating)

```
User submits photo + form fields
  ↓
analyzeImage(photo, "score this dog 1-100 on N traits, return JSON")
  → JSON with total + sub-scores
  ↓
renderPrompt(ratingCardTemplate, { dog_name, score, ...subScores })
  ↓
startGeneration({ imageUrl, prompt: renderedTemplate, kind: "rating-card" })
  → row 1 (the score card image)
  ↓
[optionally also] startGeneration({ ... kind: "rating-minimal" })
  → row 2 (minimal POD variant)
  ↓
After both complete, optionally apply Cloudinary watermark transform
  → public/watermarked URL
  ↓
Hi-res unwatermarked URL gated behind payment
```

### Pattern C — batch 12 images (LINE Stickers)

```
For each of 12 actions:
  startGeneration({ imageUrl, prompt: actionPrompt[i], kind: "sticker-N" })
  → 12 rows, all submitted in parallel

Frontend polls all 12 status endpoints, shows "8/12 ready"

When all complete:
  For each result, applyCloudinaryTransform with bg-removal
  → 12 transparent PNGs

Resize via Cloudinary to LINE's spec (370x320 png)

Pack into a ZIP server-side, return download URL
```

The engine treats each generation as independent. The project owns
the orchestration (parallel submit, batch polling, post-processing).

---

## 7. Database schema

The `sql/0001_generations.sql` migration creates one table:

```sql
generations (
  id uuid primary key,
  kind text,                 -- free-form, e.g. "rating", "sticker-3"
  original_image_url text,
  result_image_url text,
  prompt text,
  provider text,             -- "wavespeed" | "openai"
  provider_task_id text,     -- upstream task ID
  status text,               -- "processing" | "completed" | "failed"
  error_message text,
  metadata jsonb,            -- app-specific blob; engine never reads
  created_at timestamptz
)
```

Indexes on `kind`, `status`, `created_at desc`.
RLS enabled, no policies — engine uses service-role key, bypassing
RLS. If you want anon clients to read result rows directly (e.g. for
shareable result URLs without going through the API), add a SELECT
policy.

---

## 8. Required environment variables

Per consuming app (each app has its own values):

| Var | Required when | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | always | Per-project Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | always | For client-side uploads to Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | always | Server-only, used by the engine |
| `OPENAI_API_KEY` | when using `analyzeImage` | gpt-4o-mini calls |
| `WAVESPEED_API_KEY` | when using `wavespeed` provider | |
| `FAL_API_KEY` | when using `openai` provider (via Fal) | |
| `CLOUDINARY_CLOUD_NAME` | when calling `applyCloudinaryTransform` | |

Per the project-separation rule: **never share keys across projects.**
Each app gets its own Supabase project, OpenAI key, Wavespeed key,
Cloudinary cloud, etc. Spend caps and abuse blast radius are then
per-project.

---

## 9. Versioning + updates

- The package is private and not on npm. Apps install from GitHub:
  `"commongenerator": "github:yabroexperiments/commongenerator#main"`
- The `prepare` script runs `tsc` on install, so consuming apps get
  pre-built `dist/` even though it's not committed.
- To pin to a specific version, use a SHA: `#abc1234`.
  Recommended for production; use `#main` for projects in active
  iteration.
- Updating: `npm update commongenerator` in the consuming app, then
  redeploy. Vercel will refetch on next deploy.

### Breaking-change protocol

If the engine's public API changes in a way that breaks consumers
(rare — most additions are new exports), bump a tag (e.g.
`v0.2.0`) and migrate apps one at a time:

```bash
# in app:
npm install github:yabroexperiments/commongenerator#v0.2.0
# read CHANGELOG.md, fix breakages
# verify locally + on a Vercel preview before merging
```

---

## 10. Known limitations / future work

- **No direct upload helper.** Apps handle uploads via direct
  Supabase Storage signed URLs or Cloudinary unsigned preset. The
  engine just accepts a public image URL.
- **No payment / watermark gating.** That's per-app UX. The engine
  provides `applyCloudinaryTransform` so apps can build watermark
  variants; the gating logic (free preview vs paid clean version)
  lives in each app.
- **No streaming.** All providers are submit/poll. If a future
  provider supports server-sent events, the abstraction would need
  to grow.
- **No batch endpoint.** Multi-image workflows like LINE Stickers
  call `startGeneration` N times from the app and poll N status
  endpoints. Could add a batch endpoint later if it becomes painful.
- **Cloudinary auth.** Right now `applyCloudinaryTransform` builds
  fetch URLs with no signing — works for public images. If sources
  are private, you'd need signed delivery (not yet supported).
- **No structured logging / observability.** Adds via console.error
  only. Consuming apps can wrap the engine functions if they want
  Sentry / OpenTelemetry / etc.

---

## 11. Quick reference: "I want to build a new project that does X"

0. **Pick an ASCII-only path for the project folder.** Next.js 16's
   Turbopack production build crashes when the working directory
   contains non-ASCII characters (e.g. Chinese folder names). This
   is a Turbopack bug — they slice paths by byte index instead of
   char index, which lands inside multi-byte UTF-8 chars and panics.
   `npm run dev` is unaffected, and Vercel's build environment is
   ASCII-only so production deploys are fine — but local
   `npm run build` will fail. **Always place new project folders at
   ASCII-only paths.** Good: `~/Projects/PetBusiness/DogRating/`.
   Bad: `~/Projects/PetBusiness/狗狗畫廊/dog-rating/`.

1. Create a new Next.js 16 app (use gogo-gallery as the template
   — same stack, same patterns)
2. Create a new Supabase project (separate from sibling apps —
   project-separation rule)
3. Apply `sql/0001_generations.sql` to it
4. Create a `prompts` table for your project's prompt templates
   (see gogo-gallery's `prompts` table as a reference)
5. Install `commongenerator` from GitHub
6. Wire `/api/generate` and `/api/status/[id]` via the route
   factories (section 5)
7. Build the upload form + result page using the React hook
8. Iterate on prompts in your project's Supabase prompts table —
   no engine changes needed for prompt tweaks

For workflows beyond single-image (rating cards, sticker packs,
outfit suggestions, etc.) see section 6 patterns and orchestrate
multiple `startGeneration` calls from your app.
