# Handoff — 2026-07-20 12:09 — Coordinated photo-data-privacy hardening (engine + 3 consumers)

> Cross-repo session. Touched **4 repos**: `commongenerator` (engine, cwd),
> `dograting`, `furrybooth`, `gogolinesticker`. All work is MERGED to each
> repo's `main` and DEPLOYED to production and verified. This handoff lives
> in the engine repo but covers all four.

## 1. Mission
Make the 狗仔 family accept / process / store / share user-uploaded photos in
a privacy-safe way — protect users' original photos + PII — **without a
rewrite**. Started as a single-app tweak (an engine `rewriteCloudinarySource`
opt-out), then the user reframed to: analyze the engine + the 3 main consumer
apps and ship a *coordinated, minimal* end-to-end privacy improvement.

## 2. Current State (snapshot)
- **All 4 repos: clean working trees, on `main`, everything merged + deployed + green.**
- Both upload funnels **smoke-tested in prod by the user**: dograting + furrybooth uploads → generation → results all returned OK.
- **The entire "3-layer" privacy program is shipped and activated.** Nothing in-flight.
- Engine `main` HEAD: **`32b3035`** (ownerGate). Prior engine ship this session: **`f0cb901`** (rewriteCloudinarySource).

Production SHAs (all live):
| Repo | main HEAD | Engine pin |
|---|---|---|
| commongenerator | `32b3035` | — |
| dograting | `c68fc3c` | bumped `faf835a` → **`32b3035`** (needs ownerGate) |
| furrybooth | `e500e8e` | `53b8392` (unchanged — status is app-owned, didn't need engine bump) |
| gogolinesticker | `02e21e6` | `f0cb901` (from the rewriteCloudinarySource bump; doesn't use engine `createStatusRoute`) |

## 3. Completed This Session

**A. Engine — `rewriteCloudinarySource` opt-out (`f0cb901`, merged to main earlier in session):**
- `src/types.ts` — `StartGenerationInput.rewriteCloudinarySource?: boolean`
- `src/providers/index.ts` — same on `SubmitOpts`
- `src/generate.ts` — thread it in `submitGenerationToProvider`
- `src/providers/openai.ts` — guard `normalizeImageUrlForOpenAi` behind it
- Then bumped gogolinesticker lock → `f0cb901` and deployed (its own prod deploy, verified READY).

**B. Engine — `ownerGate` keystone (`32b3035`, merged to main):**
- `src/routes/status.ts` — opt-in `ownerGate: { cookieName, adminCookie? }`; redacts `original_image_url`/`prompt`/`metadata` for non-owners; uses existing `getCookie`.
- `src/generate.ts` — `getGenerationStatus` returns row `userId` on every path.
- `src/types.ts` — `GenerationStatusResponse.userId?`.

**C. dograting (`0802f5f` then `c68fc3c`, live):**
- **Deleted** `src/app/api/diagnose/[id]/route.ts` (unauth `select('*')` dumped source photos + dog PII).
- `src/app/api/status/[id]/route.ts` — adopt engine `ownerGate` (`dograting_uid` cookie, `dograting_admin`/`ADMIN_SECRET`).
- `src/app/api/send-card/route.ts` — per-card send cap (5) via `metadata.card_email_send_count` (anti email-bomb; card itself is public).
- Signed uploads: new `src/lib/cloudinary-sign.ts`, `cloudinary-upload.ts`, `cloudinary-delete.ts`, `src/app/api/sign-upload/route.ts`; converted both upload sites (`src/app/rate/upload/UploadForm.tsx`, `src/app/admin/test/page.tsx`).
- Retention: new `src/app/api/cron/purge-source-photos/route.ts`, `sql/0004_source_photo_retention.sql`, cron in `vercel.json` (path `/scorecard/api/cron/...`).
- `package-lock.json` engine bump.

**D. furrybooth (`aac32a0` then `dcb0b6f`+`e500e8e`, live):**
- `src/app/api/status/[id]/route.ts` — inline owner-gate (`furrybooth_uid` cookie / `isAdminRequest`) redacting `photo_urls` + `notes` + `photo_includes` for non-owners (app-owned route, NOT the engine factory).
- Bucket lockdown (Supabase, no new env — uses service role): new `src/app/api/sign-upload/route.ts` (`createSignedUploadUrl`) + `src/lib/upload-image.ts` (`uploadToSignedUrl`); converted **4** upload sites (`src/components/LandingCtas.tsx` + 3 admin panels: `admin/test/AdminTestPanel.tsx`, `admin/styles/StylesPanel.tsx`, `admin/style-lab/StyleLab.tsx`); `sql/0012_uploads_signed.sql` drops the `anon insert uploads` policy.
- Retention: new `src/app/api/cron/purge-source-photos/route.ts`, `sql/0013_source_photo_retention.sql`, new `vercel.json` cron.

**E. gogolinesticker (`02e21e6`, live) — already had L1-3; added the missing automation:**
- Extracted the sweep to `src/lib/purge-source-photos.ts`; `src/app/api/admin/purge-source-photos/route.ts` now calls it (same behavior/response).
- New `src/app/api/cron/purge-source-photos/route.ts` (auto-commits the purge at the `source_photo_retention_days` window, default 180); `vercel.json` daily cron (path `/LINEsticker/api/cron/...`).

**F. Operator steps the user completed:** dograting Cloudinary env (`CLOUDINARY_API_KEY`/`_API_SECRET`) set; dograting unsigned preset disabled; dograting `sql/0004` applied; furrybooth `sql/0012` + `sql/0013` applied; `CRON_SECRET` set + redeployed on all 3; deleted the 6 merged remote branches via GitHub UI.

## 4. In-Flight Work
**None.** Everything compiles (every Vercel build verified READY), deployed, and both upload funnels verified by the user. No half-refactors.

## 5. Next Steps (optional — nothing is blocking)
1. (Optional) The **authenticated-Cloudinary-delivery** gold-plate for the Cloudinary apps — deliberately parked (see §6). Only worth it if you want "access-controlled at rest," not just unlisted. Signature format already reverse-engineered (see §8).
2. (Optional) Give furrybooth's `/api/sign-upload` a rate-limit/Turnstile gate — now that uploads are server-mediated, that's the single choke point for throttling anon upload abuse (noted in the commit).
3. (Optional) `commonpayment`/`famchat`/other siblings — the audit noted `send-card`/`diagnose`/`status` leaky patterns are likely copy-pasted; worth the same 3-point checklist (status route, diagnose dumps, unauth `select('*')`).

## 6. Key Decisions + Rationale (do not re-litigate)
- **`ownerGate` is opt-in, not default-on.** Default-on would break consumers that don't configure `cookieName`. Engine rule: never break consumers. (CLAUDE.md primitives table.)
- **Prioritized the 3-layer plan over authenticated Cloudinary delivery.** The real leaks were read endpoints handing source URLs/PII to non-owners — fixed by owner-gating + retention. Authenticated delivery only adds defense against a URL *leaking out-of-band* (provider logs/referrer/future bug) and only for image bytes, not PII — and retention already covers ~80% of its value. Big multi-file change for narrow marginal benefit. Parked as optional Phase 4.
- **send-card: capped, not ownership-gated.** The card is the PUBLIC result (already shareable), so exfiltration isn't a data leak; the real risk was the open email relay. A per-card cap kills the bomb without changing the share UX.
- **Retention marker:** furrybooth/dograting use a dedicated `source_photos_purged_at` column (idempotency filter); gogolinesticker reuses `metadata.source_photos_purged_at` (it already had `metadata`).
- **furrybooth signed uploads use Supabase `createSignedUploadUrl`** (service role, no new env) — cheaper than dograting's Cloudinary route which needs the API secret.
- **gogolinesticker status is stricter than ownerGate** — it whitelists the response for EVERYONE (no client reads the private fields), so it needs no owner check. Left as-is.

## 7. Open Questions / Blockers
- None blocking. Only unknown: whether dograting shares gogolinesticker's Cloudinary account (`dwhzpy04f`) — the user set dograting's env and uploads verified, so it's resolved in practice.

## 8. Gotchas & Landmines
- **Web git proxy 403s ref DELETIONS.** `git push origin --delete` fails 403; GitHub MCP has no delete-branch tool. Merged-branch cleanup must be done via GitHub UI / local. (Wasted a round trying both.)
- **No local `node_modules` in fresh consumer clones** → can't typecheck consumers locally; the engine dep resolves via `git+ssh` which the proxy's `https`-only rewrite doesn't cover. **Verification path used: push to a feature branch → Vercel PREVIEW build = the real `npm ci` + tsc.** Only promote to main after preview is READY.
- **Engine build in a fresh clone:** `npx tsc` grabbed TS **6.0.2** (errors on `moduleResolution: node10`); after `npm install` the pinned TS **5.9.3** builds clean. Always `npm install` before building the engine.
- **dograting cron path needs the `/scorecard` basePath** (`/scorecard/api/cron/...`) or the `vercel.json` umbrella-redirect rule bounces it. Same for gogolinesticker (`/LINEsticker/...`). furrybooth has no basePath.
- **Signed uploads + Cloudinary retention require the API secret BEFORE deploy** — without it `/api/sign-upload` 503s and uploads break. Ship them together + set env first.
- **Concurrent sessions** were live on gogolinesticker (`…Cy3Z`) and its main moved mid-session — always `git fetch origin main` + check FF before merging.
- **Cloudinary MCP is on the prod account `dwhzpy04f`.** Used it to reverse-engineer the authenticated signed-URL format (SHA-1, 8-char base64url `s--sig--`, `/image/authenticated/s--<sig>--/<transform>/v<ver>/<public_id>.jpg`, and `eager` returns a ready-signed transformed URL) — kept for the parked Phase 4. The sandbox proxy blocks `curl` to res.cloudinary.com + `*.vercel.app` + the app domains, so endpoint smoke-tests must be done by the user.

## 9. Files Modified (key, one-line each)
**commongenerator:** `src/types.ts` (rewriteCloudinarySource + userId), `src/providers/index.ts` (SubmitOpts flag), `src/generate.ts` (thread flag + return userId), `src/providers/openai.ts` (guard rewrite), `src/routes/status.ts` (ownerGate), `CLAUDE.md` (this wrap), `.handoffs/*` (this handoff).
**dograting:** deleted `api/diagnose/[id]/route.ts`; `api/status/[id]/route.ts` (ownerGate), `api/send-card/route.ts` (cap), `lib/cloudinary-sign|upload|delete.ts` (new), `api/sign-upload/route.ts` (new), `api/cron/purge-source-photos/route.ts` (new), `rate/upload/UploadForm.tsx` + `admin/test/page.tsx` (signed), `sql/0004_*.sql` (new), `vercel.json` (cron), `package-lock.json` (engine bump).
**furrybooth:** `api/status/[id]/route.ts` (owner-gate), `api/sign-upload/route.ts` + `lib/upload-image.ts` (new), `components/LandingCtas.tsx` + 3 admin panels (signed), `sql/0012_*.sql` + `sql/0013_*.sql` (new), `api/cron/purge-source-photos/route.ts` (new), `vercel.json` (new).
**gogolinesticker:** `lib/purge-source-photos.ts` (new), `api/admin/purge-source-photos/route.ts` (refactor to lib), `api/cron/purge-source-photos/route.ts` (new), `vercel.json` (cron).

## 10. Env / Config / Dependency changes
- **New consumer env (operator-set):** dograting `CLOUDINARY_API_KEY` + `CLOUDINARY_API_SECRET` (required for signed uploads + retention). `CRON_SECRET` set on **all 3** apps (enables the daily purge cron; without it the cron 401s harmlessly and admin-manual purge still works).
- **New SQL migrations (operator-applied):** dograting `sql/0004`; furrybooth `sql/0012` (drops anon-insert policy — apply AFTER deploy) + `sql/0013`. All idempotent.
- **Cloudinary console:** dograting old unsigned upload preset disabled.
- **Crons:** daily `0 4 * * *` in each app's `vercel.json` → `/api/cron/purge-source-photos` (basePath-prefixed where applicable).
- **Engine dep:** dograting lockfile `faf835a` → `32b3035`.

## 11. Commands to Resume
```bash
# engine (cwd)
cd /home/user/commongenerator && git pull --ff-only && npm install && npm run build

# consumer clones live under /workspace/<app> (ephemeral container — may need re-clone/add_repo):
#   dograting / furrybooth / gogolinesticker  — all on main, all clean.
# To re-verify a consumer builds against the engine: push a branch → read the Vercel PREVIEW build state (npm ci = real typecheck).
```

## 12. Context the Summary Would Lose
- The session **started narrow** (paste-in edit for `rewriteCloudinarySource`) and the user widened it twice: first "is there an iPhone workaround" (→ discovered the client already canvas-re-encodes P3→sRGB, so the Cloudinary rewrite is vestigial), then "coordinate an end-to-end privacy solution." Don't treat the rewriteCloudinarySource flag as the point — it was the entry.
- **gogolinesticker is the reference implementation.** Its 2026-07-15 "C2 fix" (status whitelist) + deleted `/api/diagnose` + signed uploads (`cloudinary-sign.ts`) + admin retention were the templates I ported to dograting. If in doubt about a pattern, read gogolinesticker's version first.
- **AskUserQuestion / ExitPlanMode tool calls errored twice** ("permission stream closed") — I fell back to plain-text questions. If they keep failing, don't burn turns; just ask in text.
- The **authenticated-delivery investigation is real work not to redo**: signature format confirmed against the live account (SHA-1, `s--sig--`, version-in-path), and `eager` on a signed upload returns a ready-signed transformed URL — meaning Phase 4 could skip hand-rolled crypto entirely by signing at upload time. That was the near-decision when we parked it.
- **furrybooth's anon `uploads` bucket** was writable by anyone with the client anon key — the lockdown closes writes but I explicitly deferred adding throttling to `/api/sign-upload` (it's now the choke point for it). Abuse, not privacy, so it was lower priority.
- Every promotion followed the same discipline: **feature branch → Vercel preview READY → then FF-merge to main.** Never promoted unverified, especially the two upload-funnel changes.
