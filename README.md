# commongenerator

Shared image-generation engine for the 狗仔 product family (gogo-gallery,
DogRating, LINE Stickers, …).

## What it does

Three primitives:

- `analyzeImage(imageUrl, prompt)` — optional vision pre-step
- `startGeneration(...)` + `getGenerationStatus(id)` — async image edit pair, with optional fallback chain
- `applyCloudinaryTransform(...)` — generic Cloudinary post-processing

Plus reusable building blocks:

- **Provider catalog** — `wavespeed-gpt-image-2`, `wavespeed-nano-banana-pro`, `wavespeed-nano-banana-fast`, `fal-gpt-image-2`. Selectable per request, with fallback support.
- **Admin auth** — `createAdminMiddleware`, `createAdminLoginRoute/Logout`, `<AdminLoginForm />`. Single-secret pattern; ~10 lines per project.
- **Admin testbench** — `<MultiProviderRunner />`. Side-by-side compare across providers + per-family save buttons.
- **Model families** — `getModelFamily(provider)` for per-family prompt storage (one prompt for `gpt-image-2` works for both gateways).
- **Next.js route factories** — `createGenerateRoute`, `createStatusRoute` (with optional postCompletion hook).
- **React** — `useGenerationStatus` polling hook.

## Install (per app)

```bash
npm install github:yabroexperiments/commongenerator#main
```

Pin to a SHA for stability: `commongenerator#abc1234`.

## Required env per consuming app

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=         # for analyzeImage
WAVESPEED_API_KEY=      # for any wavespeed-* provider
FAL_API_KEY=            # for fal-gpt-image-2
CLOUDINARY_CLOUD_NAME=  # for applyCloudinaryTransform
ADMIN_SECRET=           # for admin auth middleware
```

Each app has its own keys / Supabase project — the engine is
credential-agnostic and configured per-call.

## Database

Each app applies `sql/0001_generations.sql` to its own Supabase project.
Apps using the admin testbench also create a `prompts` table with
per-family fork columns and a `settings` table — see [INTEGRATION_GUIDE.md §7](INTEGRATION_GUIDE.md).

## Detailed reference

See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md) for:
- Repo structure
- Public API reference
- Provider abstraction + how to add a new provider
- Step-by-step recipe for wiring into a new Next.js app
- Workflow patterns (single image / multi-image / batch)
- Admin testbench pattern (per-family prompts + auth + runner)
- Image compression utility (recommended pre-upload step)
- Required env vars
- Versioning / breaking-change protocol
- Known limitations
