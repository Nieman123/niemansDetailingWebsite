"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_MONTHS = void 0;
exports.reportMonths = reportMonths;
exports.appointmentJob = appointmentJob;
exports.invoiceJob = invoiceJob;
exports.summarizeJobs = summarizeJobs;
exports.businessReport = businessReport;
const appointment_booking_1 = require("./appointment-booking");
const invoice_model_1 = require("./invoice-model");
exports.REPORT_MONTHS = 24;
// The last `count` Eastern months, oldest first, ending with the month that contains `now`.
function reportMonths(now, count = exports.REPORT_MONTHS) {
    const [year, month] = (0, appointment_booking_1.easternDate)(now).split("-").map(Number);
    return Array.from({ length: count }, (_, index) => {
        const offset = year * 12 + (month - 1) - (count - 1 - index);
        return `${Math.floor(offset / 12)}-${String(offset % 12 + 1).padStart(2, "0")}`;
    });
}
const serviceName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Other work";
function appointmentJob(appointment) {
    if (appointment.status !== "completed" || typeof appointment.completedAt !== "number")
        return null;
    const revenueCents = Number.isSafeInteger(appointment.finalCents) ? appointment.finalCents : 0;
    const taxCents = Number.isSafeInteger(appointment.taxCents) ? appointment.taxCents : 0;
    return { month: (0, appointment_booking_1.easternDate)(appointment.completedAt).slice(0, 7), service: serviceName(appointment.service), revenueCents, taxCents, kind: "appointment" };
}
function invoiceJob(invoice) {
    if (invoice.status === "void" || invoice.source?.kind === "appointment" || !/^\d{4}-\d{2}/.test(invoice.issueDate ?? ""))
        return null;
    const totals = (0, invoice_model_1.invoiceTotals)({ lines: invoice.lines ?? [], taxRateBasisPoints: invoice.taxRateBasisPoints ?? 0, credits: invoice.credits ?? [], payments: invoice.payments ?? [] });
    // Group invoice work by its first line, so a recurring fleet job shows up as one service.
    return { month: invoice.issueDate.slice(0, 7), service: serviceName(invoice.lines?.[0]?.description), revenueCents: totals.subtotalCents, taxCents: totals.taxCents, kind: "invoice" };
}
function summarizeJobs(jobs, months) {
    const byMonth = new Map(months.map(month => [month, { month, revenueCents: 0, taxCents: 0, jobs: 0, appointments: 0, invoices: 0, services: new Map() }]));
    for (const job of jobs) {
        const row = byMonth.get(job.month);
        if (!row)
            continue;
        row.revenueCents += job.revenueCents;
        row.taxCents += job.taxCents;
        row.jobs += 1;
        row[job.kind === "invoice" ? "invoices" : "appointments"] += 1;
        const key = job.service.toLowerCase();
        const service = row.services.get(key) ?? { name: job.service, jobs: 0, revenueCents: 0 };
        service.jobs += 1;
        service.revenueCents += job.revenueCents;
        row.services.set(key, service);
    }
    return [...byMonth.values()].map(row => ({ ...row, services: [...row.services.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.jobs - a.jobs) }));
}
async function businessReport(db, now = Date.now()) {
    const months = reportMonths(now);
    // Start a day early so a job finished just after midnight Eastern on the 1st is never missed; summarizeJobs drops extras.
    const since = Date.parse(`${months[0]}-01T00:00:00Z`) - 86400000;
    const [appointments, invoices] = await Promise.all([
        db.collection("appointments").where("completedAt", ">=", since).limit(5000).get(),
        db.collection("invoices").where("issueDate", ">=", `${months[0]}-01`).limit(2000).get(),
    ]);
    const jobs = [
        ...appointments.docs.map(doc => appointmentJob(doc.data())),
        ...invoices.docs.map(doc => invoiceJob(doc.data())),
    ].filter((job) => job !== null);
    return { generatedAt: now, currentMonth: months[months.length - 1], months: summarizeJobs(jobs, months) };
}
