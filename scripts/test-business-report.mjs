// Unit checks for the Dashboard money and jobs report. Run: node scripts/test-business-report.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reportMonths, appointmentJob, invoiceJob, summarizeJobs, periodKey, periodInfo, taxPeriods } = require('../functions/lib/business-report.js');

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
assert.deepEqual(fleet, { month: '2026-11', revenueCents: 30000, taxCents: 2100, kind: 'invoice', services: [{ name: 'Fleet wash, 3 vans', cents: 30000 }] }, 'credits are prepayments, not lower revenue');

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
// A multi-service booking splits its revenue across services by their prices, and the parts add up.
const combo = appointmentJob({ ...finished('Full Detail + Monthly Mini Detail', 25001, 0, '2026-11-02T15:00:00Z'),
  items: [{ name: 'Full Detail', cents: 30000 }, { name: 'Monthly Mini Detail', cents: 15000 }] });
assert.deepEqual(combo.services, [{ name: 'Full Detail', cents: 16667 }, { name: 'Monthly Mini Detail', cents: 8334 }]);
const comboMonth = summarizeJobs([combo], ['2026-11'])[0];
assert.equal(comboMonth.jobs, 1, 'a multi-service booking is still one job');
assert.equal(comboMonth.services.length, 2);

// Sales tax filing periods and NCDOR due dates.
assert.equal(periodKey('2026-11', 'monthly'), '2026-11');
assert.equal(periodKey('2026-11', 'quarterly'), '2026-Q4');
assert.equal(periodKey('2026-03', 'quarterly'), '2026-Q1');
assert.equal(periodKey('2026-11', 'annual'), '2026');
assert.equal(periodInfo('2026-11').due, '2026-12-20', 'monthly returns are due the 20th');
assert.equal(periodInfo('2026-12').due, '2027-01-20');
assert.equal(periodInfo('2026-Q4').due, '2027-01-31', 'quarterly returns are due the end of the next month');
assert.equal(periodInfo('2027-Q1').due, '2027-04-30');
assert.deepEqual(periodInfo('2026-Q3').months, ['2026-07', '2026-08', '2026-09']);
assert.equal(periodInfo('2026').due, '2027-01-31');
assert.equal(periodInfo('2026-13'), null);
assert.equal(periodInfo('2026-Q5'), null);

const untracked = taxPeriods(summary, 'quarterly', {}, '2026-11-22', null);
assert(untracked.every(period => !period.needsFiling), 'nothing is flagged until a filing schedule is chosen');
const quarters = taxPeriods(summary, 'quarterly', { '2026-Q2': { at: 1, by: 'x' } }, '2026-11-22', '2026-06-01');
assert.equal(quarters[0].key, '2026-Q4');
assert.equal(quarters[0].ended, false);
assert.equal(quarters[0].taxCents, 5250);
assert.equal(quarters[0].taxableCents, 30000 + 30000 + 15000, 'only jobs that charged tax are taxable');
assert.equal(quarters[0].exemptCents, 28000 + 30000, 'October counts in Q4 too');
assert.equal(quarters[1].key, '2026-Q3');
assert.equal(quarters[1].ended, true);
assert.equal(quarters[1].needsFiling, false, 'a quarter that collected no tax has nothing to flag');
const september = summarizeJobs([appointmentJob(finished('Full Detail', 30000, 2100, '2026-09-12T15:00:00Z'))], months);
const q3 = taxPeriods(september, 'quarterly', {}, '2026-11-22', '2026-06-01').find(period => period.key === '2026-Q3');
assert.equal(q3.needsFiling, true);
assert.equal(q3.overdue, true, 'Q3 was due Oct 31 and is not marked filed');
assert.equal(quarters.find(period => period.key === '2026-Q2').filedAt, 1);
assert.equal(quarters.find(period => period.key === '2026-Q2').overdue, false);
assert.equal(quarters.at(-1).key, '2025-Q1', 'a quarter that starts before the report is left out');
assert.equal(quarters.find(period => period.key === '2025-Q4').needsFiling, false, 'returns due before tracking began are not flagged');
console.log('PASS: Dashboard money and jobs report and sales tax periods.');

