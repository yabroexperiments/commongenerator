# 2026-08-29 — live-guard: injectable fetch for the openai provider's internal Supabase client

**Agent:** Claude (Fable 5) · **Branch:** main (worked in worktree branch `claude/reverent-satoshi-d3eb80`, fast-forwarded to main) · **Engine commit:** `2b48478`

## Done

- **Engine (`2b48478`)**: new optional `supabaseFetch?: FetchLike` on
  `StartGenerationInput` + `SubmitOpts`, exported from the barrel. Threaded
  `startGeneration → submitGenerationToProvider → provider.submit →
  uploadResultToSupabase → createClient({ global: { fetch } })`. Closes the
  live-guard residual gap (workspace FACTS.md §87): the openai provider's
  result-PNG archive was the one engine write bypassing the consumer's guarded
  client. Omitted → `global` not passed, supabase-js uses global fetch —
  backward-compatible by construction. Gateway providers ignore it.
- **furrybooth (`75a2b6c`)**: pin bumped `7274825 → 2b48478` (surgical 3-line
  SHA edit, protocols preserved); `guardedServerFetch` exported from
  `src/lib/supabase.ts` and passed in `generateViaProvider`'s `provider.submit`.
- **furrybooth (`67144b4`)**: `vercel.json` `"installCommand": "npm ci"` — see
  Gotchas. Production deploy READY + aliased (furrybooth.com).
- **dograting (`c1802d7`)**: lock re-resolved `#main` `508cad1 → 2b48478`;
  `supabaseFetch: guardedSupabaseFetch` in both `buildPrompt` branches of
  `/api/generate`; same `npm ci` installCommand. Production deploy READY + aliased.
- CLAUDE.md updated: new primitives table (2026-08-29 section) + **Critical #2**
  in Build/release about the Vercel install-cache trap.

## Verified (all offline, zero spend, real code both sides)

- Engine offline gate (scratchpad script, run against compiled dist, global
  fetch stubbed): (A) injected fetch carries the storage write, global sees 0;
  (B) omitted → global carries it (old behavior); (C) throwing guard fails the
  upload loudly after the 3-attempt retry (~6s backoff — loud, not silent).
- End-to-end residual-gap repro with furrybooth's REAL compiled
  `guardedServerFetch` + the engine installed in its node_modules:
  `LOCAL_LIVE=paid` only → archive write blocked by live-guard, **0 storage
  requests reached the wire**; `LOCAL_LIVE=paid,storage` → archive completes.
- Consumers: `npm ci` / `tsc --noEmit` (0 errors) / `next build` (exit 0) /
  live-guard offline gates (furrybooth 27/27, dograting 33/33). Both prod
  deployments gated on MY commit's sha via the deployments API → READY +
  aliasAssigned; pushes verified by content (`git show origin/main:<path>`),
  not just ancestry.

## Gotchas (the expensive one)

- **Vercel's default `npm install` + restored build cache IGNORES a git-dep SHA
  bump.** This package's `version` never changes (consumers pin SHAs), so with
  a cached `node_modules` npm reports `up to date in <1s` and keeps the OLD
  engine. Furrybooth's first deploy of the bump commit (`dpl_CpKKvLJH…`) failed
  typecheck against the old engine's types — while local `npm ci` was green.
  Fix shipped: `"installCommand": "npm ci"` in both consumers' vercel.json.
  **Any new consumer needs the same line at its first engine bump.**
- The typecheck failure itself is a free deploy discriminator: a call site
  using a new engine field can only compile against the new engine, so a green
  build proves which engine got installed (negative control observed on the
  failed deploy).
- furrybooth's pre-commit hook warns "resolved URL rewritten to git+ssh" on any
  lock line change containing `git+ssh` — false positive here (the protocol was
  already git+ssh at HEAD; only the SHA changed; diff verified 3 lines).
- dograting's lock gained a `"name": "@yabroexperiments/commongenerator"` line —
  expected: npm recorded the scoped name from the GitHub-Packages prep commit
  (`260ed42`). Harmless; the dep key stays `commongenerator`.

## Left / not in scope

- **gogo-gallery / gogolinesticker**: no live-guard module yet, so there is no
  guarded fetch to pass — wiring `supabaseFetch` there belongs to each repo's
  live-guard rollout (FACTS.md §87 coverage table), not to this change.
- The blocked-write path burns the engine's 3 upload retries (~6s) before
  throwing. Acceptable (guard blocks are rare + local-only); if it ever
  matters, teach `uploadResultToSupabase` to treat a `[live-guard]` error as
  hard and skip retries.

## How to resume

Nothing pending for this task. For a future consumer: bump the lock, pass its
guarded fetch as `supabaseFetch` (call-site or buildPrompt), confirm its
vercel.json has `"installCommand": "npm ci"`, run its live-guard gate + build.
