# 2026-05-13 — Multi-image input through the engine

## Done

Added an optional `additionalImageUrls?: string[]` field that threads
from `StartGenerationInput` → engine route factory → `submitGeneration
ToProvider` → `SubmitOpts` → providers. Only `openai-gpt-image-2`
consumes it (sends repeated `image[]` form fields to OpenAI's
`/v1/images/edits` — gpt-image-2 documented to support up to 16 input
references). Other providers silently ignore it.

Backward-compatible. `additionalImageUrls` is optional everywhere; if
omitted the behavior is identical to before. DogRating (single-image
consumer) is unaffected.

Engine also persists the extras into `metadata.additional_image_urls`
on the generations row so post-completion hooks see the full set
(`original_image_url` column stays single by design).

## Files touched

- `src/types.ts` — `StartGenerationInput.additionalImageUrls?`
- `src/providers/index.ts` — `SubmitOpts.additionalImageUrls?`
- `src/providers/openai.ts` — switch from `image` to `image[]` form
  fields when extras are present; download all sources via
  `Promise.all`
- `src/generate.ts` — thread through `submitGenerationToProvider`;
  persist into metadata in `insertGenerationRow`
- `src/routes/generate.ts` — thread through `enginePayload`

## Gotchas

- **Cap callers at 5 images for UX.** OpenAI allows 16; we don't want
  to test payload-size edge cases right now.
- **Fallback chain silently degrades to single-image.** If openai-gpt-
  image-2 fails over to wavespeed/fal, only the primary `imageUrl` is
  used. This is acceptable for the LINE sticker use case (rare path)
  but consumers should log when fallback fires on a multi-image input.
- **OpenAI `image[]` form**: each part must be uniquely named so curl/
  fetch boundaries don't collide. Filename built from index + ext to
  satisfy OpenAI's content-sniffing.

## How to resume / how consumers pick this up

1. (Already done in this commit:) engine built + push.
2. Consumer (gogoLINEsticker or any future multi-image app):
   ```bash
   cd <app>
   npm install commongenerator
   git add package-lock.json
   git commit -m "Bump commongenerator to <SHA> (multi-image input)"
   git push
   ```
3. DogRating does not need a bump for this change (additive only),
   but bumping at next opportunity will keep its lock fresh.
