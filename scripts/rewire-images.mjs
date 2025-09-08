import fg from 'fast-glob';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {load} from 'cheerio';
import pc from 'picocolors';

const SIZE_ATTR = '(max-width: 900px) 100vw, 900px';

const DRY = process.argv.includes('--dry');

async function safeWriteFile(file, content) {
  if (DRY) {
    console.log(pc.yellow(`[dry] would write: ${file}`));
    return;
  }
  await writeFile(file, content);
}

let filesScanned = 0;
let imagesConverted = 0;
let picturesPatched = 0;
let preloadsUpdated = 0;
let filesSkipped = 0;

function normalizeSrc(src) {
  if (!src) return '';
  const clean = src.split(/[?#]/)[0];
  return clean.startsWith('/') ? clean : '/' + clean;
}

async function getVariants(base) {
  const pattern = `${base}-*.{avif,webp,jpg,jpeg}`;
  const files = await fg(pattern, {posix: true});
  const variants = {};
  for (const file of files) {
    const m = file.match(/-(\d+)\.(avif|webp|jpe?g)$/);
    if (!m) continue;
    const width = Number(m[1]);
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const rel = file.replace(/^public/, '');
    const url = rel.startsWith('/') ? rel : '/' + rel;
    if (!variants[ext]) variants[ext] = [];
    variants[ext].push({width, url});
  }
  for (const ext of Object.keys(variants)) {
    variants[ext].sort((a,b) => a.width - b.width);
  }
  return variants;
}

function buildSrcset(list) {
  return list.map(v => `${v.url} ${v.width}w`).join(', ');
}

function chooseFallback(list) {
  const target = 800;
  let selected = list[0];
  for (const v of list) {
    if (v.width === target) return v;
    if (v.width > target) {
      selected = v;
      break;
    }
    selected = v;
  }
  return selected;
}

async function processFile(file) {
  filesScanned++;

  // helpful trace in dry-run
  if (DRY) console.log(pc.dim(`[dry] scanning ${path.relative(process.cwd(), file)}`));

  const html = await readFile(file, 'utf8');
  const $ = load(html, {decodeEntities: false});
  let changed = false;
  let missingVariantsInFile = false;

  const imgEls = $('img').toArray();
  for (const el of imgEls) {
    if ($(el).parent().is('picture')) continue;
    const srcAttr = $(el).attr('src');
    const src = normalizeSrc(srcAttr);
    if (!src.startsWith('/images/')) continue;
    const rel = src.replace(/^\//, '');
    const base = path.posix.join('public', rel).replace(/\.[^.]+$/, '');
    const variants = await getVariants(base);
    if (!variants.jpg) {
      missingVariantsInFile = true;
      continue;
    }
    const avifSrcset = variants.avif ? buildSrcset(variants.avif) : null;
    const webpSrcset = variants.webp ? buildSrcset(variants.webp) : null;
    const jpgSrcset = buildSrcset(variants.jpg);
    const fallback = chooseFallback(variants.jpg);

    const attrs = $(el).attr();
    const imgTag = $('<img>');
    for (const [key, value] of Object.entries(attrs)) {
      if (['src', 'srcset', 'sizes'].includes(key)) continue;
      imgTag.attr(key, value);
    }
    imgTag.attr('src', fallback.url);
    imgTag.attr('srcset', jpgSrcset);
    imgTag.attr('sizes', SIZE_ATTR);

    const picture = $('<picture>');
    if (avifSrcset) {
      picture.append(`<source type="image/avif" srcset="${avifSrcset}" sizes="${SIZE_ATTR}">`);
    }
    if (webpSrcset) {
      picture.append(`<source type="image/webp" srcset="${webpSrcset}" sizes="${SIZE_ATTR}">`);
    }
    picture.append(imgTag);
    $(el).replaceWith(picture);
    imagesConverted++;
    changed = true;
  }

  const pictureEls = $('picture').toArray();
  for (const el of pictureEls) {
    if ($(el).children('source[type="image/avif"]').length > 0) continue;
    const img = $(el).children('img').first();
    if (!img.length) continue;
    const src = normalizeSrc(img.attr('src'));
    if (!src.startsWith('/images/')) continue;
    const rel = src.replace(/^\//, '').replace(/-\d+(?:\.[^.]+)$/, '');
    const base = path.posix.join('public', rel).replace(/\.[^.]+$/, '');
    const variants = await getVariants(base);
    if (!variants.avif) {
      missingVariantsInFile = true;
      continue;
    }
    const avifSrcset = buildSrcset(variants.avif);
    $(el).prepend(`<source type="image/avif" srcset="${avifSrcset}" sizes="${SIZE_ATTR}">`);
    picturesPatched++;
    changed = true;
  }

  const preloadEls = $('link[rel="preload"][as="image"]').toArray();
  for (const el of preloadEls) {
    const hrefAttr = $(el).attr('href');
    const href = normalizeSrc(hrefAttr);
    if (!href.startsWith('/images/')) continue;
    const rel = href.replace(/^\//, '').replace(/\.[^.]+$/, '');
    const base = path.posix.join('public', rel);
    const variants = await getVariants(base);
    if (!variants.avif) {
      missingVariantsInFile = true;
      continue;
    }
    const avifList = variants.avif;
    const largest = avifList[avifList.length - 1].url;
    const avifSrcset = buildSrcset(avifList);
    const prevHref = normalizeSrc($(el).attr('href'));
    const prevSet = $(el).attr('imagesrcset') || '';
    const prevSizes = $(el).attr('imagesizes') || '';
    if (prevHref !== largest || prevSet !== avifSrcset || prevSizes !== SIZE_ATTR) {
      $(el).attr('href', largest);
      $(el).attr('imagesrcset', avifSrcset);
      $(el).attr('imagesizes', SIZE_ATTR);
      preloadsUpdated++;
      changed = true;
    }
  }

  if (changed) {
    // this is the whole point: respect --dry
    await safeWriteFile(file, $.html());
  } else if (missingVariantsInFile) {
    filesSkipped++;
  }
}

async function main() {
  try {
    const files = await fg(['**/*.html', '!node_modules/**'], {posix: true});
    for (const file of files) {
      await processFile(file);
    }
    console.log(pc.bold('rewire-images summary'));
    console.log('  files scanned:', filesScanned);
    console.log('  images converted to <picture>:', imagesConverted);
    console.log('  pictures patched with AVIF:', picturesPatched);
    console.log('  preloads updated:', preloadsUpdated);
    console.log('  files skipped due to missing variants:', filesSkipped);
  } catch (err) {
    console.error(pc.red(err.stack || err));
    process.exit(1);
  }
}

main();
