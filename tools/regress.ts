/**
 * 行为回归 —— 「我这次改动到底改了什么」的秒级答案。
 *
 *   npm run regress        对照基线跑一遍；行为没变 → 绿；变了 → 红 + 精确差异
 *   npm run regress:bless  把当前行为落成新基线（改动是有意的时候跑这个）
 *
 * 为什么是摘要而不是又一组阈值：引擎是完全确定性的（seed + 选择 ⇒ 生涯唯一），
 * 所以固定语料库的每一局都可以哈希成一枚指纹。阈值型 probe 只能回答「分布还
 * 在不在 band 里」，band 内的意外漂移（改 A 事件顺手动了 B）它看不见；指纹能
 * 看见每一处变化，并且能指出是哪些局、哪个 profile、终值差多少。
 *
 * 三层输出，从粗到细：
 *   1. 变了没有（一行结论）
 *   2. 哪些 profile × policy 格子受影响、受影响比例
 *   3. 聚合位移（中位巅峰 85→83、世界杯率 12%→9%）+ 前几局的具体差值
 *
 * 另外每轮跑一个 preview 自检：headless 模式关掉预览药丸（约省 40% CPU），
 * 这里用小样本验证「开/关摘要完全相同」，防止这个提速前提被后续改动悄悄破坏。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { setPreviewsEnabled } from "../src/engine/events";
import { drive, POLICIES, digest, corpusSeed, quantile, mean } from "./_harness";
import { PROFILES, POLICY_IDS, TOTAL_CAREERS, CORPUS_VERSION } from "./_corpus";

const BASELINE = fileURLToPath(new URL("./baseline/regress.txt", import.meta.url));
const WORKER = fileURLToPath(new URL("./regress-worker.ts", import.meta.url));
const bless = process.argv.includes("--bless");

// ───────────────────────────── run the corpus in parallel ─────────────────────────────

interface Row { key: string; digest: string; peak: number; seasons: number; legacy: number; trophies: number; awards: number; wc: number }

function parse(line: string): Row | null {
  const p = line.split(" ");
  if (p.length < 8) return null;
  return {
    key: p[0]!, digest: p[1]!, peak: +p[2]!, seasons: +p[3]!,
    legacy: +p[4]!, trophies: +p[5]!, awards: +p[6]!, wc: +p[7]!,
  };
}

function runShard(shard: number, shards: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", WORKER, String(shard), String(shards)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`shard ${shard} exit ${code}\n${err}`))));
  });
}

const shards = Math.max(2, Math.min(16, os.cpus().length - 2));
const t0 = performance.now();
const chunks = await Promise.all(Array.from({ length: shards }, (_, i) => runShard(i, shards)));
const rows = new Map<string, Row>();
for (const c of chunks) for (const line of c.split("\n")) {
  const r = parse(line.trim());
  if (r) rows.set(r.key, r);
}
const simMs = performance.now() - t0;

if (rows.size !== TOTAL_CAREERS) {
  console.error(`✗ 语料库跑出 ${rows.size} 局，应为 ${TOTAL_CAREERS} —— 分片丢结果了`);
  process.exit(1);
}

// ───────────────────────────── preview parity self-check ─────────────────────────────
//
// headless 提速的前提：预览药丸走独立 derive 流，关掉不改变任何生涯结果。
// 小样本双跑验证；一旦有人给 previewBranch 接上了career RNG，这里立刻红。
function previewParityFailures(n: number): string[] {
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    const profile = PROFILES[i % PROFILES.length]!;
    const policyId = POLICY_IDS[i % POLICY_IDS.length]!;
    const seed = corpusSeed(i * 7919);
    setPreviewsEnabled(false);
    const off = digest(drive(seed, profile, POLICIES[policyId]!, policyId));
    setPreviewsEnabled(true);
    const on = digest(drive(seed, profile, POLICIES[policyId]!, policyId));
    setPreviewsEnabled(false);
    if (off !== on) bad.push(`${profile.id}:${policyId} seed=${seed} off=${off} on=${on}`);
  }
  return bad;
}
const parityBad = previewParityFailures(24);

// ───────────────────────────── serialize / bless ─────────────────────────────

const sorted = [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const body = sorted.map((r) => `${r.key} ${r.digest} ${r.peak} ${r.seasons} ${r.legacy} ${r.trophies} ${r.awards} ${r.wc}`).join("\n");
const header = `# regress baseline corpus=v${CORPUS_VERSION} careers=${TOTAL_CAREERS}`;

if (parityBad.length > 0) {
  console.error(`✗ preview 自检失败 ${parityBad.length}/24 —— 预览构建已经影响生涯 RNG，headless 模式不再安全:`);
  for (const b of parityBad.slice(0, 5)) console.error(`    ${b}`);
  process.exit(1);
}

if (bless) {
  mkdirSync(fileURLToPath(new URL("./baseline/", import.meta.url)), { recursive: true });
  writeFileSync(BASELINE, `${header}\n${body}\n`);
  console.log(`✅ 基线已写入 tools/baseline/regress.txt (${TOTAL_CAREERS} 局, corpus v${CORPUS_VERSION}, ${(simMs / 1000).toFixed(1)}s)`);
  console.log(`   记得把它一起提交 —— diff 里看到这个文件变化 = 这次改动动了游戏行为。`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("✗ 没有基线。先跑 npm run regress:bless 落一份，并提交。");
  process.exit(1);
}

// ───────────────────────────── compare ─────────────────────────────

const baseLines = readFileSync(BASELINE, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
const baseHeader = readFileSync(BASELINE, "utf8").split("\n")[0] ?? "";
const baseVersion = /corpus=v(\d+)/.exec(baseHeader)?.[1];
if (baseVersion !== String(CORPUS_VERSION)) {
  console.error(`✗ 语料库版本不匹配: 基线 v${baseVersion} vs 代码 v${CORPUS_VERSION}`);
  console.error("   语料库定义改了（tools/_corpus.ts），旧基线无法比对。跑 npm run regress:bless 重新落。");
  process.exit(1);
}
const base = new Map<string, Row>();
for (const l of baseLines) { const r = parse(l); if (r) base.set(r.key, r); }

const changed = sorted.filter((r) => base.get(r.key)?.digest !== r.digest);

function agg(pred: (k: string) => boolean, src: Map<string, Row> | Row[]) {
  const list = (Array.isArray(src) ? src : [...src.values()]).filter((r) => pred(r.key));
  const peaks = list.map((r) => r.peak);
  return {
    n: list.length,
    med: quantile(peaks, 0.5),
    p10: quantile(peaks, 0.1),
    p90: quantile(peaks, 0.9),
    ge90: list.filter((r) => r.peak >= 90).length / (list.length || 1),
    lt70: list.filter((r) => r.peak < 70).length / (list.length || 1),
    seasons: mean(list.map((r) => r.seasons)),
    legacy: mean(list.map((r) => r.legacy)),
    wc: mean(list.map((r) => r.wc)),
  };
}

const wall = ((performance.now() - t0) / 1000).toFixed(1);

if (changed.length === 0) {
  console.log(`✅ 行为未变 —— ${TOTAL_CAREERS} 局摘要与基线完全一致 (${wall}s, ${shards} 核)`);
  process.exit(0);
}

console.log(`⚠️  行为已改变 —— ${changed.length}/${TOTAL_CAREERS} 局 (${(100 * changed.length / TOTAL_CAREERS).toFixed(1)}%) 与基线不同 (${wall}s)\n`);

// 受影响的格子
const cells = new Map<string, { changed: number; total: number }>();
for (const r of sorted) {
  const cell = r.key.split(":").slice(0, 2).join(":");
  const c = cells.get(cell) ?? { changed: 0, total: 0 };
  c.total++;
  if (base.get(r.key)?.digest !== r.digest) c.changed++;
  cells.set(cell, c);
}
console.log("受影响的 profile × policy 格子:");
for (const [cell, c] of [...cells].sort((a, b) => b[1].changed / b[1].total - a[1].changed / a[1].total)) {
  if (c.changed === 0) continue;
  const bar = "█".repeat(Math.round(20 * c.changed / c.total)).padEnd(20, "·");
  console.log(`  ${bar} ${String(c.changed).padStart(4)}/${c.total}  ${cell}`);
}

console.log("\n聚合位移 (基线 → 现在, 只列有变化的 profile):");
console.log("  profile          中位   p10    p90    ≥90     <70     赛季   传承    世界杯");
for (const p of PROFILES) {
  const pred = (k: string) => k.startsWith(`${p.id}:`);
  const b = agg(pred, base), a = agg(pred, sorted);
  const same = b.med === a.med && b.p10 === a.p10 && b.p90 === a.p90
    && Math.abs(b.ge90 - a.ge90) < 0.005 && Math.abs(b.lt70 - a.lt70) < 0.005
    && Math.abs(b.seasons - a.seasons) < 0.05 && Math.abs(b.legacy - a.legacy) < 1
    && Math.abs(b.wc - a.wc) < 0.005;
  if (same) continue;
  const d = (x: number, y: number, f = 0) => (x === y ? `${x.toFixed(f)}` : `${x.toFixed(f)}→${y.toFixed(f)}`);
  const pc = (x: number, y: number) => (Math.abs(x - y) < 0.005 ? `${(100 * x).toFixed(0)}%` : `${(100 * x).toFixed(0)}→${(100 * y).toFixed(0)}%`);
  console.log(`  ${p.id.padEnd(16)} ${d(b.med, a.med).padEnd(6)} ${d(b.p10, a.p10).padEnd(6)} ${d(b.p90, a.p90).padEnd(6)} ${pc(b.ge90, a.ge90).padEnd(7)} ${pc(b.lt70, a.lt70).padEnd(7)} ${d(b.seasons, a.seasons, 1).padEnd(6)} ${d(b.legacy, a.legacy).padEnd(7)} ${pc(b.wc, a.wc)}`);
}

console.log("\n前 8 局具体差值 (复现: 用 tools/regress-trace.ts <key>):");
for (const r of changed.slice(0, 8)) {
  const b = base.get(r.key)!;
  const f = (label: string, x: number, y: number) => (x === y ? "" : ` ${label} ${x}→${y}`);
  console.log(`  ${r.key.padEnd(26)}${f("巅峰", b.peak, r.peak)}${f("赛季", b.seasons, r.seasons)}${f("传承", b.legacy, r.legacy)}${f("奖杯", b.trophies, r.trophies)}${f("奖项", b.awards, r.awards)}`
    + (b.peak === r.peak && b.seasons === r.seasons && b.legacy === r.legacy && b.trophies === r.trophies && b.awards === r.awards ? "  (终值相同，过程不同)" : ""));
}

console.log("\n改动是有意的 → npm run regress:bless 重落基线并提交。");
process.exit(1);
