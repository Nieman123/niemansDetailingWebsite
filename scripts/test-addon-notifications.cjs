// Exercise the compiled Firestore handler with Telegram and delivery receipts mocked.
// This test never loads real credentials or sends a network request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const receipts = new Map();
const requests = [];
let nextResponse = { ok: true, status: 200, json: async () => ({ ok: true }) };
let triggerOptions;
const sandbox = {
  exports: {},
  process: { env: {} },
  AbortSignal,
  require(name) {
    switch (name) {
      case 'firebase-functions/v2/https': return { onRequest: (_options, handler) => handler };
      case 'firebase-functions/v2/firestore': return { onDocumentUpdated: (options, handler) => { triggerOptions = options; return handler; } };
      case 'firebase-functions': return { logger: { error() {} } };
      case 'firebase-functions/params': return { defineString: name => ({ value: () => ({ HOSTING_ORIGIN: 'https://example.test', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[name] }) };
      case 'firebase-admin': return { initializeApp() {}, firestore: () => ({}) };
      case 'firebase-admin/firestore': return { FieldValue: { serverTimestamp: () => 'server-timestamp' } };
      case 'node:crypto': return crypto;
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  },
  fetch: async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
    requests.push(JSON.parse(init.body));
    return nextResponse;
  },
};
vm.runInNewContext(fs.readFileSync('functions/lib/index.js', 'utf8'), sandbox);
const notify = sandbox.exports.notifyLeadAddonUpdate;
const lead = { vehicle: 'sedan', service: 'full', name: 'Test Customer', phone_normalized: '+18285550123', addons: [], quoted_total: 300 };
const event = (id, before, after) => ({
  id, params: { leadId: 'test-lead' },
  data: {
    before: { data: () => before },
    after: { data: () => after, ref: { collection: name => {
      assert.equal(name, 'addonNotifications');
      return { doc: key => ({ get: async () => ({ exists: receipts.has(key) }), set: async data => receipts.set(key, data) }) };
    } } },
  },
});
(async () => {
  assert.equal(triggerOptions.document, 'leads/{leadId}');
  assert.equal(triggerOptions.retry, true);
  const updated = { ...lead, addons: ['wax', 'pethair'], quoted_total: 355 };
  await notify(event('added', lead, updated));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].chat_id, 'test-chat');
  for (const text of ['Quote updated:', 'Test Customer', '+18285550123', 'Added: Pet Hair, Wax/Sealant', 'Previous total: $300', 'Updated total: $355', 'https://example.test/admin/index.html?id=test-lead']) {
    assert(requests[0].text.includes(text), text);
  }
  assert(!requests[0].text.includes('Removed:'));
  assert.equal(receipts.size, 1);
  await notify(event('added', lead, updated));
  await notify(event('reordered', updated, { ...updated, addons: ['pethair', 'wax'] }));
  await notify(event('notes-only', updated, { ...updated, notes: 'New note' }));
  await notify(event('spam', lead, { ...updated, status: 'spam' }));
  await notify({ id: 'empty' });
  assert.equal(requests.length, 1, 'No duplicate or unrelated alerts');
  await notify(event('removed', updated, lead));
  assert.equal(requests.length, 2);
  assert(requests[1].text.includes('Removed: Pet Hair, Wax/Sealant'));
  assert(requests[1].text.includes('Current add-ons: None'));
  nextResponse = { ok: false, status: 503 };
  await assert.rejects(notify(event('retry', lead, updated)), /503/);
  assert.equal(receipts.size, 2, 'Failed delivery must not be marked sent');
  nextResponse = { ok: true, status: 200, json: async () => ({ ok: true }) };
  await notify(event('retry', lead, updated));
  assert.equal(receipts.size, 3);
  assert.equal(requests.length, 4);
  await notify(event('retry', lead, updated));
  assert.equal(requests.length, 4, 'Delivered retries must be skipped');
  nextResponse = { ok: true, status: 200, json: async () => ({ ok: false }) };
  await assert.rejects(notify(event('rejected', lead, updated)), /did not accept/);
  assert.equal(receipts.size, 3);
  sandbox.process.env.FUNCTIONS_EMULATOR = 'true';
  const beforeEmulator = requests.length;
  await notify(event('local', lead, updated));
  assert.equal(requests.length, beforeEmulator, 'Emulators must not send Telegram messages');
  console.log('PASS: added/removed extras, customer and price details, CMS link, unchanged saves, duplicate delivery, failed-send retries, rejected messages, spam and emulator suppression.');
})().catch(error => { console.error(error); process.exitCode = 1; });
