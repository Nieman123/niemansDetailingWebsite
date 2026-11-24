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
// ---- Online payments: pay links, the customer pay page, Stripe sessions and reminders ----
assert.equal((await as('settings')).result.settings.autoReminders, true, 'reminders default on');
assert.equal((await as('pay-link', { id })).error, 'online_payments_unavailable', 'no Stripe in the emulator');
// The rest drives the server code directly, with Stripe and email configured through the emulator env.
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.HOSTING_ORIGIN = `https://${projectId}.web.app`;
process.env.APPOINTMENT_INTEGRATIONS_PROJECT = projectId;
process.env.APPOINTMENT_STRIPE_CONFIG = JSON.stringify({ secretKey: 'sk_test_fixture', webhookSecret: 'whsec_fixture' });
process.env.APPOINTMENT_EMAIL_CONFIG = JSON.stringify({ apiKey: 're_fixture', from: 'Billing <billing@example.test>', testRecipients: ['late@example.test', 'ap@acme.test'] });
const payments = (await import('../functions/lib/invoice-payments.js')).default;
const sentMail = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) === 'https://api.resend.com/emails') { sentMail.push(JSON.parse(init.body)); return Promise.resolve(Response.json({ id: 'email' })); }
  return originalFetch(url, init);
};
async function pay(action, data) {
  const response = await fetch(`${apiBase}/api/pay/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(data), signal: AbortSignal.timeout(45_000) });
  return { status: response.status, ...(await response.json()) };
}
try {
  const invoiceDoc = db.collection('invoices').doc(id);
  const link = await db.runTransaction(async tx => {
    const minted = payments.mintPayLink(db, tx, id, (await tx.get(invoiceDoc)).data());
    tx.update(invoiceDoc, { payLinks: minted.payLinks });
    return minted;
  });
  const code = /\/i\/([A-Za-z0-9]{10})$/.exec(link.url)?.[1];
  assert(code, `pay links are short: ${link.url}`);
  assert(!JSON.stringify((await invoiceDoc.get()).data()).includes(code), 'the code is not stored');
  const resolved = await pay('resolve', { code });
  assert.equal(resolved.result.id, id);
  const customer = await pay('details', resolved.result);
  assert.equal(customer.status, 200, JSON.stringify(customer));
  assert.equal(customer.result.number, '2026-0001');
  assert.equal(customer.result.totals.balanceCents, 100000);
  assert.equal(customer.result.payOnline, false, 'the emulator function process has no Stripe');
  assert(!('payLinks' in customer.result) && !JSON.stringify(customer).includes('createdBy'), 'owner fields stay private');
  assert.equal((await pay('details', { id, token: 'f'.repeat(64) })).error, 'link_unavailable');
  assert.equal((await pay('details', { id: second_id, token: resolved.result.token })).error, 'link_unavailable', 'a link opens only its invoice');
  assert.equal(Buffer.from((await pay('pdf', { ...resolved.result, kind: 'invoice' })).result.pdf, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal((await pay('checkout', { ...resolved.result, tipCents: 0 })).error, 'stripe_unavailable');
  assert.equal((await as('get', { id })).result.payLinks, undefined, 'admin views omit link hashes');

  // A paid Checkout session is recorded once, with the tip kept off the balance.
  const session = { id: 'cs_test_invoice_paid', livemode: false, status: 'complete', payment_status: 'paid', amount_total: 101500, currency: 'usd',
    payment_intent: 'pi_invoice', url: null, metadata: { invoiceId: id, attemptId: 'lost-reservation', kind: 'invoice', amountCents: '100000', tipCents: '1500' },
    customer_details: { email: 'pat.personal@example.test' } };
  await assert.rejects(payments.applyInvoiceSession(db, { ...session, amount_total: 100000 }), /stripe_amount_mismatch/);
  await Promise.all([payments.applyInvoiceSession(db, session), payments.applyInvoiceSession(db, session)]);
  const paidOnline = (await as('get', { id })).result;
  assert.equal(paidOnline.status, 'paid');
  assert.equal(paidOnline.payments.filter(entry => entry.id === session.id).length, 1);
  assert.equal(paidOnline.payments.at(-1).method, 'stripe');
  assert.equal(paidOnline.payments.at(-1).tipCents, 1500);
  assert.equal(paidOnline.totals.balanceCents, 0);
  assert.equal(paidOnline.nextReminder, null, 'paid invoices get no reminders');
  // A different Checkout email never replaces the one on file; it waits on the client as a suggestion.
  assert.equal(paidOnline.billTo.email, 'ap@acme.test');
  const acme = (await db.collection('clients').doc('acme').get()).data();
  assert.equal(acme.email, 'ap@acme.test');
  assert.deepEqual([acme.email_suggestion.email, acme.email_suggestion.source], ['pat.personal@example.test', 'payment']);
  assert(sentMail.some(mail => mail.to[0] === 'ap@acme.test' && /^Receipt for invoice 2026-0001/.test(mail.subject) && mail.attachments?.length), 'a receipt is emailed');
  assert.equal((await pay('details', resolved.result)).result.payments.at(-1).tipCents, 1500);
  const receipt = await pay('pdf', { ...resolved.result, kind: 'receipt' });
  assert.match(receipt.result.filename, /Receipt-2026-0001/);

  // Reminders: an invoice 5 days past due gets one, with a fresh pay link and the PDF.
  const day = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const issued = day(Date.now() - 20 * 86_400_000);
  const late = await as('create', { requestId: randomUUID(), source: { kind: 'custom' }, draft: { ...draft, billTo: { ...draft.billTo, name: 'Late Payer LLC', email: 'late@example.test' }, issueDate: issued, terms: 'net_15' } });
  assert.equal(late.result.nextReminder.overdue, true);
  assert.equal(late.result.nextReminder.date, day(Date.now()), 'the first past-due reminder is due today');
  const mailBefore = sentMail.length;
  await payments.sendInvoiceReminders(db);
  const reminderMail = sentMail.slice(mailBefore).find(mail => mail.to[0] === 'late@example.test');
  assert(reminderMail, 'the past-due invoice got a reminder');
  assert.match(reminderMail.subject, /^Past due: invoice /);
  assert.match(reminderMail.html, new RegExp(`https://${projectId}\\.web\\.app/i/[A-Za-z0-9]{10}`));
  assert.equal(reminderMail.attachments.length, 1);
  const lateAfter = (await as('get', { id: late.result.id })).result;
  assert.equal(lateAfter.reminders.length, 1);
  assert.equal(lateAfter.emails.at(-1).kind, 'reminder');
  assert.equal(lateAfter.nextReminder.date > day(Date.now()), true, 'the next one is later');
  const mailAgain = sentMail.length;
  await payments.sendInvoiceReminders(db);
  assert.equal(sentMail.slice(mailAgain).filter(mail => mail.to[0] === 'late@example.test').length, 0, 'each reminder goes out once');
  const paused = await as('pause-reminders', { id: late.result.id, paused: true });
  assert.equal(paused.result.remindersPaused, true);
  assert.equal(paused.result.nextReminder, null);

  // An abandoned checkout is cleared by the reconcile job.
  await db.collection('invoices').doc(late.result.id).update({ checkout: { attempt: 'abandoned', amount: 100, tipCents: 0, expiresAt: Date.now() - 60_000 }, checkoutReconcileAt: Date.now() - 1 });
  await payments.reconcileInvoiceCheckouts(db);
  assert.equal((await db.collection('invoices').doc(late.result.id).get()).get('checkout'), null);

  // Settings keep the online toggles.
  const current = (await as('settings')).result.settings;
  const toggled = await as('save-settings', { ...current, invoiceTips: true, autoReminders: false, revision: current.revision });
  assert.equal(toggled.result.settings.invoiceTips, true);
  assert.equal(toggled.result.settings.autoReminders, false);
  assert.equal(toggled.result.settings.onlinePayments, true);
  console.log('Invoice online payment, pay link and reminder checks passed.');
} finally { globalThis.fetch = originalFetch; }
console.log('Invoice API checks passed.');
