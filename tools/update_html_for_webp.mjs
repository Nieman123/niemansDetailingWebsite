#!/usr/bin/env node
// Usage: node tools/update_html_for_webp.mjs
import { readFileSync, writeFileSync, existsSync } from 'fs';

const file = 'public/index.html';
let html = readFileSync(file, 'utf8');

html = html.replace(/<img([^>]*?)src="([^"]+?)\.(jpe?g|png)"([^>]*)>/g, (match, pre, path, ext, post) => {
  const webpPath = `${path}.webp`;
  if (!existsSync(`public/${webpPath}`)) return match;
  return `<picture>\n  <source type="image/webp" srcset="${webpPath}">\n  <img${pre}src="${path}.${ext}"${post}>\n</picture>`;
});

writeFileSync(file, html, 'utf8');

console.log('Updated HTML with <picture> tags where WebP versions exist.');
