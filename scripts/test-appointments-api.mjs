import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
assert.equal((await asOwner('list')).result.length, 2);
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
assert.equal((await asOwner('finish-job', { id: job.id, finalCents: 31_000 })).error, 'scope_acceptance_required');
const finished = await asOwner('finish-job', {
  id: job.id, finalCents: 31_000, scopeAccepted: true, scopeChanges: 'Approved extra work', maintenanceInviteAfterPayment: true,
});
assert.equal(finished.result.balanceCents, 31_000);
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

await db.collection('adminUsers').doc(stranger.localId).set({ role: 'editor' });
assert.equal((await post('list', {}, stranger.idToken)).status, 403);
assert.equal((await post('cms-read', {}, stranger.idToken)).status, 200);
const draftContent = await post('cms-save', { content: { headline: 'Preview headline' } }, stranger.idToken);
assert.equal((await post('site-content', {})).result.headline, undefined);
await post('cms-publish', { content: { headline: 'Published headline' }, revision: draftContent.result.draft.revision }, stranger.idToken);
assert.equal((await post('site-content', {})).result.headline, 'Published headline');

console.log('PASS: appointment authorization, lead/client prefill, capture reconciliation, ledger idempotency, reservations, private links, cancellation, check clearance, one maintenance invitation, and content roles.');
await admin.app().delete();
