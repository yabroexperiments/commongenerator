# commongenerator

Shared image-generation engine for the 狗仔 product family (gogo-gallery,
DogRating, LINE Stickers, …).

## What it does

Three primitives — that's it.

- `analyzeImage(imageUrl, prompt)` — optional vision pre-step
- `startGeneration(...)` + `getGenerationStatus(id)` — async image edit pair
- `applyCloudinaryTransform(...)` — generic Cloudinary post-processing

Plus Next.js route factories and a React polling hook to wire it up.

## Install (per app)

```bash
npm install github:yabroexperiments/commongenerator#main
```

Pin to a SHA for stability: `commongenerator#abc1234`.

## Required env per consuming app

```
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OPENAI_API_KEY=
WAVESPEED_API_KEY=     # optional, only if using Wavespeed provider
FAL_API_KEY=           # optional, only if using OpenAI-via-Fal provider
CLOUDINARY_CLOUD_NAME= # optional, only if calling applyCloudinaryTransform
```

Each app has its own keys/Supabase project — the engine is credential-agnostic
and is configured per-call.

## Database

Each app applies `sql/0001_generations.sql` to its own Supabase project.
