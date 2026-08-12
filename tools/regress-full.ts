/**
 * 全量回归 —— 行为指纹 + 所有带断言的门槛，一次跑完，一张总表。
 *
 *   npm run regress:full
 *
 * 和 `npm run regress` 的分工：regress 回答「行为变了没有」（秒级，改一行就跑）；
 * regress:full 额外跑平衡/形态门槛，回答「行为现在健不健康」（提交前跑）。
 *
 * 全部跑完再汇总，不在第一个红灯就停 —— 一次看到全貌比逐个撞墙快。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface Gate { id: string; desc: string; cmd: readonly string[] }

const HERE = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url));

const GATES: readonly Gate[] = [
  { id: "regress", desc: "行为指纹 (3600 局对照基线)", cmd: ["--import", "tsx", HERE("regress.ts")] },
  { id: "difficulty-smoke", desc: "难度曲线 15 条门槛", cmd: ["--import", "tsx", HERE("difficulty-smoke.ts")] },
  { id: "ascension-economy", desc: "飞升经济：identity / 货币随飞升单调不增 / 无溢价", cmd: ["--import", "tsx", HERE("ascension-economy-check.ts")] },
  { id: "climax-check", desc: "决战事件选项形态 / 预览药丸", cmd: ["--import", "tsx", HERE("climax-check.ts")] },
  { id: "dignified-exit", desc: "体面退场", cmd: ["--import", "tsx", HERE("dignified-exit-probe.ts")] },
  { id: "legacy-high-water", desc: "传承分高水位（身价下滑不抹峰值）", cmd: ["--import", "tsx", HERE("legacy-high-water.ts")] },
  { id: "preview-shape", desc: "预览分组: 共有后果必须在必定区、空簇须有落点", cmd: ["--import", "tsx", HERE("preview-shape-audit.ts")] },
  { id: "event-shape", desc: "事件奖惩形态 (无纯奖励选项)", cmd: [HERE("event-shape-check.mjs")] },
  { id: "odds-consistency", desc: "选项赔率一致 (shown % == rolled %)", cmd: [HERE("odds-consistency-check.mjs")] },
  { id: "combo-probe", desc: "词条成型 combo", cmd: ["--import", "tsx", HERE("combo-probe.ts")] },
];

function run(g: Gate): Promise<{ g: Gate; code: number; ms: number; out: string }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn(process.execPath, [...g.cmd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ g, code: code ?? 1, ms: performance.now() - t0, out }));
  });
}

const t0 = performance.now();
const results = await Promise.all(GATES.map(run));
const wall = (performance.now() - t0) / 1000;

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  console.log(`\n──────── ${r.g.id} ────────`);
  console.log(r.out.trim().split("\n").slice(-25).join("\n"));
}

console.log(`\n${"".padEnd(58, "─")}`);
for (const r of results) {
  const mark = r.code === 0 ? "✓" : "✗";
  console.log(`  ${mark} ${r.g.id.padEnd(18)} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.g.desc}`);
}
console.log(`${"".padEnd(58, "─")}`);
console.log(failed.length === 0
  ? `✅ 全部通过 (${wall.toFixed(1)}s)`
  : `⚠️  ${failed.length}/${results.length} 项未通过 (${wall.toFixed(1)}s): ${failed.map((r) => r.g.id).join(", ")}`);
process.exit(failed.length === 0 ? 0 : 1);
