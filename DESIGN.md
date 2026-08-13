# Design

<!-- impeccable:design-schema 1 -->

## World

Football-game category standard at EA FC / Dream League Soccer craft. Cool pitch-night plates under a lime floodlight. The debut object is a FUT player card, not a settings form. Electric lime is the only CTA chrome. Teal is reserved for "good" odds and must never share the lime hue.

## Surfaces

- `--color-ink` / `--color-surface` / `--color-line`: night zinc tinted toward hue 140.
- `--color-accent` / `--color-accent-2`: electric lime. Primary buttons and selected chips use near-black ink on the lime face.
- `--color-good`: teal. Odds pills, positive ratings.
- `--color-gold`, `--color-warn`, `--color-danger`, `--color-purple` (飞升 only) keep their roles.
- Six-tier FUT foil (`bronze` → `special`) still owns the mud-to-marble OVR arc.

## Type

PingFang SC stack only. Hero numerals are `font-black` + tabular-nums. No display face.

## Menu / debut

Centered foil card: starting OVR, position, flag, name, number, pace, seed. Each region opens the existing picker sheet (select-then-confirm). Lime `开始生涯` sits in the thumb zone. Returning HUD chips (连击 / 飞升 / 下一解锁) sit above the card. Custom seed prints "不结算传承" on the card.

## Inheritance

Play and summary inherit the night + lime tokens this round. Their layouts are unchanged. Foil badges stay rarity-colored (elite/special remain magenta).
