// Invoice API checks against the Firebase emulators. Run inside `firebase emulators:exec`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import admin from 'firebase-admin';

const projectId = process.env.GCLOUD_PROJECT;
assert(projectId?.startsWith('demo-') && process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST,
  'Run inside the Firebase Emulator Suite with a demo project.');
if (!admin.apps.length) admin.initializeApp({ projectId });
const db = admin.firestore();
const origin = 'http://127.0.0.1:5010';
// Hosting rewrites /api/** to the api function. INVOICE_API_BASE can point straight at the function instead.
const apiBase = process.env.INVOICE_API_BASE ?? origin;

async function signUp() {
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: 'emulator-test-password', returnSecureToken: true }),
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function post(action, data, token) {
  const headers = { 'Content-Type': 'application/json', Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase}/api/invoices/${action}`, { method: 'POST', headers, body: JSON.stringify(data), signal: AbortSignal.timeout(45_000) });
  return { status: response.status, ...(await response.json()) };
}

const owner = await signUp();
const editor = await signUp();
await db.collection('adminUsers').doc(owner.localId).set({ label: 'Invoice owner' });
await db.collection('adminUsers').doc(editor.localId).set({ label: 'Editor', role: 'editor' });
const as = (action, data = {}) => post(action, data, owner.idToken);
assert.equal((await post('list', {})).status, 401);
assert.equal((await post('list', {}, editor.idToken)).status, 403);

const settings = await as('settings');
assert.equal(settings.result.settings.businessName, "Nieman's Detailing");
const saved = await as('save-settings', { ...settings.result.settings, mailingAddress: 'PO Box 1234\nAsheville, NC 28802', revision: settings.result.settings.revision });
assert.equal(saved.result.settings.mailingAddress, 'PO Box 1234\nAsheville, NC 28802');
assert.equal((await as('save-settings', { ...saved.result.settings, revision: 'stale' })).error, 'settings_updated');

// Prefill from a client with a business name.
await db.collection('clients').doc('acme').set({ full_name: 'Pat Smith', company: 'Acme Property Co', email: 'ap@acme.test', address: '9 Main St', city: 'Asheville', state: 'NC', zip: '28801' });
const fromClient = (await as('context', { clientId: 'acme' })).result.draft;
assert.equal(fromClient.billTo.name, 'Acme Property Co');
assert.equal(fromClient.billTo.attention, 'Pat Smith');
assert.equal(fromClient.billTo.address, '9 Main St\nAsheville, NC 28801');
assert.equal(fromClient.source.kind, 'client');
assert.equal(fromClient.taxRateBasisPoints, 0, 'sales tax is off by default');

// Prefill from a finished appointment with a deposit.
await db.collection('appointments').doc('b'.repeat(64)).set({ name: 'Jo Fleet', email: 'jo@fleet.test', phone: '+18285550100', address: '1 Depot Rd, Asheville, NC 28806',
  service: 'Full Detail', vehicle: 'van_3row', start: Date.parse('2026-11-18T15:00:00Z'), estimateCents: 40000, finalCents: 45000, taxCents: 3150, taxRateBasisPoints: 700,
  invoiceLines: [{ description: 'Full Detail', cents: 40000 }, { description: 'Pet hair', cents: 5000 }], paidDeposit: 5000, payments: [], clientId: null, status: 'completed' });
const fromAppointment = (await as('context', { appointmentId: 'b'.repeat(64) })).result.draft;
assert.deepEqual(fromAppointment.lines.map(line => line.unitCents), [40000, 5000]);
assert.equal(fromAppointment.taxRateBasisPoints, 700);
assert.deepEqual(fromAppointment.credits, [{ description: 'Deposit paid', cents: 5000 }]);
assert.equal(fromAppointment.serviceDate, '2026-11-18');
assert.equal(fromAppointment.billTo.address, '1 Depot Rd\nAsheville, NC 28806');

// Create, numbering, idempotency.
const draft = { ...fromClient, reference: 'PO-7', issueDate: '2026-11-21', terms: 'net_30',
  lines: [{ description: 'Fleet detail', quantity: 3, unitCents: 40000 }], taxRateBasisPoints: 700, credits: [] };
const requestId = randomUUID();
const created = await as('create', { requestId, source: fromClient.source, draft });
assert.equal(created.status, 200, JSON.stringify(created));
assert.equal(created.result.number, '2026-0001');
assert.equal(created.result.dueDate, '2026-12-21');
assert.equal(created.result.totals.totalCents, 128400);
assert.equal((await as('create', { requestId, source: fromClient.source, draft })).result.number, '2026-0001', 'retry returns the same invoice');
const second = await as('create', { requestId: randomUUID(), source: { kind: 'appointment', appointmentId: 'b'.repeat(64) }, draft: { ...fromAppointment, issueDate: '2026-11-21' } });
assert.equal(second.result.number, '2026-0002');
assert.equal(second.result.totals.balanceCents, 43150);
assert.equal((await as('create', { requestId: randomUUID(), draft: { ...draft, lines: [] } })).error, 'lines_required');

// Edit guards against stale writes.
const id = created.result.id;
assert.equal((await as('update', { id, updatedAt: 1, draft })).error, 'invoice_changed');
const edited = await as('update', { id, updatedAt: created.result.updatedAt, draft: { ...draft, reference: 'PO-8' } });
assert.equal(edited.result.reference, 'PO-8');

// Payments by check, partial then full, then a receipt.
assert.equal((await as('pdf', { id, kind: 'receipt' })).error, 'no_payments');
assert.equal((await as('record-payment', { id, requestId: randomUUID(), method: 'check', reference: '', date: '2026-12-01', cents: 100 })).error, 'check_number_required');
assert.equal((await as('record-payment', { id, requestId: randomUUID(), method: 'check', reference: '1001', date: '2026-12-01', cents: 999999 })).error, 'invalid_payment');
const partial = await as('record-payment', { id, requestId: randomUUID(), method: 'check', reference: '1001', date: '2026-12-01', cents: 28400 });
assert.equal(partial.result.status, 'open');
assert.equal(partial.result.totals.balanceCents, 100000);
const paymentId = randomUUID();
const paid = await as('record-payment', { id, requestId: paymentId, method: 'check', reference: '1002', date: '2026-12-05', cents: 100000 });
assert.equal(paid.result.status, 'paid');
assert.ok(paid.result.paidAt);
assert.equal((await as('record-payment', { id, requestId: paymentId, method: 'check', reference: '1002', date: '2026-12-05', cents: 100000 })).result.payments.length, 2, 'retry is a no-op');
for (const kind of ['invoice', 'receipt']) {
  const pdf = await as('pdf', { id, kind });
  assert.equal(pdf.status, 200);
  assert.match(pdf.result.filename, new RegExp(`${kind === 'receipt' ? 'Receipt' : 'Invoice'}-2026-0001-Acme-Property-Co\\.pdf$`));
  assert.equal(Buffer.from(pdf.result.pdf, 'base64').subarray(0, 5).toString(), '%PDF-');
}
assert.equal((await as('void', { id })).error, 'remove_payments_first');
const removed = await as('remove-payment', { id, paymentId });
assert.equal(removed.result.status, 'open');
assert.equal(removed.result.paidAt, null);

// Email needs configuration; the emulator has none.
assert.equal((await as('email', { id, kind: 'invoice', to: 'ap@acme.test' })).error, 'email_not_configured');

// Void and reopen, list filters.
const second_id = second.result.id;
assert.equal((await as('void', { id: second_id })).result.status, 'void');
assert.equal((await as('reopen', { id: second_id })).result.status, 'open');
const list = await as('list');
assert.equal(list.result.invoices.length, 2);
assert.equal(list.result.invoices.find(row => row.id === id).balanceCents, 100000);
assert.equal((await as('get', { id: 'missing' })).error, 'invoice_not_found');
console.log('Invoice API checks passed.');
