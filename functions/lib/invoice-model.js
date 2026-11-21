"use strict";
// Invoices for work billed after the fact, mostly business clients that pay by mailed check.
// Money is in cents. Tax applies to the whole subtotal at one rate, like appointment invoices.
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceError = exports.PAYMENT_METHODS = exports.termsLabel = exports.defaultInvoiceSettings = void 0;
exports.validDate = validDate;
exports.addDays = addDays;
exports.dueDateFor = dueDateFor;
exports.parseInvoiceDraft = parseInvoiceDraft;
exports.parseInvoiceSettings = parseInvoiceSettings;
exports.invoiceTotals = invoiceTotals;
exports.defaultInvoiceSettings = {
    businessName: "Nieman's Detailing", payableTo: "Nieman's Detailing", mailingAddress: "",
    phone: "(828) 273-3894", email: "nieman@niemansdetailing.com", website: "niemansdetailing.com", taxId: "",
    defaultTerms: "net_30", invoiceNote: "", receiptNote: "", revision: "",
};
const TERMS = {
    due_on_receipt: { label: "Due on receipt", days: 0 },
    net_15: { label: "Net 15", days: 15 }, net_30: { label: "Net 30", days: 30 },
    net_45: { label: "Net 45", days: 45 }, net_60: { label: "Net 60", days: 60 },
    custom: { label: "See due date", days: null },
};
const termsLabel = (terms) => TERMS[terms]?.label ?? "See due date";
exports.termsLabel = termsLabel;
exports.PAYMENT_METHODS = new Set(["check", "cash", "ach", "card", "other"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value) {
    if (typeof value !== "string" || !DATE.test(value))
        return false;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function addDays(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function dueDateFor(issueDate, terms, custom) {
    const days = TERMS[terms].days;
    return days === null ? custom : addDays(issueDate, days);
}
const clean = (value, max) => typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";
const cleanLines = (value, max, lines) => clean(value, max).split("\n").map(line => line.trim()).filter(Boolean).slice(0, lines).join("\n");
const cents = (value, min, max) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
class InvoiceError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
exports.InvoiceError = InvoiceError;
// Validates what the owner typed. Throws InvoiceError with a code the admin page explains.
function parseInvoiceDraft(input) {
    const bill = (typeof input.billTo === "object" && input.billTo !== null ? input.billTo : {});
    const billTo = {
        name: clean(bill.name, 120), attention: clean(bill.attention, 120), address: cleanLines(bill.address, 300, 5),
        email: clean(bill.email, 200).toLowerCase(), phone: clean(bill.phone, 40),
    };
    if (!billTo.name)
        throw new InvoiceError(400, "bill_to_required");
    if (billTo.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billTo.email))
        throw new InvoiceError(400, "invalid_email");
    const terms = Object.prototype.hasOwnProperty.call(TERMS, input.terms) ? input.terms : null;
    if (!terms)
        throw new InvoiceError(400, "invalid_terms");
    if (!validDate(input.issueDate))
        throw new InvoiceError(400, "invalid_issue_date");
    const issueDate = input.issueDate;
    const custom = validDate(input.dueDate) ? input.dueDate : "";
    if (terms === "custom" && !custom)
        throw new InvoiceError(400, "invalid_due_date");
    const dueDate = dueDateFor(issueDate, terms, custom);
    if (dueDate < issueDate)
        throw new InvoiceError(400, "invalid_due_date");
    const serviceDate = validDate(input.serviceDate) ? input.serviceDate : "";
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 40)
        throw new InvoiceError(400, "lines_required");
    const lines = input.lines.map(raw => {
        const line = (typeof raw === "object" && raw !== null ? raw : {});
        const description = clean(line.description, 300);
        const quantity = typeof line.quantity === "number" && Number.isFinite(line.quantity) ? Math.round(line.quantity * 100) / 100 : NaN;
        const unitCents = cents(line.unitCents, -10000000, 10000000);
        if (!description || !(quantity > 0 && quantity <= 10000) || unitCents === null)
            throw new InvoiceError(400, "invalid_line");
        return { description, quantity, unitCents };
    });
    const rate = cents(input.taxRateBasisPoints, 0, 2000);
    if (rate === null)
        throw new InvoiceError(400, "invalid_tax_rate");
    if (!Array.isArray(input.credits ?? []) || (input.credits ?? []).length > 10)
        throw new InvoiceError(400, "invalid_credit");
    const credits = (input.credits ?? []).map(raw => {
        const credit = (typeof raw === "object" && raw !== null ? raw : {});
        const description = clean(credit.description, 120);
        const amount = cents(credit.cents, 1, 100000000);
        if (!description || amount === null)
            throw new InvoiceError(400, "invalid_credit");
        return { description, cents: amount };
    });
    const draft = {
        billTo, reference: clean(input.reference, 80), issueDate, terms, dueDate, serviceDate,
        serviceDetail: cleanLines(input.serviceDetail, 300, 4), lines, taxRateBasisPoints: rate, credits,
        notes: clean(input.notes, 1200), receiptNote: clean(input.receiptNote, 600),
    };
    const totals = invoiceTotals({ ...draft, payments: [] });
    if (totals.subtotalCents < 0)
        throw new InvoiceError(400, "negative_total");
    if (totals.creditCents > totals.totalCents)
        throw new InvoiceError(400, "credits_exceed_total");
    return draft;
}
function parseInvoiceSettings(input) {
    const settings = {
        businessName: clean(input.businessName, 80), payableTo: clean(input.payableTo, 80),
        mailingAddress: cleanLines(input.mailingAddress, 300, 4), phone: clean(input.phone, 40), email: clean(input.email, 200),
        website: clean(input.website, 100), taxId: clean(input.taxId, 40),
        defaultTerms: (Object.prototype.hasOwnProperty.call(TERMS, input.defaultTerms) ? input.defaultTerms : "net_30"),
        invoiceNote: clean(input.invoiceNote, 1200), receiptNote: clean(input.receiptNote, 600),
    };
    if (!settings.businessName)
        throw new InvoiceError(400, "business_name_required");
    return settings;
}
function invoiceTotals(invoice) {
    const lineCents = invoice.lines.map(line => Math.round(line.quantity * line.unitCents));
    const subtotalCents = lineCents.reduce((total, value) => total + value, 0);
    const taxCents = Math.max(0, Math.round(subtotalCents * invoice.taxRateBasisPoints / 10000));
    const totalCents = subtotalCents + taxCents;
    const creditCents = invoice.credits.reduce((total, credit) => total + credit.cents, 0);
    const paidCents = invoice.payments.reduce((total, payment) => total + payment.cents, 0);
    const amountDueCents = Math.max(0, totalCents - creditCents);
    const balanceCents = Math.max(0, amountDueCents - paidCents);
    const lastPaymentDate = invoice.payments.map(payment => payment.date).sort().pop() ?? null;
    return { lineCents, subtotalCents, taxCents, totalCents, creditCents, amountDueCents, paidCents, balanceCents, lastPaymentDate };
}
