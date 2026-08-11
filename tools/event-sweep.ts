/**
 * 事件频次批量扫描 —— 直接替换那条 process-per-career 的 shell one-liner。
 *
 *   npx tsx tools/event-sweep.ts \
 *       --profiles bra-st-epl,chn-st-l1,asc5-st,fra-lw-long \
 *       --policies first,varied,last \
 *       --seeds 0-30 \
 *       --keys academy_legacy,growth_spurt,boot_deal_youth,loan_to_satellite,harsh_coach,agent_circling,dual_nationality_youth,bone_age_verdict,roommate_released,u17_callup
 *
 * 为什么这个而不是 `npx tsx tools/regress-trace.ts … | grep | sort | uniq -c`：
 * 后者每局 spawn 一次 npx tsx（≈446ms 启动），465 局 ≈ 207s；这里把同样的 465 局
 * 塞进分片 worker，只付一次启动，跑完 <1s。瓶颈不是引擎慢，是那条循环 spawn 进程。
 *
 * 复刻 regress-worker 的分片：flat 索引和 regress-trace / regress-worker 完全一致，
 * 所以同一颗 (profile:policy:i) 拿到同一颗 seed，结果可与 regress-trace 交叉验证。
 *
 * 输出：
 *   1. 概况：N 局、墙钟、每局耗时
 *   2. 命中表：每个 key 的生涯命中数 / 出现总次数 / 命中率%，按次数降序
 *      —— --keys 指定的那批会高亮在前（方便盯某一组新事件）
 *   3. 0 命中：扫了却一次没弹的 key（死事件 / 门槛过窄的可疑信号）
 *
 * 默认全语料库（8 profiles × 3 policies × 150 seeds = 3600 局），跟 regress 同一个输入。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { PROFILES, POLICY_IDS } from "./_corpus.ts";

const WORKER = fileURLToPath(new URL("./event-sweep-worker.ts", import.meta.url));

// ───────────────────────────── argv ─────────────────────────────

interface Args {
  profiles: readonly string[];
  policies: readonly string[];
  seedLo: number;
  seedHi: number;
  keys: readonly string[];
}
function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (v: string | undefined, fallback: readonly string[]): readonly string[] =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
  const profiles = list(get("--profiles"), PROFILES.map((p) => p.id));
  const policies = list(get("--policies"), POLICY_IDS as readonly string[]);
  for (const p of profiles) if (!PROFILES.some((x) => x.id === p)) throw new Error(`未知 profile: ${p}`);
  for (const p of policies) if (!POLICY_IDS.includes(p as never)) throw new Error(`未知 policy: ${p}`);

  const seeds = get("--seeds") ?? "0-149";
  const m = /^(\d+)-(\d+)$/.exec(seeds);
  if (!m) throw new Error(`--seeds 必须是 lo-hi 形式，如 0-30，收到 ${seeds}`);
  const seedLo = Number(m[1]);
  const seedHi = Number(m[2]);
  if (seedLo > seedHi) throw new Error(`--seeds lo>hi: ${seeds}`);

  const keys = list(get("--keys"), []);
  return { profiles, policies, seedLo, seedHi, keys };
}

// ───────────────────────────── sharded workers ─────────────────────────────
//
// 沿用 regress.ts 的分片模式：主进程 spawn min(16, cpu-2) 个 worker，每个 worker
// 跑 flat%shards 的那批生涯，每行吐 `key count` 对（worker 内已聚合，避免把
// 每局每条决策都吐回主进程——那是 465 局 × 数十决策的 stdout 爆炸）。
// 主进程把各 worker 的局部聚合并成全局表。

function runShard(args: Args, shard: number, shards: number): Promise<Map<string, { fires: number; touched: number; careers: number }>> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", WORKER, JSON.stringify(args), String(shard), String(shards)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`worker ${shard} exit ${code}\n${err}`));
      const m = new Map<string, { fires: number; touched: number; careers: number }>();
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        const sp = s.split(" ");
        if (sp[0] === "@careers") { m.set("@careers", { fires: 0, touched: 0, careers: Number(sp[1]) }); continue; }
        const key = sp[0]!, fires = Number(sp[1]), touched = Number(sp[2]);
        m.set(key, { fires, touched, careers: 0 });
      }
      resolve(m);
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const totalCareers = args.profiles.length * args.policies.length * (args.seedHi - args.seedLo + 1);
const shards = Math.max(2, Math.min(16, os.cpus().length - 2));

const t0 = performance.now();
const chunks = await Promise.all(Array.from({ length: shards }, (_, i) => runShard(args, i, shards)));

// merge
const fires: Record<string, number> = {};
const touched: Record<string, number> = {};
let careers = 0;
for (const m of chunks) {
  const c = m.get("@careers");
  if (c) careers += c.careers;
  for (const [key, v] of m) {
    if (key === "@careers") continue;
    fires[key] = (fires[key] ?? 0) + v.fires;
    touched[key] = (touched[key] ?? 0) + v.touched;
  }
}
const wall = (performance.now() - t0) / 1000;

if (careers !== totalCareers) {
  console.error(`✗ 跑出 ${careers} 局，应为 ${totalCareers} —— 分片丢结果了`);
  process.exit(1);
}

// ───────────────────────────── 输出 ─────────────────────────────

const keySet = new Set(args.keys);
const present = Object.keys(fires).sort((a, b) => fires[b]! - fires[a]!);
const highlighted = present.filter((k) => keySet.has(k));
const rest = present.filter((k) => !keySet.has(k));
const zeroHit = args.keys.filter((k) => !(fires[k] > 0));

console.log(`N=${careers} 局 · ${shards} 核 · ${wall.toFixed(2)}s · ${(wall * 1000 / careers).toFixed(2)}ms/局`);
console.log(`profile=${args.profiles.join(",")}  policy=${args.policies.join(",")}  seeds=${args.seedLo}-${args.seedHi}`);
console.log("");

const printRow = (k: string) => {
  const f = fires[k] ?? 0;
  const t = touched[k] ?? 0;
  const pct = careers > 0 ? (t / careers * 100) : 0;
  console.log(`  ${String(f).padStart(6)} 次  ${String(t).padStart(6)} 局 ${pct.toFixed(1).padStart(5)}%  ${k}`);
};

if (highlighted.length > 0) {
  console.log(`盯住的 key（--keys，命中 ${highlighted.length}/${args.keys.length}）:`);
  for (const k of highlighted) printRow(k);
  if (zeroHit.length > 0) {
    console.log(`  ── 0 命中（扫了 ${careers} 局一次没弹，门槛/死事件可疑）:`);
    for (const k of zeroHit) console.log(`  ${" ".repeat(6)}      ${" ".repeat(6)}         ${k}`);
  }
  console.log("");
}

console.log(`全部命中 key（${present.length} 种，按次数降序）:`);
for (const k of rest) printRow(k);
