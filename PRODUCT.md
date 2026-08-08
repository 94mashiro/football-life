# Product

## Register

product

## Users

Football fans who actively follow the sport — who know World Cup years, the Ballon d'Or race, big-club transfers, and decisive penalties. They play in short bursts on mobile: a commute, a queue, a five-minute break. They want to pick it up instantly, play a full career in a few minutes, and feel the pull to start "just one more run." They are not spreadsheet managers; they are fans chasing a "what if" fantasy.

## Product Purpose

绿茵轮回 is a roguelike football-career sim. Each run is one career from 16-year-old academy prospect to retirement. Every decision changes fate; a seed determines everything, so the same seed + same choices always reproduces the same career — shareable, replayable, replay-able for a friend to challenge. Death is the end of a run but legacy (传承) is permanent and unlocks blessings, ascensions, new nations and leagues across runs. Success = "easy to learn, simple to operate, but addictive" — a quick game anytime that football fans return to.

## Brand Personality

Authentic, addictive, electric. Three words: football-first, quick-hit, legendary. The interface should feel like a Saturday-night fixture under the lights — tense, glamorous, a little theatrical — never like a database admin panel. Emotion: the buzz of a pack opening, the dread of an 18% penalty, the pride of a shareable end-of-career card.

## Anti-references

- The "wall of stats" that scares casual fans — dense attribute tables upfront, meta-progression shown before the first retirement.
- Generic dark SaaS dashboards with no identity, where a football sim could be any productivity tool.
- Football Manager's data-density at the cost of feel (great for hardcore managers, wrong for our quick-burst fan).
- Competitor games that hide odds behind opacity — our visible odds are the differentiator and must stay the hero of every decision.
- Card-board brutalism: endless identical cards with no sense of premium or spectacle.

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
