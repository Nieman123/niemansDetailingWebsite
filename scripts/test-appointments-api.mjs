import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import admin from 'firebase-admin';
import paymentLifecycle from '../functions/lib/appointments.js';

const projectId = process.env.GCLOUD_PROJECT;
assert(projectId?.startsWith('demo-') && process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST,
  'Run inside the Firebase Emulator Suite with a demo project.');
admin.initializeApp({ projectId });
const db = admin.firestore();
const origin = 'http://127.0.0.1:5010';

async function signUp() {
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: 'emulator-test-password', returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}

async function post(action, data, token, originHeader = origin) {
  const headers = { 'Content-Type': 'application/json', Origin: originHeader };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}/api/appointments/${action}`, {
    method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.timeout(45_000),
  });
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return { status: response.status, ...(await response.json()) };
}

const owner = await signUp();
const stranger = await signUp();
const asOwner = (action, data = {}) => post(action, data, owner.idToken);
await db.collection('adminUsers').doc(owner.localId).set({ label: 'Test owner' });
assert.equal((await post('list', {})).status, 401);
assert.equal((await post('owner-detail', { id: 'a'.repeat(64) })).status, 401);
assert.equal((await post('admin-availability', { month: '2026-11', durationMinutes: 60 })).status, 401);
assert.equal((await post('list', {}, stranger.idToken)).status, 403);
assert.equal((await post('list', {}, owner.idToken, 'https://unrelated.example')).status, 403);

const client = db.collection('clients').doc('trusted-client');
const lead = db.collection('leads').doc('test-lead');
await client.set({ full_name: 'Test Customer', phone_e164: '+18285550123', address: '1 Test Street', city: 'Asheville', state: 'NC' });
await lead.set({ client_id: client.id, service: 'full', vehicle: 'sedan', quoted_total: 300 });
const context = await asOwner('context', { leadId: lead.id });
assert.equal(context.result.clientId, client.id);
assert.equal(context.result.estimateCents, 30_000);
assert.equal(context.result.deposit, 'required');

const start = Math.ceil((Date.now() + 3 * 86_400_000) / 86_400_000) * 86_400_000 - 30 * 60_000;
const appointment = {
  requestId: randomUUID(), clientId: client.id, leadId: lead.id,
  name: 'Test Customer', phone: '(828) 555-0123', email: 'client@example.test',
  address: '1 Test Street, Asheville, NC', service: 'Full Detail', vehicle: 'Test sedan', preparation: 'Park in the driveway.',
  start, durationMinutes: 60, estimateCents: 30_000, deposit: 'waived', saveClientDefault: true,
};
assert.equal((await asOwner('create', { ...appointment, durationMinutes: -1 })).error, 'invalid_time');
const draft = await asOwner('create', { ...appointment, requestId: randomUUID(), deposit: 'required', saveClientDefault: false });
assert.equal(draft.result.status, 'draft');
assert.equal(draft.result.depositCents, 5000);
assert.equal((await asOwner('issue-link', { id: draft.result.id })).status, 503);

const competing = { ...appointment, requestId: randomUUID(), start: start + 45 * 60_000 };
const [a, b] = await Promise.all([asOwner('create', appointment), asOwner('create', competing)]);
assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a, b]));
const [accepted, rejected] = a.ok ? [a, b] : [b, a];
const details = accepted.result;
assert.equal(rejected.error, 'time_unavailable');
assert.equal(details.status, 'confirmed');
assert.equal(details.depositCents, 0);
assert.equal((await asOwner('context', { clientId: client.id })).result.deposit, 'waived');
assert.equal((await asOwner('list')).result.records.length, 2);
assert.equal((await asOwner('list', { search: 'test customer' })).result.records.length, 2);
assert.equal((await asOwner('list', { search: '555-0123' })).result.records.length, 2);
assert.equal((await asOwner('list', { search: 'nobody-matches-this' })).result.records.length, 0);
assert.deepEqual((await asOwner('list', { view: 'confirmed' })).result.records.map(record => record.status), ['confirmed']);
assert.equal((await post('health', {}, stranger.idToken)).status, 403);
const health = (await asOwner('health')).result;
assert(Array.isArray(health.checks) && health.checks.some(item => item.id === 'stripe'));
assert.equal(typeof health.summary.errors24h, 'number');
assert(health.events.some(event => event.code === 'stripe_unavailable'), 'a 503 is logged on the health page');
assert.equal((await asOwner('save-follow-up-settings', { reminders: true, reviewRequests: true, reviewUrl: '' })).error, 'invalid_follow_up_settings');
assert.equal((await asOwner('save-follow-up-settings', { reminders: true, reviewRequests: true, reviewUrl: 'http://g.page/r/x' })).error, 'invalid_follow_up_settings');
const followUps = (await asOwner('save-follow-up-settings', { reminders: true, reviewRequests: true, reviewUrl: 'https://g.page/r/example/review', revision: '' })).result;
assert.equal(followUps.reviewUrl, 'https://g.page/r/example/review');
assert.equal((await asOwner('follow-up-settings')).result.revision, followUps.revision);
console.log('PASS: Queue search and filters, health report, and follow-up email settings.');
assert.equal((await asOwner('create', a.ok ? appointment : competing)).result.id, details.id);

const id = details.id;
const issue = await asOwner('issue-link', { id });
const open = token => post('details', { id, token });
const shared = await open(issue.result.token);
assert.equal(shared.result.address, appointment.address);
assert.equal(shared.result.status, 'confirmed');
for (const field of ['name', 'phone', 'email', 'createdBy', 'leadId', 'clientId', 'linkHash']) assert(!(field in shared.result), field);
const saved = (await db.collection('appointments').doc(id).get()).data();
assert.notEqual(saved.linkHash, issue.result.token);
assert(!JSON.stringify(saved).includes(issue.result.token));

const storedUrl = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents/appointments/${id}`;
assert.equal((await fetch(storedUrl, { headers: { Authorization: `Bearer ${stranger.idToken}` } })).status, 403);

const replacement = await asOwner('issue-link', { id });
assert.equal((await open(issue.result.token)).status, 404);
assert.equal((await open(replacement.result.token)).status, 200);

// Short links: /a/<code> resolves to the current long link, a replaced link's short code stops working,
// and stored rows never hold the code or the token in the clear.
const resolve = (code, kind = 'appointment') => post('resolve-short-link', { code, kind });
assert.match(replacement.result.code, /^[A-Za-z0-9]{10}$/);
assert.deepEqual((await resolve(replacement.result.code)).result, { id, token: replacement.result.token });
assert.equal((await resolve(replacement.result.code, 'maintenance')).status, 404);
assert.equal((await resolve('AAAAAAAAAA')).status, 404);
assert.equal((await resolve('short')).status, 404);
const oldShort = (await resolve(issue.result.code)).result;
assert.equal((await open(oldShort.token)).status, 404, 'a replaced link keeps its short code dead');
const shortRows = JSON.stringify((await db.collection('appointmentShortLinks').where('appointmentId', '==', id).get()).docs.map(row => row.data()));
for (const secret of [issue.result.code, replacement.result.code, issue.result.token, replacement.result.token]) assert(!shortRows.includes(secret));
const customerCode = (await post('short-link', { id, token: replacement.result.token })).result.code;
assert.equal((await resolve(customerCode)).result.token, replacement.result.token);
assert.equal((await post('short-link', { id, token: issue.result.token })).status, 404);
const page = await fetch(`${origin}/a/${customerCode}`);
assert.equal(page.status, 200);
assert.match(await page.text(), /appointment-page\.mjs/);
assert.match(page.headers.get('referrer-policy') ?? '', /no-referrer/);
assert.match(page.headers.get('cache-control') ?? '', /no-store/);
console.log('PASS: Short appointment links resolve, expire with their long link, and stay sealed at rest.');
assert.equal((await asOwner('cancel', { id })).result.status, 'cancelled');
assert.equal((await open(replacement.result.token)).result.status, 'cancelled');
assert.equal((await asOwner('create', { ...appointment, requestId: randomUUID() })).result.status, 'confirmed');
await asOwner('revoke-link', { id });
assert.equal((await open(replacement.result.token)).status, 404);

const paidLater = start + 10 * 86_400_000;
const pending = (await asOwner('create', { ...appointment, requestId: randomUUID(), start: paidLater, deposit: 'required' })).result;
const pendingRef = db.collection('appointments').doc(pending.id);
await pendingRef.update({
  status: 'awaiting_deposit', preapproved: false, depositDeadline: Date.now() + 40 * 60_000,
  checkout: { attempt: 'attempt', kind: 'deposit', amount: 5000, expiresAt: Date.now() + 35 * 60_000 },
});
const paid = {
  id: 'cs_test_payment', livemode: false, status: 'complete', payment_status: 'paid',
  amount_total: 5000, currency: 'usd', payment_intent: 'pi_proof',
  metadata: { appointmentId: pending.id, attemptId: 'attempt', kind: 'deposit' },
};
await assert.rejects(paymentLifecycle.applyStripeSession(db, { ...paid, amount_total: 100 }), /stripe_amount_mismatch/);
await Promise.all([paymentLifecycle.applyStripeSession(db, paid), paymentLifecycle.applyStripeSession(db, paid)]);
assert.equal((await pendingRef.get()).get('status'), 'pending_approval');
assert.equal((await pendingRef.get()).get('paidDeposit'), 5000);
assert.equal((await pendingRef.collection('ledger').get()).size, 1);
assert.equal((await asOwner('cancel', { id: pending.id })).result.refundState, 'queued');

const job = (await asOwner('create', { ...appointment, requestId: randomUUID(), start: paidLater + 86_400_000 })).result;
assert.equal((await post('save-notes', { id: job.id, workNotes: 'Sneaky' })).status, 401);
assert.equal((await post('save-notes', { id: job.id, workNotes: 'Sneaky' }, stranger.idToken)).status, 403);
const noted = await asOwner('save-notes', { id: job.id, workNotes: '  Owner-only note: side gate sticks.  ' });
assert.equal(noted.result.workNotes, 'Owner-only note: side gate sticks.');
assert.equal((await asOwner('owner-detail', { id: job.id })).result.workNotes, 'Owner-only note: side gate sticks.');
assert((await asOwner('list', { search: 'side gate sticks' })).result.records.some(record => record.id === job.id));
const jobLink = await asOwner('issue-link', { id: job.id });
const customerView = await post('details', { id: job.id, token: jobLink.result.token });
assert.equal(customerView.status, 200);
assert(!('workNotes' in customerView.result));
assert(!JSON.stringify(customerView).includes('side gate'), 'private notes must not reach the customer');
assert.equal((await asOwner('save-notes', { id, workNotes: 'Cancelled, call back in spring.' })).result.workNotes, 'Cancelled, call back in spring.');
console.log('PASS: Private owner notes save on any appointment and stay out of customer views.');
assert.equal((await asOwner('finish-job', { id: job.id, finalCents: 31_000 })).error, 'scope_acceptance_required');
const finished = await asOwner('finish-job', {
  id: job.id, finalCents: 31_000, scopeAccepted: true, scopeChanges: 'Approved extra work', maintenanceInviteAfterPayment: true,
});
assert.equal(finished.result.balanceCents, 31_000);
assert.equal(finished.result.clientId, client.id);
const historyEntry = (await client.get()).get('bookings').find(entry => entry.appointment_id === job.id);
assert.equal(historyEntry?.amount, 310);
assert.equal(historyEntry.source, 'appointment');
assert.equal((await client.get()).get('last_service_date'), historyEntry.date);
assert.equal((await client.get()).get('status'), 'active');
assert.equal(finished.result.workNotes, 'Owner-only note: side gate sticks.');
const invitations = () => db.collection('appointmentEmails').where('maintenance.appointmentId', '==', job.id).get();
assert.equal((await invitations()).size, 0);
const manual = { id: job.id, amountCents: 10_000, method: 'cash', requestId: randomUUID() };
assert.equal((await asOwner('record-payment', manual)).result.balanceCents, 21_000);
assert.equal((await asOwner('record-payment', manual)).result.balanceCents, 21_000);
assert.equal((await asOwner('reverse-payment', { id: job.id, paymentId: manual.requestId, requestId: randomUUID() })).result.balanceCents, 31_000);
assert.equal((await asOwner('payment-export')).result.csv.includes('cash'), true);
const check = { id: job.id, amountCents: 31_000, method: 'check', requestId: randomUUID() };
assert.equal((await asOwner('record-payment', check)).result.paymentPending, true);
assert.equal((await invitations()).size, 0);
const cleared = { id: job.id, paymentId: check.requestId, requestId: randomUUID() };
assert.equal((await asOwner('clear-check', cleared)).result.balanceCents, 0);
assert.equal((await asOwner('clear-check', cleared)).result.balanceCents, 0);
assert.equal((await invitations()).size, 1);
const invitationText = (await invitations()).docs[0].get('text');
const inviteCode = /\/m\/([A-Za-z0-9]{10})/.exec(invitationText)?.[1];
assert(inviteCode, 'maintenance invitations use a short link');
assert.equal((await post('maintenance-offer', (await post('resolve-short-link', { code: inviteCode, kind: 'maintenance' })).result)).status, 200);

// Sales tax ships off. Once on, booking captures the rate for estimates, completion freezes the tax on the
// subtotal, payments cover the service price before the tax, and the export reports the tax collected.
assert.equal((await asOwner('tax-settings')).result.enabled, false);
assert.equal((await post('sales-tax', {})).result.enabled, false);
assert.equal((await asOwner('save-tax-settings', { enabled: true, rateBasisPoints: 0 })).error, 'invalid_tax_settings');
const taxSaved = (await asOwner('save-tax-settings', { enabled: true, rateBasisPoints: 700, taxId: '600-1234567', revision: '' })).result;
assert.equal(taxSaved.rateBasisPoints, 700);
assert.equal((await post('sales-tax', {})).result.rateBasisPoints, 700);
const taxed = (await asOwner('create', { ...appointment, requestId: randomUUID(), start: paidLater + 2 * 86_400_000 })).result;
assert.equal(taxed.taxRateBasisPoints, 700);
assert.equal(taxed.estimateTaxCents, 2100);
assert.equal((await asOwner('finish-job', { id: taxed.id, finalCents: 30_000 })).error, 'tax_settings_changed');
const taxedDone = (await asOwner('finish-job', { id: taxed.id, finalCents: 30_000, taxRateBasisPoints: 700 })).result;
assert.equal(taxedDone.taxCents, 2100);
assert.equal(taxedDone.totalCents, 32_100);
assert.equal(taxedDone.balanceCents, 32_100);
assert.equal(taxedDone.taxId, '600-1234567');
assert.equal((await client.get()).get('bookings').find(entry => entry.appointment_id === taxed.id)?.amount, 321);
// A customer with no client record gets one when the job is finished, and a repeat sync adds nothing.
const walkIn = (await asOwner('create', { ...appointment, requestId: randomUUID(), clientId: null, leadId: null, saveClientDefault: false,
  name: 'Walk In Customer', email: 'walk.in@example.test', phone: '828-555-0177', address: '9 Elm Road, Weaverville, NC 28787',
  start: paidLater + 3 * 86_400_000 })).result;
assert.equal(walkIn.clientId, null);
const walkInDone = (await asOwner('finish-job', { id: walkIn.id, finalCents: 20_000, taxRateBasisPoints: 700 })).result;
const walkInClients = await db.collection('clients').where('email', '==', 'walk.in@example.test').get();
assert.equal(walkInClients.size, 1);
const walkInClient = walkInClients.docs[0];
assert.equal(walkInDone.clientId, walkInClient.id);
assert.equal(walkInClient.get('phone_e164'), '+18285550177');
assert.equal(walkInClient.get('city'), 'Weaverville');
assert.equal(walkInClient.get('zip'), '28787');
assert.equal(walkInClient.get('bookings').length, 1);
assert.equal(walkInClient.get('bookings')[0].amount, 214);
// The Dashboard report counts finished jobs this month, with their pre-tax revenue and sales tax.
assert.equal((await post('business-report', {}, stranger.idToken)).status, 403);
const businessReport = (await asOwner('business-report')).result;
assert.equal(businessReport.months.length, 24);
const thisMonth = businessReport.months.at(-1);
assert.equal(thisMonth.month, businessReport.currentMonth);
assert(thisMonth.jobs >= 2 && thisMonth.revenueCents >= 50_000 && thisMonth.taxCents >= 3_500, JSON.stringify(thisMonth));
assert(thisMonth.services.some(service => service.name === 'Full Detail'));
assert.equal(businessReport.salesTax.frequencyChosen, false);
assert.equal((await asOwner('save-tax-filing', { frequency: 'weekly' })).error, 'invalid_frequency');
const monthlyFiling = (await asOwner('save-tax-filing', { frequency: 'monthly' })).result.salesTax;
assert.equal(monthlyFiling.frequency, 'monthly');
assert(monthlyFiling.periods[0].taxCents >= 3_500 && monthlyFiling.periods[0].taxableCents >= 50_000, JSON.stringify(monthlyFiling.periods[0]));
const lastPeriod = monthlyFiling.periods[1].key;
assert.equal((await asOwner('save-tax-filing', { period: '2026-13' })).error, 'invalid_period');
assert((await asOwner('save-tax-filing', { period: lastPeriod })).result.salesTax.periods[1].filedAt > 0);
assert.equal((await asOwner('save-tax-filing', { period: lastPeriod, filed: false })).result.salesTax.periods[1].filedAt, null);
// Client history lists linked and same-email appointments, links them, and backfills older finished jobs once.
const older = db.collection('appointments').doc('f'.repeat(64));
await older.set({ ...(await db.collection('appointments').doc(walkIn.id).get()).data(), clientId: null, clientBookingSyncedAt: null,
  start: paidLater - 40 * 86_400_000, end: paidLater - 40 * 86_400_000 + 3_600_000, finalCents: 15_000, taxCents: 0, service: 'Interior Only' });
const walkInUpcoming = (await asOwner('create', { ...appointment, requestId: randomUUID(), clientId: null, leadId: null, saveClientDefault: false,
  name: 'Walk In Customer', email: 'walk.in@example.test', phone: '828-555-0177', start: paidLater + 30 * 86_400_000 })).result;
assert.equal((await post('client-history', { clientId: walkInClient.id })).status, 401);
const walkInHistory = (await asOwner('client-history', { clientId: walkInClient.id })).result;
assert.deepEqual(walkInHistory.appointments.map(item => item.id).sort(), [walkIn.id, older.id, walkInUpcoming.id].sort());
assert.equal(walkInHistory.client.bookings.length, 2);
assert.equal(walkInHistory.client.last_service_date, walkInClient.get('last_service_date'));
assert.equal((await db.collection('appointments').doc(walkInUpcoming.id).get()).get('clientId'), walkInClient.id);
assert.equal((await asOwner('client-history', { clientId: walkInClient.id })).result.client.bookings.length, 2);
assert.equal((await asOwner('client-history', { clientId: 'missing-client' })).error, 'record_not_found');
console.log('PASS: Finished jobs save to the client record, new customers get one, and client history links and backfills appointments.');
const servicePart = { id: taxed.id, amountCents: 30_000, method: 'cash', requestId: randomUUID() };
assert.equal((await asOwner('record-payment', servicePart)).result.balanceCents, 2100);
const taxPart = { id: taxed.id, amountCents: 2100, method: 'venmo', requestId: randomUUID() };
const taxPaid = (await asOwner('record-payment', taxPart)).result;
assert.equal(taxPaid.balanceCents, 0);
assert.equal(taxPaid.payments.find(entry => entry.id === servicePart.requestId).taxCents, undefined);
assert.equal(taxPaid.payments.find(entry => entry.id === taxPart.requestId).taxCents, 2100);
const taxExport = (await asOwner('payment-export')).result.csv;
assert.match(taxExport, /amount_cents,tax_cents/);
assert.match(taxExport, /venmo.*,2100,2100/);
const taxOff = await asOwner('save-tax-settings', { enabled: false, rateBasisPoints: 700, taxId: '600-1234567', revision: taxSaved.revision });
assert.equal(taxOff.result.enabled, false);

// Follow-up emails from the maintenance job: one day-before reminder, one review request per customer.
const reminderStart = Math.ceil((Date.now() + 20 * 3_600_000) / 60_000) * 60_000 + 17 * 60_000;
const upcoming = (await asOwner('create', { ...appointment, requestId: randomUUID(), start: reminderStart, saveClientDefault: false })).result;
assert.equal(upcoming.status, 'confirmed');
await db.collection('appointments').doc(upcoming.id).update({ createdAt: Date.now() - 3 * 86_400_000 });
await db.collection('appointments').doc(taxPaid.id).update({ completedAt: Date.now() - 3 * 3_600_000 });
const followUpsNow = (await asOwner('follow-up-settings')).result;
await asOwner('save-follow-up-settings', { ...followUpsNow, reviewRequests: true, reviewUrl: 'https://g.page/r/example/review' });
await paymentLifecycle.reconcileAppointments(db);
const reminder = await db.collection('appointmentEmails').doc(`reminder-${upcoming.id}-${reminderStart}`).get();
assert(reminder.exists, 'a confirmed job about 20 hours out gets a reminder');
assert.match(reminder.get('subject'), /^Reminder: your detail is (today|tomorrow) at /);
assert.equal(reminder.get('to'), 'client@example.test');
const review = await db.collection('appointmentEmails').doc(`review-${taxPaid.id}`).get();
assert(review.exists, 'a finished, paid job gets a review request');
assert.match(review.get('html'), /g\.page\/r\/example\/review/);
await db.collection('appointmentEmails').doc(`reminder-${upcoming.id}-${reminderStart}`).delete();
await paymentLifecycle.reconcileAppointments(db);
assert(!(await db.collection('appointmentEmails').doc(`reminder-${upcoming.id}-${reminderStart}`).get()).exists, 'reminders go out once');
console.log('PASS: Day-before reminders and review requests go out once.');

// Unpaid balance reminders and a tip on a balance paid online.
{
  process.env.HOSTING_ORIGIN ??= 'https://' + projectId + '.web.app';
  process.env.APPOINTMENT_INTEGRATIONS_PROJECT ??= projectId;
  const owing = (await asOwner('create', { ...appointment, requestId: randomUUID(), start: start + 30 * 86_400_000, saveClientDefault: false })).result;
  assert.equal((await asOwner('finish-job', { id: owing.id, finalCents: 20_000, scopeAccepted: true })).result.balanceCents, 20_000);
  const owingRef = db.collection('appointments').doc(owing.id);
  // 3 PM Eastern on a fixed day, so the daytime window always applies.
  const afternoon = Date.parse('2026-12-02T20:00:00Z');
  await owingRef.update({ completedAt: afternoon - 2 * 86_400_000 });
  await paymentLifecycle.sendBalanceReminders(db, afternoon - 2 * 86_400_000 + 3_600_000);
  assert.equal((await owingRef.get()).get('balanceRemindersSent') ?? 0, 0, 'no reminder before a day has passed');
  await paymentLifecycle.sendBalanceReminders(db, afternoon);
  const balanceEmail = await db.collection('appointmentEmails').doc(`balance-${owing.id}-1`).get();
  assert(balanceEmail.exists, 'a finished job with a balance gets a reminder');
  assert.match(balanceEmail.get('subject'), /^Balance due for your /);
  assert.match(balanceEmail.get('text'), /\$200\.00/);
  const payCode = /\/a\/([A-Za-z0-9]{10})/.exec(balanceEmail.get('text'))?.[1];
  assert(payCode, 'the reminder carries a short pay link');
  const payLink = (await post('resolve-short-link', { code: payCode, kind: 'appointment' })).result;
  assert.equal((await post('details', payLink)).result.balanceCents, 20_000, 'the pay link opens the appointment');
  await paymentLifecycle.sendBalanceReminders(db, afternoon + 3_600_000);
  assert.equal((await owingRef.get()).get('balanceRemindersSent'), 1, 'one reminder per step');
  await paymentLifecycle.sendBalanceReminders(db, afternoon - 14 * 3_600_000 + 4 * 86_400_000);
  assert.equal((await owingRef.get()).get('balanceRemindersSent'), 1, 'no reminders at night');

  await owingRef.update({ checkout: { attempt: 'tip-attempt', kind: 'balance', amount: 20_000, tipCents: 3_000, expiresAt: Date.now() + 35 * 60_000 } });
  const tipped = { id: 'cs_test_tipped', livemode: false, status: 'complete', payment_status: 'paid', amount_total: 23_000, currency: 'usd',
    payment_intent: 'pi_tipped', metadata: { appointmentId: owing.id, attemptId: 'tip-attempt', kind: 'balance' } };
  await assert.rejects(paymentLifecycle.applyStripeSession(db, { ...tipped, amount_total: 20_000 }), /stripe_amount_mismatch/);
  await paymentLifecycle.applyStripeSession(db, tipped);
  const afterTip = (await asOwner('owner-detail', { id: owing.id })).result;
  assert.equal(afterTip.balanceCents, 0, 'the tip does not count toward the balance');
  assert.equal(afterTip.payments.find(entry => entry.id === 'cs_test_tipped').tipCents, 3_000);
  assert.match((await db.collection('appointmentEmails').doc('receipt-cs_test_tipped').get()).get('text'), /Tip/);
  assert.match((await asOwner('payment-export')).result.csv, /tip_cents[\s\S]*,20000,0,3000/);
  console.log('PASS: Unpaid balance reminders with a pay link, and tips on balance payments.');
}

await db.collection('adminUsers').doc(stranger.localId).set({ role: 'editor' });
assert.equal((await post('list', {}, stranger.idToken)).status, 403);
assert.equal((await post('cms-read', {}, stranger.idToken)).status, 200);
const draftContent = await post('cms-save', { content: { headline: 'Preview headline' } }, stranger.idToken);
assert.equal((await post('site-content', {})).result.headline, undefined);
await post('cms-publish', { content: { headline: 'Published headline' }, revision: draftContent.result.draft.revision }, stranger.idToken);
assert.equal((await post('site-content', {})).result.headline, 'Published headline');

console.log('PASS: appointment authorization, lead/client prefill, capture reconciliation, ledger idempotency, reservations, private links, cancellation, check clearance, one maintenance invitation, and content roles.');


// Exercise the public booking entry point with real emulator transactions and test calendars.
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.APPOINTMENT_STRIPE_CONFIG = JSON.stringify({secretKey:'sk_test_fixture',webhookSecret:'whsec_fixture'});
process.env.APPOINTMENT_GOOGLE_CONFIG = JSON.stringify({
  clientId:'demo',clientSecret:'demo',refreshToken:'demo',detailingId:'detail',personalId:'personal',plutoId:'pluto'
});
process.env.HOSTING_ORIGIN = 'https://' + projectId + '.web.app';
process.env.APPOINTMENT_INTEGRATIONS_PROJECT = projectId;
const publicSettings = {enabled:true,services:[{id:'full',name:'Full Detail',duration:60,cents:30000}],days:[0,1,2,3,4,5,6],
  open:'09:00',close:'17:00',minimumHours:1,horizonDays:45,bufferMinutes:30,blockedDates:[],postalCodes:['28803'],revision:'test'};
await db.collection('appointmentSettings').doc('booking').set(publicSettings);
const originalFetch = globalThis.fetch;
let calendarReads = 0;
let personalBusy = [];
let detailEvents = [];
globalThis.fetch = (url, init) => {
  if (String(url).includes('/calendars/detail/events?')) return Promise.resolve(Response.json({items:detailEvents}));
  if (String(url) === 'https://oauth2.googleapis.com/token') return Promise.resolve(Response.json({access_token:'demo',expires_in:3600}));
  if (String(url).endsWith('/freeBusy')) {
    calendarReads++;
    return Promise.resolve(Response.json({calendars:{detail:{busy:[]},personal:{busy:personalBusy},pluto:{busy:[]}}}));
  }
  return originalFetch(url,init);
};
async function callWithCalendar(action, body, token) {
  let response;
  await paymentLifecycle.handleAppointments(db,admin.auth(),{method:'POST',body,is:()=>true,get:name=>token && name === "Authorization" ? "Bearer " + token : undefined,rawBody:Buffer.from(JSON.stringify(body))},
    {status(){return this;},json(value){response=value;}},action);
  return response;
}
try {
  const month = new Date(Date.now() + 10 * 86400000).toISOString().slice(0,7);
  const available = await callWithCalendar('availability',{serviceId:'full',month});
  assert(available.result.slots.length);
  assert.equal(calendarReads,1);
  const phoneBooking = {name:'Phone customer',phone:'828-555-0199',email:'phone.customer@example.test',customerNotes:' Gate code 1234. Park by the garage. ',start:available.result.slots[0],serviceId:'full',vehicleType:'suv_truck',accepted:true,token:'b'.repeat(64)};
  assert.equal((await callWithCalendar('book',{...phoneBooking,vehicleType:''})).error,'vehicle_required');
  assert.equal((await callWithCalendar('book',{...phoneBooking,phone:''})).error,'invalid_details');
  assert.equal((await callWithCalendar('book',{...phoneBooking,email:''})).error,'email_required');
  assert.equal((await callWithCalendar('book',{...phoneBooking,postalCode:'99999'})).error,'outside_service_area');
  const booked = await callWithCalendar('book',phoneBooking);
  assert.equal(booked.result.status,'awaiting_deposit');
  assert.equal(booked.result.estimateCents,35000);
  const stored = (await db.collection('appointments').doc(booked.result.id).get()).data();
  assert.deepEqual([stored.email,stored.address,stored.phone],['phone.customer@example.test','','+18285550199']);
  assert.equal(stored.customerNotes,'Gate code 1234. Park by the garage.');
  const requestEmail = (await db.collection('appointmentEmails').doc(`request-${booked.result.id}`).get()).get('text');
  const bookedCode = /\/a\/([A-Za-z0-9]{10})/.exec(requestEmail)?.[1];
  assert(bookedCode && !requestEmail.includes(phoneBooking.token), 'booking emails carry the short link');
  assert.equal((await post('resolve-short-link',{code:bookedCode})).result.id,booked.result.id);
  assert.equal((await callWithCalendar('book',phoneBooking)).result.id,booked.result.id);
  assert.equal((await callWithCalendar('book',{...phoneBooking,token:'c'.repeat(64)})).error,'existing_booking_hold');
  const expected = Object.fromEntries(['name','phone','email','vehicle','address'].map(key=>[key,stored[key]]));
  const patch = {id:booked.result.id,...expected,address:'Test service address',vehicle:'Sedan',expected};
  assert.equal((await asOwner('update-contact',patch)).result.address,patch.address);
  assert.equal((await asOwner('update-contact',patch)).error,'status_changed');
  const detail = await asOwner('owner-detail', { id: booked.result.id });
  assert.equal(detail.result.address, patch.address);
  assert.equal(detail.result.customerNotes, 'Gate code 1234. Park by the garage.');
  assert.equal((await post('owner-detail', { id: booked.result.id }, stranger.idToken)).status, 403);
  await db.collection('appointmentSettings').doc('booking').update({ enabled: false });
  assert.deepEqual((await callWithCalendar('availability',{serviceId:'full',month})).result.slots, []);
  const ownerTimes = await callWithCalendar('admin-availability', { month, durationMinutes: 90, deposit: 'waived' }, owner.idToken);
  assert(ownerTimes.result.slots.length);
  assert(!ownerTimes.result.slots.includes(phoneBooking.start));
  const checkTime = data => callWithCalendar('admin-check-time', { durationMinutes: 60, deposit: 'waived', ...data }, owner.idToken);
  const clash = (await checkTime({ start: phoneBooking.start })).result;
  assert.equal(clash.open, false);
  assert(clash.issues.includes('overlap'));
  assert.deepEqual([clash.conflicts[0].name, clash.conflicts[0].kind, clash.conflicts[0].start], ['Phone customer', 'appointment', phoneBooking.start]);
  const free = (await checkTime({ start: ownerTimes.result.slots.at(-1), durationMinutes: 90 })).result;
  assert.deepEqual([free.open, free.issues, free.conflicts], [true, [], []]);
  const near = (await checkTime({ start: phoneBooking.start + 90 * 60_000 })).result;
  assert.deepEqual(near.issues, ['buffer'], JSON.stringify(near));
  const late = new Date(ownerTimes.result.slots.at(-1)); late.setUTCHours(late.getUTCHours() + 6);
  assert((await checkTime({ start: late.getTime() })).result.issues.includes('outside_hours'));
  const lastSlot = ownerTimes.result.slots.at(-1);
  personalBusy = [{ start: new Date(lastSlot).toISOString(), end: new Date(lastSlot + 30 * 60_000).toISOString() }];
  const personal = (await checkTime({ start: lastSlot })).result;
  personalBusy = [];
  assert.deepEqual([personal.issues, personal.conflicts[0].kind], [['overlap'], 'calendar']);
  const overlapping = { name: 'Squeezed in', phone: '828-555-0177', start: phoneBooking.start, durationMinutes: 60, deposit: 'waived' };
  assert.equal((await callWithCalendar('create', { ...overlapping, requestId: randomUUID() }, owner.idToken)).error, 'time_unavailable');
  const forced = await callWithCalendar('create', { ...overlapping, allowOverlap: true, requestId: randomUUID() }, owner.idToken);
  assert.equal(forced.result.status, 'confirmed');
  assert.equal((await db.collection('appointments').doc(forced.result.id).get()).get('overlapApproved'), true);
  assert.equal((await asOwner('cancel', { id: forced.result.id })).result.status, 'cancelled');
  console.log('PASS: Owner time check explains conflicts, and the owner can book over one on purpose.');
  console.log('PASS: Owner-only appointment details and calendar with public booking paused.');
  await db.collection('appointmentSettings').doc('booking').update({ enabled: true });

  // Rescheduling uses the booking calendar for the appointment's own length, without the appointment blocking itself.
  const moveId = booked.result.id, moveToken = phoneBooking.token, iso = value => new Date(value).toISOString();
  await db.collection('appointments').doc(moveId).update({ status: 'confirmed', paidDeposit: 5000 });
  detailEvents = [{ id: 'a' + moveId, start: { dateTime: iso(phoneBooking.start) }, end: { dateTime: iso(phoneBooking.start + 60 * 60_000) } }];
  const moveSlots = (await callWithCalendar('reschedule-availability', { id: moveId, token: moveToken, month })).result;
  assert.equal(moveSlots.horizonDays, 45);
  assert(!moveSlots.slots.includes(phoneBooking.start), 'the current time is not offered');
  assert(moveSlots.slots.includes(phoneBooking.start + 30 * 60_000), 'the appointment and its calendar event do not block it');
  const otherAt = moveSlots.slots.at(-2);
  detailEvents.push({ id: 'aother', start: { dateTime: iso(otherAt) }, end: { dateTime: iso(otherAt + 30 * 60_000) } });
  const withOther = (await callWithCalendar('reschedule-availability', { id: moveId, token: moveToken, month })).result.slots;
  assert(!withOther.includes(otherAt), 'other detailing calendar events still block');
  assert(withOther.includes(phoneBooking.start + 30 * 60_000));
  // An all-day event blocks only its own Eastern date, not the whole month.
  const easternDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(value);
  const allDay = easternDay(otherAt);
  const nextDay = new Date(Date.parse(allDay + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  detailEvents = [{ id: 'aallday', start: { date: allDay }, end: { date: nextDay } }];
  const withAllDay = (await callWithCalendar('reschedule-availability', { id: moveId, token: moveToken, month })).result.slots;
  assert(!withAllDay.some(start => easternDay(start) === allDay), 'the all-day event blocks its day');
  assert.deepEqual(withAllDay, moveSlots.slots.filter(start => easternDay(start) !== allDay), 'and only its day');
  detailEvents = [];
  assert.equal((await callWithCalendar('reschedule-availability', { id: moveId, token: 'f'.repeat(64), month })).error, 'link_unavailable');
  assert.equal((await callWithCalendar('request-reschedule', { id: moveId, token: moveToken, start: phoneBooking.start + 12 * 3_600_000 })).error, 'time_unavailable');
  const wanted = moveSlots.slots.at(-1);
  assert.equal((await callWithCalendar('request-reschedule', { id: moveId, token: moveToken, start: wanted })).result.hasRescheduleRequest, true);
  const ownerMoveResult = (await callWithCalendar('admin-availability', { month, durationMinutes: 60, except: moveId }, owner.idToken)).result;
  assert.equal(ownerMoveResult.horizonDays, 45, 'the owner reschedule calendar can page ahead');
  const ownerMove = ownerMoveResult.slots;
  assert(ownerMove.includes(phoneBooking.start + 30 * 60_000), 'the owner calendar ignores the appointment being moved');
  assert(!(await checkTime({ start: phoneBooking.start + 30 * 60_000, except: moveId })).result.issues.includes('overlap'));
  personalBusy = [{ start: iso(wanted), end: iso(wanted + 60 * 60_000) }];
  assert((await checkTime({ start: wanted, except: moveId })).result.issues.includes('overlap'));
  assert.equal((await callWithCalendar('reschedule', { id: moveId, start: wanted }, owner.idToken)).error, 'time_unavailable');
  const movedAnyway = await callWithCalendar('reschedule', { id: moveId, start: wanted, allowOverlap: true }, owner.idToken);
  personalBusy = [];
  assert.equal(movedAnyway.result.start, wanted, JSON.stringify(movedAnyway));
  assert.equal(movedAnyway.result.rescheduleRequest, null);
  assert.equal((await db.collection('appointments').doc(moveId).get()).get('overlapApproved'), true);
  console.log('PASS: Customer and owner reschedule calendars, customer request rules, and moving over a conflict on purpose.');
  const quoteReceipt = { id:'a'.repeat(64),token:'d'.repeat(64) };
  const quoteRef = db.collection('leads').doc(quoteReceipt.id);
  await quoteRef.set({
    addon_token_hash:createHash('sha256').update(quoteReceipt.token).digest('hex'),
    addon_token_expires_at:Date.now() + 60_000,
    name:'Saved Quote Customer',phone_normalized:'+18285550221',service:'full',vehicle:'van_3row',quoted_total:475,
  });
  const preview = await callWithCalendar('quote-context',{quoteReceipt});
  assert.deepEqual(preview.result,{service:'full',vehicle:'van_3row',estimateCents:47500,phoneEnding:'0221'});
  const quoteDraft = { ...phoneBooking, name:'',phone:'',email:'quote.customer@example.test',token:'f'.repeat(64),reuseQuoteContact:true,quoteReceipt,vehicleType:'van_3row' };
  const fresh = await callWithCalendar('availability',{serviceId:'full',month});
  quoteDraft.start = fresh.result.slots[0];
  const fromQuote = await callWithCalendar('book',quoteDraft);
  assert.equal(fromQuote.result.estimateCents,47500);
  const storedQuote = (await db.collection('appointments').doc(fromQuote.result.id).get()).data();
  assert.equal(storedQuote.name,'Saved Quote Customer');
  assert.equal(storedQuote.phone,'+18285550221');
  await quoteRef.update({addon_token_expires_at:Date.now()-1});
  assert.equal((await callWithCalendar('quote-context',{quoteReceipt})).result,null);
  assert.equal((await callWithCalendar('book',{...quoteDraft,token:'e'.repeat(64)})).error,'quote_contact_expired');
  assert.equal((await asOwner('create',{...appointment, requestId:randomUUID(), deposit:'required', service:'', saveClientDefault:false})).result.service,
    'Detailing appointment');
  console.log('PASS: Vehicle pricing, masked quote preview, contact reuse, expired receipt fallback and optional admin service.');

  // Several services and vehicles on one booking.
  const multiSettings = { ...publicSettings, enabled: true, revision: 'multi', services: [
    { id: 'full', name: 'Full Detail', duration: 60, cents: 30000, vehiclePrices: { sedan: 30000, suv_truck: 35000, van_3row: 40000 } },
    { id: 'monthly_mini', name: 'Monthly Mini', duration: 30, cents: 10000, vehiclePrices: { sedan: 10000, suv_truck: 14000, van_3row: 14000 } },
  ] };
  await db.collection('appointmentSettings').doc('booking').set(multiSettings);
  const longer = await callWithCalendar('availability', { serviceId: 'full', serviceIds: ['full', 'monthly_mini', 'monthly_mini'], month });
  assert(longer.result.slots.length);
  assert.equal((await callWithCalendar('availability', { serviceId: 'full', serviceIds: ['nope'], month })).error, 'invalid_items');
  const multiBooking = { name: 'Two Car Customer', phone: '828-555-0177', email: 'two.cars@example.test', start: longer.result.slots[0],
    serviceId: 'full', vehicleType: 'suv_truck', vehicle: 'Ford Explorer', accepted: true, token: '9'.repeat(64),
    items: [
      { serviceId: 'full', vehicleIndex: 0, vehicleType: 'suv_truck', vehicle: 'Ford Explorer' },
      { serviceId: 'monthly_mini', vehicleIndex: 1, vehicleType: 'sedan', vehicle: 'Honda Civic' },
    ] };
  assert.equal((await callWithCalendar('book', { ...multiBooking, items: [multiBooking.items[0], { serviceId: 'monthly_mini', vehicleIndex: 1 }] })).error, 'vehicle_required');
  assert.equal((await callWithCalendar('book', { ...multiBooking, items: [multiBooking.items[0], { ...multiBooking.items[1], vehicleIndex: 2 }] })).error, 'invalid_items');
  assert.equal((await callWithCalendar('book', { ...multiBooking, items: [multiBooking.items[1], multiBooking.items[0]] })).error, 'invalid_items');
  const multi = await callWithCalendar('book', multiBooking);
  assert(multi.ok, JSON.stringify(multi));
  assert.equal(multi.result.estimateCents, 45000, JSON.stringify(multi));
  assert.equal(multi.result.end - multi.result.start, 90 * 60_000);
  assert.equal(multi.result.service, 'Full Detail (Ford Explorer); Monthly Mini (Honda Civic)');
  assert.equal(multi.result.vehicle, 'Ford Explorer + Honda Civic');
  assert.equal(multi.result.items.length, 2);

  // The owner books a main service plus an add-on, then adds a second vehicle to the existing booking.
  const ownerStart = longer.result.slots[longer.result.slots.length - 1] - 3 * 60 * 60_000;
  const ownerMulti = await asOwner('create', { ...appointment, clientId: null, leadId: null, requestId: randomUUID(), start: ownerStart, durationMinutes: 90,
    estimateCents: 40_000, saveClientDefault: false, allowOverlap: true, items: [
      { serviceId: 'full', name: 'Full Detail', vehicleIndex: 0, vehicleType: 'sedan', vehicle: 'Chad sedan', cents: 30_000, minutes: 60 },
      { serviceId: 'monthly_mini', name: 'Monthly Mini', vehicleIndex: 0, cents: 10_000, minutes: 30 },
    ] });
  assert.equal(ownerMulti.result.service, 'Full Detail + Monthly Mini', JSON.stringify(ownerMulti));
  assert.equal(ownerMulti.result.items[1].vehicle, 'Chad sedan');
  assert.equal((await asOwner('create', { ...appointment, requestId: randomUUID(), items: [{ name: 'X', vehicleIndex: 1, minutes: 30 }] })).error, 'invalid_items');
  const added = await asOwner('update-services', { id: ownerMulti.result.id, allowOverlap: true, items: [
    ...ownerMulti.result.items, { name: 'Monthly Mini', serviceId: 'monthly_mini', vehicleIndex: 1, vehicleType: 'suv_truck', vehicle: 'Second truck', cents: 14_000, minutes: 30 },
  ] });
  assert.equal(added.result.estimateCents, 54_000, JSON.stringify(added));
  assert.equal(added.result.end - added.result.start, 120 * 60_000);
  assert.equal(added.result.service, 'Full Detail + Monthly Mini (Chad sedan); Monthly Mini (Second truck)');
  const reserved = (await db.collection('appointmentDays').doc(String(Math.floor(ownerStart / 86_400_000))).get()).get('slots')
    .find(slot => slot.id === ownerMulti.result.id);
  assert.equal(reserved.end - reserved.start, 120 * 60_000);
  assert.equal((await asOwner('update-services', { id: ownerMulti.result.id, items: [] })).error, 'invalid_items');
  const taxNow = (await asOwner('tax-settings')).result;
  await asOwner('start-job', { id: ownerMulti.result.id });
  const multiDone = await asOwner('finish-job', { id: ownerMulti.result.id, finalCents: 54_000, taxRateBasisPoints: taxNow.enabled ? taxNow.rateBasisPoints : 0 });
  assert.deepEqual(multiDone.result.invoiceLines.map(line => line.cents), [30_000, 10_000, 14_000], JSON.stringify(multiDone));
  assert.equal(multiDone.result.invoiceLines[2].description, 'Monthly Mini (Second truck)');
  assert.equal((await asOwner('update-services', { id: ownerMulti.result.id, items: added.result.items })).error, 'status_changed');
  console.log('PASS: Add-ons and extra vehicles on public and owner bookings, adding to an existing booking, and itemized closeout.');
  console.log('PASS: Month availability, email-required booking with notes, retry, hold protection and owner contact updates.');
} finally { globalThis.fetch = originalFetch; }
await admin.app().delete();
