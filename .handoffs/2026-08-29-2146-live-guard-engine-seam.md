# Handoff — 2026-08-29 21:46 (Asia/Taipei)

**Session:** close the engine-side live-guard gap, then roll live-guard coverage +
docs across every `commongenerator` consumer.
**Agent:** Claude (Fable 5, switched from Opus 5 mid-session) · **Repo:** commongenerator
· **Branch:** worked in worktree `claude/reverent-satoshi-d3eb80`, all commits pushed to `main`.

> **Note on location:** this repo's convention is `.handoffs/` + `.handoffs/INDEX.md`
> (CLAUDE.md lines 9/12), which is what `/backtowork` reads here. The `/wrap` command's
> generic `docs/handoffs/` path was deliberately NOT used — creating a second handoff
> directory would fragment where the next session looks. Repo rules win.

---

## 1. Mission

`commongenerator` is the shared image-generation engine for the 狗仔 family
(furrybooth · dograting · gogolinesticker · gogo-gallery). This session's mission was
the residual gap left by the 2026-08-29 workspace-wide **live-guard** rollout
(policy: `docs/agents/FACTS.md` §87, umbrella CLAUDE.md hard rule 15): a LOCAL process
must not mutate prod, send outward, or spend money unless explicitly armed via
`LOCAL_LIVE`. Consumers implement that by injecting a guarded `fetch` into the Supabase
client **they** construct — but the engine's `openai-gpt-image-2` provider builds its
**own** client from env vars to archive the result PNG, so that one write escaped every
consumer's guard.

## 2. Current State

- **Engine:** `origin/main` @ `f3d141f`. Clean. Feature shipped in `2b48478`.
- **All four consumers wired and deploy-verified** (except the archived one).
- **Docs:** FACTS.md §87 updated + new §92; every consumer CLAUDE.md now documents
  live-guard; global `~/.claude/CLAUDE.md` gained 3 new rules; yabro-hq mirror synced.
- **New tool:** `yabro-hq/scripts/sync-agents-docs.sh` (see §6).
- Nothing is half-done. No failing gate, no half-refactor.

## 3. Completed This Session

**Engine (`commongenerator`)**
- `2b48478` — optional `supabaseFetch` (type `FetchLike`) on `StartGenerationInput` +
  `SubmitOpts`, exported from the barrel. Threaded
  `startGeneration → submitGenerationToProvider → provider.submit →
  uploadResultToSupabase → createClient({ global: { fetch } })`. Omitted ⇒ the `global`
  key is not passed at all, so behaviour is byte-identical for existing consumers.
- `cd577ad` — CLAUDE.md: new primitives table + **"Critical #2"** in Build/release.
- `f3d141f` — amended the earlier brief once its "Left" section went stale.

**Consumers**
| Repo | Commits | State |
|---|---|---|
| furrybooth | `75a2b6c` wiring · `67144b4` npm-ci · `9cad4d1` docs | pushed, deploys READY |
| dograting | `c1802d7` wiring+npm-ci · `46ed118` docs | pushed, deploy READY |
| gogolinesticker | `6dec338` wiring+npm-ci+missing paid guard · `763ad42` docs | pushed, deploy READY |
| gogo-gallery | `45ebd2f` full port · `4048bbe` docs+gitignore · `74f6629` doc fix | **LOCAL ONLY** (archived remote) |

**Workspace docs**
- `docs/agents/FACTS.md` — §87 rewritten (residual CLOSED; gogo-gallery audit recorded
  as a closed decision), new **§92** (package-boundary lessons), yt-dlp date corrected.
- `docs/agents/MAINTENANCE.md` §5 — mirror-sync rule now points at an enforcing script.
- `~/.claude/CLAUDE.md` — 3 new global rules (see §6).
- yabro-hq mirror: `1a1411e`, `646747c` (script), `9996974` (docs sync).

## 4. In-Flight Work

**None.** Everything compiles, every gate passes, everything pushed where pushing is
possible. Verified at wrap time: engine clean; furrybooth/dograting/gogolinesticker level
with origin; gogo-gallery 5 ahead **by design**.

## 5. Next Steps (prioritized)

1. **Nothing is required.** The mission is complete and audited.
2. *If* AC ever wants gogo-gallery's 5 local commits on GitHub: unarchive
   (`gh api -X PATCH repos/yabroexperiments/gogo-gallery -F archived=false`, or
   Settings → Danger Zone), `git push origin main`, then re-archive. Purely optional —
   the repo is retired and its infrastructure is gone.
3. **Any NEW `common*` consumer** must set `"installCommand": "npm ci"` in `vercel.json`
   at its first engine bump, and pass its guarded fetch as `supabaseFetch`. See §92b.
4. Use `yabro-hq/scripts/sync-agents-docs.sh` for future agent-doc mirroring — do not
   hand-`cp` (see §6).

## 6. Key Decisions + Rationale

- **Injectable fetch, not a hardcoded guard in the engine.** The engine is
  credential-agnostic by design; baking a guard in would make it consumer-policy-aware.
  An optional param defaulting to undefined keeps every existing consumer byte-identical
  — backward-compatible by construction, per the repo's "never break consumers" rule.
- **`npm ci` in every consumer's vercel.json.** A git-dep pinned by SHA has a `version`
  that never changes, so `npm install` over a cached `node_modules` keeps the OLD
  package. Proven by a real failed deploy (`dpl_CpKKvLJH…`). Config, not memory.
- **gogo-gallery got the FULL guard port, not just engine wiring.** It's archived, but
  the code still runs locally; the guard exists for the day someone recreates
  `.env.local`. Committing locally matches the repo's existing local-only security commits.
- **The gogo-gallery unpushed commits are a CLOSED decision, not a backlog item.** AC's
  call. Audited clean and recorded in FACTS.md §87 so nobody re-raises it.
- **Handoff written to `.handoffs/`, not `docs/handoffs/`** — repo convention wins.
- **A blind mirror `cp` is now blocked by a script.** MAINTENANCE.md §5 had said
  "diff before you copy" since 2026-07-31 and I broke it twice in one evening. A rule
  that fails twice needs enforcement, not restatement.

## 7. Open Questions / Blockers

- **None blocking.** One optional decision: unarchive gogo-gallery (§5.2) — AC declined
  in-session ("just make sure … then update the docs and not bother with it").
- A **parallel session is active in yabro-hq** (was editing FACTS.md and renaming
  `tools/downloadvid` → `downloadvideo` during this session). Its work was left strictly
  untouched. If a FACTS.md conflict appears, keep both sides — the sections are disjoint.

## 8. Gotchas & Landmines (what actually wasted time)

1. **Vercel's `npm install` + build cache ignores a git-dep SHA bump.** Cost one failed
   production deploy. Fix shipped everywhere; documented as "Critical #2".
2. **macOS has no `timeout(1)`** — `timeout 600 npm run build` exits 127 and reads like
   the build failed. Use `gtimeout` or omit.
3. **zsh does not word-split** — `for pair in "app sha"; do set -- $pair` left `$2` empty;
   my deploy poll queried a garbage app name and reported "PENDING" for **three deploys
   that were live and READY.** I nearly reported the pushes as undeployed. Structural fix
   now in the global file: *any loop that can report an absence must print the resolved
   query it actually ran.*
4. **Managed ECVP/COST blocks sit at EOF** in furrybooth/dograting/gogolinesticker
   CLAUDE.md *and* in `~/.claude/CLAUDE.md`. `install-vet-protocol.sh` regenerates that
   region — appending there gets silently deleted. All additions went **above** the marker.
5. **gogo-gallery's `next build` fails** — 34 TS errors, all inside the embedded
   `furrybooth/` prototype, last touched 2026-06-10. Proven pre-existing by reproducing at
   `origin/main` in a detached worktree. NOT caused by this session; app code compiles.
6. A **secret-scan positive control leaves a stash entry** on the *shared* stash stack.
   Cleaned up (tagged, verified, dropped by SHA). Tag your probes.

## 9. Files Modified

**commongenerator** — `src/types.ts` (+`FetchLike`, +`supabaseFetch`) · `src/providers/index.ts`
(+`supabaseFetch` on SubmitOpts) · `src/providers/openai.ts` (conditional `global.fetch`) ·
`src/generate.ts` (threads it) · `src/index.ts` (exports `FetchLike`) · `CLAUDE.md` ·
`.handoffs/*`.
**furrybooth** — `src/lib/supabase.ts` (exports `guardedServerFetch`) · `src/lib/image-provider.ts`
· `package.json` + `package-lock.json` (SHA bump) · `vercel.json` · `CLAUDE.md`.
**dograting** — `src/app/api/generate/route.ts` (both buildPrompt branches) ·
`package-lock.json` · `vercel.json` · `CLAUDE.md`.
**gogolinesticker** — `src/lib/sticker-generator.ts` · `src/app/api/admin/test-master/route.ts`
(+ the missing `paid` guard) · `package-lock.json` · `vercel.json` · `CLAUDE.md`.
**gogo-gallery** — NEW `src/lib/live-guard.ts` · NEW `scripts/test-live-guard-offline.mjs` ·
`src/lib/supabase.ts` · `src/app/api/generate/route.ts` · `package-lock.json` · `.gitignore` ·
`CLAUDE.md`.
**workspace/yabro-hq** — `docs/agents/FACTS.md` · `docs/agents/MAINTENANCE.md` ·
NEW `yabro-hq/scripts/sync-agents-docs.sh` · `~/.claude/CLAUDE.md`.

## 10. Env / Config / Dependency Changes

- **No env-var changes anywhere.** No secrets touched, added, or rotated.
- `vercel.json` gained `"installCommand": "npm ci"` in furrybooth, dograting,
  gogolinesticker. **This changes how every future build installs** — slower installs,
  correct dependencies.
- Engine pin bumped: furrybooth `7274825 → 2b48478`; dograting `508cad1 → 2b48478`;
  gogolinesticker `7274825 → cd577ad`; gogo-gallery `337150c → cd577ad`.
- `gogo-gallery/.gitignore` now ignores `/backups/` (322 MB, files untouched on disk)
  and the redundant `/furrybooth_10_asset_zip_bundle.zip`.
- **No money-code touched** (ECPay/Stripe/Printful/checkout untouched everywhere).

## 11. Commands to Resume

```bash
cd ~/Documents/ClaudeCodex/commongenerator && git pull --ff-only && npm run build
# verify the whole family is still coherent:
for r in furrybooth dograting gogolinesticker; do
  (cd ~/Documents/ClaudeCodex/$r && git pull --ff-only -q &&
   node scripts/test-live-guard-offline.mjs && npx tsc --noEmit && echo "$r OK")
done
# gogo-gallery (archived; strip-types because it has no build):
cd ~/Documents/ClaudeCodex/gogo-gallery && node --experimental-strip-types scripts/test-live-guard-offline.mjs
# mirror agent docs (NEVER hand-cp):
bash ~/Documents/ClaudeCodex/yabro-hq/scripts/sync-agents-docs.sh
```

## 12. Context the Summary Would Lose

- **The bug was invisible from both sides, and that's the real lesson.** The consumer's
  guard was correct; the engine's archive was correct. The gap lived in the seam. If you
  ever audit a guard/tracing/retry wrapper again, grep the *dependency* for `createClient(`
  / `new <SDK>(` / `process.env.` — a library that reads credentials has its own egress.
- **Almost went a different way on the engine API:** I considered accepting a whole
  `SupabaseClient` instead of a `fetch`. Rejected — it would force every consumer to build
  a second client for the engine's private bucket, and `fetch` is the narrowest thing that
  closes the hole.
- **The most valuable thing this session did wasn't the code.** A standing security
  to-do ("owed: the gogo-gallery service-role key was never rotated — *if* that project
  still runs…") was **closed by one `dig`**: the Supabase project is NXDOMAIN and the
  Vercel project 404s. `INFRA.md` had recorded that a month earlier while FACTS.md kept
  carrying the hedge. **A conditional owed-item is an unrun measurement.** Note the honest
  residual: the OpenAI/FAL keys from that file are account-level and were *not* re-probed.
- **Every "clean" result this session came with a positive control**, and it paid off
  twice: the secret scanner was proven to fire on a planted key before I trusted its pass,
  and the new sync script was proven to BLOCK on real divergence before I trusted its sync.
  A detector that has only ever returned green is not evidence.
- **The sync script's first real run caught a canonical error**, not a mirror one:
  canonical had the yt-dlp vet date as 2026-08-11, the mirror as 08-10, and the actual
  file `docs/company/security/2026-08-10-vet-yt-dlp.md` settled it. A blind `cp` would
  have pushed the wrong date *into* the mirror. That is the whole argument for the tool.
- **I corrected my own hours-old writing twice.** A warning I added to gogo-gallery's
  CLAUDE.md in the afternoon was stale by evening; the earlier brief's "Left" section was
  stale within hours. When you flip a status, grep the doc set for the OLD wording —
  including your own.
