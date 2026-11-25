// Applies storage.cors.json to the project's default Storage bucket.
// The admin job screen downloads private job photos with getBlob(), which only works in a browser when
// the bucket allows cross-origin GETs. Uploads go through Firebase's own endpoint and work without it,
// so a missing CORS setting shows up as photos that save but never show a thumbnail.
// Usage: node scripts/apply-storage-cors.mjs <projectId>  (needs GOOGLE_APPLICATION_CREDENTIALS)
// Never fails the deploy: it prints a warning with the one-time manual command instead.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const projectId = process.argv[2];
if (!projectId) throw new Error('Pass the Firebase project ID.');
const root = fileURLToPath(new URL('..', import.meta.url));
const cors = JSON.parse(readFileSync(new URL('../storage.cors.json', import.meta.url), 'utf8'));
const warn = message => console.log(`::warning::${message}`);

try {
  // firebase-admin is installed for Functions, which the workflow builds before this step.
  const require = createRequire(`${root}functions/package.json`);
  const { initializeApp } = require('firebase-admin/app');
  const { getStorage } = require('firebase-admin/storage');
  const storage = getStorage(initializeApp({ projectId }));
  let applied = false;
  for (const name of [`${projectId}.firebasestorage.app`, `${projectId}.appspot.com`]) {
    const bucket = storage.bucket(name);
    const [exists] = await bucket.exists().catch(() => [false]);
    if (!exists) continue;
    const [metadata] = await bucket.getMetadata();
    if (JSON.stringify(metadata.cors ?? []) === JSON.stringify(cors)) {
      console.log(`Storage CORS already set on ${name}.`);
    } else {
      await bucket.setCorsConfiguration(cors);
      console.log(`Applied storage.cors.json to ${name}.`);
    }
    applied = true;
    break;
  }
  if (!applied) warn(`No default Storage bucket found for ${projectId}, so storage.cors.json was not applied.`);
} catch (error) {
  warn(`Couldn't apply storage.cors.json (${error.message}). Job photo thumbnails need it. ` +
    `Give the deploy service account Storage Admin on the bucket, or run once: ` +
    `gcloud storage buckets update gs://${projectId}.firebasestorage.app --cors-file=storage.cors.json`);
}
