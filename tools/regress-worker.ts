/**
 * regress 的分片工人 —— 由 tools/regress.ts spawn，跑语料库的 1/N 并把结果
 * 按行吐到 stdout。不要手动运行。
 *
 * 分片按「单局」取模而非按格子，所以每个核心拿到的是同一批混合负载，
 * 不会出现「一个慢 profile 拖住整轮」的长尾（旧模式一个 probe 一个进程，
 * event-uniformity-counterfactual 一个人就占了 350s 墙钟）。
 *
 * 每行: <profileId>:<policyId>:<i> <digest> <copyDigest> <peak> <seasons> <legacy> <trophies> <awards> <wc>
 */
import { drive, POLICIES, digest, copyDigest, corpusSeed } from "./_harness";
import { PROFILES, POLICY_IDS, SEEDS_PER_CELL, TOTAL_CAREERS } from "./_corpus";

const shard = Number(process.argv[2] ?? 0);
const shards = Number(process.argv[3] ?? 1);

const out: string[] = [];
for (let flat = shard; flat < TOTAL_CAREERS; flat += shards) {
  const i = flat % SEEDS_PER_CELL;
  const cell = Math.floor(flat / SEEDS_PER_CELL);
  const profile = PROFILES[cell % PROFILES.length]!;
  const policyId = POLICY_IDS[Math.floor(cell / PROFILES.length)]!;
  const t = drive(corpusSeed(flat), profile, POLICIES[policyId]!, policyId);
  const wc = t.trophies.includes("world_cup") ? 1 : 0;
  out.push(`${profile.id}:${policyId}:${i} ${digest(t)} ${copyDigest(t)} ${t.peakOvr} ${t.seasons} ${t.legacy} ${t.trophies.length} ${t.awards.length} ${wc}`);
}
process.stdout.write(out.join("\n") + "\n");
