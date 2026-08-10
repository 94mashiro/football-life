# Balance Check: 阶段四 regional ceiling awards (中超最佳球员 / 中超金靴 / 亚洲足球先生)

Supplement sourced from the 足一把 career-sim award art (career-sim.pages.dev/
assets/trophies/). Three new `Award` kinds added to the existing Ballon d'Or /
Golden Boot / Golden Glove set, gated to a league or nationality, rolling on
INDEPENDENT derive streams so every existing seed's ballon/boot/glove + stats +
trophies + growth stay byte-identical (verified: `tools/award-determinism-check.ts`,
48 fingerprints incl. CSL/AFC setups, master vs worktree → identical).

## Data sources analyzed
- `src/engine/sim.ts` — `rollAwards` regional block (csl_mvp / csl_boot / afc_poy
  base tables + `posMvpMod`), `awardBaseProb` (existing, untouched).
- `src/meta/legacy.ts` — `AWARD_LEGACY` (regional tier: afc_poy 45 / csl_mvp 25 /
  csl_boot 20, vs global ballon 70 / boot 40 / glove 40).
- `tools/award-rate-probe.ts` — 300-run probes (skilled: wonderkid + 3 blessings +
  9 perks; and a stay-home variant that picks `stay` on transfers).

## Health summary: HEALTHY (one minor note)

## New tables
| Award | Gate | Per-season base | Mods |
|---|---|---|---|
| csl_mvp | league=="csl", non-GK, apps≥30 | OVR≥88 .09 · ≥84 .07 · ≥80 .045 · ≥76 .028 · ≥72 .016 · ≥68 .008 | ×posMvpMod ×(wonLeague?1.15) |
| csl_boot | league=="csl", non-GK | G≥30 .5 · ≥25 .25 · ≥20 .1 | — |
| afc_poy | nat AFC, non-GK, apps≥30 | OVR≥90 .065 · ≥86 .045 · ≥82 .028 · ≥78 .015 · ≥74 .007 | ×posMvpMod ×(nat-cont\|cont-primary?1.2) |

`posMvpMod`: att 1.0 / mid 0.8 / def 0.5 (softer than the Ballon d'Or
`awardPosModInternal` 0.25/0.5/1 — a defender CAN win a weaker league's MVP).

## Measured career-ever rates (300 runs)
| Award | skilled climbing | skilled stay-home |
|---|---|---|
| csl_mvp | 1% (0.01/career) | 18% (0.23/career) |
| csl_boot | 4% (0.05/career) | 36% (1.83/career) |
| afc_poy | 38–41% (elite Asian, climbing) | 22% (stay-home) |

Skilled = wonderkid + sharpshooter/glass_cannon/big_game_player + all 9 perks
(avg peak OVR 93 — the elite ceiling, not the median). Median careers (no buffs,
peak ~82) sit on the OVR 78–82 tiers → afc_poy ~0.015–0.028/season ≈ 10–15%
career-ever for a median Asian career.

## Outliers detected
| Item | Expected | Actual | Issue |
|---|---|---|---|
| csl_mvp (climbing) | a regional ceiling, not farmed | 1% | Low, but INTENDED — the award rewards the stay-home path (18%); a career that climbs out of CSL forgoes it. Not a bug. |
| csl_boot (stay-home) | ~0.5–1/career | 1.83/career | Generous: a roleplayed CSL legend sweeps the scoring title ~2×. Borderline-acceptable for a lower-prestige regional title (the honor wall collapses to ×N), but worth watching. |
| afc_poy (elite) | special, not automatic | 38–41% | High for the elite probe, but the probe is all-elite (avg peak 93); an elite Asian sweeping AFC POY is football-authentic (Son-tier). Median ~10–15%. OK. |

## Degenerate strategies
- **"Stay in CSL to farm csl_mvp/csl_boot"** — NOT degenerate: staying home yields
  regional awards (legacy 25/20) but forgoes the European path to Ballon d'Or
  (70) + top-league Golden Boot (40) + bigger trophy odds. The regional ceiling
  is strictly below the global one, so it is a meaningful trade-off (climb for
  glory vs stay for a guaranteed regional floor), not a dominant strategy.
- **afc_poy farming** — gated to AFC nationality (not player choice) and OVR
  74+; an elite Asian winning it repeatedly is the intended Son-tier fantasy,
  not a grind (no repeat-decay needed since it's a continental honor, not the
  Ballon d'Or crown jewel).

## Progression analysis
Before: a non-elite CSL/AFC career had NO individual award path (Ballon d'Or
gates at OVR 82 + top-tier league; Golden Boot gates to tier-1 contRep≥4). A
CSL stalwart or an Asian star could only win team trophies. The supplement adds
a personal-award floor for those careers (中超最佳球员 / 中超金靴 for CSL;
亚洲足球先生 for AFC), closing a dead zone without inflating the global
endgame (separate streams, not counted in `priorMajorAwards`, not fed into
`growthDelta`).

## Recommendations
| Priority | Issue | Suggested fix | Impact |
|---|---|---|---|
| Low | csl_boot 1.83/career stay-home | raise floor G≥20→≥22 (trim 20–21 goal seasons) | ~−20% stay-home rate; climbing unchanged. Optional — the ×N collapse reads fine. |
| — | csl_mvp 1% climbing | none | intended (stay-home reward) |
| — | afc_poy 38–41% elite | none | authentic for elite Asians; median ~10–15% |

## Values needing attention
None critical. The one soft knob: `csl_boot` goal floor (20 vs 22) if the
stay-home scoring-title rate feels spammy in playtesting.

## Determinism
Verified byte-identical (`tools/award-determinism-check.ts`): the regional
awards consume only NEW derive tags ("csl-mvp"/"csl-boot"/"afc-poy") and are
excluded from `priorMajorAwards` (run.ts filters ballon_dor/golden_glove) and
from `growthDelta`'s `r += 0.5/0.35` modifiers, so adding them moves only the
award record + end-of-career legacy — never the downstream stats/trophies of
any season. 48 fingerprints (eng-epl, csl-chn, jpn-epl, kor-csl-GK × 12 seeds)
match master exactly.
