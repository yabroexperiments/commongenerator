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
│   ├── 0001_generations.sql      # apply once per consuming Supabase project
│   └── 0002_rename_providers.sql # for legacy apps with the pre-rename catalog
└── src/
    ├── index.ts              # public exports for `commongenerator`
    ├── types.ts              # ProviderName, GenerationRow, etc.
    ├── analyze.ts            # analyzeImage (with retry)
    ├── generate.ts           # startGeneration + getGenerationStatus (with fallback chain)
    ├── render-prompt.ts      # renderPrompt utility
    ├── cloudinary.ts         # applyCloudinaryTransform helpers
    ├── model-families.ts     # getModelFamily / providersInFamily
    ├── db.ts                 # internal Supabase generations-table CRUD
    ├── providers/
    │   ├── index.ts          # ImageProvider interface + registry
    │   ├── wavespeed.ts      # 3 Wavespeed-routed providers (gpt-image-2, nano-banana pro/fast)
    │   └── fal.ts            # fal-gpt-image-2 (OpenAI via Fal.ai queue)
    ├── auth/
    │   ├── index.ts          # public exports for `commongenerator/auth`
    │   ├── middleware-factory.ts   # createAdminMiddleware
    │   └── login-route-factory.ts  # createAdminLoginRoute / Logout
    ├── routes/
    │   ├── index.ts          # public exports for `commongenerator/routes`
    │   ├── generate.ts       # createGenerateRoute factory
    │   └── status.ts         # createStatusRoute factory (with postCompletion hook)
    └── react/
        ├── index.ts                  # public exports for `commongenerator/react`
        ├── use-generation-status.ts  # polling hook
        ├── multi-provider-runner.tsx # admin testbench primitive
        └── admin-login-form.tsx      # drop-in login form
```

### Subpath imports

```ts
import { startGeneration, analyzeImage, getModelFamily } from "commongenerator";
import { createGenerateRoute, createStatusRoute } from "commongenerator/routes";
import { createAdminMiddleware, createAdminLoginRoute } from "commongenerator/auth";
import {
  useGenerationStatus,
  MultiProviderRunner,
  AdminLoginForm,
} from "commongenerator/react";
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

### `startGeneration(opts) → Promise<{ generationId, acceptedBy }>`

Submit one image-edit task to a provider, with optional fallback chain.
Inserts a row into the `generations` table, calls `provider.submit()`,
stores the upstream task ID, returns the row ID.

| Option | Default | Notes |
|---|---|---|
| `sb` | required | Server-side SupabaseClient (service-role key) |
| `imageUrl` | required | Source image (public URL) |
| `prompt` | required | Already-rendered prompt text (use `renderPrompt` first) |
| `provider` | `"wavespeed-gpt-image-2"` | Primary provider — see catalog below |
| `fallbackProviders` | `[]` | Tried in order if primary's submit fails transiently |
| `size` | provider default | `"1024*1024"`, `"1024x1024"`, etc. |
| `kind` | null | Free-form tag — `"rating"`, `"gallery-renaissance"`, etc. |
| `metadata` | null | Free-form jsonb — engine never reads it |
| `id` | random UUID | Pre-generate if you need the ID before insert |

**Provider catalog:**

| Name | Gateway | Model | Notes |
|---|---|---|---|
| `wavespeed-gpt-image-2` | Wavespeed.ai | OpenAI gpt-image-2 | Default. Best for text-rich + multilingual scenes. |
| `wavespeed-nano-banana-pro` | Wavespeed.ai | Google Nano Banana Pro | High fidelity, slower. |
| `wavespeed-nano-banana-fast` | Wavespeed.ai | Google Nano Banana 2 Fast | Faster + cheaper tier. |
| `fal-gpt-image-2` | Fal.ai queue | OpenAI gpt-image-2 | Same model as wavespeed-gpt-image-2 via a different gateway. Useful as a fallback. |

**Recommended default for new apps:**
```ts
provider: "wavespeed-gpt-image-2",
fallbackProviders: ["fal-gpt-image-2"],
```

**Fallback semantics:**
- Transient errors (network, 5xx, 408, 429) → walk the chain.
- Hard errors (401/403, 4xx other than 408/429, missing API key) → fail
  fast without trying fallbacks. Config errors aren't transient.
- Once a provider accepts the job and returns a task ID, polling
  sticks with that provider. Task IDs are provider-specific.
- The `generations.provider` column reflects which provider actually
  accepted (after any fallback).

**Env required:** depends on provider chain. Set every key for every
gateway you might fall back to. Always need `NEXT_PUBLIC_SUPABASE_URL`
+ `SUPABASE_SERVICE_ROLE_KEY` for the SupabaseClient.

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

### `<MultiProviderRunner />` (admin testbench primitive)

Side-by-side comparison runner for prompt iteration. Submits the same
generation to N providers in parallel, shows result panels with
elapsed timers, optional "Save prompt" buttons.

```tsx
import { MultiProviderRunner } from "commongenerator/react";
import { getModelFamily } from "commongenerator";

<MultiProviderRunner
  providers={[
    "wavespeed-gpt-image-2",
    "wavespeed-nano-banana-pro",
    "fal-gpt-image-2",
  ]}
  buildBody={(provider) => ({
    upload_url: imageUrl,
    style: selectedStyle,
    provider,
    prompt_override: promptForFamily(getModelFamily(provider)),
  })}
  onSave={async (provider) => {
    const family = getModelFamily(provider);
    await fetch("/api/admin/save-prompt", {
      method: "POST",
      body: JSON.stringify({
        style: selectedStyle,
        family,
        prompt_text: promptForFamily(family),
      }),
    });
  }}
/>
```

**Recommended pattern:** save prompts per **model family**
(`gpt-image-2`, `nano-banana`) rather than per specific provider —
same model behaves the same regardless of gateway. Use
`getModelFamily(provider)` to bucket.

### `getModelFamily(provider) → ModelFamily`

Maps a provider name to its model family:
- `wavespeed-gpt-image-2`, `fal-gpt-image-2` → `"gpt-image-2"`
- `wavespeed-nano-banana-pro`, `wavespeed-nano-banana-fast` → `"nano-banana"`

### `createAdminMiddleware(config?) → Next middleware`

Single-secret admin auth. Reads `ADMIN_SECRET` env var, gates routes
by checking a cookie whose value equals the secret.

```ts
// src/middleware.ts in the consuming app
import { createAdminMiddleware } from "commongenerator/auth";

export const middleware = createAdminMiddleware({
  cookieName: "myapp_admin",  // unique-per-app to avoid *.vercel.app collisions
});

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
```

| Option | Default | Notes |
|---|---|---|
| `envVar` | `"ADMIN_SECRET"` | Env var holding the secret |
| `cookieName` | `"admin_session"` | Pick a unique value per app |
| `loginPath` | `"/admin/login"` | Where to redirect unauth'd page requests |
| `allowPaths` | `[]` | Extra always-allowed paths beyond loginPath, /api/admin/login, /api/admin/logout |

Without the env var set, middleware returns 503 (refuses to run
unsafely). Pages get redirected to login with `?from=`. APIs get 401.

### `createAdminLoginRoute(config?)` / `createAdminLogoutRoute(config?)`

Companion route factories for the login form's POST endpoint.

```ts
// src/app/api/admin/login/route.ts
import {
  createAdminLoginRoute,
  createAdminLogoutRoute,
} from "commongenerator/auth";

export const runtime = "nodejs";
export const POST = createAdminLoginRoute({ cookieName: "myapp_admin" });
export const DELETE = createAdminLogoutRoute({ cookieName: "myapp_admin" });
```

POST validates `{ secret }` JSON body against the env var, sets the
cookie on success (httpOnly, SameSite=Lax, Secure in prod, 30-day
default). DELETE clears it.

### `<AdminLoginForm />`

Drop-in client login form. Mounts on the login page, POSTs to the
login endpoint, redirects to `?from=` query param on success.

```tsx
// src/app/admin/login/page.tsx
import { AdminLoginForm } from "commongenerator/react";

export const metadata = { robots: { index: false, follow: false } };

export default function AdminLoginPage() {
  return <AdminLoginForm title="🐶 MyApp admin" redirectTo="/admin/test" />;
}
```

| Prop | Default | Notes |
|---|---|---|
| `redirectTo` | `"/admin"` | Fallback if no `?from=` query param |
| `endpoint` | `"/api/admin/login"` | POST target |
| `title` | `"Admin Login"` | Header text |

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
4. (No DB-migration step — `provider` is `text` with no check constraint; the engine validates names at the TS layer)
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
     defaultProvider: "wavespeed-gpt-image-2",
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
   accepts whatever public URL you already have. **Add the
   `compressImage` utility from §8** before uploading — saves
   10-30s end-to-end on most generations.

8. **Wire admin auth** — three small files (see §7 for details):

   ```ts
   // src/middleware.ts
   import { createAdminMiddleware } from "commongenerator/auth";
   export const middleware = createAdminMiddleware({ cookieName: "myapp_admin" });
   export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
   ```

   ```tsx
   // src/app/admin/login/page.tsx
   import { AdminLoginForm } from "commongenerator/react";
   export default function Page() {
     return <AdminLoginForm title="MyApp admin" redirectTo="/admin/test" />;
   }
   ```

   ```ts
   // src/app/api/admin/login/route.ts
   import { createAdminLoginRoute, createAdminLogoutRoute } from "commongenerator/auth";
   export const runtime = "nodejs";
   export const POST = createAdminLoginRoute({ cookieName: "myapp_admin" });
   export const DELETE = createAdminLogoutRoute({ cookieName: "myapp_admin" });
   ```

   Set `ADMIN_SECRET` in Vercel (Production + Preview — see §10
   for the Development-scope gotcha). Without it, middleware
   returns 503.

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

## 7. Admin testbench pattern

Every project that ships AI-generated content needs prompt iteration
infrastructure: change a prompt → see how it renders → save the
winning version. Building this from scratch per project would be
~500 lines × N projects. The engine ships the reusable pieces
(provider runner + auth + login form), each app provides ~250 lines
of project-specific glue (prompt schema, form fields, save endpoint).

**Reference implementations:**
- `gogo-gallery/src/app/admin/test/page.tsx` (style + subject schema)
- `dograting/src/app/admin/test/page.tsx` (rating-card schema with
  test-variable fields like dog_name, age, breed)

### The pieces

```
src/middleware.ts                         ← createAdminMiddleware (gates routes)
src/app/admin/login/page.tsx              ← <AdminLoginForm />
src/app/api/admin/login/route.ts          ← createAdminLoginRoute + Logout
src/app/admin/test/page.tsx               ← project-specific UI + <MultiProviderRunner />
src/app/api/admin/get-prompt/route.ts     ← project-specific GET handler
src/app/api/admin/save-prompt/route.ts    ← project-specific POST handler
src/app/api/admin/settings/route.ts       ← optional: default-provider knob
```

### Per-family prompt schema (recommended)

Store one prompt per **model family**, not per specific provider —
`wavespeed-gpt-image-2` and `fal-gpt-image-2` route to the same
underlying model so the same prompt works for both. Use
`getModelFamily(provider)` to bucket.

Schema for the project's `prompts` table:

```sql
create table public.prompts (
  id uuid primary key default gen_random_uuid(),
  kind text not null,           -- e.g. "rating-card", "stickers-wave", "outfit-overlay"
  prompt_text text not null,    -- nano-banana family (default for all non-gpt-image-2 providers)
  gpt_image_2_prompt_text text, -- gpt-image-2 fork; falls back to prompt_text if NULL
  description text,             -- human-readable note for admins
  version int default 1,
  updated_at timestamptz default now(),
  unique(kind)
);

create table public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

insert into public.settings (key, value) values
  ('default_provider', 'wavespeed-nano-banana-fast');
```

### Server-side prompt resolution

```ts
// src/lib/prompts.ts
import { type ModelFamily } from "commongenerator";
import { getServerSupabase } from "./supabase";

export async function fetchPromptTemplate(
  kind: string,
  family: ModelFamily,
): Promise<string> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("prompts")
    .select("prompt_text, gpt_image_2_prompt_text")
    .eq("kind", kind)
    .single();
  if (error || !data) throw new Error(`Prompt "${kind}" not found`);
  return family === "gpt-image-2" && data.gpt_image_2_prompt_text?.trim()
    ? data.gpt_image_2_prompt_text
    : data.prompt_text;
}
```

Then in `/api/generate`:

```ts
const family = getModelFamily(provider);
const template = await fetchPromptTemplate("rating-card", family);
const prompt = renderPrompt(template, { dog_name, age, breed, ... });
```

### Recipe: spinning up the testbench for a new project

1. Apply the SQL migration to your project's Supabase (prompts table
   schema above, plus settings table).
2. Seed your prompts table with a row for each `kind` you support.
3. Add `src/middleware.ts` (3 lines, picks a unique cookieName).
4. Add `src/app/admin/login/page.tsx` (3 lines, mounts `<AdminLoginForm />`).
5. Add `src/app/api/admin/login/route.ts` (3 lines, factory wrappers).
6. Write the project-specific admin/test page using `<MultiProviderRunner />`
   — copy DogRating's as a starting point, swap the prompt-form section for
   your project's schema (whatever variables your prompts have).
7. Wire `/api/admin/get-prompt` and `/api/admin/save-prompt` against
   your project's prompts table. Both are project-specific because the
   schema varies — usually 30-50 lines each.
8. Optional: `/api/admin/settings` for the default-provider dropdown
   (reuses the generic ALL_PROVIDERS validation).
9. Set `ADMIN_SECRET` in Vercel for all 3 scopes; deploy.

Total per project: ~300-400 lines, mostly the admin/test page UI.

---

## 8. Image compression utility

Phones produce 4-12 MB photos. Sending those raw inflates upload
time, the AI provider's image-fetch step (OpenAI's 30s timeout
triggers on slow fetches), and the model's inference cost
(gpt-image-2 is sensitive to input size). Resizing to 1024px / JPEG
q=70 cuts payload to <500 KB and shaves 10-30s off end-to-end
generation time.

**Pattern (NOT in the engine — copy this util into each project):**

```ts
// src/lib/compress-image.ts
export async function compressImage(
  file: File | Blob,
  opts: { maxDimension?: number; quality?: number } = {},
): Promise<Blob> {
  const maxDim = opts.maxDimension ?? 1024;
  const quality = opts.quality ?? 0.7;

  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob null"))),
      "image/jpeg",
      quality,
    );
  });
}
```

Wire it BEFORE the upload to Storage:

```tsx
const compressed = await compressImage(file);
await sb.storage.from("uploads").upload(path, compressed, {
  contentType: "image/jpeg",
});
```

Why not in the engine: it's pure browser code (uses
`createImageBitmap`, `<canvas>`, `document.createElement`) and
projects often want to tune defaults (max dim, quality, output format)
per their use case. Promote to engine if a 3rd or 4th project needs
the exact same shape.

`imageOrientation: "from-image"` is required so EXIF rotation is
applied — without it, mobile portrait photos come out sideways.

---

## 9. Database schema

The `sql/0001_generations.sql` migration creates one table:

```sql
generations (
  id uuid primary key,
  kind text,                 -- free-form, e.g. "rating", "sticker-3"
  original_image_url text,
  result_image_url text,
  prompt text,
  provider text,             -- e.g. "wavespeed-gpt-image-2", "fal-gpt-image-2"
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

## 10. Required environment variables

Per consuming app (each app has its own values):

| Var | Required when | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | always | Per-project Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | always | For client-side uploads to Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | always | Server-only, used by the engine |
| `OPENAI_API_KEY` | when using `analyzeImage` | gpt-4o-mini calls |
| `WAVESPEED_API_KEY` | when using a `wavespeed-*` provider | covers all 3 wavespeed model variants |
| `FAL_API_KEY` | when using `fal-gpt-image-2` provider | |
| `CLOUDINARY_CLOUD_NAME` | when calling `applyCloudinaryTransform` | |
| `ADMIN_SECRET` | when admin auth middleware is wired | required for `/admin/*` access; without it, middleware returns 503 (refuses to operate unsafely). Generate with `openssl rand -base64 32`. |

Per the project-separation rule: **never share keys across projects.**
Each app gets its own Supabase project, OpenAI key, Wavespeed key,
Cloudinary cloud, etc. Spend caps and abuse blast radius are then
per-project.

### Vercel "Sensitive" env var gotcha

Vercel auto-flags variables containing "SECRET", "KEY", "TOKEN" etc.
as Sensitive. Sensitive vars **cannot be set in the Development
scope** via the dashboard — only Production and Preview. Two
workarounds:

1. **(Recommended)** Set `ADMIN_SECRET` only in Production + Preview
   on Vercel. For local development, generate a separate value and
   put it directly in your local `.env.local`. The local value only
   guards local dev (already private to your machine), so it can be
   anything — `admin123` is fine for local. Production gets the
   strong random value.

2. Uncheck the "Sensitive" toggle when adding the variable in Vercel.
   The value becomes readable in the dashboard going forward — fine
   for a value used by only one or two people, less ideal otherwise.

---

## 11. Versioning + updates

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

## 12. Known limitations / future work

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

## 13. Quick reference: "I want to build a new project that does X"

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

1. Create a new Next.js 16 app (use gogo-gallery or DogRating as
   the template — same stack, same patterns)
2. Create a new Supabase project (separate from sibling apps —
   project-separation rule). DogRating + gogo-gallery + every new
   app has its own.
3. Apply `sql/0001_generations.sql` to it. Add a `prompts` table
   with the per-family fork schema from §7.
4. Install `commongenerator` from GitHub:
   `npm install github:yabroexperiments/commongenerator#main`
5. Wire `/api/generate` and `/api/status/[id]` via the route
   factories (§5 step 5)
6. Wire admin auth: middleware + login page + login route (§5 step 8).
   Set `ADMIN_SECRET` in Vercel.
7. Build the user-facing upload form + result page using the React
   hook. Add `compressImage` (§8) before the Storage upload.
8. Build the `/admin/test` prompt playground (§7 recipe). Compares
   3 providers side-by-side via `<MultiProviderRunner />`, saves
   per family.
9. Seed your prompts table with one row per `kind` you support.
   Iterate from `/admin/test` — no engine changes needed for prompt
   tweaks.

For workflows beyond single-image (rating cards, sticker packs,
outfit suggestions, etc.) see section 6 patterns and orchestrate
multiple `startGeneration` calls from your app.

### Cookie name conflicts on *.vercel.app

When multiple sibling apps deploy to the same `*.vercel.app` parent
domain, browsers may share cookies across them depending on Domain
settings. To avoid one app's admin session leaking into another's
auth check, **pick a unique `cookieName` per project**:
`gogo_gallery_admin`, `dograting_admin`, `linestickers_admin`, etc.
The middleware factory makes this a one-line config option.
