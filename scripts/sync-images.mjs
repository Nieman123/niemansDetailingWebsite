import {cp, mkdir, rm} from 'node:fs/promises';
import pc from 'picocolors';

const SRC_DIR = 'assets/images';
const OUT_DIR = 'public/images';

async function main() {
  try {
    await rm(OUT_DIR, {recursive: true, force: true});
    await mkdir('public', {recursive: true});
    await cp(SRC_DIR, OUT_DIR, {
      recursive: true,
      force: true,
      filter: (src) => !src.endsWith('.DS_Store')
    });
    console.log(pc.green('Synced image sources'), `${SRC_DIR} -> ${OUT_DIR}`);
  } catch (err) {
    console.error(pc.red(err.stack || err));
    process.exit(1);
  }
}

main();
