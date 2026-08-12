/** Self-check for P-ASC-GATES per-level unlock semantics. Run:
 *  `npx tsx tools/ascension-unlock-check.ts` — throws on any regression. */
import { applyRunResult, maxAscensionUnlocked, bestAtOrAbove, defaultMeta, ASCENSION_UNLOCK_REQ, type MetaSave } from "../src/meta/legacy";

function eq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

// fresh save: nothing unlocked
let m = defaultMeta();
eq(maxAscensionUnlocked(m), 0, "fresh");

// a good asc-0 run unlocks A1 only — even a monster score can't skip rungs
m = applyRunResult(defaultMeta(), 2600, 0);
eq(maxAscensionUnlocked(m), 1, "monster asc-0 run unlocks exactly A1");
eq(bestAtOrAbove(m, 0), 2600, "bestAtOrAbove(0)");
eq(bestAtOrAbove(m, 1), 0, "bestAtOrAbove(1) untouched");

// climbing rung by rung: qualifying run at L-1 unlocks L
m = defaultMeta();
for (let lvl = 1; lvl < ASCENSION_UNLOCK_REQ.length; lvl++) {
  m = applyRunResult(m, ASCENSION_UNLOCK_REQ[lvl]!, lvl - 1);
  eq(maxAscensionUnlocked(m), lvl, `climb to A${lvl}`);
}

// a run at a HIGHER level counts down (harder always qualifies) — use a value
// between A1 and A2 reqs so it credits A1 but not A2 (robust to req retuning).
const a1Only = Math.floor((ASCENSION_UNLOCK_REQ[1]! + ASCENSION_UNLOCK_REQ[2]!) / 2);
m = applyRunResult(defaultMeta(), a1Only, 2);
eq(maxAscensionUnlocked(m), 1, "asc-2 run credits the A1 gate");

// a below-gate run unlocks nothing
m = applyRunResult(defaultMeta(), ASCENSION_UNLOCK_REQ[1]! - 1, 0);
eq(maxAscensionUnlocked(m), 0, "below-gate run");

// grandfathering shape: seeded saves reproduce their old max, no extra rung
// (mirrors normalizeAscensionBests: REQ[k+1] at k<oldMax, bestRun credited at 0)
const oldMax = 7;
const seeded: number[] = [];
for (let k = 0; k < oldMax; k++) seeded[k] = ASCENSION_UNLOCK_REQ[k + 1]!;
seeded[0] = Math.max(seeded[0]!, 1300);
const g: MetaSave = { ...defaultMeta(), bestRun: 1300, ascension: 7, bestByAscension: seeded };
eq(maxAscensionUnlocked(g), oldMax, "grandfathered save keeps exactly its old rungs");

console.log("ascension-unlock-check: all assertions passed");
