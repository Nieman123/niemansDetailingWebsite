// Invoices for work billed after the fact, mostly business clients that pay by mailed check.
// Money is in cents. Tax applies to the whole subtotal at one rate, like appointment invoices.

export type InvoiceTerms = "due_on_receipt" | "net_15" | "net_30" | "net_45" | "net_60" | "custom";
export type InvoiceLine = { description: string; quantity: number; unitCents: number };
export type InvoiceCredit = { description: string; cents: number };
export type InvoicePayment = { id: string; method: string; reference: string; date: string; cents: number; recordedAt: number; by: string };
export type InvoiceStatus = "open" | "paid" | "void";

export type InvoiceDraft = {
  billTo: { name: string; attention: string; address: string; email: string; phone: string };
  reference: string;
  issueDate: string;
  terms: InvoiceTerms;
  dueDate: string;
  serviceDate: string;
  serviceDetail: string;
  lines: InvoiceLine[];
  taxRateBasisPoints: number;
  credits: InvoiceCredit[];
  notes: string;
  receiptNote: string;
};

export type InvoiceRecord = InvoiceDraft & {
  number: string;
  status: InvoiceStatus;
  source: { kind: "appointment" | "client" | "custom"; appointmentId: string | null; clientId: string | null };
  payments: InvoicePayment[];
  createdAt: number; createdBy: string; updatedAt: number;
  paidAt?: number | null; voidedAt?: number | null;
  emails?: Array<{ to: string; kind: string; at: number }>;
};

export type InvoiceSettings = {
  businessName: string;
  payableTo: string;
  mailingAddress: string;
  phone: string;
  email: string;
  website: string;
  taxId: string;
  defaultTerms: InvoiceTerms;
  invoiceNote: string;
  receiptNote: string;
  revision: string;
};

export const defaultInvoiceSettings: InvoiceSettings = {
  businessName: "Nieman's Detailing", payableTo: "Nieman's Detailing", mailingAddress: "",
  phone: "(828) 273-3894", email: "nieman@niemansdetailing.com", website: "niemansdetailing.com", taxId: "",
  defaultTerms: "net_30", invoiceNote: "", receiptNote: "", revision: "",
};

const TERMS: Record<InvoiceTerms, { label: string; days: number | null }> = {
  due_on_receipt: { label: "Due on receipt", days: 0 },
  net_15: { label: "Net 15", days: 15 }, net_30: { label: "Net 30", days: 30 },
  net_45: { label: "Net 45", days: 45 }, net_60: { label: "Net 60", days: 60 },
  custom: { label: "See due date", days: null },
};
export const termsLabel = (terms: InvoiceTerms) => TERMS[terms]?.label ?? "See due date";
export const PAYMENT_METHODS = new Set(["check", "cash", "ach", "card", "other"]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
export function dueDateFor(issueDate: string, terms: InvoiceTerms, custom: string) {
  const days = TERMS[terms].days;
  return days === null ? custom : addDays(issueDate, days);
}

const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
const cleanLines = (value: unknown, max: number, lines: number) => clean(value, max).split("\n").map(line => line.trim()).filter(Boolean).slice(0, lines).join("\n");
const cents = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

export class InvoiceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

// Validates what the owner typed. Throws InvoiceError with a code the admin page explains.
export function parseInvoiceDraft(input: Record<string, unknown>): InvoiceDraft {
  const bill = (typeof input.billTo === "object" && input.billTo !== null ? input.billTo : {}) as Record<string, unknown>;
  const billTo = {
    name: clean(bill.name, 120), attention: clean(bill.attention, 120), address: cleanLines(bill.address, 300, 5),
    email: clean(bill.email, 200).toLowerCase(), phone: clean(bill.phone, 40),
  };
  if (!billTo.name) throw new InvoiceError(400, "bill_to_required");
  if (billTo.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billTo.email)) throw new InvoiceError(400, "invalid_email");
  const terms = Object.prototype.hasOwnProperty.call(TERMS, input.terms as string) ? input.terms as InvoiceTerms : null;
  if (!terms) throw new InvoiceError(400, "invalid_terms");
  if (!validDate(input.issueDate)) throw new InvoiceError(400, "invalid_issue_date");
  const issueDate = input.issueDate;
  const custom = validDate(input.dueDate) ? input.dueDate : "";
  if (terms === "custom" && !custom) throw new InvoiceError(400, "invalid_due_date");
  const dueDate = dueDateFor(issueDate, terms, custom);
  if (dueDate < issueDate) throw new InvoiceError(400, "invalid_due_date");
  const serviceDate = validDate(input.serviceDate) ? input.serviceDate : "";
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 40) throw new InvoiceError(400, "lines_required");
  const lines = input.lines.map(raw => {
    const line = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const description = clean(line.description, 300);
    const quantity = typeof line.quantity === "number" && Number.isFinite(line.quantity) ? Math.round(line.quantity * 100) / 100 : NaN;
    const unitCents = cents(line.unitCents, -10_000_000, 10_000_000);
    if (!description || !(quantity > 0 && quantity <= 10_000) || unitCents === null) throw new InvoiceError(400, "invalid_line");
    return { description, quantity, unitCents };
  });
  const rate = cents(input.taxRateBasisPoints, 0, 2000);
  if (rate === null) throw new InvoiceError(400, "invalid_tax_rate");
  if (!Array.isArray(input.credits ?? []) || ((input.credits as unknown[]) ?? []).length > 10) throw new InvoiceError(400, "invalid_credit");
  const credits = ((input.credits as unknown[]) ?? []).map(raw => {
    const credit = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const description = clean(credit.description, 120);
    const amount = cents(credit.cents, 1, 100_000_000);
    if (!description || amount === null) throw new InvoiceError(400, "invalid_credit");
    return { description, cents: amount };
  });
  const draft: InvoiceDraft = {
    billTo, reference: clean(input.reference, 80), issueDate, terms, dueDate, serviceDate,
    serviceDetail: cleanLines(input.serviceDetail, 300, 4), lines, taxRateBasisPoints: rate, credits,
    notes: clean(input.notes, 1200), receiptNote: clean(input.receiptNote, 600),
  };
  const totals = invoiceTotals({ ...draft, payments: [] });
  if (totals.subtotalCents < 0) throw new InvoiceError(400, "negative_total");
  if (totals.creditCents > totals.totalCents) throw new InvoiceError(400, "credits_exceed_total");
  return draft;
}

export function parseInvoiceSettings(input: Record<string, unknown>): Omit<InvoiceSettings, "revision"> {
  const settings = {
    businessName: clean(input.businessName, 80), payableTo: clean(input.payableTo, 80),
    mailingAddress: cleanLines(input.mailingAddress, 300, 4), phone: clean(input.phone, 40), email: clean(input.email, 200),
    website: clean(input.website, 100), taxId: clean(input.taxId, 40),
    defaultTerms: (Object.prototype.hasOwnProperty.call(TERMS, input.defaultTerms as string) ? input.defaultTerms : "net_30") as InvoiceTerms,
    invoiceNote: clean(input.invoiceNote, 1200), receiptNote: clean(input.receiptNote, 600),
  };
  if (!settings.businessName) throw new InvoiceError(400, "business_name_required");
  return settings;
}

export function invoiceTotals(invoice: Pick<InvoiceRecord, "lines" | "taxRateBasisPoints" | "credits" | "payments">) {
  const lineCents = invoice.lines.map(line => Math.round(line.quantity * line.unitCents));
  const subtotalCents = lineCents.reduce((total, value) => total + value, 0);
  const taxCents = Math.max(0, Math.round(subtotalCents * invoice.taxRateBasisPoints / 10_000));
  const totalCents = subtotalCents + taxCents;
  const creditCents = invoice.credits.reduce((total, credit) => total + credit.cents, 0);
  const paidCents = invoice.payments.reduce((total, payment) => total + payment.cents, 0);
  const amountDueCents = Math.max(0, totalCents - creditCents);
  const balanceCents = Math.max(0, amountDueCents - paidCents);
  const lastPaymentDate = invoice.payments.map(payment => payment.date).sort().pop() ?? null;
  return { lineCents, subtotalCents, taxCents, totalCents, creditCents, amountDueCents, paidCents, balanceCents, lastPaymentDate };
}
