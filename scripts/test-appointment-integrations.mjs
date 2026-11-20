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
assert.deepEqual(booking.bookingPrices(service), { sedan:30000, suv_truck:35000, van_3row:40000 });
const custom = { ...service, vehiclePrices: { sedan:31000, suv_truck:36500, van_3row:42500 } };
assert.deepEqual(booking.bookingPrices(booking.parseBookingSettings({ ...settings, services:[custom] }).services[0]),custom.vehiclePrices);
assert.equal(booking.parseBookingSettings({ ...settings, services:[{ ...custom, vehiclePrices:{sedan:31000} }] }),null);
assert.equal(booking.parseBookingSettings({ ...settings, services: [service, service] }), null);
assert.equal(booking.parseBookingSettings({ ...settings, services: [{ ...service, cents: 4999 }] }), null);
assert.equal(booking.bookingSlots(settings, '2027-01-18', service, now)[0], Date.parse('2027-01-18T14:00:00Z'));
assert.equal(booking.bookingSlots({ ...settings, blockedDates: ['2027-01-18'] }, '2027-01-18', service, now).length, 0);
assert.equal(booking.bookingSlots(settings, '2027-01-19', service, now).length, 0);
// Per-day hours override the default open time and validate their own ranges.
const weekend = { ...settings, days: [1, 6], hours: { '6': { open: '11:00', close: '17:00' } } };
assert(booking.parseBookingSettings(weekend).hours['6']);
assert.equal(booking.bookingSlots(weekend, '2027-01-23', service, now)[0], Date.parse('2027-01-23T16:00:00Z'));
assert.equal(booking.bookingSlots(weekend, '2027-01-18', service, now)[0], Date.parse('2027-01-18T14:00:00Z'));
assert.equal(booking.parseBookingSettings({ ...settings, hours: { '6': { open: '12:00', close: '11:00' } } }), null);
assert.equal(booking.parseBookingSettings({ ...settings, hours: { '7': { open: '09:00', close: '11:00' } } }), null);
assert.equal(booking.parseBookingSettings({ ...settings, services: [{ ...service, featured: true, description: 'Inside and out' }] }).services[0].featured, true);

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
  assert(![...calls[0].body.keys()].some(key => key.split('[')[0] === 'payment_method_types'));
  assert.equal(calls[0].body.get('success_url'), 'https://example-test.web.app/appointment?checkout=complete');

  const changePayloads = {
    '/v1/charges/ch_test_charge': { livemode: false, currency: 'usd', payment_intent: 'pi_test_payment', amount_refunded: 1500 },
    '/v1/disputes/dp_test_dispute': { livemode: false, currency: 'usd', payment_intent: 'pi_test_payment', amount: 5000, status: 'needs_response' },
    '/v1/payment_intents/pi_test_payment': { livemode: false, metadata: { appointmentId: 'appointment-id' } },
  };
  const requests = [];
  globalThis.fetch = async url => {
    const { pathname } = new URL(url);
    requests.push(pathname);
    assert(Object.hasOwn(changePayloads, pathname), pathname);
    return { ok: true, json: async () => changePayloads[pathname] };
  };
  const config = { secretKey: 'sk_test_sample', webhookSecret: secret };
  const refund = { type: 'charge.refunded', data: { object: { id: 'ch_test_charge', metadata: { appointmentId: 'forged-id' } } } };
  assert.deepEqual(await stripe.stripeMoneyChange(config, refund), {
    appointmentId: 'appointment-id', intent: 'pi_test_payment', kind: 'refund', amount: 1500,
    stripeStatus: 'refunded', stripeObjectId: 'ch_test_charge',
  });
  const dispute = { type: 'charge.dispute.created', data: { object: { id: 'dp_test_dispute' } } };
  assert.deepEqual(await stripe.stripeMoneyChange(config, dispute), {
    appointmentId: 'appointment-id', intent: 'pi_test_payment', kind: 'dispute', amount: 5000,
    stripeStatus: 'needs_response', stripeObjectId: 'dp_test_dispute',
  });
  changePayloads['/v1/payment_intents/pi_test_payment'].livemode = true;
  assert.equal(await stripe.stripeMoneyChange(config, dispute), null);
  const before = requests.length;
  assert.equal(await stripe.stripeMoneyChange(config, { ...refund, data: { object: { id: '../unexpected' } } }), null);
  assert.equal(requests.length, before);

  const matchingSession = { id: 'cs_test_match', livemode: false, metadata: { appointmentId: options.id, attemptId: options.attempt } };
  const otherSession = { ...matchingSession, id: 'cs_test_other', metadata: { ...matchingSession.metadata, attemptId: 'other-attempt' } };
  const lookup = () => stripe.findCheckoutAttempt(config, options.id, options.attempt, now, options.expiresAt);
  globalThis.fetch = async (url, { method }) => {
    const { pathname, searchParams } = new URL(url);
    assert.equal(method, 'GET');
    assert.equal(pathname, '/v1/checkout/sessions');
    assert.equal(searchParams.get('created[gte]'), String(now / 1000));
    assert.equal(searchParams.get('created[lte]'), String(options.expiresAt / 1000));
    const nextPage = searchParams.get('starting_after') === otherSession.id;
    return { ok: true, json: async () => ({ data: nextPage ? [matchingSession] : [otherSession], has_more: !nextPage }) };
  };
  assert.deepEqual(await lookup(), matchingSession);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [otherSession], has_more: false }) });
  assert.equal(await lookup(), null);
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(lookup, /stripe_request_503/);
} finally { globalThis.fetch = previous; }
console.log('PASS: Stripe signature and replay checks, stable Checkout requests, provider-verified refund and dispute references, and public booking policy validation.');
