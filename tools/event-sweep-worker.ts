/**
 * event-sweep 的分片工人 —— 由 tools/event-sweep.ts spawn，不要手动运行。
 *
 * 复刻 regress-worker 的 flat 索引（profile × policy × seed），所以同一颗
 * (profile:policy:i) 跟 regress / regress-trace 拿到完全相同的 seed，结果可交叉验证。
 *
 * 传参：JSON(args) shard shards —— 用 argv 而非 stdin，避免大对象序列化进 stdin。
 * 输出：每个 key 一行 `key fires touched`，外加一行 `@careers N` 报本片跑了多少局。
 * worker 内部已聚合，主进程只需 merge —— 不把每条决策都吐回 stdout。
 */
import { drive, POLICIES, corpusSeed } from "./_harness.ts";
import { PROFILES, POLICY_IDS } from "./_corpus.ts";

interface Args {
  profiles: readonly string[];
  policies: readonly string[];
  seedLo: number;
  seedHi: number;
  keys: readonly string[];
}
const args = JSON.parse(process.argv[2] ?? "{}") as Args;
const shard = Number(process.argv[3] ?? 0);
const shards = Number(process.argv[4] ?? 1);

const profileIdx = new Map(args.profiles.map((id) => [id, PROFILES.findIndex((p) => p.id === id)]));
const policyIdx = new Map(args.policies.map((id) => [id, POLICY_IDS.indexOf(id as never)]));

// flat 索引：(policyCell * PROFILES.length + profileCell) * SEEDS + i
// 与 regress-worker 一致：cell = policyIdx * PROFILES.length + profileIdx
const SEEDS_PER_CELL = 150; // 与 _corpus.SEEDS_PER_CELL 保持一致
const cells: { profile: typeof PROFILES[number]; policyId: string; flatBase: number }[] = [];
for (const pid of args.policies) {
  const pi = policyIdx.get(pid);
  if (pi === undefined) continue;
  for (const profId of args.profiles) {
    const pri = profileIdx.get(profId);
    if (pri === undefined) continue;
    const flatBase = (pi * PROFILES.length + pri) * SEEDS_PER_CELL;
    cells.push({ profile: PROFILES[pri]!, policyId: pid, flatBase });
  }
}

const fires: Record<string, number> = {};
const touched: Record<string, number> = {};
let careers = 0;

const totalSlots = cells.length * (args.seedHi - args.seedLo + 1);
for (let slot = shard; slot < totalSlots; slot += shards) {
  const cellIdx = Math.floor(slot / (args.seedHi - args.seedLo + 1));
  const i = args.seedLo + (slot % (args.seedHi - args.seedLo + 1));
  const c = cells[cellIdx]!;
  const flat = c.flatBase + i;
  const t = drive(corpusSeed(flat), c.profile, POLICIES[c.policyId]!, c.policyId);
  const seen = new Set<string>();
  for (const d of t.decisions) {
    const key = d.split(":")[0]!;
    fires[key] = (fires[key] ?? 0) + 1;
    if (!seen.has(key)) { seen.add(key); touched[key] = (touched[key] ?? 0) + 1; }
  }
  careers++;
}

const out: string[] = [`@careers ${careers}`];
for (const k of Object.keys(fires)) out.push(`${k} ${fires[k]} ${touched[k] ?? 0}`);
process.stdout.write(out.join("\n") + "\n");
