# Handoff — 2026-06-02 — MultiProviderRunner statusEndpoint prop

## Done
- Added optional `statusEndpoint?: (id: string) => string` to
  `MultiProviderRunner` (`src/react/multi-provider-runner.tsx`). It
  threads through `ResultPanel` → `useGenerationStatus({ endpoint })`.
- Closes the long-standing open engine task (documented in
  PetBusiness/CLAUDE.md "basePath-aware engine consumers" + the
  DogRating 2026-05-27 handoff): the runner already accepted `endpoint`
  for the `/api/generate` POST, but its internal status polling
  hardcoded `/api/status/{id}`, so basePath-mounted consumers
  (hahadoggo.com/scorecard) had testbench polling silently 404.
- `npm run build` (tsc) passes clean. Pushed to main.

## Backwards compatibility
- Prop is optional; `undefined` falls back to the hook's existing
  default `/api/status/${id}`. Non-basePath consumers (gogo-gallery on
  its own domain) are unaffected — no consumer-side change required for
  them.

## Commits
- `faf835a` — MultiProviderRunner: add statusEndpoint prop for basePath consumers

## Consumer bump status
- **DogRating**: bumped (lock → faf835a) + wired
  `statusEndpoint={(id) => apiPath(`/api/status/${id}`)}` in
  `/admin/test`. Shipped (dograting `3b45c80`).
- **gogoLINEsticker**: NOT bumped — it has no admin testbench, so it
  doesn't use MultiProviderRunner. No action needed unless/until it
  grows one.

## Files touched
- `src/react/multi-provider-runner.tsx` (props type + ResultPanel
  type + destructure + pass-through to useGenerationStatus)

## How to resume
- Nothing outstanding for this change. If a future basePath consumer
  builds a testbench, the pattern is: pass both `endpoint` and
  `statusEndpoint` wrapped in that app's `apiPath()`.
