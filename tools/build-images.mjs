import fg from 'fast-glob';
import sharp from 'sharp';
import pc from 'picocolors';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';

const SRC_DIR = 'assets/images';     // originals live here (png/jpg/webp)
const OUT_DIR = 'public';            // generated sizes+formats go under public/images/...
// Records which source content and settings produced each variant. Hosting ignores dotfiles.
const MANIFEST = join(OUT_DIR, 'images', '.variants.json');
const SIZES   = [150, 300, 512, 640, 800, 1024, 1375]; // tweak per need

const formats = {
  avif: { quality: 40 },                // 30–45 is a good range
  webp: { quality: 85 },                // 80–90 is typical
  jpg:  { quality: 85, progressive: true }
};

// Variants are reused only when the source bytes and these settings are unchanged. Comparing
// content, not file times, is what lets a CI cache survive a fresh git checkout.
const settings = JSON.stringify({ sharp: sharp.versions?.sharp, SIZES, formats });

function readManifest() {
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return manifest && typeof manifest.variants === 'object' ? manifest.variants : {};
  } catch {
    return {};
  }
}

const previous = readManifest();
const next = {};
const files = (await fg([`${SRC_DIR}/**/*.{png,jpg,jpeg,webp}`], { dot: false })).sort();
let built = 0;
let reused = 0;
let failed = 0;

// Sources that differ only by extension (logo.png + logo.webp) share variant names. The last one
// in sorted order wins, so each variant has exactly one source and is not rebuilt on every run.
const sources = new Map();
for (const file of files) {
  const relDir = dirname(file).replace(/^assets\/?/, ''); // keep subfolders
  const outDir = join(OUT_DIR, relDir);
  sources.set(join(outDir, basename(file, extname(file))), { file, outDir });
}

async function buildSource({ file, outDir }) {
  const base = basename(file, extname(file));
  const fingerprint = createHash('sha256').update(settings).update(readFileSync(file)).digest('hex');
  mkdirSync(outDir, { recursive: true });

  for (const w of SIZES) {
    const basePipe = sharp(file).resize({ width: w, withoutEnlargement: true });
    for (const [fmt, opts] of Object.entries(formats)) {
      const outPath = join(outDir, `${base}-${w}.${fmt}`).replace(/\\/g, '/');
      if (previous[outPath] === fingerprint && existsSync(outPath)) {
        next[outPath] = fingerprint;
        reused++;
        continue;
      }
      try {
        let p = basePipe.clone();
        if (fmt === 'avif') p = p.avif(opts);
        if (fmt === 'webp') p = p.webp(opts);
        if (fmt === 'jpg')  p = p.jpeg(opts);
        await p.toFile(outPath);
        next[outPath] = fingerprint;
        built++;
        console.log(pc.green('✓'), outPath);
      } catch (err) {
        failed++;
        console.error(pc.red('✗'), outPath, err.message);
      }
    }
  }
}

// A few sources at a time keeps a cold build quick without exhausting runner memory.
const queue = [...sources.values()];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await buildSource(queue.shift());
}));

// Drop variants whose source image was removed or renamed, so they are not deployed.
for (const outPath of Object.keys(previous)) {
  if (!(outPath in next)) rmSync(outPath, { force: true });
}

mkdirSync(dirname(MANIFEST), { recursive: true });
writeFileSync(MANIFEST, `${JSON.stringify({ variants: next }, null, 1)}\n`);
console.log(`Images: ${built} built, ${reused} reused from earlier builds, ${failed} failed.`);
if (failed) process.exitCode = 1;
