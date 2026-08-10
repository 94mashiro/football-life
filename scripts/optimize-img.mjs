// Shrink oversized crest/flag/trophy art for mobile delivery.
//
// The copero/TheSportsDB mirror contains some multi-hundred-KB "SVGs" (embedded
// base64 rasters or mega-path vectors — worst case 2 MB) that the UI renders at
// ≤40 CSS px. This rasterizes every /public/img asset over SIZE_LIMIT to a
// 192px WebP (covers 40px @3x Retina and the share card), rewrites the mapping
// string in src/engine/images.ts, and deletes the fat original.
//
// One-shot / re-runnable after asset backfills. sharp is NOT a project dep:
//   npm i --no-save sharp && node scripts/optimize-img.mjs
import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IMG_DIR = join(ROOT, "public/img");
const IMAGES_TS = join(ROOT, "src/engine/images.ts");
const SIZE_LIMIT = 100 * 1024;
const TARGET = 192;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let ts = await readFile(IMAGES_TS, "utf8");
let before = 0, after = 0, converted = 0;
const skipped = [];

for await (const file of walk(IMG_DIR)) {
  if (!/\.(svg|png)$/.test(file)) continue;
  const size = (await stat(file)).size;
  if (size < SIZE_LIMIT) continue;

  // Match the bare relative path — mappings store either "clubs/FRA/x.svg"
  // or a full "/img/trophies/.../x.png" (string or template literal).
  const rel = relative(IMG_DIR, file);
  if (!ts.includes(rel)) { skipped.push(rel); continue; }

  const isSvg = file.endsWith(".svg");
  let img;
  if (isSvg) {
    // Scale SVG density so the vector rasterizes at >= TARGET px before encoding.
    const meta = await sharp(file).metadata();
    const dim = Math.max(meta.width ?? TARGET, meta.height ?? TARGET);
    img = sharp(file, { density: Math.min(2400, Math.max(72, Math.ceil((72 * TARGET) / dim))) });
  } else {
    img = sharp(file);
  }
  const out = file.replace(/\.(svg|png)$/, ".webp");
  await img
    .resize(TARGET, TARGET, { fit: "inside", withoutEnlargement: !isSvg })
    .webp({ quality: 82 })
    .toFile(out);

  const outSize = (await stat(out)).size;
  ts = ts.replaceAll(rel, rel.replace(/\.(svg|png)$/, ".webp"));
  await unlink(file);
  before += size; after += outSize; converted++;
  console.log(`${(size / 1024).toFixed(0).padStart(5)}K -> ${(outSize / 1024).toFixed(0).padStart(4)}K  ${rel}`);
}

await writeFile(IMAGES_TS, ts);
console.log(`\n${converted} files: ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
if (skipped.length) console.log(`skipped (not referenced in images.ts):\n  ${skipped.join("\n  ")}`);
