// Exercise the compiled booking alert with Telegram and delivery receipts mocked.
// This test never loads real credentials or sends a network request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const receipts = new Map();
const requests = [];
const handlers = {};
const sandbox = {
  exports: {},
  process: { env: {} },
  AbortSignal,
  require(name) {
    switch (name) {
      case 'firebase-functions/v2/https': return { onRequest: (_options, handler) => handler };
      case 'firebase-functions/v2/scheduler': return { onSchedule: (_options, handler) => handler };
      case 'firebase-functions/v2/firestore': {
        const register = (options, handler) => { handlers[options.document] = { options, handler }; return handler; };
        return { onDocumentUpdated: register, onDocumentWritten: register };
      }
      case 'firebase-functions': return { logger: { error() {} } };
      case 'firebase-functions/params': return { defineString: name => ({ value: () => ({ HOSTING_ORIGIN: 'https://example.test', TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' })[name] }) };
      case 'firebase-admin': return { initializeApp() {}, firestore: () => ({}) };
      case 'firebase-admin/firestore': return { FieldValue: { serverTimestamp: () => 'server-timestamp' } };
      case 'node:crypto': return crypto;
      case './appointment-calendar': return require(path.resolve('functions/lib/appointment-calendar.js'));
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  },
  fetch: async (url, init) => {
    assert.equal(url, 'https://api.telegram.org/bottest-token/sendMessage');
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  },
};
vm.runInNewContext(fs.readFileSync('functions/lib/index.js', 'utf8'), sandbox);
const { options, handler: notify } = handlers['appointments/{appointmentId}'];
const start = Date.parse('2026-11-22T16:00:00Z');
const booking = {
  status: 'awaiting_deposit', start, end: start + 3 * 3_600_000, service: 'Full Detail', name: 'Test Customer',
  phone: '+18285550123', address: '1 Main St, Asheville, NC', vehicle: 'SUV or truck', estimateCents: 35_000, depositCents: 5_000,
};
const event = (id, before, after) => ({
  id, params: { appointmentId: 'appt-1' },
  data: {
    before: { data: () => before },
    after: { data: () => after, ref: { collection: name => {
      assert.equal(name, 'telegramNotifications');
      return { doc: key => ({ get: async () => ({ exists: receipts.has(key) }), set: async data => receipts.set(key, data) }) };
    } } },
  },
});
(async () => {
  assert.equal(options.retry, true);
  await notify(event('paid', booking, { ...booking, status: 'pending_approval', paidDeposit: 5_000 }));
  assert.equal(requests.length, 1);
  for (const text of ['New booking (needs your approval)', 'When: Sun, Nov 22, 11:00 AM to 2:00 PM ET', 'Test Customer', '+18285550123',
    '1 Main St, Asheville, NC', 'Full Detail', '$50 paid', 'https://example.test/admin/appointments?appointment=appt-1']) {
    assert(requests[0].text.includes(text), text);
  }
  await notify(event('paid', booking, { ...booking, status: 'pending_approval', paidDeposit: 5_000 }));
  assert.equal(requests.length, 1, 'Retries of a delivered alert are skipped');
  await notify(event('preapproved', booking, { ...booking, status: 'confirmed', paidDeposit: 5_000 }));
  assert(requests[1].text.startsWith('New booking (confirmed)'));
  await notify(event('owner-approval', { ...booking, status: 'pending_approval' }, { ...booking, status: 'confirmed' }));
  await notify(event('owner-created', { ...booking, status: 'draft' }, { ...booking, status: 'confirmed' }));
  await notify(event('expired', booking, { ...booking, status: 'cancelled' }));
  assert.equal(requests.length, 2, 'Only a customer booking whose deposit cleared alerts');
  const created = (id, after) => ({ ...event(id, null, after), data: { ...event(id, null, after).data, before: { data: () => undefined } } });
  await notify(created('returning', { ...booking, status: 'pending_approval', depositCents: 0, bookingChannel: 'public' }));
  assert.equal(requests.length, 3);
  assert(requests[2].text.startsWith('New booking (needs your approval) · returning customer, no deposit'));
  await notify(created('owner-direct', { ...booking, status: 'confirmed', depositCents: 0 }));
  await notify(created('public-hold', { ...booking, bookingChannel: 'public' }));
  await notify({ ...event('deleted', booking, null), data: { ...event('deleted', booking, null).data, after: { data: () => undefined } } });
  assert.equal(requests.length, 3, 'Owner bookings, unpaid holds and deletions do not alert');
  sandbox.process.env.ENABLE_TELEGRAM_NOTIFICATIONS = 'false';
  await notify(event('staging', booking, { ...booking, status: 'confirmed' }));
  assert.equal(requests.length, 3, 'Staging must not send Telegram messages');
  console.log('PASS: booking alerts on paid deposits with time, customer and admin link; no alerts for approvals, owner bookings, expiries, retries or staging.');
})().catch(error => { console.error(error); process.exitCode = 1; });
