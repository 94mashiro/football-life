/**
 * 单线程生涯吞吐基准 —— 用来验证 headless（关预览 + narrative 记忆化）到底省了多少。
 *
 *   npx tsx tools/_bench.ts [N=1500]
 *
 * 跑两遍同一批生涯（预览开/关），打印吞吐比。摘要必须一致——不一致说明预览
 * 构建已经污染了生涯 RNG，headless 提速的前提被破坏了（regress 也会红）。
 */
import { setPreviewsEnabled } from "../src/engine/events";
import { drive, POLICIES, digest, corpusSeed } from "./_harness";
import { PROFILES } from "./_corpus";

const N = Number(process.argv[2] ?? 1500);
const profile = PROFILES[0]!;
const policy = POLICIES["varied"]!;

function pass(label: string, previews: boolean): { ms: number; sig: number } {
  setPreviewsEnabled(previews);
  for (let i = 0; i < 100; i++) drive(corpusSeed(i), profile, policy, "varied"); // warm
  const t0 = performance.now();
  let sig = 0;
  for (let i = 0; i < N; i++) sig = (sig + Number.parseInt(digest(drive(corpusSeed(i + 1000), profile, policy, "varied")), 36)) >>> 0;
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(16)} ${(ms / N).toFixed(3)} ms/局  ${Math.round(N / (ms / 1000))} 局/秒`);
  return { ms, sig };
}

const on = pass("预览开 (app)", true);
const off = pass("预览关 (headless)", false);
setPreviewsEnabled(false);
console.log(`\nheadless 提速 ${(on.ms / off.ms).toFixed(2)}×`);
console.log(on.sig === off.sig ? "摘要一致 ✓ (关预览不改变任何生涯结果)" : "✗ 摘要不一致 —— 预览构建污染了生涯 RNG");
if (on.sig !== off.sig) process.exit(1);
