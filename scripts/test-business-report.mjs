// Unit checks for the Dashboard money and jobs report. Run: node scripts/test-business-report.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reportMonths, appointmentJob, invoiceJob, summarizeJobs } = require('../functions/lib/business-report.js');

// Months are Eastern: 03:30 UTC on Dec 1 is still Nov 30 in Asheville.
const months = reportMonths(Date.parse('2026-12-01T03:30:00Z'), 24);
assert.equal(months.length, 24);
assert.equal(months.at(-1), '2026-11');
assert.equal(months[0], '2024-12');
assert.deepEqual(reportMonths(Date.parse('2027-01-15T17:00:00Z'), 3), ['2026-11', '2026-12', '2027-01']);

const finished = (service, finalCents, taxCents, completedAt) => ({ status: 'completed', service, finalCents, taxCents, completedAt: Date.parse(completedAt) });
assert.equal(appointmentJob({ ...finished('Full Detail', 30000, 0, '2026-11-10T15:00:00Z'), status: 'cancelled' }), null);
assert.equal(appointmentJob({ status: 'completed', service: 'Full Detail' }), null);
const late = appointmentJob(finished('Full Detail', 30000, 2100, '2026-12-01T03:00:00Z'));
assert.equal(late.month, '2026-11', 'a job finished late on Nov 30 Eastern counts in November');

const invoice = (overrides) => ({
  status: 'open', source: { kind: 'client', appointmentId: null, clientId: 'c' }, issueDate: '2026-11-05', taxRateBasisPoints: 700,
  lines: [{ description: 'Fleet wash, 3 vans', quantity: 3, unitCents: 10000 }], credits: [{ description: 'Deposit paid', cents: 5000 }], payments: [], ...overrides,
});
assert.equal(invoiceJob(invoice({ status: 'void' })), null, 'void invoices do not count');
assert.equal(invoiceJob(invoice({ source: { kind: 'appointment', appointmentId: 'a', clientId: null } })), null, 'appointment invoices are counted with the appointment');
const fleet = invoiceJob(invoice({}));
assert.deepEqual(fleet, { month: '2026-11', service: 'Fleet wash, 3 vans', revenueCents: 30000, taxCents: 2100, kind: 'invoice' }, 'credits are prepayments, not lower revenue');

const summary = summarizeJobs([
  late, fleet,
  appointmentJob(finished('Interior Only', 15000, 1050, '2026-11-12T15:00:00Z')),
  appointmentJob(finished('full detail', 28000, 0, '2026-11-20T15:00:00Z')),
  appointmentJob(finished('Full Detail', 30000, 0, '2026-10-20T15:00:00Z')),
  appointmentJob(finished('Full Detail', 30000, 0, '2020-01-20T15:00:00Z')),
], months);
const november = summary.at(-1);
assert.equal(november.revenueCents, 103000);
assert.equal(november.taxCents, 5250);
assert.equal(november.jobs, 4);
assert.equal(november.appointments, 3);
assert.equal(november.invoices, 1);
assert.deepEqual(november.services.map(service => [service.name, service.jobs, service.revenueCents]),
  [['Full Detail', 2, 58000], ['Fleet wash, 3 vans', 1, 30000], ['Interior Only', 1, 15000]], 'services group case-insensitively, biggest first');
assert.equal(summary.at(-2).jobs, 1);
assert.equal(summary.reduce((sum, month) => sum + month.jobs, 0), 5, 'jobs outside the 24 months are dropped');
console.log('PASS: Dashboard money and jobs report.');
