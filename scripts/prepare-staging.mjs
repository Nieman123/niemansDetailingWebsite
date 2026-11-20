import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { firebaseConfig as production } from '../public/scripts/firebase-config.mjs';

const projectId = process.env.STAGING_FIREBASE_PROJECT_ID;
const publicDir = 'public-staging';
const deploymentConfig = 'firebase.staging.generated.json';

if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? '') || projectId === production.projectId) {
  throw new Error('STAGING_FIREBASE_PROJECT_ID must be a valid, separate Firebase project ID.');
}

let webConfig;
try {
  const input = (process.env.STAGING_FIREBASE_WEB_CONFIG ?? '').trim();
  const sdkSnippet = /^const\s+firebaseConfig\s*=\s*(\{[\s\S]+\})\s*;?$/.exec(input);
  // Firebase's Web SDK snippet uses bare JS keys. Convert only its object literal and parse as data.
  const json = sdkSnippet ? sdkSnippet[1]
    .replace(/([,{]\s*)([A-Za-z_]\w*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*}/, '}') : input;
  webConfig = JSON.parse(json);
} catch {
  throw new Error('STAGING_FIREBASE_WEB_CONFIG must be the staging web app SDK config as JSON or as the Firebase config object snippet.');
}

const origin = `https://${projectId}.web.app`;
const authDomains = new Set([`${projectId}.firebaseapp.com`, `${projectId}.web.app`]);
const storageBuckets = new Set([`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`]);
if (webConfig?.projectId !== projectId || !authDomains.has(webConfig.authDomain) ||
    !storageBuckets.has(webConfig.storageBucket) || typeof webConfig.apiKey !== 'string' ||
    !webConfig.apiKey.trim() || webConfig.apiKey === production.apiKey ||
    !/^1:\d+:web:[a-f0-9]+$/i.test(webConfig.appId ?? '')) {
  throw new Error('Supply the SDK config from the staging web app, including its default Storage bucket.');
}

const { apiKey, authDomain, storageBucket, appId } = webConfig;
const stagingConfig = { apiKey, authDomain, projectId, storageBucket, appId };

const siteCopy = {};
const copySelectors = {
  'index.html': {
    headline: '.hero-copy h1', introduction: '.hero-copy .sub-title',
    serviceAreas: '.srv-area-txt h3:first-of-type', contactNote: '.srv-area-txt h2',
    testimonials: '.testimonial-list blockquote', serviceDescriptions: '.overview-service-copy',
  },
  'schedule.html': { bookingNotice: '.booking-intro' },
};
const readCopy = element => element.text().trim().replace(/\s+/g, ' ');

function preparePages(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      preparePages(file);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const isFragment = path.relative(publicDir, file).startsWith(`fragments${path.sep}`);
      const $ = load(readFileSync(file, 'utf8'), {}, !isFragment);
      $('a[href], form[action]').each((_, element) => {
        const node = $(element);
        const attribute = node.is('form') ? 'action' : 'href';
        const href = node.attr(attribute);
        const relative = href.replace(/^https?:\/\/(?:www\.)?niemansdetailing\.com(?=\/|[?#]|$)/i, '');
        if (relative !== href) node.attr(attribute, relative.startsWith('/') ? relative : `/${relative}`);
      });
      $('meta[name="firebase-api-key"]').remove();
      const name = path.relative(publicDir, file);
      const selectors = copySelectors[name];
      if (selectors) {
        for (const [key, selector] of Object.entries(selectors)) {
          const nodes = $(selector);
          if (!nodes.length) throw new Error('Site copy selector matched nothing: ' + selector);
          siteCopy[key] = nodes.map((_, element) => {
            const node = $(element);
            if (key === 'serviceDescriptions') {
              const copy = node.clone();
              copy.find('a').each((_, link) => {
                const anchor = $(link);
                if (!anchor.is('[class*="button"]')) anchor.replaceWith(anchor.text());
                else anchor.remove();
              });
              return readCopy(copy);
            }
            return readCopy(node);
          }).get().join('\n\n');
          if (nodes.length === 1) {
            nodes.attr('data-site-copy', key).attr('data-original-copy', siteCopy[key]);
          } else {
            const override = $('<p class="site-copy-override" hidden></p>').attr('data-site-copy', key).attr('data-original-copy', siteCopy[key]);
            if (key === 'serviceDescriptions') $('.overview-services').first().append(override);
            else {
              nodes.attr('data-original-section', key);
              nodes.parent().first().append(override);
            }
          }
        }
      }
      if (name === 'faq.html') {
        $('.faq-item').last().after('<section data-site-copy="faq" class="site-copy-override" hidden></section>');
      }
      if (selectors || name === 'faq.html') {
        $('body').append('<script type="module" src="/scripts/published-site-content.mjs"></script>');
      }
      writeFileSync(file, $.html());
    }
  }
}

cpSync('public', publicDir, { recursive: true, force: false, errorOnExist: true });
cpSync('templates/schedule.html', path.join(publicDir, 'schedule.html'));
preparePages(publicDir);
const publishing = path.join(publicDir, 'admin', 'content.html');
const $publishing = load(readFileSync(publishing, 'utf8'));
const serializedCopy = JSON.stringify(siteCopy).replace(/</g, '\\u003c');
$publishing('body').append('<script id="site-copy-defaults" type="application/json">' + serializedCopy + '</script>');
writeFileSync(publishing, $publishing.html());
await sharp('assets/images/touch/chrome-touch-icon-192x192.png')
  .resize(360, 360, { fit: 'contain', background: '#0b1330' })
  .extend({ top: 76, bottom: 76, left: 76, right: 76, background: '#0b1330' })
  .png().toFile(path.join(publicDir, 'admin', 'appointment-icon-512.png'));
writeFileSync(path.join(publicDir, 'scripts', 'firebase-config.mjs'),
  `export const firebaseConfig = Object.freeze(${JSON.stringify(stagingConfig, null, 2)});\nexport const appointmentsPreview = true;\n`);

const firebase = JSON.parse(readFileSync('firebase.json', 'utf8'));
firebase.hosting.public = publicDir;
firebase.hosting.redirects.unshift(...['/book', '/book.html'].map(source => ({ source, destination: '/schedule', type: 301 })));
delete firebase.hosting.predeploy;
for (const entry of firebase.hosting.headers) {
  if (['**/*.css', '**/*.js', '**/*.html'].includes(entry.source)) {
    entry.headers.find(header => header.key === 'Cache-Control').value = 'no-cache';
  }
}
firebase.hosting.headers.push({ source: '**/*.mjs', headers: [{ key: 'Cache-Control', value: 'no-cache' }] });
firebase.hosting.headers[0].headers.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
firebase.storage = { rules: 'storage.staging.rules' };
writeFileSync(deploymentConfig, `${JSON.stringify(firebase, null, 2)}\n`, { flag: 'wx' });
// Firebase CLI resolves declared parameters even when staging disables Telegram delivery.
const functionsEnv = [
  `HOSTING_ORIGIN=${origin}`,
  'ENABLE_TELEGRAM_NOTIFICATIONS=false',
  'TELEGRAM_BOT_TOKEN=disabled',
  'TELEGRAM_CHAT_ID=disabled',
  'ENABLE_APPOINTMENTS=true',
  `APPOINTMENT_INTEGRATIONS_PROJECT=${projectId}`,
].join('\n');
writeFileSync(`functions/.env.${projectId}`, `${functionsEnv}\n`, { flag: 'wx' });
console.log(`Prepared staging assets for ${origin}`);
