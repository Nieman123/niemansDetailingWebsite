// Owner-only invoice and receipt API at /api/invoices/<action>. Invoices live in their own collection, so they
// work for any client or one-off job, and work before online booking is switched on in production.
import { randomBytes } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import {
  InvoiceError, PAYMENT_METHODS, defaultInvoiceSettings, invoiceTotals, parseInvoiceDraft, parseInvoiceSettings, validDate,
  type InvoiceDraft, type InvoicePayment, type InvoiceRecord, type InvoiceSettings, type InvoiceStatus,
} from "./invoice-model";
import { friendlyDate, invoicePdf, type PdfKind } from "./invoice-pdf";
import { sendEmailNow } from "./appointment-email";
import { recordOpsEvent } from "./ops-health";

const ID = /^[\w-]{1,128}$/;
const settingsRef = (db: Firestore) => db.collection("invoiceSettings").doc("business");
const counterRef = (db: Firestore) => db.collection("invoiceSettings").doc("counter");
const invoiceRef = (db: Firestore, id: string) => db.collection("invoices").doc(id);
const VEHICLES: Record<string, string> = { sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "3-row SUV / full-size truck / van" };
const easternDay = (time: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function identifier(value: unknown) {
  if (typeof value !== "string" || !ID.test(value)) throw new InvoiceError(400, "invalid_identifier");
  return value;
}

async function ownerUid(db: Firestore, auth: Auth, req: Request) {
  const token = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
  if (!token) throw new InvoiceError(401, "sign_in_required");
  const identity = await auth.verifyIdToken(token).catch(() => null);
  if (!identity) throw new InvoiceError(401, "sign_in_required");
  const admin = await db.collection("adminUsers").doc(identity.uid).get();
  if (!admin.exists || admin.get("role") === "editor") throw new InvoiceError(403, "access_denied");
  return identity.uid;
}

async function getInvoiceSettings(db: Firestore): Promise<InvoiceSettings> {
  return { ...defaultInvoiceSettings, ...((await settingsRef(db).get()).data() as Partial<InvoiceSettings> | undefined) };
}

async function salesTax(db: Firestore) {
  const tax = (await db.collection("appointmentSettings").doc("salesTax").get()).data() as { enabled?: boolean; rateBasisPoints?: number; taxId?: string } | undefined;
  return { enabled: !!tax?.enabled, rateBasisPoints: Number.isSafeInteger(tax?.rateBasisPoints) ? tax!.rateBasisPoints! : 700, taxId: tax?.taxId ?? "" };
}

function view(id: string, invoice: InvoiceRecord) {
  return { id, ...invoice, totals: invoiceTotals(invoice), overdue: invoice.status === "open" && invoice.dueDate < easternDay(Date.now()) };
}

async function readInvoice(db: Firestore, id: string) {
  const snapshot = await invoiceRef(db, id).get();
  if (!snapshot.exists) throw new InvoiceError(404, "invoice_not_found");
  return snapshot.data() as InvoiceRecord;
}

// Prefills a new invoice from an appointment or a client record. The owner reviews and edits before saving.
async function invoiceContext(db: Firestore, body: Record<string, unknown>) {
  const settings = await getInvoiceSettings(db);
  const tax = await salesTax(db);
  const today = easternDay(Date.now());
  const draft: Partial<InvoiceDraft> & { source: InvoiceRecord["source"] } = {
    source: { kind: "custom", appointmentId: null, clientId: null },
    billTo: { name: "", attention: "", address: "", email: "", phone: "" },
    reference: "", issueDate: today, terms: settings.defaultTerms, dueDate: "", serviceDate: "", serviceDetail: "",
    lines: [{ description: "", quantity: 1, unitCents: 0 }], taxRateBasisPoints: tax.enabled ? tax.rateBasisPoints : 0, credits: [],
    notes: "", receiptNote: "",
  };
  let clientId = body.clientId ? identifier(body.clientId) : null;
  if (body.appointmentId) {
    const appointmentId = identifier(body.appointmentId);
    const appointment = (await db.collection("appointments").doc(appointmentId).get()).data();
    if (!appointment) throw new InvoiceError(404, "record_not_found");
    clientId = clientId ?? (typeof appointment.clientId === "string" ? appointment.clientId : null);
    draft.source = { kind: "appointment", appointmentId, clientId };
    draft.billTo = { name: appointment.name ?? "", attention: "", address: String(appointment.address ?? "").split(/,\s*(?=[^,]+,\s*[A-Z]{2}\b)/).join("\n"),
      email: appointment.email ?? "", phone: appointment.phone ?? "" };
    draft.serviceDate = typeof appointment.start === "number" ? easternDay(appointment.start) : "";
    draft.serviceDetail = [[appointment.service, VEHICLES[appointment.vehicle] ?? appointment.vehicle].filter(Boolean).join(" · "), appointment.address].filter(Boolean).join("\n");
    const lines = Array.isArray(appointment.invoiceLines) && appointment.invoiceLines.length
      ? appointment.invoiceLines.map((line: { description: string; cents: number }) => ({ description: line.description, quantity: 1, unitCents: line.cents }))
      : [{ description: appointment.service || "Detailing service", quantity: 1, unitCents: appointment.finalCents ?? appointment.estimateCents ?? 0 }];
    draft.lines = lines;
    if (appointment.finalCents !== undefined) draft.taxRateBasisPoints = appointment.taxCents ? appointment.taxRateBasisPoints ?? tax.rateBasisPoints : 0;
    const deposit = appointment.refund?.state === "succeeded" ? 0 : appointment.paidDeposit ?? 0;
    const credits = [];
    if (deposit > 0) credits.push({ description: "Deposit paid", cents: deposit });
    const received = (appointment.payments ?? []).reduce((total: number, entry: { amount: number; clearance?: string }) =>
      ["pending", "returned"].includes(entry.clearance ?? "") ? total : total + entry.amount, 0);
    if (received > 0) credits.push({ description: "Payments received", cents: received });
    draft.credits = credits;
  }
  if (clientId) {
    const client = (await db.collection("clients").doc(clientId).get()).data();
    if (!client && !body.appointmentId) throw new InvoiceError(404, "record_not_found");
    if (client) {
      if (!body.appointmentId) draft.source = { kind: "client", appointmentId: null, clientId };
      const cityLine = [client.city, [client.state, client.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      const address = [client.address, cityLine].filter(Boolean).join("\n");
      draft.billTo = {
        name: client.company || client.business_name || draft.billTo!.name || client.full_name || "",
        attention: client.company || client.business_name ? client.full_name ?? "" : draft.billTo!.attention,
        address: address || draft.billTo!.address, email: client.email || draft.billTo!.email,
        phone: client.phone_e164 || client.phone || draft.billTo!.phone,
      };
    }
  }
  return { draft, salesTax: tax };
}

async function nextNumber(db: Firestore, tx: FirebaseFirestore.Transaction, issueDate: string) {
  const year = issueDate.slice(0, 4);
  const counter = await tx.get(counterRef(db));
  const next = (Number(counter.get(year)) || 0) + 1;
  tx.set(counterRef(db), { [year]: next }, { merge: true });
  return `${year}-${String(next).padStart(4, "0")}`;
}

function statusAfterPayments(invoice: InvoiceRecord): InvoiceStatus {
  if (invoice.status === "void") return "void";
  return invoiceTotals(invoice).balanceCents === 0 && invoice.payments.length ? "paid" : "open";
}

function filename(invoice: InvoiceRecord, kind: PdfKind) {
  const name = invoice.billTo.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `Niemans-Detailing-${kind === "receipt" ? "Receipt" : "Invoice"}-${invoice.number}${name ? `-${name}` : ""}.pdf`;
}

async function emailInvoice(db: Firestore, uid: string, id: string, body: Record<string, unknown>) {
  const invoice = await readInvoice(db, id);
  const kind: PdfKind = body.kind === "receipt" ? "receipt" : "invoice";
  if (invoice.status === "void") throw new InvoiceError(409, "invoice_void");
  if (kind === "receipt" && !invoice.payments.length) throw new InvoiceError(409, "no_payments");
  const to = text(body.to, 200).toLowerCase() || invoice.billTo.email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new InvoiceError(400, "invalid_email");
  const settings = await getInvoiceSettings(db);
  const totals = invoiceTotals(invoice);
  const money = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = text(body.message, 1000);
  const payable = settings.payableTo || settings.businessName;
  const subject = kind === "receipt" ? `Receipt for invoice ${invoice.number} from ${settings.businessName}` : `Invoice ${invoice.number} from ${settings.businessName}`;
  const details: Array<[string, string]> = kind === "receipt" ? [
    ["Invoice", invoice.number], ["Paid", money(totals.paidCents)],
    ...(totals.balanceCents ? [["Balance remaining", money(totals.balanceCents)] as [string, string]] : []),
  ] : [
    ["Invoice", invoice.number], ["Amount due", money(totals.balanceCents)], ["Due", friendlyDate(invoice.dueDate)],
    ...(invoice.reference ? [["PO / reference", invoice.reference] as [string, string]] : []),
    ...(settings.mailingAddress ? [["Mail checks to", [payable, ...settings.mailingAddress.split("\n")].join(", ")] as [string, string]] : []),
  ];
  const pdf = await invoicePdf(invoice, settings, kind);
  const sent = await sendEmailNow({
    to, subject, attachment: { filename: filename(invoice, kind), content: pdf },
    idempotencyKey: `invoice/${id}/${kind}/${body.requestId ? identifier(body.requestId) : randomBytes(8).toString("hex")}`,
    content: {
      eyebrow: kind === "receipt" ? "Payment received" : "Invoice",
      heading: kind === "receipt" ? "Thank you, your payment is in." : `Invoice ${invoice.number}`,
      paragraphs: [
        ...(message ? [message] : []),
        kind === "receipt" ? `Your receipt for invoice ${invoice.number} is attached as a PDF.`
          : `Your invoice is attached as a PDF.${settings.mailingAddress ? ` Please make checks payable to ${payable} and write ${invoice.number} on the memo line.` : ""}`,
      ],
      details,
    },
  });
  if (!sent.ok) {
    if (sent.error !== "email_not_configured" && sent.error !== "test_recipient_only") {
      await recordOpsEvent(db, { source: "email", code: "email_failed", ref: id, detail: `Invoice ${invoice.number}: ${sent.error}` });
    }
    throw new InvoiceError(sent.error === "test_recipient_only" ? 409 : 502, sent.error.split(":")[0]);
  }
  const emails = [...(invoice.emails ?? []), { to, kind, at: Date.now() }].slice(-20);
  await invoiceRef(db, id).update({ emails, updatedAt: Date.now(), lastEmailedBy: uid });
  return view(id, { ...invoice, emails });
}

export async function handleInvoices(db: Firestore, auth: Auth, req: Request, res: Response, action: string) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  const body = req.body as Record<string, unknown> | undefined;
  if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) || req.rawBody.length > 65_536) {
    res.status(400).json({ ok: false, error: "invalid_request" });
    return;
  }
  try {
    const uid = await ownerUid(db, auth, req);
    let result: unknown;
    if (action === "settings") {
      result = { settings: await getInvoiceSettings(db), salesTax: await salesTax(db) };
    } else if (action === "save-settings") {
      const settings = parseInvoiceSettings(body);
      result = await db.runTransaction(async tx => {
        const previous = await tx.get(settingsRef(db));
        if ((previous.get("revision") ?? "") !== (body.revision ?? "")) throw new InvoiceError(409, "settings_updated");
        const saved = { ...settings, revision: randomBytes(16).toString("hex") };
        tx.set(settingsRef(db), { ...saved, updatedBy: uid, updatedAt: Date.now() });
        return { settings: saved };
      });
    } else if (action === "list") {
      const rows = await db.collection("invoices").orderBy("createdAt", "desc").limit(300).get();
      result = { invoices: rows.docs.map(row => {
        const invoice = row.data() as InvoiceRecord;
        const { totals, overdue } = view(row.id, invoice);
        return { id: row.id, number: invoice.number, status: invoice.status, billTo: invoice.billTo.name, reference: invoice.reference,
          issueDate: invoice.issueDate, dueDate: invoice.dueDate, totalCents: totals.totalCents, balanceCents: totals.balanceCents,
          source: invoice.source, overdue, createdAt: invoice.createdAt };
      }) };
    } else if (action === "get") {
      const id = identifier(body.id);
      result = view(id, await readInvoice(db, id));
    } else if (action === "context") {
      result = await invoiceContext(db, body);
    } else if (action === "create") {
      const draft = parseInvoiceDraft((body.draft ?? {}) as Record<string, unknown>);
      const rawSource = (body.source ?? {}) as Record<string, unknown>;
      const source: InvoiceRecord["source"] = {
        kind: rawSource.kind === "appointment" || rawSource.kind === "client" ? rawSource.kind : "custom",
        appointmentId: rawSource.appointmentId ? identifier(rawSource.appointmentId) : null,
        clientId: rawSource.clientId ? identifier(rawSource.clientId) : null,
      };
      const requestId = identifier(body.requestId);
      const ref = invoiceRef(db, requestId);
      result = await db.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists) return view(ref.id, existing.data() as InvoiceRecord);
        const number = await nextNumber(db, tx, draft.issueDate);
        const now = Date.now();
        const invoice: InvoiceRecord = { ...draft, number, status: "open", source, payments: [], createdAt: now, createdBy: uid, updatedAt: now };
        tx.create(ref, invoice);
        return view(ref.id, invoice);
      });
    } else if (action === "update") {
      const id = identifier(body.id);
      const draft = parseInvoiceDraft((body.draft ?? {}) as Record<string, unknown>);
      result = await db.runTransaction(async tx => {
        const snapshot = await tx.get(invoiceRef(db, id));
        if (!snapshot.exists) throw new InvoiceError(404, "invoice_not_found");
        const invoice = snapshot.data() as InvoiceRecord;
        if (invoice.status === "void") throw new InvoiceError(409, "invoice_void");
        if (body.updatedAt !== invoice.updatedAt) throw new InvoiceError(409, "invoice_changed");
        const revised: InvoiceRecord = { ...invoice, ...draft, updatedAt: Date.now() };
        if (invoiceTotals(revised).paidCents > invoiceTotals(revised).amountDueCents) throw new InvoiceError(409, "payments_exceed_total");
        revised.status = statusAfterPayments(revised);
        revised.paidAt = revised.status === "paid" ? invoice.paidAt ?? Date.now() : null;
        tx.set(invoiceRef(db, id), revised);
        return view(id, revised);
      });
    } else if (["record-payment", "remove-payment", "void", "reopen"].includes(action)) {
      const id = identifier(body.id);
      result = await db.runTransaction(async tx => {
        const snapshot = await tx.get(invoiceRef(db, id));
        if (!snapshot.exists) throw new InvoiceError(404, "invoice_not_found");
        const invoice = snapshot.data() as InvoiceRecord;
        const now = Date.now();
        let revised: InvoiceRecord;
        if (action === "record-payment") {
          if (invoice.status === "void") throw new InvoiceError(409, "invoice_void");
          const requestId = identifier(body.requestId);
          if (invoice.payments.some(payment => payment.id === requestId)) return view(id, invoice);
          const method = text(body.method, 20);
          const amount = body.cents;
          const balance = invoiceTotals(invoice).balanceCents;
          if (!PAYMENT_METHODS.has(method) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > balance ||
            !validDate(body.date) || invoice.payments.length >= 50) throw new InvoiceError(400, "invalid_payment");
          const reference = text(body.reference, 60);
          if (method === "check" && !reference) throw new InvoiceError(400, "check_number_required");
          const payment: InvoicePayment = { id: requestId, method, reference, date: body.date, cents: amount, recordedAt: now, by: uid };
          revised = { ...invoice, payments: [...invoice.payments, payment] };
        } else if (action === "remove-payment") {
          if (!invoice.payments.some(payment => payment.id === body.paymentId)) throw new InvoiceError(409, "payment_unavailable");
          revised = { ...invoice, payments: invoice.payments.filter(payment => payment.id !== body.paymentId) };
        } else if (action === "void") {
          if (invoice.payments.length) throw new InvoiceError(409, "remove_payments_first");
          revised = { ...invoice, status: "void", voidedAt: now };
        } else {
          revised = { ...invoice, status: "open", voidedAt: null };
        }
        revised.status = statusAfterPayments(revised);
        revised.paidAt = revised.status === "paid" ? invoice.paidAt ?? now : null;
        revised.updatedAt = now;
        tx.set(invoiceRef(db, id), revised);
        return view(id, revised);
      });
    } else if (action === "pdf") {
      const id = identifier(body.id);
      const invoice = await readInvoice(db, id);
      const kind: PdfKind = body.kind === "receipt" ? "receipt" : "invoice";
      if (kind === "receipt" && !invoice.payments.length) throw new InvoiceError(409, "no_payments");
      const pdf = await invoicePdf(invoice, await getInvoiceSettings(db), kind);
      result = { filename: filename(invoice, kind), pdf: pdf.toString("base64") };
    } else if (action === "email") {
      result = await emailInvoice(db, uid, identifier(body.id), body);
    } else throw new InvoiceError(404, "not_found");
    res.json({ ok: true, result });
  } catch (error) {
    if (error instanceof InvoiceError) {
      const { status, code } = error;
      if (status >= 500) await recordOpsEvent(db, { source: "api", code, detail: `During invoice "${action}".` });
      res.status(status).json({ ok: false, error: code });
    } else {
      logger.error("Invoice operation failed", { action, message: error instanceof Error ? error.message : String(error) });
      await recordOpsEvent(db, { source: "api", code: "operation_failed", ref: `invoice-${action}`,
        detail: `invoice ${action}: ${error instanceof Error ? error.message : String(error)}` });
      res.status(500).json({ ok: false, error: "invoice_operation_failed" });
    }
  }
}
