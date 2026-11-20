import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import sharp from 'sharp';
import { firebaseConfig as production } from '../public/scripts/firebase-config.mjs';

// Builds the appointments bundle: the first-party booking page, /book redirects, site-copy publishing
// hooks and appointmentsPreview. `node scripts/prepare-staging.mjs` targets staging (its own Firebase
// config, noindex, no-cache). `--production` targets the live project once appointments are launched.
const isProduction = process.argv.includes('--production');
const projectId = isProduction ? production.projectId : process.env.STAGING_FIREBASE_PROJECT_ID;
const publicDir = isProduction ? 'public-production' : 'public-staging';
const deploymentConfig = isProduction ? 'firebase.production.generated.json' : 'firebase.staging.generated.json';

if (!isProduction && (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId ?? '') || projectId === production.projectId)) {
  throw new Error('STAGING_FIREBASE_PROJECT_ID must be a valid, separate Firebase project ID.');
}

let webConfig;
if (isProduction) webConfig = production;
else try {
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

const origin = isProduction ? null : `https://${projectId}.web.app`;
const authDomains = new Set([`${projectId}.firebaseapp.com`, `${projectId}.web.app`]);
const storageBuckets = new Set([`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`]);
if (!isProduction && (webConfig?.projectId !== projectId || !authDomains.has(webConfig.authDomain) ||
    !storageBuckets.has(webConfig.storageBucket) || typeof webConfig.apiKey !== 'string' ||
    !webConfig.apiKey.trim() || webConfig.apiKey === production.apiKey ||
    !/^1:\d+:web:[a-f0-9]+$/i.test(webConfig.appId ?? ''))) {
  throw new Error('Supply the SDK config from the staging web app, including its default Storage bucket.');
}

const { apiKey, authDomain, storageBucket, appId } = webConfig;
const siteConfig = isProduction ? { ...production } : { apiKey, authDomain, projectId, storageBucket, appId };

const siteCopy = {};
const copySelectors = {
  'index.html': {
    headline: '.hero-copy h1', introduction: '.hero-copy .sub-title',
    serviceAreas: '.srv-area-txt h3:first-of-type', contactNote: '.srv-area-txt .area__note',
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
      // Staging keeps visitors on staging; production links may stay absolute.
      if (!isProduction) $('a[href], form[action]').each((_, element) => {
        const node = $(element);
        const attribute = node.is('form') ? 'action' : 'href';
        const href = node.attr(attribute);
        const relative = href.replace(/^https?:\/\/(?:www\.)?niemansdetailing\.com(?=\/|[?#]|$)/i, '');
        if (relative !== href) node.attr(attribute, relative.startsWith('/') ? relative : `/${relative}`);
      });
      if (!isProduction) $('meta[name="firebase-api-key"]').remove();
      const name = path.relative(publicDir, file);
      if (name === 'thank-you.html') $('body').attr('data-booking-handoff', 'true');
      if (!isProduction && name === path.join('admin', 'appointments.html')) {
        $('#workspace').prepend('<p class="appointment-notice">Staging preview. Use test customer details and Stripe test cards.</p>');
      }
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
  `export const firebaseConfig = Object.freeze(${JSON.stringify(siteConfig, null, 2)});\nexport const appointmentsPreview = true;\n`);

const firebase = JSON.parse(readFileSync('firebase.json', 'utf8'));
firebase.hosting.public = publicDir;
firebase.hosting.redirects.unshift(...['/book', '/book.html'].map(source => ({ source, destination: '/schedule', type: 301 })));
delete firebase.hosting.predeploy;
if (!isProduction) {
  for (const entry of firebase.hosting.headers) {
    if (['**/*.css', '**/*.js', '**/*.html'].includes(entry.source)) {
      entry.headers.find(header => header.key === 'Cache-Control').value = 'no-cache';
    }
  }
  firebase.hosting.headers.push({ source: '**/*.mjs', headers: [{ key: 'Cache-Control', value: 'no-cache' }] });
  firebase.hosting.headers[0].headers.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
}
firebase.storage = { rules: 'storage.rules' };
writeFileSync(deploymentConfig, `${JSON.stringify(firebase, null, 2)}\n`, { flag: 'wx' });
if (isProduction) {
  // The production workflow writes functions/.env itself, with the real Telegram and mode settings.
  console.log(`Prepared production appointment assets in ${publicDir}`);
  process.exit(0);
}
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
