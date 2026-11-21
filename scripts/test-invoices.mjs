// Unit checks for invoice math, validation and PDF rendering. Run: node scripts/test-invoices.mjs [outDir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { parseInvoiceDraft, invoiceTotals, defaultInvoiceSettings, dueDateFor, InvoiceError } = require('../functions/lib/invoice-model.js');
const { invoicePdf } = require('../functions/lib/invoice-pdf.js');

const base = {
  billTo: { name: 'Blue Ridge Property Group', attention: 'Accounts Payable', address: '45 Haywood St, Suite 300\nAsheville, NC 28801', email: 'AP@example.com', phone: '' },
  reference: 'PO-88231', issueDate: '2026-11-21', terms: 'net_30', dueDate: '', serviceDate: '2026-11-18',
  serviceDetail: 'Fleet detail, 3 vans\n12 Biltmore Ave, Asheville',
  lines: [
    { description: 'Full Detail, Ford Transit van', quantity: 3, unitCents: 40000 },
    { description: 'Heavily soiled interior surcharge', quantity: 1, unitCents: 8000 },
    { description: 'Engine bay cleaning', quantity: 2, unitCents: 3000 },
  ],
  taxRateBasisPoints: 700, credits: [{ description: 'Deposit paid', cents: 5000 }], notes: '', receiptNote: '',
};

const draft = parseInvoiceDraft(base);
assert.equal(draft.dueDate, '2026-12-21', 'Net 30 sets the due date');
assert.equal(draft.billTo.email, 'ap@example.com');
assert.equal(dueDateFor('2026-11-21', 'due_on_receipt', ''), '2026-11-21');
const totals = invoiceTotals({ ...draft, payments: [] });
assert.equal(totals.subtotalCents, 134000);
assert.equal(totals.taxCents, 9380);
assert.equal(totals.totalCents, 143380);
assert.equal(totals.amountDueCents, 138380);
assert.equal(totals.balanceCents, 138380);
const paid = invoiceTotals({ ...draft, payments: [{ id: 'p1', method: 'check', reference: '1042', date: '2026-12-02', cents: 138380, recordedAt: 0, by: 'x' }] });
assert.equal(paid.balanceCents, 0);
assert.equal(paid.lastPaymentDate, '2026-12-02');

const rejects = (change, code) => assert.throws(() => parseInvoiceDraft({ ...base, ...change }), error => error instanceof InvoiceError && error.code === code, code);
rejects({ billTo: { ...base.billTo, name: ' ' } }, 'bill_to_required');
rejects({ lines: [] }, 'lines_required');
rejects({ lines: [{ description: 'x', quantity: 0, unitCents: 100 }] }, 'invalid_line');
rejects({ terms: 'net_7' }, 'invalid_terms');
rejects({ terms: 'custom', dueDate: '' }, 'invalid_due_date');
rejects({ issueDate: '2026-02-30' }, 'invalid_issue_date');
rejects({ credits: [{ description: 'Too much', cents: 99_999_999 }] }, 'credits_exceed_total');
rejects({ taxRateBasisPoints: 5000 }, 'invalid_tax_rate');
assert.equal(parseInvoiceDraft({ ...base, terms: 'custom', dueDate: '2027-01-15' }).dueDate, '2027-01-15');

const settings = { ...defaultInvoiceSettings, mailingAddress: 'PO Box 1234\nAsheville, NC 28802' };
const record = { ...draft, number: '2026-0007', status: 'open', source: { kind: 'custom', appointmentId: null, clientId: null }, payments: [], createdAt: 0, createdBy: 'x', updatedAt: 0 };
const invoice = await invoicePdf(record, settings, 'invoice');
const receipt = await invoicePdf({ ...record, status: 'paid', payments: [{ id: 'p1', method: 'check', reference: '1042', date: '2026-12-02', cents: 138380, recordedAt: 0, by: 'x' }] }, settings, 'receipt');
const long = await invoicePdf({ ...record, lines: Array.from({ length: 34 }, (_, index) => ({ description: `Fleet vehicle ${index + 1}, exterior wash and interior wipe-down`, quantity: 1, unitCents: 7500 })) }, settings, 'invoice');
for (const pdf of [invoice, receipt, long]) {
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000 && pdf.length < 400_000, `PDF size ${pdf.length}`);
}
const out = process.argv[2];
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'invoice.pdf'), invoice);
  writeFileSync(path.join(out, 'receipt.pdf'), receipt);
  writeFileSync(path.join(out, 'invoice-long.pdf'), long);
}
console.log('Invoice checks passed.');
