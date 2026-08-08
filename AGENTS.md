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

### Determinism is sacred (`rng.ts`)
- FNV-1a hash seeds an xorshift32 step. State is a single mutable `{ s: number }` box, mutated in place for speed (a career draws tens of thousands of times).
- **`derive(base, ...tags)` returns a fresh `RngState` from `hash("base:tag1:tag2")`.** Every logical event gets an independent, reproducible stream. This is how determinism is enforced per-event without global RNG ordering issues. Examples in `sim.ts`: `derive(seed, "stats", age, periodIndex, seasonInPeriod)`, `derive(seed, "trophy", ...)`, `derive(seed, "growth", age, periodIndex)`.
- **`Math.random` is used ONLY in `meta/legacy.ts` `randomSeed()`** (generating new run seeds) and never in sim outcomes. If you add randomness anywhere in the engine, use `derive()` — never `Math.random`.

### Run lifecycle (`run.ts`)
Constants: `PERIOD_LENGTH = 1` (one decision per season — high decision density), `START_AGE = 16`, `START_OVR = 50` (53 with `golden_boy` blessing), `RETIRE_AGE = 40`, `FORCE_RETIRE_OVR = 50` (age ≥26 and OVR <50 → forced "no_offers" retirement).

Flow: `createRun(setup)` → `simulatePeriod(state)` runs `PERIOD_LENGTH` seasons via `simOneSeason`, then builds a decision via `buildPeriodDecision`. The user picks a choice → `resolveChoice` runs the event's stored `pendingResolve` against `derive(seed, "resolve", age)`, stashes `Modifiers` into `pendingMods`. The store then auto-advances into the next `simulatePeriod`. A choice IS the advance — there is no separate "continue" button (PRODUCT principle).

**Modifier timing** (`Modifiers` in `types.ts`): `immediateOverallDelta` + `permanentOverallDelta` apply upfront; `deferredOverallDelta` applies after the period's seasons. Other mods: `roleShift`/`roleOverride`, `suspended`, `leagueTrophyMult`/`continentalTrophyMult`, `forceTrophy`, `legacy`, `loyalStay`, `newClubId`, `addTags`. Documented in `run.ts` `simulatePeriod`.

**Status tags** are encoded `"name@ttl"` (TTL in periods, default 2). Helpers: `ttlTag`, `decayTag` (decrement), `dedupeTags` (keep longest TTL). Events gate eligibility on bare tag names from `ctx.statusTags`. `club_legend@99` is effectively permanent.

**`buildPeriodDecision` priority**: climax events at WC ages (19/23/27/31) → `decisivePenalty` at 21/25 for starters ≥75 → transfer window every other period (`periodIndex % 2 === 1`) → random event → fallback transfer. The regular transfer cadence is deliberate so players can climb to bigger clubs — don't remove it.

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
`npm run build` currently fails with TypeScript errors in `src/engine/` (`run.ts`, `sim.ts`, `events.ts`) — signature mismatches in `clubTrophyCandidates` (run.ts passes `club`, sim.ts expects `league`) plus unused imports. **These are pre-existing and out of scope for style/UI work.** `npm run dev` and `vite build` (esbuild, no full typecheck) both work. If you're touching the engine, fix these first.

## Conventions checklist
- **Determinism first**: new engine randomness → `derive()`, never `Math.random`.
- **Pick-1-of-N decisions**: choices have `id`/`kind`/`text`/optional `sub`; resolution returns `ResolveResult` (`mods`, `outcome` text, `good` flag, optional `injury`).
- **Football stories over abstract mechanics** (PRODUCT): stats/events should map to narratives a fan understands. Don't fabricate FUT-style PAC/SHO/PAS attributes; the hero card uses real stats (出场/进球/助攻/零封).
- Keep `types.ts` dependency-free. Keep the engine React-free. Keep the reducer pure.
- Match existing naming: lowercase files, PascalCase types, camelCase functions, SCREAMING_SNAKE constants. Chinese in copy, English in code.
- Honor `prefers-reduced-motion`. Keep color-blind legibility (color + numerals, never color alone).
