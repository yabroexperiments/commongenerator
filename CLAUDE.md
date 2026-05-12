# CLAUDE.md — commongenerator (shared engine for the 狗仔 family)

## Cross-machine workflow (Claude Code · Codex CLI · Codex Web)

This project syncs through GitHub. Same rules apply wherever you operate.

**Session start:**
1. `git pull --ff-only` (skip on Codex Web — the container is already at HEAD).
2. Read the latest `.handoffs/*.md` and `.handoffs/INDEX.md` — the bridge from the previous session.

**Session end (mandatory):**
1. Write `.handoffs/YYYY-MM-DD-<task>.md` with: Done · Left · Gotchas · Files touched · How to resume.
2. Commit + push everything stable. Feature branches (`feat/...`) for half-done work. No force-push to `main`. No committing `.env` or any real secret.

**File convention:**
- `CLAUDE.md` is the canonical project brief. `AGENTS.md` in the same directory is a **symlink** to it — both names resolve to the same content for Claude Code and Codex.
- Never replace `AGENTS.md` with a regular file (atomic-save tools can do this). Use in-place writes.
- If `AGENTS.md` ever becomes a regular file: `rm AGENTS.md && ln -s CLAUDE.md AGENTS.md`. Server-side enforcement: `.github/workflows/agents-symlink.yml`. Local enforcement: `.githooks/pre-commit`.

**Fresh clone setup (one-time):** `./setup.sh` — wires up the tracked git hooks.

---

> This file is for someone **editing the engine itself**. If you're
> just consuming the engine from a child app, read `INTEGRATION_GUIDE.md`
> and `README.md` instead.
>
> Read this AND `PetBusiness/CLAUDE.md` (the umbrella) at the start
> of every session.

---

## Who I Am

- Name: Albert, non-technical founder based in Taiwan.
- I drive product. You write all the code.
- Always explain what you're doing in plain language before doing it.
- If there are multiple ways, tell me the tradeoffs simply and recommend one.
- Ask before installing new dependencies or making big structural changes.

---

## What this engine is

`commongenerator` is the shared image-generation engine for the
狗仔 product family — gogo-gallery, DogRating, planned LINE Stickers
and Pet Outfits. Each consuming app installs via:

```
npm install github:yabroexperiments/commongenerator#main
```

…and gets:

| Layer | What's in it |
|---|---|
| Provider abstraction | `openai-gpt-image-2`, `wavespeed-gpt-image-2`, `wavespeed-nano-banana-pro/fast`, `fal-gpt-image-2`. Same submit/pollResult interface across all. |
| Engine API | `startGeneration` / `getGenerationStatus` / `analyzeImage` / `applyCloudinaryTransform` / `verifyTurnstileToken` |
| Next.js route factories | `createGenerateRoute` / `createStatusRoute` / `createQuotaRoute` / `createEmailBypassRoute` / `createAdminLoginRoute` |
| Admin auth helpers | `createAdminMiddleware` + `<AdminLoginForm />` |
| React primitives | `MultiProviderRunner`, `useGenerationStatus`, `useQuota`, `useEmailBypass`, `TurnstileWidget`, `AdminLoginForm` |
| Rate-limit primitives | `createRateLimit`, `checkQuota`, email normalization, cookie helpers |

The engine **never reads its own credentials** — every consuming
app passes a `SupabaseClient` (or env-key string) per call. The
engine is credential-agnostic; per-app keys stay per-app.

---

## Design philosophy

- **Engine = thin platform; apps = thick clients.** Engine ships
  primitives + extension points; apps own policy + visuals + UX.
  Same split everywhere:
  - Auth: engine ships factories, app picks cookie name + secret
  - Prompts: engine ships `renderPrompt`, app owns prompts table
  - Providers: engine ships catalog, app picks defaults + fallback chain
  - Rate-limit: engine ships counter mechanism, app picks numbers + identity model
  - Turnstile: engine ships verifier + widget, app picks where it renders

- **Promote to engine when a 2nd app needs identical shape.** Same
  rule the handoff documented for `compressImage`: ship in the
  first app, lift to engine when the second app needs it. Avoids
  premature abstraction.

- **Never break consumers without a migration path.** New options
  on factories should be optional. New required env vars need a
  fallback. SQL changes ship as numbered migrations
  (`sql/000N_*.sql`) that consumers apply per-Supabase-project;
  the engine never auto-migrates.

---

## Repo structure

```
commongenerator/
├── INTEGRATION_GUIDE.md     # for CONSUMING apps (read this if writing app code)
├── README.md                # TL;DR + provider catalog
├── CLAUDE.md                # ← you're here — for engine MAINTAINERS
├── package.json             # main: dist/index.js. Subpath exports for /routes /react /auth.
├── sql/
│   ├── 0001_generations.sql         # core tracking table
│   ├── 0002_rename_providers.sql    # legacy migration (provider names + check-constraint drop)
│   └── 0003_rate_limit.sql          # user_id + user_email columns + user_emails table
└── src/
    ├── index.ts             # public API barrel
    ├── analyze.ts           # analyzeImage + retries
    ├── generate.ts          # startGeneration / getGenerationStatus + insertGenerationRow / submitGenerationToProvider
    ├── db.ts                # internal Supabase generations CRUD
    ├── types.ts             # ProviderName union, GenerationRow, StartGenerationInput
    ├── providers/           # one file per gateway: wavespeed, fal, openai
    ├── rate-limit.ts        # createRateLimit, checkQuota, email normalization
    ├── turnstile.ts         # verifyTurnstileToken
    ├── render-prompt.ts     # {var} substitution
    ├── cloudinary.ts        # applyCloudinaryTransform helpers
    ├── model-families.ts    # provider → family map
    ├── auth/                # createAdminMiddleware + login route factory
    ├── routes/              # createGenerateRoute / createStatusRoute / createQuotaRoute / createEmailBypassRoute
    └── react/               # MultiProviderRunner / hooks / TurnstileWidget / AdminLoginForm
```

`dist/` is gitignored — npm `prepare` script runs `tsc` on install
so consumers always get freshly compiled output from whatever SHA
they pin.

---

## Build / release process

The engine has no version bumps; consumers pin to commit SHAs via
git URL.

**To ship a change:**

```
cd commongenerator
# 1. Edit src/, run npm run build to verify tsc passes
npm run build

# 2. Commit (HEREDOC, Co-Authored-By line)
git add src/<files>  # specific files only — NEVER -A
git commit -m "<concise>"
git push

# 3. In each consuming app, bump the lock to pull the new SHA:
cd ../<app>/app
npm install commongenerator           # rewrites package-lock to current main HEAD
git add package-lock.json
git commit -m "Bump commongenerator to <SHA> (<reason>)"
git push
```

**Critical:** consumers' `npm ci` (Vercel build) follows the resolved
SHA in `package-lock.json` strictly. Pushing to commongenerator main
does NOT cause Vercel to pick it up on the next consumer deploy.
The consumer's lock has to be bumped + committed for Vercel to fetch
the new engine code. **Empty redeploy commits do not help.**

This is the #1 confusing-failure-mode for engine bumps. Document
it in the commit message when you ship to make sure the operator
running the consumer-side bump knows.

---

## When to add to engine vs. per-app

| Looks like… | Add to… | Examples |
|---|---|---|
| New provider implementation | Engine `src/providers/` | `openai-gpt-image-2` |
| Cross-cutting infra (auth, rate-limit, vision) | Engine | `createRateLimit`, `verifyTurnstileToken` |
| Reusable React primitive (no business logic) | Engine `src/react/` | `MultiProviderRunner`, `TurnstileWidget` |
| Image-format normalization (color space, dimensions) | Engine provider hooks | Cloudinary URL `f_jpg,q_auto` rewrite in openai provider |
| App-specific policy decisions | Per-app | Rate-limit numbers, error messages, quality defaults |
| Visual / styling | Per-app | Modal markup, badge placement, copy |
| Prompts | Per-app | Each app's `prompts` table |
| Identity (cookie names, admin secrets) | Per-app | `dograting_admin`, `gogo_gallery_admin` |

**Rule of thumb:** if the same code would copy-paste verbatim into
the second app, it's an engine candidate. If it'd diverge per app,
keep it app-side.

---

## Recently added primitives (2026-05-09 → 2026-05-10)

| Primitive | What it gives consumers |
|---|---|
| `openai-gpt-image-2` provider | Direct OpenAI `/v1/images/edits` calls; bypasses Wavespeed/Fal gateways. Synchronous (full inference inside `submit()`); auto-uploads result PNG to Supabase Storage at `<generationId>.png`. Auto-rewrites Cloudinary URLs to sRGB JPEG to dodge OpenAI's "Invalid image file" rejection of Display P3. |
| `createRateLimit({ cookieName, freeLimitPerWindow, emailBypassLimitPerWindow, windowDays, exceededMessageFree, exceededMessageEmail, skipForAdminCookie })` | Per-user rate-limit hook for `createGenerateRoute`. Issues anonymous UUID cookie, counts rows in window, returns 429 with cookie + `require_email` flag. |
| `createEmailBypassRoute` | POST handler that binds typed email to cookie UUID, unlocking email-tier quota. |
| `createQuotaRoute` | GET handler returning `{used, limit, has_email, require_email, is_admin}` — same options as `createRateLimit`; apps share config between the two. |
| `useEmailBypass` / `useQuota` | React hooks for the modal + quota badge. App owns visuals. |
| `verifyTurnstileToken` + `verifyTurnstile?` option on `createGenerateRoute` | Cloudflare Turnstile gate. 5s AbortSignal timeout, fail-closed on network errors. Forwards `CF-Connecting-IP` to siteverify. |
| `<TurnstileWidget />` | Client component. Loads CF script once, manages widget lifecycle. Configurable size/appearance/theme. |
| `MultiProviderRunner.productionProvider` prop | Highlights the matching panel with a red ring + "IN PROD" badge so operators see at a glance which result real users get. |
| `DEFAULT_COMPARE_ORDER` const | Canonical "best → fast" provider order for consumers' admin testbenches. Apps import + pass to `MultiProviderRunner`; engine reorders → all sister apps follow. |

---

## Provider abstraction notes

The `ImageProvider` interface assumes **submit + poll** semantics —
`submit` returns a taskId fast (5–15s), `pollResult` is called
every poll interval until terminal.

`openai-gpt-image-2` doesn't fit this naturally — OpenAI's
`/v1/images/edits` is **synchronous** (15–90s blocking call). The
adapter:

1. `submit()` does the full work: download source URL → multipart
   POST to OpenAI → b64_json result → upload PNG to Supabase
   Storage at `<generationId>.png` → returns the public Storage URL
   as the synthetic taskId
2. `pollResult(taskId)` is a no-op: returns
   `{ status: "completed", imageUrl: taskId }` instantly

This means consumers using the synchronous provider need
`maxDuration ≥ 60s` on the calling route (Vercel Pro: up to 300s).
At `quality: high` (40–90s) it still doesn't always fit; default
to `medium` and document the constraint. The provider takes an
optional `generationId` in `SubmitOpts` so its Storage path
collides cleanly with downstream archive steps.

---

## Cross-cutting gotchas to remember

These hit during the 2026-05-09→05-10 build of DogRating's full
stack. Document any future ones here.

- **Vercel `npm ci` is strict about package-lock.** Consumer bumps
  need a real `npm install commongenerator` + lock commit. Empty
  commits don't propagate engine changes.
- **Vercel auto-Sensitive on `KEY` / `SECRET` / `TOKEN` / `PASSWORD`
  in env var names** prevents build-time injection. For
  `NEXT_PUBLIC_*` vars (which Next.js inlines at build), use names
  WITHOUT those trigger words (e.g. `NEXT_PUBLIC_TURNSTILE_SITE`,
  not `..._SITE_KEY`).
- **Supabase rolled out new key formats** (`sb_secret_*` /
  `sb_publishable_*`) which are NOT JWTs. Raw `Authorization: Bearer
  sb_secret_...` to Storage 403s with "Invalid Compact JWS". Engine
  uploads via supabase-js SDK to handle both legacy and new formats.
- **Cloudinary serves source-color-profile JPEGs.** iPhone uploads
  arrive as Display P3 wide-gamut. OpenAI rejects with
  `invalid_image_file`. Engine inserts
  `f_jpg,q_auto,c_limit,w_2048` URL transform on Cloudinary URLs
  before handing to OpenAI.
- **`generations.provider` `CHECK` constraint may exist on legacy
  Supabase projects.** New provider names trigger 23514 violations.
  `sql/0002_rename_providers.sql` drops it; document in consumers'
  migration recipes.
- **Stuck "processing" rows**: client polls only while user is on
  the loading page. If they close it mid-gen, the row stays
  processing forever. Recommend consumers add a server-side lazy-
  flip on their result page (call `getGenerationStatus` once before
  rendering processing state).

---

## Build verification

The engine's tsc must pass cleanly before any push. `npm run build`
(which runs `tsc` directly) is sufficient.

For consumer typecheck verification (catches type drift between
engine + consumer), use `npm pack` to produce a tarball that
matches the GitHub install behavior:

```bash
cd commongenerator && npm pack
cd ../<app>/app && npm install ../../commongenerator/commongenerator-*.tgz --no-save
npx tsc --noEmit -p .
# Cleanup: npm install commongenerator   (back to GitHub-resolved version)
```

`file:` deps don't work for this — npm symlinks back to the source
which causes duplicate-`@supabase/supabase-js` type conflicts.

---

## Session start checklist (engine work)

1. Read this file + `PetBusiness/CLAUDE.md` umbrella.
2. Skim `INTEGRATION_GUIDE.md` Provider Catalog + Required Env sections
   to know what's currently shipped.
3. If adding a new provider or breaking change: plan the migration
   path for both DogRating and gogo-gallery before writing code.
4. After shipping, write the consumer-side bump steps in your
   commit message (or in chat) so the operator running each app's
   `npm install commongenerator` knows what to expect.
