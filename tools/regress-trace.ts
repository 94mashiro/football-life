/**
 * 把 regress 报出的某一局摊开看 —— 差异定位的最后一公里。
 *
 *   npx tsx tools/regress-trace.ts bra-st-epl:varied:37
 *
 * regress 只能告诉你「这一局变了、终值差多少」；要知道是哪个赛季、哪次决策
 * 开始跑偏，就在改动前后各跑一次这个命令 diff 一下。
 */
import { drive, POLICIES, digest, canonical, corpusSeed } from "./_harness";
import { PROFILES, POLICY_IDS, SEEDS_PER_CELL } from "./_corpus";

const key = process.argv[2];
if (!key) {
  console.error("用法: npx tsx tools/regress-trace.ts <profileId>:<policyId>:<i>");
  process.exit(1);
}
const [profileId, policyId, iStr] = key.split(":");
const profile = PROFILES.find((p) => p.id === profileId);
const policy = policyId ? POLICIES[policyId] : undefined;
if (!profile || !policy || !POLICY_IDS.includes(policyId as never)) {
  console.error(`未知的 key: ${key}\nprofiles: ${PROFILES.map((p) => p.id).join(", ")}\npolicies: ${POLICY_IDS.join(", ")}`);
  process.exit(1);
}
// flat 索引必须和 regress-worker 的编排一致，才能还原同一颗种子。
const cell = POLICY_IDS.indexOf(policyId as never) * PROFILES.length + PROFILES.indexOf(profile);
const flat = cell * SEEDS_PER_CELL + Number(iStr);
const seed = corpusSeed(flat);

const t = drive(seed, profile, policy, policyId!);
console.log(`${key}  seed=${seed}  digest=${digest(t)}`);
console.log(`巅峰 ${t.peakOvr} · ${t.seasons} 赛季 · 传承 ${t.legacy} · 退役 ${t.retireReason || "-"}`);
console.log(`奖杯: ${t.trophies.join(", ") || "-"}`);
console.log(`奖项: ${t.awards.join(", ") || "-"}`);
console.log(`俱乐部: ${t.clubPath.join(" → ")}`);
console.log("\n逐季 (age,club,role,ovr,出场/进球/助攻/零封):");
for (const l of t.seasonLine) console.log(`  ${l}`);
console.log("\n决策 (key:option):");
for (const d of t.decisions) console.log(`  ${d}`);
if (process.env.CANON) console.log(`\ncanonical:\n${canonical(t)}`);
