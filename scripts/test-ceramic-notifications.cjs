// Run the compiled API with in-memory Firestore and mocked Telegram.
// No real credentials, customer records, or network requests are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const records = new Map();
const messages = [];
const failures = [];
let failTelegram = false;
const ref = path => ({ path, id: path.split('/').at(-1) });
const db = {
  collection: name => ({ doc: id => ref(`${name}/${id}`) }),
  runTransaction: async callback => callback({
    get: async reference => ({ exists: records.has(reference.path), data: () => records.get(reference.path) }),
    create: (reference, data) => records.set(reference.path, data),
    set: (reference, data) => records.set(reference.path, { ...records.get(reference.path), ...data }),
    update: (reference, data) => records.set(reference.path, { ...records.get(reference.path), ...data }),
  }),
};
const sandbox = {
  exports: {}, process: { env: {} }, AbortSignal,
  require(name) {
    switch (name) {
      case 'firebase-functions/v2/https': return { onRequest: (_options, handler) => handler };
      case 'firebase-functions/v2/firestore': return { onDocumentUpdated: (_options, handler) => handler };
      case 'firebase-functions': return { logger: { error: (...args) => failures.push(args) } };
      case 'firebase-functions/params': return { defineString: name => ({ value: () => ({ HOSTING_ORIGIN: 'https://example.test', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[name] }) };
      case 'firebase-admin': return { initializeApp() {}, firestore: () => db };
      case 'firebase-admin/firestore': return { FieldValue: { serverTimestamp: () => 'server-time', arrayUnion: (...values) => values, increment: value => value } };
      case 'node:crypto': return crypto;
      default: throw new Error(`Unexpected module: ${name}`);
    }
  },
  fetch: async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
    assert.equal(init.method, 'POST');
    const message = JSON.parse(init.body);
    assert.equal(message.chat_id, 'test-chat');
    messages.push(message);
    if (failTelegram) throw new Error('Simulated Telegram failure');
    return { ok: true, json: async () => ({ ok: true }) };
  },
};
vm.runInNewContext(fs.readFileSync('functions/lib/index.js', 'utf8'), sandbox);
const post = async (body, route = 'createLead') => {
  let status, data;
  const response = { setHeader() {}, status(value) { status = value; return this; }, json(value) { data = value; } };
  await sandbox.exports.api({ method: 'POST', path: `/api/${route}`, headers: {}, body }, response);
  return { status, data };
};
const request = overrides => ({
  vehicle: 'sedan', service: 'ceramic', paint_condition: 'heavy_swirls', coating_package: 'two_step',
  name: 'Test Ceramic Customer', phone: '8285550123', vehicle_details: '<b>2024 Toyota RAV4</b>',
  notes: 'Weekend availability', update_token: crypto.randomBytes(32).toString('hex'),
  session_id: crypto.randomUUID(), flow_version: 'ceramic-1', ...overrides,
});
(async () => {
  for (const [vehicle, coating_package, expected, label] of [
    ['sedan', 'single_step', 1000, 'Sedan/Coupe'], ['sedan', 'two_step', 1400, 'Sedan/Coupe'],
    ['suv_truck', 'single_step', 1400, 'SUV/Crossover'], ['suv_truck', 'two_step', 1800, 'SUV/Crossover'],
    ['van_3row', 'two_step', null, 'Truck/Van/Other'], ['sedan', 'recommend', null, 'Sedan/Coupe'],
  ]) {
    const body = request({ vehicle, coating_package, quoted_total: 5, addons: ['wax'] });
    const result = await post(body);
    assert.equal(result.status, 200);
    const saved = records.get(`leads/${result.data.id}`);
    assert.equal(saved.quoted_total, expected);
    assert.equal(saved.vehicle_details, '2024 Toyota RAV4');
    assert.equal(saved.page, 'ceramic-quote');
    assert.equal(saved.flow_version, 'ceramic-1');
    assert.equal(saved.addons.length, 0);
    const text = messages.at(-1).text;
    for (const part of [label, 'Ceramic Coating', expected === null ? 'consult' : `$${expected}`, 'Source: /ceramic-quote', 'Package:', 'Paint: Visible swirls / dull paint', 'Vehicle details: 2024 Toyota RAV4', 'Test Ceramic Customer', '+18285550123', 'Notes: Weekend availability', `/admin/index.html?id=${result.data.id}`]) assert(text.includes(part), part);
    const count = messages.length;
    assert.equal((await post(body)).data.id, result.data.id);
    assert.equal(messages.length, count, 'Retries must not duplicate Telegram alerts');
    const options = await post({ id: result.data.id, token: result.data.update_token, action: 'read' }, 'leadOptions');
    assert.equal(options.status, 200);
    assert.equal(options.data.quoted_total, expected);
    assert.equal(Object.keys(options.data.addon_prices).length, 0);
    assert(!('phone' in options.data) && !('vehicle_details' in options.data));
  }
  for (const fields of [{ paint_condition: '__proto__' }, { coating_package: 'constructor' }, { paint_condition: null }, { coating_package: null }]) assert.equal((await post(request(fields))).status, 400);
  const recovery = await post(request({ name: '', capture_method: 'exit_intent' }));
  assert.equal(recovery.status, 200);
  assert(messages.at(-1).text.includes('Source: mobile exit-intent quote request'));
  const detail = await post(request({ service: 'full', vehicle: 'sedan', addons: [] }));
  assert.equal(records.get(`leads/${detail.data.id}`).quoted_total, 300);
  assert(messages.at(-1).text.includes('Sedan/Coupe • Full Detail • $300'));
  assert(!messages.at(-1).text.includes('Package:'));
  failTelegram = true;
  const failure = await post(request({}));
  assert.equal(failure.status, 200, 'Telegram downtime must not lose a saved customer request');
  assert(records.has(`leads/${failure.data.id}`));
  assert.equal(failures.length, 1);
  failTelegram = false;
  const count = messages.length;
  await post(request({ honeypot: true }));
  sandbox.process.env.FUNCTIONS_EMULATOR = 'true';
  await post(request({}));
  assert.equal(messages.length, count, 'Spam and emulator leads must not send alerts');
  console.log('PASS: ceramic pricing, custom quotes, paint/package/vehicle Telegram details, deduplicated retries, private receipts, recovery capture, detail regression, saved leads during Telegram failure, and spam/emulator suppression.');
})().catch(error => { console.error(error); process.exitCode = 1; });
