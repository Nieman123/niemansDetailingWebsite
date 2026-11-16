import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import stripe from '../functions/lib/appointment-stripe.js';
import booking from '../functions/lib/appointment-booking.js';

const now = Date.parse('2027-01-17T13:00:00Z');
const timestamp = Math.trunc(now / 1000);
const secret = 'whsec_test_signature';
const raw = Buffer.from(JSON.stringify({
  id: 'evt_test', livemode: false, type: 'checkout.session.completed', data: { object: { id: 'cs_test_checkout' } },
}));
const sign = buffer => createHmac('sha256', secret).update(String(timestamp)).update('.').update(buffer).digest('hex');
const header = `t=${timestamp},v1=${sign(raw)}`;
assert.equal(stripe.verifyStripeEvent(raw, header, secret, now).id, 'evt_test');
assert.equal(stripe.verifyStripeEvent(Buffer.concat([raw, Buffer.from(' ')]), header, secret, now), null);
assert.equal(stripe.verifyStripeEvent(raw, header, secret, now + 300_001), null);
const live = Buffer.from(raw.toString().replace('false', 'true'));
assert.equal(stripe.verifyStripeEvent(live, `t=${timestamp},v1=${sign(live)}`, secret, now), null);

const service = { id: 'full', name: 'Full Detail', duration: 180, cents: 30_000 };
const settings = { ...booking.emptyBookingSettings, enabled: true, days: [1], postalCodes: ['28803'], services: [service] };
assert(booking.parseBookingSettings(settings));
assert.equal(booking.parseBookingSettings({ ...settings, services: [service, service] }), null);
assert.equal(booking.parseBookingSettings({ ...settings, services: [{ ...service, cents: 4999 }] }), null);
assert.equal(booking.bookingSlots(settings, '2027-01-18', service, now)[0], Date.parse('2027-01-18T14:00:00Z'));
assert.equal(booking.bookingSlots({ ...settings, blockedDates: ['2027-01-18'] }, '2027-01-18', service, now).length, 0);
assert.equal(booking.bookingSlots(settings, '2027-01-19', service, now).length, 0);

const previous = globalThis.fetch;
const calls = [];
try {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, ...init });
    return { ok: true, json: async () => ({ id: 'cs_test_checkout', livemode: false }) };
  };
  const options = {
    id: 'appointment-id', attempt: 'attempt-id', origin: 'https://example-test.web.app',
    kind: 'deposit', amount: 5000, expiresAt: now + 35 * 60_000, disclosure: 'Staging deposit terms',
  };
  await stripe.createStripeSession({ secretKey: 'sk_test_sample', webhookSecret: secret }, options);
  await stripe.createStripeSession({ secretKey: 'sk_test_sample', webhookSecret: secret }, options);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(String(calls[0].body), String(calls[1].body));
  assert.equal(calls[0].body.get('line_items[0][price_data][unit_amount]'), '5000');
  assert.equal(calls[0].body.get('payment_method_types[0]'), 'card');
  assert.equal(calls[0].body.get('success_url'), 'https://example-test.web.app/appointment?checkout=complete');
} finally { globalThis.fetch = previous; }
console.log('PASS: Stripe authentication, mode and replay window, stable Checkout requests, and public booking policy validation.');
