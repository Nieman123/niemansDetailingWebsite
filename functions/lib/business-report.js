"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportError = exports.TAX_FREQUENCIES = exports.REPORT_MONTHS = void 0;
exports.reportMonths = reportMonths;
exports.appointmentJob = appointmentJob;
exports.invoiceJob = invoiceJob;
exports.summarizeJobs = summarizeJobs;
exports.periodKey = periodKey;
exports.periodInfo = periodInfo;
exports.taxPeriods = taxPeriods;
exports.businessReport = businessReport;
exports.saveTaxFiling = saveTaxFiling;
exports.remindSalesTax = remindSalesTax;
const firebase_functions_1 = require("firebase-functions");
const appointment_booking_1 = require("./appointment-booking");
const invoice_model_1 = require("./invoice-model");
const telegram_1 = require("./telegram");
exports.REPORT_MONTHS = 24;
// The last `count` Eastern months, oldest first, ending with the month that contains `now`.
function reportMonths(now, count = exports.REPORT_MONTHS) {
    const [year, month] = (0, appointment_booking_1.easternDate)(now).split("-").map(Number);
    return Array.from({ length: count }, (_, index) => monthAt(year * 12 + (month - 1) - (count - 1 - index)));
}
const monthAt = (offset) => `${Math.floor(offset / 12)}-${String(offset % 12 + 1).padStart(2, "0")}`;
const monthOffset = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const serviceName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Other work";
// Splits a job's revenue across its services in proportion to their prices, so the parts add up exactly.
function splitServices(items, revenueCents, fallback) {
    const named = items.map(item => ({ name: serviceName(item.name), weight: Number.isSafeInteger(item.cents) && item.cents > 0 ? item.cents : 0 }));
    if (named.length < 2)
        return [{ name: serviceName(named[0]?.name ?? fallback), cents: revenueCents }];
    const weights = named.reduce((sum, item) => sum + item.weight, 0);
    let left = revenueCents;
    return named.map((item, index) => {
        const cents = index === named.length - 1 ? left : Math.round(revenueCents * (weights ? item.weight / weights : 1 / named.length));
        left -= cents;
        return { name: item.name, cents };
    });
}
function appointmentJob(appointment) {
    if (appointment.status !== "completed" || typeof appointment.completedAt !== "number")
        return null;
    const revenueCents = Number.isSafeInteger(appointment.finalCents) ? appointment.finalCents : 0;
    const taxCents = Number.isSafeInteger(appointment.taxCents) ? appointment.taxCents : 0;
    const items = Array.isArray(appointment.items) ? appointment.items : [];
    return { month: (0, appointment_booking_1.easternDate)(appointment.completedAt).slice(0, 7), revenueCents, taxCents, kind: "appointment", services: splitServices(items, revenueCents, appointment.service) };
}
function invoiceJob(invoice) {
    if (invoice.status === "void" || invoice.source?.kind === "appointment" || !/^\d{4}-\d{2}/.test(invoice.issueDate ?? ""))
        return null;
    const totals = (0, invoice_model_1.invoiceTotals)({ lines: invoice.lines ?? [], taxRateBasisPoints: invoice.taxRateBasisPoints ?? 0, credits: invoice.credits ?? [], payments: invoice.payments ?? [] });
    // Group invoice work by its first line, so a recurring fleet job shows up as one service.
    return { month: invoice.issueDate.slice(0, 7), revenueCents: totals.subtotalCents, taxCents: totals.taxCents, kind: "invoice",
        services: [{ name: serviceName(invoice.lines?.[0]?.description), cents: totals.subtotalCents }] };
}
function summarizeJobs(jobs, months) {
    const byMonth = new Map(months.map(month => [month, { month, revenueCents: 0, taxCents: 0, taxableCents: 0, jobs: 0, appointments: 0, invoices: 0, services: new Map() }]));
    for (const job of jobs) {
        const row = byMonth.get(job.month);
        if (!row)
            continue;
        row.revenueCents += job.revenueCents;
        row.taxCents += job.taxCents;
        if (job.taxCents > 0)
            row.taxableCents += job.revenueCents;
        row.jobs += 1;
        row[job.kind === "invoice" ? "invoices" : "appointments"] += 1;
        for (const part of job.services) {
            const key = part.name.toLowerCase();
            const service = row.services.get(key) ?? { name: part.name, jobs: 0, revenueCents: 0 };
            service.jobs += 1;
            service.revenueCents += part.cents;
            row.services.set(key, service);
        }
    }
    return [...byMonth.values()].map(row => ({ ...row, services: [...row.services.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.jobs - a.jobs) }));
}
exports.TAX_FREQUENCIES = ["monthly", "quarterly", "annual"];
const filingDoc = (db) => db.collection("appointmentSettings").doc("salesTaxFiling");
const PERIOD_KEY = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
// The filing period a month falls in: 2026-11 (monthly), 2026-Q4 (quarterly) or 2026 (annual).
function periodKey(month, frequency) {
    if (frequency === "monthly")
        return month;
    if (frequency === "annual")
        return month.slice(0, 4);
    return `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;
}
// The months in a period and its NCDOR due date: monthly returns are due the 20th of the next month, quarterly
// returns the last day of the month after the quarter, and annual returns January 31.
function periodInfo(key) {
    const match = PERIOD_KEY.exec(key);
    if (!match)
        return null;
    const year = Number(match[1]);
    const first = match[2] ? Number(match[2]) : match[3] ? (Number(match[3]) - 1) * 3 + 1 : 1;
    const count = match[2] ? 1 : match[3] ? 3 : 12;
    const months = Array.from({ length: count }, (_, index) => monthAt(year * 12 + first - 1 + index));
    const after = monthOffset(months[count - 1]) + 1;
    const dueMonth = monthAt(after);
    const [dueYear, dueMonthNumber] = dueMonth.split("-").map(Number);
    const dueDay = count === 1 ? 20 : lastDay(dueYear, dueMonthNumber);
    const label = match[2] ? `${MONTH_NAMES[first - 1]} ${year}` : match[3] ? `Q${match[3]} ${year} (${MONTH_NAMES[first - 1].slice(0, 3)}–${MONTH_NAMES[first + 1].slice(0, 3)})` : `${year}`;
    return { key, label, months, due: `${dueMonth}-${String(dueDay).padStart(2, "0")}` };
}
async function getFiling(db) {
    const data = (await filingDoc(db).get()).data() ?? {};
    return {
        frequency: exports.TAX_FREQUENCIES.includes(data.frequency) ? data.frequency : null,
        trackingSince: typeof data.trackingSince === "string" ? data.trackingSince : null,
        filed: data.filed && typeof data.filed === "object" ? data.filed : {},
        reminded: data.reminded && typeof data.reminded === "object" ? data.reminded : {},
    };
}
// The filing periods covered by the report, newest first, with what goes on each return.
// A return needs filing once its period has ended, it collected tax, it isn't marked filed, and it falls due after tracking began.
function taxPeriods(months, frequency, filed, today, trackingSince = null) {
    const byMonth = new Map(months.map(month => [month.month, month]));
    const keys = [...new Set(months.map(month => periodKey(month.month, frequency)))].reverse();
    return keys.map(key => {
        const info = periodInfo(key);
        // Skip periods that started before the report's first month, since their totals would be partial.
        if (!byMonth.has(info.months[0]))
            return null;
        const rows = info.months.map(month => byMonth.get(month)).filter((row) => !!row);
        const sum = (field) => rows.reduce((total, row) => total + row[field], 0);
        const ended = info.months[info.months.length - 1] < today.slice(0, 7);
        const taxCents = sum("taxCents");
        const needsFiling = ended && !filed[key] && taxCents > 0 && !!trackingSince && info.due >= trackingSince;
        return {
            ...info, ended, filedAt: filed[key]?.at ?? null, needsFiling, overdue: needsFiling && info.due < today,
            grossCents: sum("revenueCents"), taxableCents: sum("taxableCents"), exemptCents: sum("revenueCents") - sum("taxableCents"),
            taxCents, jobs: sum("jobs"),
            byMonth: rows.map(row => ({ month: row.month, grossCents: row.revenueCents, taxableCents: row.taxableCents, taxCents: row.taxCents, jobs: row.jobs })),
        };
    }).filter(period => period !== null);
}
async function businessReport(db, now = Date.now()) {
    const months = reportMonths(now);
    // Start a day early so a job finished just after midnight Eastern on the 1st is never missed; summarizeJobs drops extras.
    const since = Date.parse(`${months[0]}-01T00:00:00Z`) - 86400000;
    const [appointments, invoices, filing, tax] = await Promise.all([
        db.collection("appointments").where("completedAt", ">=", since).limit(5000).get(),
        db.collection("invoices").where("issueDate", ">=", `${months[0]}-01`).limit(2000).get(),
        getFiling(db),
        db.collection("appointmentSettings").doc("salesTax").get(),
    ]);
    const jobs = [
        ...appointments.docs.map(doc => appointmentJob(doc.data())),
        ...invoices.docs.map(doc => invoiceJob(doc.data())),
    ].filter((job) => job !== null);
    const summary = summarizeJobs(jobs, months);
    const frequency = filing.frequency ?? "quarterly";
    return {
        generatedAt: now, currentMonth: months[months.length - 1], months: summary,
        salesTax: {
            enabled: tax.get("enabled") === true, rateBasisPoints: tax.get("rateBasisPoints") ?? null, taxId: tax.get("taxId") ?? "",
            frequency, frequencyChosen: filing.frequency !== null,
            periods: taxPeriods(summary, frequency, filing.filed, (0, appointment_booking_1.easternDate)(now), filing.trackingSince).slice(0, frequency === "monthly" ? 13 : frequency === "quarterly" ? 6 : 2),
        },
    };
}
class ReportError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
exports.ReportError = ReportError;
async function saveTaxFiling(db, uid, body) {
    if (body.frequency !== undefined) {
        if (!exports.TAX_FREQUENCIES.includes(body.frequency))
            throw new ReportError(400, "invalid_frequency");
        const current = await getFiling(db);
        await filingDoc(db).set({ frequency: body.frequency, trackingSince: current.trackingSince ?? (0, appointment_booking_1.easternDate)(Date.now()), updatedAt: Date.now(), updatedBy: uid }, { merge: true });
    }
    if (body.period !== undefined) {
        const key = String(body.period);
        if (!periodInfo(key))
            throw new ReportError(400, "invalid_period");
        const { FieldValue } = await Promise.resolve().then(() => __importStar(require("firebase-admin/firestore")));
        await filingDoc(db).set({ filed: { [key]: body.filed === false ? FieldValue.delete() : { at: Date.now(), by: uid } }, updatedAt: Date.now() }, { merge: true });
    }
    return businessReport(db);
}
const money = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dueLabel = (due) => new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
// Daily: a Telegram reminder a week before a return is due, and again on the due date if it isn't marked filed.
async function remindSalesTax(db, now = Date.now()) {
    const filing = await getFiling(db);
    if (!filing.frequency || !(0, telegram_1.telegramConfigured)())
        return;
    const today = (0, appointment_booking_1.easternDate)(now);
    const report = await businessReport(db, now);
    const origin = (process.env.HOSTING_ORIGIN ?? "").replace(/\/$/, "");
    for (const period of report.salesTax.periods) {
        if (!period.needsFiling)
            continue;
        const days = daysBetween(today, period.due);
        const stage = days < 0 ? "overdue" : days === 0 ? "due" : days <= 7 ? "week" : null;
        // A stale overdue period from long ago shouldn't nag every day; remind once.
        if (!stage || (filing.reminded[period.key] ?? []).includes(stage))
            continue;
        const text = [
            stage === "overdue" ? `Sales tax for ${period.label} was due ${dueLabel(period.due)} and isn't marked filed.`
                : stage === "due" ? `Sales tax for ${period.label} is due today.` : `Sales tax for ${period.label} is due ${dueLabel(period.due)}.`,
            `Gross sales ${money(period.grossCents)}, taxable ${money(period.taxableCents)}, tax ${money(period.taxCents)}.`,
            origin ? `Summary: ${origin}/admin/dashboard#sales-tax` : null,
        ].filter(Boolean).join("\n");
        try {
            await (0, telegram_1.sendTelegramMessage)(text);
            await filingDoc(db).set({ reminded: { [period.key]: [...(filing.reminded[period.key] ?? []), stage] } }, { merge: true });
        }
        catch (error) {
            firebase_functions_1.logger.error("Sales tax reminder not sent", { period: period.key, reason: error instanceof Error ? error.message : String(error) });
        }
    }
}
