// Money and jobs report for the admin Dashboard: revenue, job count, average ticket, sales tax and top services by month.
// Revenue is the pre-tax amount billed for finished work, counted in the Eastern month the job was finished
// (appointments) or the invoice was issued (stand-alone invoices). Invoices made from an appointment are skipped,
// because that appointment already counts. Money is in cents.
//
// The Dashboard also tracks sales tax filing. Stripe doesn't file or pay sales tax, so the owner files with NCDOR
// each period; the report shows what to put on the return and reminds the owner on Telegram before it's due.
import type { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { easternDate } from "./appointment-booking";
import { invoiceTotals, type InvoiceRecord } from "./invoice-model";
import { sendTelegramMessage, telegramConfigured } from "./telegram";

export type ReportJob = {
  month: string; revenueCents: number; taxCents: number; kind: "appointment" | "invoice";
  // How the revenue splits across services: one entry, or one per service on a multi-service booking.
  services: Array<{ name: string; cents: number }>;
};
export type ReportMonth = {
  month: string; revenueCents: number; taxCents: number; taxableCents: number; jobs: number; appointments: number; invoices: number;
  services: Array<{ name: string; jobs: number; revenueCents: number }>;
};

export const REPORT_MONTHS = 24;

// The last `count` Eastern months, oldest first, ending with the month that contains `now`.
export function reportMonths(now: number, count = REPORT_MONTHS) {
  const [year, month] = easternDate(now).split("-").map(Number);
  return Array.from({ length: count }, (_, index) => monthAt(year * 12 + (month - 1) - (count - 1 - index)));
}
const monthAt = (offset: number) => `${Math.floor(offset / 12)}-${String(offset % 12 + 1).padStart(2, "0")}`;
const monthOffset = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

const serviceName = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Other work";

// Splits a job's revenue across its services in proportion to their prices, so the parts add up exactly.
function splitServices(items: Array<{ name: unknown; cents: unknown }>, revenueCents: number, fallback: unknown) {
  const named = items.map(item => ({ name: serviceName(item.name), weight: Number.isSafeInteger(item.cents) && (item.cents as number) > 0 ? item.cents as number : 0 }));
  if (named.length < 2) return [{ name: serviceName(named[0]?.name ?? fallback), cents: revenueCents }];
  const weights = named.reduce((sum, item) => sum + item.weight, 0);
  let left = revenueCents;
  return named.map((item, index) => {
    const cents = index === named.length - 1 ? left : Math.round(revenueCents * (weights ? item.weight / weights : 1 / named.length));
    left -= cents;
    return { name: item.name, cents };
  });
}

export function appointmentJob(appointment: Record<string, unknown>): ReportJob | null {
  if (appointment.status !== "completed" || typeof appointment.completedAt !== "number") return null;
  const revenueCents = Number.isSafeInteger(appointment.finalCents) ? appointment.finalCents as number : 0;
  const taxCents = Number.isSafeInteger(appointment.taxCents) ? appointment.taxCents as number : 0;
  const items = Array.isArray(appointment.items) ? appointment.items as Array<{ name: unknown; cents: unknown }> : [];
  return { month: easternDate(appointment.completedAt).slice(0, 7), revenueCents, taxCents, kind: "appointment", services: splitServices(items, revenueCents, appointment.service) };
}

export function invoiceJob(invoice: InvoiceRecord): ReportJob | null {
  if (invoice.status === "void" || invoice.source?.kind === "appointment" || !/^\d{4}-\d{2}/.test(invoice.issueDate ?? "")) return null;
  const totals = invoiceTotals({ lines: invoice.lines ?? [], taxRateBasisPoints: invoice.taxRateBasisPoints ?? 0, credits: invoice.credits ?? [], payments: invoice.payments ?? [] });
  // Group invoice work by its first line, so a recurring fleet job shows up as one service.
  return { month: invoice.issueDate.slice(0, 7), revenueCents: totals.subtotalCents, taxCents: totals.taxCents, kind: "invoice",
    services: [{ name: serviceName(invoice.lines?.[0]?.description), cents: totals.subtotalCents }] };
}

export function summarizeJobs(jobs: ReportJob[], months: string[]): ReportMonth[] {
  const byMonth = new Map(months.map(month => [month, { month, revenueCents: 0, taxCents: 0, taxableCents: 0, jobs: 0, appointments: 0, invoices: 0, services: new Map<string, { name: string; jobs: number; revenueCents: number }>() }]));
  for (const job of jobs) {
    const row = byMonth.get(job.month);
    if (!row) continue;
    row.revenueCents += job.revenueCents;
    row.taxCents += job.taxCents;
    if (job.taxCents > 0) row.taxableCents += job.revenueCents;
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

// ---------- Sales tax filing ----------

export type TaxFrequency = "monthly" | "quarterly" | "annual";
export const TAX_FREQUENCIES: TaxFrequency[] = ["monthly", "quarterly", "annual"];
const filingDoc = (db: Firestore) => db.collection("appointmentSettings").doc("salesTaxFiling");
const PERIOD_KEY = /^(\d{4})(?:-(0[1-9]|1[0-2])|-Q([1-4]))?$/;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The filing period a month falls in: 2026-11 (monthly), 2026-Q4 (quarterly) or 2026 (annual).
export function periodKey(month: string, frequency: TaxFrequency) {
  if (frequency === "monthly") return month;
  if (frequency === "annual") return month.slice(0, 4);
  return `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`;
}

// The months in a period and its NCDOR due date: monthly returns are due the 20th of the next month, quarterly
// returns the last day of the month after the quarter, and annual returns January 31.
export function periodInfo(key: string) {
  const match = PERIOD_KEY.exec(key);
  if (!match) return null;
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

// trackingSince is the Eastern date the owner first chose a schedule: returns due before then were handled outside the app.
type FilingSettings = { frequency: TaxFrequency | null; trackingSince: string | null; filed: Record<string, { at: number; by: string }>; reminded: Record<string, string[]> };

async function getFiling(db: Firestore): Promise<FilingSettings> {
  const data = (await filingDoc(db).get()).data() ?? {};
  return {
    frequency: TAX_FREQUENCIES.includes(data.frequency) ? data.frequency : null,
    trackingSince: typeof data.trackingSince === "string" ? data.trackingSince : null,
    filed: data.filed && typeof data.filed === "object" ? data.filed : {},
    reminded: data.reminded && typeof data.reminded === "object" ? data.reminded : {},
  };
}

// The filing periods covered by the report, newest first, with what goes on each return.
// A return needs filing once its period has ended, it collected tax, it isn't marked filed, and it falls due after tracking began.
export function taxPeriods(months: ReportMonth[], frequency: TaxFrequency, filed: FilingSettings["filed"], today: string, trackingSince: string | null = null) {
  const byMonth = new Map(months.map(month => [month.month, month]));
  const keys = [...new Set(months.map(month => periodKey(month.month, frequency)))].reverse();
  return keys.map(key => {
    const info = periodInfo(key)!;
    // Skip periods that started before the report's first month, since their totals would be partial.
    if (!byMonth.has(info.months[0])) return null;
    const rows = info.months.map(month => byMonth.get(month)).filter((row): row is ReportMonth => !!row);
    const sum = (field: "revenueCents" | "taxCents" | "taxableCents" | "jobs") => rows.reduce((total, row) => total + row[field], 0);
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

export async function businessReport(db: Firestore, now = Date.now()) {
  const months = reportMonths(now);
  // Start a day early so a job finished just after midnight Eastern on the 1st is never missed; summarizeJobs drops extras.
  const since = Date.parse(`${months[0]}-01T00:00:00Z`) - 86_400_000;
  const [appointments, invoices, filing, tax] = await Promise.all([
    db.collection("appointments").where("completedAt", ">=", since).limit(5000).get(),
    db.collection("invoices").where("issueDate", ">=", `${months[0]}-01`).limit(2000).get(),
    getFiling(db),
    db.collection("appointmentSettings").doc("salesTax").get(),
  ]);
  const jobs = [
    ...appointments.docs.map(doc => appointmentJob(doc.data())),
    ...invoices.docs.map(doc => invoiceJob(doc.data() as InvoiceRecord)),
  ].filter((job): job is ReportJob => job !== null);
  const summary = summarizeJobs(jobs, months);
  const frequency = filing.frequency ?? "quarterly";
  return {
    generatedAt: now, currentMonth: months[months.length - 1], months: summary,
    salesTax: {
      enabled: tax.get("enabled") === true, rateBasisPoints: tax.get("rateBasisPoints") ?? null, taxId: tax.get("taxId") ?? "",
      frequency, frequencyChosen: filing.frequency !== null,
      periods: taxPeriods(summary, frequency, filing.filed, easternDate(now), filing.trackingSince).slice(0, frequency === "monthly" ? 13 : frequency === "quarterly" ? 6 : 2),
    },
  };
}

export class ReportError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function saveTaxFiling(db: Firestore, uid: string, body: Record<string, unknown>) {
  if (body.frequency !== undefined) {
    if (!TAX_FREQUENCIES.includes(body.frequency as TaxFrequency)) throw new ReportError(400, "invalid_frequency");
    const current = await getFiling(db);
    await filingDoc(db).set({ frequency: body.frequency, trackingSince: current.trackingSince ?? easternDate(Date.now()), updatedAt: Date.now(), updatedBy: uid }, { merge: true });
  }
  if (body.period !== undefined) {
    const key = String(body.period);
    if (!periodInfo(key)) throw new ReportError(400, "invalid_period");
    const { FieldValue } = await import("firebase-admin/firestore");
    await filingDoc(db).set({ filed: { [key]: body.filed === false ? FieldValue.delete() : { at: Date.now(), by: uid } }, updatedAt: Date.now() }, { merge: true });
  }
  return businessReport(db);
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dueLabel = (due: string) => new Date(`${due}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

// Daily: a Telegram reminder a week before a return is due, and again on the due date if it isn't marked filed.
export async function remindSalesTax(db: Firestore, now = Date.now()) {
  const filing = await getFiling(db);
  if (!filing.frequency || !telegramConfigured()) return;
  const today = easternDate(now);
  const report = await businessReport(db, now);
  const origin = (process.env.HOSTING_ORIGIN ?? "").replace(/\/$/, "");
  for (const period of report.salesTax.periods) {
    if (!period.needsFiling) continue;
    const days = daysBetween(today, period.due);
    const stage = days < 0 ? "overdue" : days === 0 ? "due" : days <= 7 ? "week" : null;
    // A stale overdue period from long ago shouldn't nag every day; remind once.
    if (!stage || (filing.reminded[period.key] ?? []).includes(stage)) continue;
    const text = [
      stage === "overdue" ? `Sales tax for ${period.label} was due ${dueLabel(period.due)} and isn't marked filed.`
        : stage === "due" ? `Sales tax for ${period.label} is due today.` : `Sales tax for ${period.label} is due ${dueLabel(period.due)}.`,
      `Gross sales ${money(period.grossCents)}, taxable ${money(period.taxableCents)}, tax ${money(period.taxCents)}.`,
      origin ? `Summary: ${origin}/admin/dashboard#sales-tax` : null,
    ].filter(Boolean).join("\n");
    try {
      await sendTelegramMessage(text);
      await filingDoc(db).set({ reminded: { [period.key]: [...(filing.reminded[period.key] ?? []), stage] } }, { merge: true });
    } catch (error) {
      logger.error("Sales tax reminder not sent", { period: period.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}
