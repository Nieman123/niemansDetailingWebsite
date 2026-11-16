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
      if (file === path.join(publicDir, 'schedule.html')) {
        $('#scheduler').replaceWith('<p><a href="/book">Check available appointments and reserve a time</a> · <a href="/account">Manage an appointment</a></p>');
        $('link[href*="calendar.google.com"]').remove();
        if ($.html().includes('calendar.google.com/calendar/appointments')) {
          throw new Error('The production Google scheduler is still present in staging.');
        }
      }
      if (file === path.join(publicDir, 'thank-you.html')) {
        $('a[href="/schedule"]').attr('href', '/book');
      }
      const contentKeys = {
        'index.html': 'headline introduction serviceAreas testimonials contactNote serviceDescriptions',
        'faq.html': 'faq',
        'schedule.html': 'bookingNotice',
        'book.html': 'bookingNotice',
      }[path.relative(publicDir, file)];
      if (contentKeys) {
        const section = $('<section class="panel" hidden></section>').attr('data-site-content', contentKeys);
        section.css({ whiteSpace: 'pre-wrap', maxWidth: '58rem', margin: '1rem auto', padding: '1rem' });
        if ($('main').length) $('main').first().append(section);
        else $('body').append(section);
        $('body').append('<script type="module" src="/scripts/published-site-content.mjs"></script>');
      }
      writeFileSync(file, $.html());
    }
  }
}

cpSync('public', publicDir, { recursive: true, force: false, errorOnExist: true });
preparePages(publicDir);
await sharp('assets/images/touch/chrome-touch-icon-192x192.png')
  .resize(360, 360, { fit: 'contain', background: '#0b1330' })
  .extend({ top: 76, bottom: 76, left: 76, right: 76, background: '#0b1330' })
  .png().toFile(path.join(publicDir, 'admin', 'appointment-icon-512.png'));
writeFileSync(path.join(publicDir, 'scripts', 'firebase-config.mjs'),
  `export const firebaseConfig = Object.freeze(${JSON.stringify(stagingConfig, null, 2)});\nexport const appointmentsPreview = true;\n`);

const firebase = JSON.parse(readFileSync('firebase.json', 'utf8'));
firebase.hosting.public = publicDir;
delete firebase.hosting.predeploy;
firebase.hosting.headers[0].headers.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
firebase.storage = { rules: 'storage.staging.rules' };
writeFileSync(deploymentConfig, `${JSON.stringify(firebase, null, 2)}\n`, { flag: 'wx' });
writeFileSync(`functions/.env.${projectId}`, `HOSTING_ORIGIN=${origin}\nENABLE_TELEGRAM_NOTIFICATIONS=false\nENABLE_APPOINTMENTS=true\nAPPOINTMENT_INTEGRATIONS_PROJECT=${projectId}\n`, { flag: 'wx' });
console.log(`Prepared staging assets for ${origin}`);
