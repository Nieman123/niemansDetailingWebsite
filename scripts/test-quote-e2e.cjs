const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const admin = require('firebase-admin');
const assert = require('node:assert/strict');
(async () => {
  assert(process.env.FIRESTORE_EMULATOR_HOST, 'Use Firebase emulators:exec with a demo project.');
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-quote-cro' });
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.addInitScript(() => window.addEventListener('beforeunload', () => {
      if (window.__lastQuoteConversion) sessionStorage.setItem('testConversion', JSON.stringify(window.__lastQuoteConversion));
    }));
    await page.goto('http://127.0.0.1:5010/quote');
    await page.locator('[data-value="suv_truck"]').click();
    assert.equal(await page.locator('[data-service-price="full"]').innerText(), 'Starting at $350');
    await page.locator('[data-value="full"]').click();
    await page.locator('#name').fill('Emulator Browser Test');
    await page.locator('#phone').fill('8285550123');
    await page.locator('#quote-action-primary').click();
    await page.waitForURL('**/thank-you*');
    await page.locator('#addon-section').waitFor({ state: 'visible' });
    const receipt = await page.evaluate(() => JSON.parse(sessionStorage.getItem('quoteLeadReceipt')));
    const conversion = await page.evaluate(() => JSON.parse(sessionStorage.getItem('testConversion')));
    assert.equal(conversion.transaction_id, receipt.id);
    assert.equal(await page.evaluate(() => location.hash), '');
    const ref = admin.firestore().collection('leads').doc(receipt.id);
    assert.equal((await ref.get()).data().quoted_total, 350);
    await page.locator('[data-addon="wax"]').click();
    await page.locator('[data-addon="pethair"]').click();
    await page.locator('#save-addons').click();
    await page.waitForFunction(() => document.querySelector('#addon-status').textContent.startsWith('Saved'));
    const saved = (await ref.get()).data();
    assert.deepEqual(saved.addons, ['wax', 'pethair']);
    assert.equal(saved.quoted_total, 420);
    assert.equal(saved.phone_normalized, '+18285550123');
    await page.reload();
    await page.locator('#addon-section').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-addon="wax"]').getAttribute('aria-pressed'), 'true');
    assert((await page.locator('#saved-quote').innerText()).includes('$420'));
    assert.deepEqual(errors, []);
    console.log('PASS: real browser → Hosting rewrite → Function → Firestore → thank-you → add-on update → reload, with a deduplicated Ads transaction ID.');
  } finally {
    await browser.close();
    await admin.app().delete();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
