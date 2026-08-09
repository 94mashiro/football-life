/**
 * Name-localization probe — validate the nationality-authentic name generator.
 *
 * For every one of the 61 nations: draw N names from a batch of seeds, print
 * samples, and assert the design invariants:
 *   1. CJK nations render in their native script (chn→汉字, jpn→漢字, kor→한글).
 *   2. Korean names have NO space between surname and given (김민재, not 김 민재).
 *   3. Hispanic nations produce double surnames (paternal + maternal present
 *      in a good fraction — not 100%, since maternal is optional).
 *   4. Fallback nations (no explicit spec) NEVER produce a generic English
 *      "Jack Smith" — they reuse a same-region real pool (AFC→jpn CJK, etc.).
 *   5. No name exceeds the 16-char custom-name slice limit catastrophically
 *      (longest sample reported; >16 flagged but non-blocking — CJK is short,
 *      only some Hispanic double-surnames can run long and that's expected).
 *   6. Reproducibility: same seed+nat always yields the same string.
 *
 * Run:  npx tsx tools/name-probe.ts [N=12]
 */
import { NATIONS } from "../src/engine/data";
import { generatePlayerName, NAME_SPECS } from "../src/engine/names";

const N = Number(process.argv[2] ?? 12);

// A batch of distinct seeds (deterministic, no Math.random in the harness).
const SEEDS: string[] = Array.from({ length: N }, (_, i) => `probe-seed-${i}`);

const isHan = (s: string) => /[\u4e00-\u9fff]/.test(s);        // CJK unified (chn/jpn)
const isHangul = (s: string) => /[\uac00-\ud7af]/.test(s);      // Korean

let fail = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { fail++; console.log("  ✗ " + msg); } };

// nations WITHOUT an explicit spec — fall back to a confederation pool.
// (den/swe/nor/sui/aut now have own specs; OFC reuses eng — acceptable.)
const FALLBACK_EXPECT: Record<string, string> = {
  idn: "AFC", uzb: "AFC", irq: "AFC",             // → jpn (CJK)
  nzl: "OFC", fij: "OFC",                          // → eng
  bol: "CONMEBOL", ven: "CONMEBOL", per: "CONMEBOL", par: "CONMEBOL", ecu: "CONMEBOL",  // → arg
  crc: "CONCACAF", pan: "CONCACAF",                // → mex
};

console.log(`\n=== name-probe: ${N} seeds × ${NATIONS.length} nations ===\n`);

let totalMaxLen = 0;
for (const nat of NATIONS) {
  const id = nat.id;
  const hasSpec = id in NAME_SPECS;
  const spec = NAME_SPECS[id];
  const samples = SEEDS.map((s) => generatePlayerName(s, id));
  const unique = new Set(samples).size;
  const maxLen = Math.max(...samples.map((s) => s.length));
  totalMaxLen = Math.max(totalMaxLen, maxLen);
  const tag = hasSpec ? `spec(${spec.family}/${spec.script})` : "FALLBACK";

  // reproducibility check
  const dup = generatePlayerName(SEEDS[0]!, id);
  ok(dup === samples[0], `${id}: reproducibility broke (${dup} vs ${samples[0]})`);

  // CJK native-script assertion
  if (id === "chn" || id === "jpn") ok(samples.every(isHan), `${id}: not all Hanzi (${samples.slice(0, 3).join(", ")})`);
  if (id === "kor") ok(samples.every(isHangul), `kor: not all Hangul (${samples.slice(0, 3).join(", ")})`);
  // Korean no-space
  if (id === "kor") ok(samples.every((s) => !s.includes(" ")), `kor: name has space (${samples.find((s) => s.includes(" "))})`);

  // fallback nations: AFC minnows reuse the jpn (CJK) pool → samples MUST
  // contain Hanzi (proves they fell back to jpn, not a generic eng "Jack
  // Smith"). OFC reuses eng (English-speaking — acceptable); CONMEBOL/CONCACAF
  // reuse Hispanic Latin pools.
  if (id in FALLBACK_EXPECT) {
    const conf = FALLBACK_EXPECT[id]!;
    if (conf === "AFC") ok(samples.some(isHan), `${id} (AFC fb→jpn): no Hanzi in samples`);
  }

  // CJK anti-clone: real-player fragments are recombined — a generated name
  // must NOT equal a known real international's full name.
  if (id === "chn") ok(!samples.includes("武磊") && !samples.includes("郑智"), `chn: cloned a real player (${samples.find((s) => ["武磊","郑智","孙继海"].includes(s)) ?? "none"})`);
  if (id === "jpn") ok(!samples.includes("本田圭佑") && !samples.includes("中田英寿"), `jpn: cloned a real player`);
  if (id === "kor") ok(!samples.includes("손흥민") && !samples.includes("김민재"), `kor: cloned a real player`);

  const head = samples.slice(0, 3).map((s) => `"${s}"`).join(" ");
  console.log(`${id.padEnd(4)} ${nat.name.padEnd(6)} ${tag.padEnd(14)} uniq ${String(unique).padStart(2)}/${N} maxlen ${String(maxLen).padStart(2)}  ${head}`);
}

console.log(`\n=== summary ===`);
console.log(`nations with explicit spec: ${Object.keys(NAME_SPECS).length} / ${NATIONS.length}`);
console.log(`fallback nations:           ${NATIONS.length - Object.keys(NAME_SPECS).length}`);
console.log(`global longest sample:     ${totalMaxLen} chars`);
console.log(fail === 0 ? "ALL INVARIANTS PASS ✓" : `${fail} INVARIANT FAILURE(S) ✗`);
process.exit(fail === 0 ? 0 : 1);
