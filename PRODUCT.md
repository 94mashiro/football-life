# Product

<!-- impeccable:product-schema 1 -->

## Register

product

## Platform

web

## Users

Football fans who actively follow the sport — who know World Cup years, the Ballon d'Or race, big-club transfers, and decisive penalties. They play in short bursts on mobile: a commute, a queue, a five-minute break. They want to pick it up instantly, play a full career in a few minutes, and feel the pull to start "just one more run." They are not spreadsheet managers; they are fans chasing a "what if" fantasy.

## Product Purpose

绿茵轮回 is a roguelike football-career sim. Each run is one career from 16-year-old academy prospect to retirement. Every decision changes fate; a seed determines everything, so the same seed + same choices always reproduces the same career — shareable, replayable, replay-able for a friend to challenge. Death is the end of a run but legacy (传承) is permanent and unlocks blessings, ascensions, new nations and leagues across runs. Success = "easy to learn, simple to operate, but addictive" — a quick game anytime that football fans return to.

## Positioning

A neighboring football manager or career sim cannot truthfully copy all three at once: **visible success probability on every decision** (the tension no competitor shows), **a seed that deterministically reproduces the entire career** (shareable, challengeable, replayable), and **death ending the run while 传承 persists** (roguelike legacy, not a save-file career).

## Operating Context

Single-player, no login. A sitting is a phone in one hand: menu → one career of tap-to-decide seasons → retirement card. Three screens: 菜单 / 生涯 / 总结.

- **Debut setup:** nationality, position, pace (漫长 / 标准 / 极速), optional name and squad number. Seed is random by default; a specified seed reproduces the career and does not settle 传承 / 最佳 / 飞升 / 成就.
- **Daily 战帖:** everyone plays the same seed and setup that calendar day, with blessings / 声望 / 飞升 neutralized so the board is comparable.
- **In-run:** one tap is the advance. A period can surface a special-event decision, a transfer decision, both, or neither. Odds stay on the choice.
- **Between runs:** 传承 buys blessings (equip at most three per run); 飞升 raises the next career's difficulty; archive and achievements keep prior careers. Specified-seed runs stay off this ledger.
- **Sharing:** a URL hash encodes the setup so a recipient can kick off the same career. A share card is the end-of-career artifact.
- **Optional cloud:** careers upload anonymously to a server board (filterable by nationality, position, and 今日 seed). Event feedback is optional. Play itself does not require the network.
- **Install:** add-to-home-screen PWA, portrait. Meta lives in localStorage.

## Capabilities and Constraints

**Can do**

- Play a full 16-to-retirement career in minutes; retire or abort; restart immediately.
- See success probability on every decision (oracle blessing: one decimal; 飞升 3 情报封锁: numerals black-taped).
- Climb via transfers, national team, trophies, and awards; decline and retention can end the career before a hard age wall.
- Carry 传承 across deaths into blessings, 飞升 (levels 1–10), 声望, and unlocks.
- Challenge a friend with a seed link, or run today's shared 战帖.
- Compare anonymously on the server board; keep a local archive.

**Must preserve**

- Determinism: same seed + same choices = same career. Engine randomness is seeded; never `Math.random` / clock inside simulation outcomes.
- Chinese-first player-facing UI. No login, no account.
- Copy belongs to exactly one layer (functional vs event narrative) — see Copy Standard.
- One term per concept: 赛季 · 决策 · 轮回 · 成功概率 · 档 · 战帖.
- Color-blind-safe tiers: color always paired with numerals / labels.
- `prefers-reduced-motion` disables resolve / pop / tick motion.

**Must not**

- Invent testimonials, user counts, press, pricing, or an event-count boast (existing 151 vs 173 claims already disagree — neither is product truth).
- Hide odds, add a separate "continue" after a choice, or reopen the career after death.
- Treat specified-seed runs as meta-progress.

**Undecided**

- No bound production URL or legal-owner line.
- No English (or other) localization commitment.

## Brand Commitments

Player-facing name is **绿茵轮回**. Voice is authentic, addictive, electric — football-first, quick-hit, legendary. The interface should feel like a Saturday-night fixture under the lights: tense, glamorous, a little theatrical — never a database admin panel. Emotion: the buzz of a pack opening, the dread of an 18% penalty, the pride of a shareable end-of-career card. Chinese-first; established football-game domain words (OVR) are allowed, mixed Chinese/English is not.

Visual world is the football-game category standard at EA FC Ultimate Team and Dream League Soccer craft: night-stadium plates, electric-lime chrome on the primary action, a FUT player card as the debut object. The "good" odds band stays teal, never lime. Chosen 2026-08-13.

## Brand Personality

Authentic, addictive, electric. Three words: football-first, quick-hit, legendary. The interface should feel like a Saturday-night fixture under the lights — tense, glamorous, a little theatrical — never like a database admin panel. Emotion: the buzz of a pack opening, the dread of an 18% penalty, the pride of a shareable end-of-career card.

## Anti-references

- The "wall of stats" that scares casual fans — dense attribute tables upfront, meta-progression shown before the first retirement.
- Generic dark SaaS dashboards with no identity, where a football sim could be any productivity tool.
- Football Manager's data-density at the cost of feel (great for hardcore managers, wrong for our quick-burst fan).
- Competitor games that hide odds behind opacity — our visible odds are the differentiator and must stay the hero of every decision.
- Card-board brutalism: endless identical cards with no sense of premium or spectacle.

## Evidence on Hand

- Club, nation, league, national-team, trophy, and award art under `public/img/` (crests, flags, cups — real football identity, not placeholders).
- Share / install marks: `public/og-card.svg`, `public/og-card.png`, `public/favicon.svg`, `public/icons.svg`.
- Copy research that the Copy Standard cites: `research/game-copy-standards.md`.

Do not fabricate testimonials, case studies, press, DAU, or a canonical event count. The OG description and the web-app manifest already disagree on story count; future work must not pick a number.

## Product Principles

- **Football stories over abstract roguelike mechanics.** Every stat and event should map to a narrative a football fan instinctively understands. Mechanics earn their place by serving the story.
- **One-tap decisions.** No heavy menus, no separate "continue" button — the choice IS the advance. Frictionless restarts.
- **Odds are the hero.** Visible success probability on every decision. Never bury it.
- **Mud to marble.** A 60 OVR prospect and a 92 Ballon d'Or contender are not the same career. Ascent must be felt.
- **Quick-hit spectacle.** A run is short; reward that brevity. Respect the sport's glamour.

## Design Principles

- **Football stories over abstract roguelike mechanics.** Every stat, color, and event should map to a narrative a football fan instinctively understands (World Cup year approaching, Ballon d'Or race, big-club move). Mechanics earn their place by serving the story.
- **One-tap decisions.** No heavy menus, no separate "continue" button — the choice IS the advance. Frictionless restarts.
- **Odds are the hero.** Visible, color-coded success probability on every decision — this is what no competitor shows and what creates real tension. Never bury it.
- **Mud to marble.** The interface should warm and elevate as a career rises — a 60 OVR prospect and a 92 Ballon d'Or contender should not feel the same on screen. Ascent is a visual narrative.
- **Quick-hit spectacle.** A run is short; the surface should reward that brevity with punchy, premium, mobile-game feel (resolve animations, foil-card players, neon highlights) — not a flat terminal. Respect the sport's glamour.

## Accessibility & Inclusion

- Mobile-first, single-thumb operable; touch targets meet minimum sizes.
- Color tier system (OVR / odds / ratings) must remain legible to color-blind users — never rely on color alone; pair with numerals and labels.
- Respect `prefers-reduced-motion`: all resolve/pop/tick animations must disable cleanly.
- High-contrast text on dark backgrounds; WCAG AA contrast for body and stat numerals.
- No login, no friction — seed in the URL/state for sharing.

## Copy Standard (文案守则)

Every player-facing string belongs to exactly one of two layers, and the layers follow nearly opposite rules — applying the wrong ruleset is worse than writing badly. Full research with sources: `research/game-copy-standards.md`.

### Layer A — Functional UI copy (non-diegetic)

Menus, buttons, blessing/ascension/perk descriptions, achievement names & conditions, odds and number explanations, debut setup, share-sheet labels, confirm dialogs. The **system** is speaking; the goal is a fast, correct decision.

- **Zero emotion.** No psychological description, no editorializing the player's choice. Playstyle positioning ("高风险高回报的成长流") is allowed — it describes who an option suits, never what the player feels.
- **Zero dev jargon.** No delta / offer / 周期 / index. The test is "does a football fan know this word?" — OVR passes, delta doesn't.
- **Zero mixed Chinese/English** (established football-game domain words like OVR excepted).
- **Zero implementation details or dev notes.** No "向下取整", "暂以…近似", "（不超顶级）". State the effect, not the algorithm.
- **One term per concept, globally.** 赛季 (time unit) · 决策 (the once-per-period choice) · 轮回 (one run) · 成功概率 (odds — matches the decision deck label) · 档 (strength/offer step) · 战帖 (challenge share text).
- **Scannable.** One sentence, information in the first words; explanation strings ≤ 30 characters where possible.

### Layer B — Event narrative copy (diegetic)

Event situations, choice texts, outcome prose. The **world** is speaking; second person ("你") defines the player-character's situation. Interior monologue and psychological beats ARE part of this game's narrative voice — a deliberate product choice (stricter industry norms exist; see the research doc) — so 事件叙事 keeps its inner voice. Hard rules that still apply:

- No dev terms and no mixed language in narrative either. Footballer names (Best, Gerrard, Riquelme) pass the fan test; English common words ("feared", "mentoring") do not.
- Mechanics belong in a choice's `sub` line ("指导新秀 · 出场减少"), never inside outcome prose.
- One outcome tells one action and its consequence; keep outcomes tight (guideline ≤ ~120 characters), choice text ≤ 20.
- Numbers, trophies, and odds already shown by the UI are not re-narrated in prose.
