"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleInvoices = handleInvoices;
// Owner-only invoice and receipt API at /api/invoices/<action>. Invoices live in their own collection, so they
// work for any client or one-off job, and work before online booking is switched on in production.
const node_crypto_1 = require("node:crypto");
const firebase_functions_1 = require("firebase-functions");
const invoice_model_1 = require("./invoice-model");
const invoice_pdf_1 = require("./invoice-pdf");
const appointment_email_1 = require("./appointment-email");
const ops_health_1 = require("./ops-health");
const appointment_items_1 = require("./appointment-items");
// A booking with several services starts its invoice with one line per service, when those add up to the amount owed.
function bookedLines(appointment) {
    if (!Array.isArray(appointment.items) || appointment.items.length < 2)
        return null;
    const lines = (0, appointment_items_1.itemInvoiceLines)(appointment.items);
    const owed = appointment.finalCents ?? appointment.estimateCents;
    if (typeof owed === "number" && lines.reduce((total, line) => total + line.cents, 0) !== owed)
        return null;
    return lines.map(line => ({ description: line.description, quantity: 1, unitCents: line.cents }));
}
const ID = /^[\w-]{1,128}$/;
const settingsRef = (db) => db.collection("invoiceSettings").doc("business");
const counterRef = (db) => db.collection("invoiceSettings").doc("counter");
const invoiceRef = (db, id) => db.collection("invoices").doc(id);
const VEHICLES = { sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "3-row SUV / full-size truck / van" };
const easternDay = (time) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
function identifier(value) {
    if (typeof value !== "string" || !ID.test(value))
        throw new invoice_model_1.InvoiceError(400, "invalid_identifier");
    return value;
}
async function ownerUid(db, auth, req) {
    const token = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
    if (!token)
        throw new invoice_model_1.InvoiceError(401, "sign_in_required");
    const identity = await auth.verifyIdToken(token).catch(() => null);
    if (!identity)
        throw new invoice_model_1.InvoiceError(401, "sign_in_required");
    const admin = await db.collection("adminUsers").doc(identity.uid).get();
    if (!admin.exists || admin.get("role") === "editor")
        throw new invoice_model_1.InvoiceError(403, "access_denied");
    return identity.uid;
}
async function getInvoiceSettings(db) {
    return { ...invoice_model_1.defaultInvoiceSettings, ...(await settingsRef(db).get()).data() };
}
async function salesTax(db) {
    const tax = (await db.collection("appointmentSettings").doc("salesTax").get()).data();
    return { enabled: !!tax?.enabled, rateBasisPoints: Number.isSafeInteger(tax?.rateBasisPoints) ? tax.rateBasisPoints : 700, taxId: tax?.taxId ?? "" };
}
function view(id, invoice) {
    return { id, ...invoice, totals: (0, invoice_model_1.invoiceTotals)(invoice), overdue: invoice.status === "open" && invoice.dueDate < easternDay(Date.now()) };
}
async function readInvoice(db, id) {
    const snapshot = await invoiceRef(db, id).get();
    if (!snapshot.exists)
        throw new invoice_model_1.InvoiceError(404, "invoice_not_found");
    return snapshot.data();
}
// Prefills a new invoice from an appointment or a client record. The owner reviews and edits before saving.
async function invoiceContext(db, body) {
    const settings = await getInvoiceSettings(db);
    const tax = await salesTax(db);
    const today = easternDay(Date.now());
    const draft = {
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
        if (!appointment)
            throw new invoice_model_1.InvoiceError(404, "record_not_found");
        clientId = clientId ?? (typeof appointment.clientId === "string" ? appointment.clientId : null);
        draft.source = { kind: "appointment", appointmentId, clientId };
        draft.billTo = { name: appointment.name ?? "", attention: "", address: String(appointment.address ?? "").split(/,\s*(?=[^,]+,\s*[A-Z]{2}\b)/).join("\n"),
            email: appointment.email ?? "", phone: appointment.phone ?? "" };
        draft.serviceDate = typeof appointment.start === "number" ? easternDay(appointment.start) : "";
        draft.serviceDetail = [[appointment.service, VEHICLES[appointment.vehicle] ?? appointment.vehicle].filter(Boolean).join(" · "), appointment.address].filter(Boolean).join("\n");
        const lines = Array.isArray(appointment.invoiceLines) && appointment.invoiceLines.length
            ? appointment.invoiceLines.map((line) => ({ description: line.description, quantity: 1, unitCents: line.cents }))
            : bookedLines(appointment) ?? [{ description: appointment.service || "Detailing service", quantity: 1, unitCents: appointment.finalCents ?? appointment.estimateCents ?? 0 }];
        draft.lines = lines;
        if (appointment.finalCents !== undefined)
            draft.taxRateBasisPoints = appointment.taxCents ? appointment.taxRateBasisPoints ?? tax.rateBasisPoints : 0;
        const deposit = appointment.refund?.state === "succeeded" ? 0 : appointment.paidDeposit ?? 0;
        const credits = [];
        if (deposit > 0)
            credits.push({ description: "Deposit paid", cents: deposit });
        const received = (appointment.payments ?? []).reduce((total, entry) => ["pending", "returned"].includes(entry.clearance ?? "") ? total : total + entry.amount, 0);
        if (received > 0)
            credits.push({ description: "Payments received", cents: received });
        draft.credits = credits;
    }
    if (clientId) {
        const client = (await db.collection("clients").doc(clientId).get()).data();
        if (!client && !body.appointmentId)
            throw new invoice_model_1.InvoiceError(404, "record_not_found");
        if (client) {
            if (!body.appointmentId)
                draft.source = { kind: "client", appointmentId: null, clientId };
            const cityLine = [client.city, [client.state, client.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
            const address = [client.address, cityLine].filter(Boolean).join("\n");
            draft.billTo = {
                name: client.company || client.business_name || draft.billTo.name || client.full_name || "",
                attention: client.company || client.business_name ? client.full_name ?? "" : draft.billTo.attention,
                address: address || draft.billTo.address, email: client.email || draft.billTo.email,
                phone: client.phone_e164 || client.phone || draft.billTo.phone,
            };
        }
    }
    return { draft, salesTax: tax };
}
async function nextNumber(db, tx, issueDate) {
    const year = issueDate.slice(0, 4);
    const counter = await tx.get(counterRef(db));
    const next = (Number(counter.get(year)) || 0) + 1;
    tx.set(counterRef(db), { [year]: next }, { merge: true });
    return `${year}-${String(next).padStart(4, "0")}`;
}
function statusAfterPayments(invoice) {
    if (invoice.status === "void")
        return "void";
    return (0, invoice_model_1.invoiceTotals)(invoice).balanceCents === 0 && invoice.payments.length ? "paid" : "open";
}
function filename(invoice, kind) {
    const name = invoice.billTo.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    return `Niemans-Detailing-${kind === "receipt" ? "Receipt" : "Invoice"}-${invoice.number}${name ? `-${name}` : ""}.pdf`;
}
async function emailInvoice(db, uid, id, body) {
    const invoice = await readInvoice(db, id);
    const kind = body.kind === "receipt" ? "receipt" : "invoice";
    if (invoice.status === "void")
        throw new invoice_model_1.InvoiceError(409, "invoice_void");
    if (kind === "receipt" && !invoice.payments.length)
        throw new invoice_model_1.InvoiceError(409, "no_payments");
    const to = text(body.to, 200).toLowerCase() || invoice.billTo.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))
        throw new invoice_model_1.InvoiceError(400, "invalid_email");
    const settings = await getInvoiceSettings(db);
    const totals = (0, invoice_model_1.invoiceTotals)(invoice);
    const money = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const message = text(body.message, 1000);
    const payable = settings.payableTo || settings.businessName;
    const subject = kind === "receipt" ? `Receipt for invoice ${invoice.number} from ${settings.businessName}` : `Invoice ${invoice.number} from ${settings.businessName}`;
    const details = kind === "receipt" ? [
        ["Invoice", invoice.number], ["Paid", money(totals.paidCents)],
        ...(totals.balanceCents ? [["Balance remaining", money(totals.balanceCents)]] : []),
    ] : [
        ["Invoice", invoice.number], ["Amount due", money(totals.balanceCents)], ["Due", (0, invoice_pdf_1.friendlyDate)(invoice.dueDate)],
        ...(invoice.reference ? [["PO / reference", invoice.reference]] : []),
        ...(settings.mailingAddress ? [["Mail checks to", [payable, ...settings.mailingAddress.split("\n")].join(", ")]] : []),
    ];
    const pdf = await (0, invoice_pdf_1.invoicePdf)(invoice, settings, kind);
    const sent = await (0, appointment_email_1.sendEmailNow)({
        to, subject, attachment: { filename: filename(invoice, kind), content: pdf },
        idempotencyKey: `invoice/${id}/${kind}/${body.requestId ? identifier(body.requestId) : (0, node_crypto_1.randomBytes)(8).toString("hex")}`,
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
            await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_failed", ref: id, detail: `Invoice ${invoice.number}: ${sent.error}` });
        }
        throw new invoice_model_1.InvoiceError(sent.error === "test_recipient_only" ? 409 : 502, sent.error.split(":")[0]);
    }
    const emails = [...(invoice.emails ?? []), { to, kind, at: Date.now() }].slice(-20);
    await invoiceRef(db, id).update({ emails, updatedAt: Date.now(), lastEmailedBy: uid });
    return view(id, { ...invoice, emails });
}
async function handleInvoices(db, auth, req, res, action) {
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }
    const body = req.body;
    if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) || req.rawBody.length > 65536) {
        res.status(400).json({ ok: false, error: "invalid_request" });
        return;
    }
    try {
        const uid = await ownerUid(db, auth, req);
        let result;
        if (action === "settings") {
            result = { settings: await getInvoiceSettings(db), salesTax: await salesTax(db) };
        }
        else if (action === "save-settings") {
            const settings = (0, invoice_model_1.parseInvoiceSettings)(body);
            result = await db.runTransaction(async (tx) => {
                const previous = await tx.get(settingsRef(db));
                if ((previous.get("revision") ?? "") !== (body.revision ?? ""))
                    throw new invoice_model_1.InvoiceError(409, "settings_updated");
                const saved = { ...settings, revision: (0, node_crypto_1.randomBytes)(16).toString("hex") };
                tx.set(settingsRef(db), { ...saved, updatedBy: uid, updatedAt: Date.now() });
                return { settings: saved };
            });
        }
        else if (action === "list") {
            const rows = await db.collection("invoices").orderBy("createdAt", "desc").limit(300).get();
            result = { invoices: rows.docs.map(row => {
                    const invoice = row.data();
                    const { totals, overdue } = view(row.id, invoice);
                    return { id: row.id, number: invoice.number, status: invoice.status, billTo: invoice.billTo.name, reference: invoice.reference,
                        issueDate: invoice.issueDate, dueDate: invoice.dueDate, totalCents: totals.totalCents, balanceCents: totals.balanceCents,
                        source: invoice.source, overdue, createdAt: invoice.createdAt };
                }) };
        }
        else if (action === "get") {
            const id = identifier(body.id);
            result = view(id, await readInvoice(db, id));
        }
        else if (action === "context") {
            result = await invoiceContext(db, body);
        }
        else if (action === "create") {
            const draft = (0, invoice_model_1.parseInvoiceDraft)((body.draft ?? {}));
            const rawSource = (body.source ?? {});
            const source = {
                kind: rawSource.kind === "appointment" || rawSource.kind === "client" ? rawSource.kind : "custom",
                appointmentId: rawSource.appointmentId ? identifier(rawSource.appointmentId) : null,
                clientId: rawSource.clientId ? identifier(rawSource.clientId) : null,
            };
            const requestId = identifier(body.requestId);
            const ref = invoiceRef(db, requestId);
            result = await db.runTransaction(async (tx) => {
                const existing = await tx.get(ref);
                if (existing.exists)
                    return view(ref.id, existing.data());
                const number = await nextNumber(db, tx, draft.issueDate);
                const now = Date.now();
                const invoice = { ...draft, number, status: "open", source, payments: [], createdAt: now, createdBy: uid, updatedAt: now };
                tx.create(ref, invoice);
                return view(ref.id, invoice);
            });
        }
        else if (action === "update") {
            const id = identifier(body.id);
            const draft = (0, invoice_model_1.parseInvoiceDraft)((body.draft ?? {}));
            result = await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(invoiceRef(db, id));
                if (!snapshot.exists)
                    throw new invoice_model_1.InvoiceError(404, "invoice_not_found");
                const invoice = snapshot.data();
                if (invoice.status === "void")
                    throw new invoice_model_1.InvoiceError(409, "invoice_void");
                if (body.updatedAt !== invoice.updatedAt)
                    throw new invoice_model_1.InvoiceError(409, "invoice_changed");
                const revised = { ...invoice, ...draft, updatedAt: Date.now() };
                if ((0, invoice_model_1.invoiceTotals)(revised).paidCents > (0, invoice_model_1.invoiceTotals)(revised).amountDueCents)
                    throw new invoice_model_1.InvoiceError(409, "payments_exceed_total");
                revised.status = statusAfterPayments(revised);
                revised.paidAt = revised.status === "paid" ? invoice.paidAt ?? Date.now() : null;
                tx.set(invoiceRef(db, id), revised);
                return view(id, revised);
            });
        }
        else if (["record-payment", "remove-payment", "void", "reopen"].includes(action)) {
            const id = identifier(body.id);
            result = await db.runTransaction(async (tx) => {
                const snapshot = await tx.get(invoiceRef(db, id));
                if (!snapshot.exists)
                    throw new invoice_model_1.InvoiceError(404, "invoice_not_found");
                const invoice = snapshot.data();
                const now = Date.now();
                let revised;
                if (action === "record-payment") {
                    if (invoice.status === "void")
                        throw new invoice_model_1.InvoiceError(409, "invoice_void");
                    const requestId = identifier(body.requestId);
                    if (invoice.payments.some(payment => payment.id === requestId))
                        return view(id, invoice);
                    const method = text(body.method, 20);
                    const amount = body.cents;
                    const balance = (0, invoice_model_1.invoiceTotals)(invoice).balanceCents;
                    if (!invoice_model_1.PAYMENT_METHODS.has(method) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 || amount > balance ||
                        !(0, invoice_model_1.validDate)(body.date) || invoice.payments.length >= 50)
                        throw new invoice_model_1.InvoiceError(400, "invalid_payment");
                    const reference = text(body.reference, 60);
                    if (method === "check" && !reference)
                        throw new invoice_model_1.InvoiceError(400, "check_number_required");
                    const payment = { id: requestId, method, reference, date: body.date, cents: amount, recordedAt: now, by: uid };
                    revised = { ...invoice, payments: [...invoice.payments, payment] };
                }
                else if (action === "remove-payment") {
                    if (!invoice.payments.some(payment => payment.id === body.paymentId))
                        throw new invoice_model_1.InvoiceError(409, "payment_unavailable");
                    revised = { ...invoice, payments: invoice.payments.filter(payment => payment.id !== body.paymentId) };
                }
                else if (action === "void") {
                    if (invoice.payments.length)
                        throw new invoice_model_1.InvoiceError(409, "remove_payments_first");
                    revised = { ...invoice, status: "void", voidedAt: now };
                }
                else {
                    revised = { ...invoice, status: "open", voidedAt: null };
                }
                revised.status = statusAfterPayments(revised);
                revised.paidAt = revised.status === "paid" ? invoice.paidAt ?? now : null;
                revised.updatedAt = now;
                tx.set(invoiceRef(db, id), revised);
                return view(id, revised);
            });
        }
        else if (action === "pdf") {
            const id = identifier(body.id);
            const invoice = await readInvoice(db, id);
            const kind = body.kind === "receipt" ? "receipt" : "invoice";
            if (kind === "receipt" && !invoice.payments.length)
                throw new invoice_model_1.InvoiceError(409, "no_payments");
            const pdf = await (0, invoice_pdf_1.invoicePdf)(invoice, await getInvoiceSettings(db), kind);
            result = { filename: filename(invoice, kind), pdf: pdf.toString("base64") };
        }
        else if (action === "email") {
            result = await emailInvoice(db, uid, identifier(body.id), body);
        }
        else
            throw new invoice_model_1.InvoiceError(404, "not_found");
        res.json({ ok: true, result });
    }
    catch (error) {
        if (error instanceof invoice_model_1.InvoiceError) {
            const { status, code } = error;
            if (status >= 500)
                await (0, ops_health_1.recordOpsEvent)(db, { source: "api", code, detail: `During invoice "${action}".` });
            res.status(status).json({ ok: false, error: code });
        }
        else {
            firebase_functions_1.logger.error("Invoice operation failed", { action, message: error instanceof Error ? error.message : String(error) });
            await (0, ops_health_1.recordOpsEvent)(db, { source: "api", code: "operation_failed", ref: `invoice-${action}`,
                detail: `invoice ${action}: ${error instanceof Error ? error.message : String(error)}` });
            res.status(500).json({ ok: false, error: "invoice_operation_failed" });
        }
    }
}
