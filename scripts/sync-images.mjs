import {cp, mkdir, readFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import fg from 'fast-glob';
import pc from 'picocolors';

const SRC_DIR = 'assets/images';
const OUT_DIR = 'public/images';
const MANIFEST = `${OUT_DIR}/.variants.json`;

async function main() {
  try {
    // Keep the generated size variants (tools/build-images.mjs reuses them when the source is
    // unchanged) and only refresh the originals.
    await mkdir(OUT_DIR, {recursive: true});
    await cp(SRC_DIR, OUT_DIR, {
      recursive: true,
      force: true,
      filter: (src) => !src.endsWith('.DS_Store')
    });

    // Remove originals that were deleted from assets/images. Variants are pruned by build-images.
    let variants = {};
    if (existsSync(MANIFEST)) {
      try { variants = JSON.parse(await readFile(MANIFEST, 'utf8')).variants ?? {}; } catch {}
    }
    const sources = new Set((await fg('**/*', {cwd: SRC_DIR, dot: true})));
    for (const file of await fg('**/*', {cwd: OUT_DIR, dot: false})) {
      if (!sources.has(file) && !(`${OUT_DIR}/${file}` in variants)) await rm(`${OUT_DIR}/${file}`, {force: true});
    }
    console.log(pc.green('Synced image sources'), `${SRC_DIR} -> ${OUT_DIR}`);
  } catch (err) {
    console.error(pc.red(err.stack || err));
    process.exit(1);
  }
}

main();
