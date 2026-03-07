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
  if (/^(?:[a-z]+:)?\/\//i.test(clean) || clean.startsWith('data:')) return clean;
  let s = clean.startsWith('/') ? clean : '/' + clean;
  // Tolerate accidental /public/ prefixes and normalize to root-relative
  s = s.replace(/^\/public\//, '/');
  return s;
}

function toBasePath(url) {
  const rel = normalizeSrc(url)
    .replace(/^\//, '')
    .replace(/-\d+(?=\.[^.]+$)/, '');
  return path.posix.join('public', rel).replace(/\.[^.]+$/, '');
}

function isSizedVariantUrl(url) {
  return /-\d+\.(?:avif|webp|jpe?g|png)$/i.test(normalizeSrc(url));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function buildImg($, attrs, {src, srcset, sizes}) {
  const img = $('<img>');
  for (const [key, value] of Object.entries(attrs)) {
    if (['src', 'srcset', 'sizes'].includes(key)) continue;
    img.attr(key, value);
  }
  img.attr('src', src);
  if (srcset) img.attr('srcset', srcset);
  if (sizes) img.attr('sizes', sizes);
  return img;
}

function resolveSizes($, pictureEl, imgAttrs = {}) {
  if (imgAttrs.sizes) return imgAttrs.sizes;
  if (pictureEl) {
    const sourceWithSizes = $(pictureEl)
      .children('source')
      .toArray()
      .find((sourceEl) => Boolean($(sourceEl).attr('sizes')));
    if (sourceWithSizes) {
      return $(sourceWithSizes).attr('sizes');
    }
  }
  return SIZE_ATTR;
}

function buildResponsivePicture($, imgAttrs, variants, pictureAttrs = {}, sizes = SIZE_ATTR) {
  const picture = $('<picture>');
  for (const [key, value] of Object.entries(pictureAttrs)) {
    picture.attr(key, value);
  }
  if (variants.avif?.length) {
    picture.append(
      `<source type="image/avif" srcset="${buildSrcset(variants.avif)}" sizes="${sizes}">`
    );
  }
  if (variants.webp?.length) {
    picture.append(
      `<source type="image/webp" srcset="${buildSrcset(variants.webp)}" sizes="${sizes}">`
    );
  }
  const jpgSrcset = buildSrcset(variants.jpg);
  const fallback = chooseFallback(variants.jpg);
  picture.append(buildImg($, imgAttrs, {
    src: fallback.url,
    srcset: jpgSrcset,
    sizes
  }));
  return picture;
}

function pictureLooksResponsive($, pictureEl) {
  const img = $(pictureEl).children('img').first();
  if (img.length) {
    if (isSizedVariantUrl(img.attr('src'))) return true;
    if ((img.attr('srcset') || '').includes('w')) return true;
  }
  return $(pictureEl).children('source').toArray().some((sourceEl) => {
    const srcset = $(sourceEl).attr('srcset') || '';
    if (!srcset) return false;
    return srcset.includes('w') || srcset.split(',').some((entry) => isSizedVariantUrl(entry.trim().split(/\s+/)[0]));
  });
}

function getPictureBase($, pictureEl) {
  const img = $(pictureEl).children('img').first();
  const imgSrc = normalizeSrc(img.attr('src'));
  if (imgSrc.startsWith('/images/')) return toBasePath(imgSrc);

  const sources = $(pictureEl).children('source').toArray();
  for (const sourceEl of sources) {
    const srcset = $(sourceEl).attr('srcset') || '';
    const firstUrl = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    const normalized = normalizeSrc(firstUrl);
    if (normalized.startsWith('/images/')) return toBasePath(normalized);
  }

  return null;
}

const variantCache = new Map();

async function getVariants(base) {
  if (variantCache.has(base)) return variantCache.get(base);

  const pattern = `${base}-*.{avif,webp,jpg,jpeg}`;
  const variantsPromise = (async () => {
    const files = await fg(pattern, {posix: true});
    const variantPattern = new RegExp(`^${escapeRegex(base)}-(\\d+)\\.(avif|webp|jpe?g)$`);
    const variants = {};
    for (const file of files) {
      const m = file.match(variantPattern);
      if (!m) continue;
      const width = Number(m[1]);
      const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
      const rel = file.replace(/^public/, '');
      const url = rel.startsWith('/') ? rel : '/' + rel;
      if (!variants[ext]) variants[ext] = [];
      variants[ext].push({width, url});
    }
    for (const ext of Object.keys(variants)) {
      variants[ext].sort((a, b) => a.width - b.width);
    }
    return variants;
  })();

  variantCache.set(base, variantsPromise);
  return variantsPromise;
}

const originalCache = new Map();

async function getOriginal(base) {
  if (originalCache.has(base)) return originalCache.get(base);

  const originalPromise = (async () => {
    const matches = await fg(`${base}.{png,jpg,jpeg,webp,avif}`, {posix: true});
    const file = matches[0];
    if (!file) return null;
    const rel = file.replace(/^public/, '');
    return rel.startsWith('/') ? rel : '/' + rel;
  })();

  originalCache.set(base, originalPromise);
  return originalPromise;
}

async function processFile(file) {
  filesScanned++;

  // helpful trace in dry-run
  if (DRY) console.log(pc.dim(`[dry] scanning ${path.relative(process.cwd(), file)}`));

  const html = await readFile(file, 'utf8');
  const isFullDocument = /^\s*(?:<!doctype|<html[\s>])/i.test(html);
  const $ = load(html, {decodeEntities: false});
  let changed = false;
  let missingVariantsInFile = false;

  const imgEls = $('img').toArray();
  for (const el of imgEls) {
    if ($(el).parent().is('picture')) continue;
    const srcAttr = $(el).attr('src');
    const src = normalizeSrc(srcAttr);
    if (!src.startsWith('/images/')) continue;
    const base = toBasePath(src);
    const variants = await getVariants(base);
    if (!variants.jpg) {
      missingVariantsInFile = true;
      continue;
    }
    const imgAttrs = $(el).attr();
    const picture = buildResponsivePicture($, imgAttrs, variants, {}, resolveSizes($, null, imgAttrs));
    $(el).replaceWith(picture);
    imagesConverted++;
    changed = true;
  }

  const pictureEls = $('picture').toArray();
  for (const el of pictureEls) {
    const img = $(el).children('img').first();
    if (!img.length) continue;
    if (!pictureLooksResponsive($, el)) continue;

    const base = getPictureBase($, el);
    if (!base) continue;

    const variants = await getVariants(base);
    if (variants.jpg?.length) {
      const imgAttrs = img.attr();
      const rebuilt = buildResponsivePicture($, imgAttrs, variants, $(el).attr(), resolveSizes($, el, imgAttrs));
      const prevHtml = $.html(el);
      const nextHtml = $.html(rebuilt);
      if (prevHtml !== nextHtml) {
        $(el).replaceWith(rebuilt);
        picturesPatched++;
        changed = true;
      }
      continue;
    }

    const original = await getOriginal(base);
    if (!original) {
      missingVariantsInFile = true;
      continue;
    }

    const restoredImg = buildImg($, img.attr(), {src: original});
    const prevHtml = $.html(el);
    const nextHtml = $.html(restoredImg);
    if (prevHtml !== nextHtml) {
      $(el).replaceWith(restoredImg);
      picturesPatched++;
      changed = true;
    }
  }

  const preloadEls = $('link[rel="preload"][as="image"]').toArray();
  for (const el of preloadEls) {
    const hrefAttr = $(el).attr('href');
    const href = normalizeSrc(hrefAttr);
    if (!href.startsWith('/images/')) continue;
    const base = toBasePath(href);
    const variants = await getVariants(base);
    if (!variants.avif?.length) {
      const original = await getOriginal(base);
      if (!original) {
        missingVariantsInFile = true;
        continue;
      }
      const prevHref = normalizeSrc($(el).attr('href'));
      const prevSet = $(el).attr('imagesrcset');
      const prevSizes = $(el).attr('imagesizes');
      if (prevHref !== original || prevSet != null || prevSizes != null) {
        $(el).attr('href', original);
        $(el).removeAttr('imagesrcset');
        $(el).removeAttr('imagesizes');
        preloadsUpdated++;
        changed = true;
      }
      continue;
    }
    if (!variants.jpg?.length) {
      missingVariantsInFile = true;
      continue;
    }
    const avifList = variants.avif;
    const largest = avifList[avifList.length - 1].url;
    const avifSrcset = buildSrcset(avifList);
    const prevHref = normalizeSrc($(el).attr('href'));
    const prevSet = $(el).attr('imagesrcset') || '';
    const preloadSizes = $(el).attr('imagesizes') || SIZE_ATTR;
    const prevSizes = $(el).attr('imagesizes') || '';
    if (prevHref !== largest || prevSet !== avifSrcset || prevSizes !== preloadSizes) {
      $(el).attr('href', largest);
      $(el).attr('imagesrcset', avifSrcset);
      $(el).attr('imagesizes', preloadSizes);
      preloadsUpdated++;
      changed = true;
    }
  }

  if (changed) {
    const output = isFullDocument ? $.html() : ($('body').html() ?? $.html());
    await safeWriteFile(file, output);
  } else if (missingVariantsInFile) {
    filesSkipped++;
  }
}

async function main() {
  try {
    const files = await fg(['public/**/*.html'], {posix: true});
    for (const file of files) {
      await processFile(file);
    }
    console.log(pc.bold('rewire-images summary'));
    console.log('  files scanned:', filesScanned);
    console.log('  images converted to <picture>:', imagesConverted);
    console.log('  pictures rebuilt/restored:', picturesPatched);
    console.log('  preloads updated:', preloadsUpdated);
    console.log('  files skipped due to missing variants:', filesSkipped);
  } catch (err) {
    console.error(pc.red(err.stack || err));
    process.exit(1);
  }
}

main();
