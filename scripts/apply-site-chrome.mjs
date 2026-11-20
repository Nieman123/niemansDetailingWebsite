// Stamps the shared header, footer, icon sprite, and brand stylesheet into public pages.
// Edit templates/partials/*.html, then run: node scripts/apply-site-chrome.mjs
// Pages opt in with <!-- site:… --> markers; pages listed in CONVERT get their legacy
// .site-header/.site-footer replaced with markers on first run.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

const partial = name => readFileSync(`templates/partials/${name}.html`, 'utf8').replace(/\r\n/g, '\n').trimEnd();
const blocks = {
  head: [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap">',
    '<link rel="stylesheet" href="/styles/brand.css?v=20261120">',
  ].join('\n  '),
  sprite: partial('sprite'),
  header: partial('header'),
  footer: partial('footer'),
  scripts: '<script defer src="/scripts/site.js?v=20261120"></script>',
};

const CONVERT = [
  'public/*-detailing.html',
  'public/services/*.html',
];

const marked = (name, body) => `<!-- site:${name} -->\n  ${body}\n  <!-- /site:${name} -->`;

function convertLegacy(html) {
  if (html.includes('<!-- site:header -->')) return html;
  const swap = (pattern, replacement) => {
    if (!pattern.test(html)) throw new Error('Pattern not found: ' + pattern);
    html = html.replace(pattern, replacement);
  };
  swap(/<header class="site-header">[\s\S]*?<\/header>/, marked('header', ''));
  swap(/<footer class="site-footer">[\s\S]*?<\/footer>/, marked('footer', ''));
  swap(/<a class="skip-link" href="#main-content">Skip to content<\/a>/, marked('sprite', '') + '\n  <a class="skip-link" href="#main-content">Skip to content</a>');
  swap(/<\/head>/, marked('head', '') + '\n</head>');
  swap(/<\/body>/, marked('scripts', '') + '\n</body>');
  html = html.replace(/<body([^>]*)>/, (match, attrs) => {
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch) return `<body class="nd has-action-bar"${attrs}>`;
    return `<body${attrs.replace(classMatch[0], `class="nd has-action-bar ${classMatch[1]}"`)}>`;
  });
  return html;
}

function currentNavPath(file) {
  const rel = '/' + path.relative('public', file).replace(/\\/g, '/').replace(/(index)?\.html$/, '');
  if (rel.startsWith('/services/')) return '/#services';
  if (rel.endsWith('-detailing')) return '/#service-area';
  return rel.replace(/\/$/, '') || '/';
}

const files = await fg(['public/**/*.html'], { ignore: ['public/admin/**', 'public/fragments/**'] });
const convert = new Set(await fg(CONVERT));
let changed = 0;
for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let html = original.replace(/\r\n/g, '\n');
  if (convert.has(file)) html = convertLegacy(html);
  if (!html.includes('<!-- site:header -->')) continue;

  const navPath = currentNavPath(file);
  for (const [name, body] of Object.entries(blocks)) {
    let content = body;
    if (name === 'header') {
      content = content.replace(/ aria-current="page"/g, '').replace(
        new RegExp(`(<nav class="site-nav"[\\s\\S]*?)<a href="${navPath.replace(/[#/]/g, '\\$&')}">`),
        `$1<a href="${navPath}" aria-current="page">`);
    }
    const pattern = new RegExp(`<!-- site:${name} -->[\\s\\S]*?<!-- /site:${name} -->`);
    if (pattern.test(html)) html = html.replace(pattern, marked(name, content));
  }
  if (html !== original.replace(/\r\n/g, '\n')) {
    writeFileSync(file, html);
    changed += 1;
  }
}
console.log(`Site chrome applied to ${changed} page(s).`);
