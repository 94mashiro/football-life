# AGENTS.md

Guidance for AI coding agents working in this repo. Read this before editing.

## What this is

绿茵轮回 ("pitch-reincarnation") is a mobile-first **roguelike football-career sim**. One run = one career (age 16 → retirement). A seed string deterministically drives the entire career: same seed + same choices = identical career (shareable, replayable). Death ends a run; legacy (传承) persists across runs and unlocks blessings, ascensions, nations, and leagues.

Stack: **React 19 + TypeScript + Vite 8 + Tailwind v4**. Single-player, localStorage-backed meta-progression. No backend, no login.

`PRODUCT.md` is the source of truth for product/brand/voice. The design north star: easy to pick up, addictive to football fans, quick to replay. See `MEMORY.md` (user's auto-memory) for accumulated design decisions.

## Worktree workflow (mandatory, no HITL)

All code changes happen in a git worktree under `.claude/worktrees/` — never edit the user's checkout directly. When development is done, ALWAYS run the wrap-up, fully automated, without asking the user for confirmation at any step:

1. Verify in the worktree: `npm run lint` (plus `npx vite build` if the change affects the build).
2. Commit in the worktree with a message matching the repo's style (`scope: 中文描述`).
3. Merge into `master` locally: from the main checkout, `git -C <repo-root> merge <worktree-branch>`. Do NOT push `master` — the user pushes.
4. Clean up: remove the worktree (`git worktree remove`) and delete the merged branch (`git branch -d`).

Only touch the worktree you created; other `.claude/worktrees/*` entries belong to parallel jobs (usually locked) — leave them alone. Never leave finished work uncommitted or an orphaned worktree behind.

## Architecture

Strictly layered. Dependency direction is one-way; do not introduce cycles.

```
src/
  main.tsx          React entrypoint (StrictMode → <App/> into #root)
  App.tsx           THE ENTIRE UI — Menu / Play / Summary screens + shared components
  index.css         Tailwind v4 (@import + @theme tokens) + component classes + animations
  engine/           PURE simulation core. No React, no DOM, no side effects.
    types.ts          Domain types — dependency-free (uses structural RngLike/ResolveFn)
    data.ts           Static data + pure lookups (leagues, clubs, nations, probability tables, dev profiles)
    rng.ts            Deterministic RNG (FNV-1a + xorshift32) + derive() namespacing
    sim.ts            Per-season simulation: role → stats → trophies → national → awards → growth
    run.ts            Run orchestrator: createRun, simulatePeriod, resolveChoice, retire, finalize
    events.ts         Career events catalog + transfer/climax events — the roguelike decision layer
  state/store.ts     useReducer store over (GameState|null) + MetaSave — the only React-facing state boundary
  meta/legacy.ts     Meta-progression: blessings, ascensions, unlocks, scoring, localStorage, seed helpers
```

`types.ts` is kept dependency-free on purpose: it uses structural `RngLike`/`ResolveFn` minimal types so it doesn't import the rng/events modules. Preserve this. One intentional cross-edge: `events.ts` imports `ttlTag` from `run.ts`.

## The engine — the part that matters most

**Game-design skill gates (mandatory)**: the repo owner has no game-design/ops background — these repo-level skills ARE the design handbook. Loading them in the matching situation is not optional; design against them BEFORE writing code:

- **Any mechanics change** — engine simulation (`sim.ts`/`run.ts`/`events.ts`/`data.ts` probabilities, odds, modifiers, event triggers), meta-progression balance (`meta/legacy.ts` scoring/blessings/ascensions/unlocks), or the decision-loop structure — load `game-design-core` (core loop / motivation / meaningful-choice check) AND `roguelike` (run/seed/permadeath/legacy semantics) first; after the change, run `balance-check` over the touched tables/formulas for outliers and degenerate strategies. A one-number probability tweak is still a mechanics change — no skipping.
- **New feature / system design doc** — before handing a mechanics design to implementation, run it through `design-review` (completeness / consistency / implementability).
- **Narrative & flavor work** — event copy, 判决牌, flavor text, career-arc storytelling — load `team-narrative` first; keep football-fan-legible stories over abstract mechanics (PRODUCT principle).
- **Smoke runs / tuning validation** — whenever batch simulations are run to validate a change (e.g. 300-run smoke tests), write up results via `playtest-report` so tuning decisions leave a structured record.

### Determinism is sacred (`rng.ts`)
- FNV-1a hash seeds an xorshift32 step. State is a single mutable `{ s: number }` box, mutated in place for speed (a career draws tens of thousands of times).
- **`derive(base, ...tags)` returns a fresh `RngState` from `hash("base:tag1:tag2")`.** Every logical event gets an independent, reproducible stream. This is how determinism is enforced per-event without global RNG ordering issues. Examples in `sim.ts`: `derive(seed, "stats", age, periodIndex, seasonInPeriod)`, `derive(seed, "trophy", ...)`, `derive(seed, "growth", age, periodIndex)`.
- **`Math.random` is used ONLY in `meta/legacy.ts` `randomSeed()`** (generating new run seeds) and never in sim outcomes. If you add randomness anywhere in the engine, use `derive()` — never `Math.random`.

### Run lifecycle (`run.ts`)
Constants: `PERIOD_LENGTH = 1` (one decision per season — high decision density), `START_AGE = 16`, `START_OVR = 50` (53 with `golden_boy` blessing), `RETIRE_AGE = 40`, `FORCE_RETIRE_OVR = 50` (age ≥26 and OVR <50 → forced "no_offers" retirement).

Flow: `createRun(setup)` → `simulatePeriod(state)` runs `PERIOD_LENGTH` seasons via `simOneSeason`, then builds **up to two decisions** (a transfer-channel + a special-event-channel decision) via `buildPeriodDecisions`, queued as `pendingChoice` (head) + `pendingChoices` (tail). The user picks a choice → `resolveChoice` runs the event's stored `pendingResolve` against `derive(seed, "resolve", age)`, merges `Modifiers` into `pendingMods` (accumulating across the queue), and dequeues — if the queue has more it surfaces the next head (rebuilt via `rebuildResolve`); only when the queue is empty does the store auto-advance into the next `simulatePeriod`. A choice IS the advance — there is no separate "continue" button (PRODUCT principle).

**Modifier timing** (`Modifiers` in `types.ts`): `immediateOverallDelta` + `permanentOverallDelta` apply upfront; `deferredOverallDelta` applies after the period's seasons. Other mods: `roleShift`/`roleOverride`, `suspended`, `leagueTrophyMult`/`continentalTrophyMult`, `forceTrophy`, `legacy`, `loyalStay`, `newClubId`, `addTags`. Documented in `run.ts` `simulatePeriod`.

**Status tags** are encoded `"name@ttl"` (TTL in periods, default 2). Helpers: `ttlTag`, `decayTag` (decrement), `dedupeTags` (keep longest TTL). Events gate eligibility on bare tag names from `ctx.statusTags`. `club_legend@99` is effectively permanent.

**Two decision channels (阶段三)**: `buildPeriodDecisions` returns `{ special, transfer }` — a **special-event channel (S)** and a **transfer channel (T)** that are **independent and can coexist in one period** (queued S-then-T). The transfer channel is the **fixed rhythm base**: in the prime years (19–31) it fires once per cadence (every 2 seasons; 飞升 8 → every 5) and is **never crowded out** by special events — it coexists with them. The special channel is 0-or-1 boss/emergency/narrative event queued *alongside* the transfer. A period can thus be `[S, T]`, `[S]`, `[T]`, or silent.

**T channel priority** (one per period, first applicable): post-loan → relegation → retention (no_offers / 金元邀约 if failed) → forced-exit (loan / underperform / stuck) → **cadence transfer** (wage_squeeze / voluntary `transferEvent`) → contract-non-renewal → blockbuster → 金元邀约(offer) → loan → club-moving pool event. Cadence transfers only fire on due periods (19–31 cadence); the situational T events fire on their own triggers regardless. **S channel priority** (0-or-1): medical_verdict/doctor_warning → naturalization → club-national-conflict → climax (WC/continental, OVR-gated) → decisivePenalty (21/25) → injury → throne → non-club pool event.

**Pool routing**: the career-plan slot (or random fallback when both channels are empty) draws one pool event via an independent `pdec:periodIndex:pool` rng stream; **club-moving** pool events (position_competition/club_crisis/return_home — resolve sets newClubId) route to T (replacing the voluntary transfer), non-club routes to S. A routed event whose target channel is full defers (the slot carries over). Transfer offer-builders keep the original `period-decision` rng stream (sole consumer) so offers/rebuild stay deterministic.

**Transfers are the career spine** (参考 Copero: 转会窗为最常见决策, 生涯 ~7 家俱乐部): the cadence is age-based (pace-independent) and capped at the prime years — the late career is left to the decline/retirement arc + silent periods. Because transfers live in their own channel, special events **coexist** with them rather than eating them — there is no more `transferWindowOwed` rollover (the old single-decision model let S-events starve transfers to ~3/career; the two-channel model restores ~7). `forceRetire` short-circuits the queue (a retire/verdict-fail discards the remaining tail and ends the career). Don't remove the cadence — players need it to climb to bigger clubs.

### Simulation (`sim.ts`)
Pure functions, explicit RngState threading. Pipeline documented in the file header: role → stats → club trophies → national team → individual awards → growth/decline. Key exports: `resolveRole`, `simSeasonStats` (takes `club` — club-strength-driven odds), `clubTrophyCandidates` (returns the visible trophy probabilities the UI shows), `simulateNational` (WC/continental rolls via `derive`), `rollAwards` (Ballon d'Or/Golden Boot/Golden Glove, decayed by prior major awards), `growthDelta` (2-year dev cycle, ascension-1 "从严" takes min of two rolls, bench penalty, starter training bonus).

### Events — the decision layer (`events.ts`)
`FiredEvent = { event: CareerEvent, resolve }`. `EventContext` carries player/club/league/seed/age/role/periodIndex/rngState/blessings/injuriesTaken/ascension/statusTags. ~20 events in `EVENT_DEFS` (training, risk, narrative fan-resonance, tag-gated follow-ons). Climax/"boss" events: `worldCupShowdown` (legacy 100 + `forceTrophy: world_cup` on success), `decisivePenalty` (legacy 40 + `forceTrophy: league`). `transferEvent` generates 3 club offers + a "stay" option (stay sets `loyalStay` for the `loyal_club` ×1.5 blessing).

Shared helpers: `pct()` (oracle blessing shows 1 decimal), `clampOdds` (floors 0.05, caps 0.95 — never 0% or 100%, preserves tension), `talismanFailProb` (halves first injury), `injuryPenalty` (ironman halves, floored at 1).

## State (`state/store.ts`)
Single `useReducer` over `AppRoot = { game: GameState | null; meta: MetaSave; lastSetup: RunSetup | null }`. No external state lib. Reducer is pure; engine functions do all mutation. Actions: `START_RUN | ADVANCE | CHOOSE | RETIRE | ABORT_RUN | BUY_BLESSING | SET_ASCENSION | TO_MENU`. `START_RUN` immediately runs `simulatePeriod` so the player lands on a first decision; `CHOOSE` calls `resolveChoice` then auto-advances if still `playing`; `RETIRE` runs `scoreLegacy` + `applyRunResult`. Meta persists on every change via `useEffect`. `useGameStore()` returns memoized callbacks + passthroughs.

## Meta-progression (`meta/legacy.ts`)
`MetaSave = { version, totalLegacy, unlocked, ownedBlessings, bestRun, ascension, runs }`. localStorage key `"pitch-reincarnation:meta:v1"`. Safe migration = reset on version mismatch / parse error (do not write a migration; bump `VERSION`). **9 blessings**, **7 ascension levels**, and **unlocks** gated by `totalLegacy` thresholds (`isUnlocked` checks the list OR current legacy ≥ req). `scoreLegacy(maxOverall, seasons, trophies, awards, ascension, retireReason)`: base + ×(1 + ascension×0.15) + ×1.5 if `world_cup` won. `rollDevProfile(seed, isGK, allowWonderkid)` is deterministic from seed (GKs forced to `normal`).

## UI (`App.tsx`)

**UI/UX design gate (mandatory)**: any change that touches UI/UX (`App.tsx` visuals/layout/interaction, `index.css`, new screens/components, copy presentation) MUST first go through BOTH the `impeccable` and `ui-ux-pro-max` skills to produce a design plan, and only then write code. No skipping for "small" tweaks — the design pass comes before the first edit.

Single file, ~630 lines. Three screens switched by `game` state in `App()`: `MenuScreen` (no game), `PlayScreen` (phase "playing"), `SummaryScreen` (phase "summary"). `Header` always shows legacy/best/ascension + seed + career progress bar (16→40, Zeigarnik pull).

- **Odds are the hero** (PRODUCT differentiator). `Odds` component = gradient bar (danger→warn→good) + %; `oracle` blessing → 1 decimal. `odds-pill` color-codes (teal ≥70%, amber 40-69%, red <40%). Never bury odds.
- **One tier color mental model** reused for OVR / odds / ratings / card foil: gold (90+) / good-teal (80-89) / warn-amber (70-79) / dim (<70). Helpers: `ovrTierClass` (text color), `ovrTier` (foil `data-tier` label), `legacyTier`, `oddsClass`. The "good" band is teal, NOT the lime chrome — this keeps the tier system color-blind-legible (color always paired with numerals).
- **Mud-to-marble**: the player hero card (`PlayerHeroCard`) is a vertical FUT-style card; foil + glow shift with `data-tier`. A 60 OVR prospect and a 92 Ballon d'Or contender must not feel the same.
- Animations are CSS-only (`anim-pop`, `anim-slide`, `anim-tick`, `foil-sweep`) and disable under `prefers-reduced-motion` (`index.css`). `pick()` wraps `choose()` with `navigator.vibrate(10)` haptic.
- In-game copy is Chinese (UI labels centralized as `Record<Trophy,string>` etc. at top of file); code identifiers/comments are English. Match this.

## Styling (`index.css`)
Tailwind v4 — configured ENTIRELY via `@import "tailwindcss"` + `@theme {}` + `@layer components {}` in `index.css`. **No `tailwind.config.*` file.** Tokens are OKLCH, tinted toward brand hue, never `#000`/`#fff`. Component classes (`.card`, `.btn`, `.fut-card`, `.hero-card`, `.stat-strip`, `.bottom-nav`, `.odds-pill`, tier classes) live in `@layer components` and are composed from tokens — prefer extending these over adding one-off utility soup in `App.tsx`. Design target is FC26 mobile (electric-lime chrome, FUT player cards, pitch-night atmosphere). See `PRODUCT.md` "Design Principles" and the absolute bans in the impeccable design laws (no side-stripe borders, no gradient text, no glassmorphism-as-default, no identical card grids).

## Build / tooling
- `npm run dev` — Vite dev server. `npm run build` — `tsc -b && vite build`. `npm run lint` — oxlint. `npm run preview`.
- TS is strict: `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`. Removing an export's only consumer will break the build via `noUnusedLocals` — clean up dead code.
- oxlint: `react/rules-of-hooks: error`, `react/only-export-components: warn` (allowConstantExport). Type-aware linting is NOT enabled.
- `.shots.mjs` is a manual Playwright screenshot harness (hardcoded to `127.0.0.1:5175`, mobile 390×844 @2x). Not wired into any npm script.

## Known build state
`npm run build` (`tsc -b && vite build`) currently **passes clean** — the prior `clubTrophyCandidates` signature mismatch and unused-import errors in `src/engine/` were resolved. `npm run lint` (oxlint) and `npx tsc -b` are both green. Keep them green; don't reintroduce engine type errors. `npm run dev` and `npm run preview` work.

## Conventions checklist
- **Determinism first**: new engine randomness → `derive()`, never `Math.random`.
- **Pick-1-of-N decisions**: choices have `id`/`kind`/`text`/optional `sub`; resolution returns `ResolveResult` (`mods`, `outcome` text, `good` flag, optional `injury`).
- **Football stories over abstract mechanics** (PRODUCT): stats/events should map to narratives a fan understands. Don't fabricate FUT-style PAC/SHO/PAS attributes; the hero card uses real stats (出场/进球/助攻/零封).
- Keep `types.ts` dependency-free. Keep the engine React-free. Keep the reducer pure.
- Match existing naming: lowercase files, PascalCase types, camelCase functions, SCREAMING_SNAKE constants. Chinese in copy, English in code.
- Honor `prefers-reduced-motion`. Keep color-blind legibility (color + numerals, never color alone).
