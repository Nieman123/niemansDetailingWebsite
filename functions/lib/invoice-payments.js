"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TIP_CENTS = void 0;
exports.invoiceSettings = invoiceSettings;
exports.payOrigin = payOrigin;
exports.onlinePaymentsReady = onlinePaymentsReady;
exports.mintPayLink = mintPayLink;
exports.applyInvoiceSession = applyInvoiceSession;
exports.handleInvoicePay = handleInvoicePay;
exports.reconcileInvoiceCheckouts = reconcileInvoiceCheckouts;
exports.sendInvoiceReminders = sendInvoiceReminders;
exports.nextReminder = nextReminder;
// Customer side of invoices: the /pay page (reached by a short /i/<code> link), online card payment through
// Stripe Checkout with an optional tip, and the automatic reminder emails for unpaid invoices.
// Pay links are minted per email and only their hashes are stored on the invoice.
const node_crypto_1 = require("node:crypto");
const firebase_functions_1 = require("firebase-functions");
const invoice_model_1 = require("./invoice-model");
const invoice_pdf_1 = require("./invoice-pdf");
const appointment_email_1 = require("./appointment-email");
const appointment_short_links_1 = require("./appointment-short-links");
const appointment_clients_1 = require("./appointment-clients");
const appointment_stripe_1 = require("./appointment-stripe");
const appointment_secrets_1 = require("./appointment-secrets");
const ops_health_1 = require("./ops-health");
const telegram_1 = require("./telegram");
const ID = /^[\w-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MINUTE = 60000;
const DAY = 86400000;
// Stripe keeps a session open at least 30 minutes.
const CHECKOUT_WINDOW = 35 * MINUTE;
// A pay link keeps working this long, so an old email still opens the invoice and shows that it's paid.
const PAY_LINK_LIFE = 365 * DAY;
exports.MAX_TIP_CENTS = 100000;
const digest = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
const easternDay = (time) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
const money = (cents) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const invoiceRef = (db, id) => db.collection("invoices").doc(id);
async function invoiceSettings(db) {
    return { ...invoice_model_1.defaultInvoiceSettings, ...(await db.collection("invoiceSettings").doc("business").get()).data() };
}
// The site origin customer links point at. Same rule as appointment checkout: production only on live mode,
// staging and the emulators only on <project>.web.app. Null when it isn't set up.
function payOrigin() {
    const origin = process.env.HOSTING_ORIGIN ?? "";
    const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
    const ok = (0, appointment_secrets_1.liveMode)() ? /^https:\/\/[a-z0-9.-]+$/.test(origin) : !!project && origin === `https://${project}.web.app`;
    return ok ? origin : null;
}
// Whether a customer can pay this invoice by card right now.
async function onlinePaymentsReady(settings) {
    return settings.onlinePayments && !!payOrigin() && !!(await (0, appointment_stripe_1.stripeConfig)().catch(() => null));
}
// Mints a short /i/<code> link for the invoice inside the caller's transaction. Returns the url and the new
// payLinks list, which the caller writes with the rest of its update.
function mintPayLink(db, tx, id, invoice, now = Date.now()) {
    const origin = payOrigin();
    if (!origin)
        return null;
    const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
    const code = (0, appointment_short_links_1.createShortLink)(db, tx, "invoice", id, token);
    const payLinks = [...(invoice.payLinks ?? []).filter(link => link.at + PAY_LINK_LIFE > now), { hash: digest(token), at: now }].slice(-12);
    return { url: origin + (0, appointment_short_links_1.shortLinkPath)("invoice", code), payLinks };
}
function assertPayLink(token, invoice) {
    if (typeof token !== "string" || !HASH.test(token))
        throw new invoice_model_1.InvoiceError(404, "link_unavailable");
    const hash = Buffer.from(digest(token), "hex");
    const now = Date.now();
    if (!invoice || !(invoice.payLinks ?? []).some(link => HASH.test(link.hash) && link.at + PAY_LINK_LIFE > now &&
        (0, node_crypto_1.timingSafeEqual)(Buffer.from(link.hash, "hex"), hash)))
        throw new invoice_model_1.InvoiceError(404, "link_unavailable");
}
async function readLinked(db, id, token) {
    if (typeof id !== "string" || !ID.test(id))
        throw new invoice_model_1.InvoiceError(404, "link_unavailable");
    const invoice = (await invoiceRef(db, id).get()).data();
    assertPayLink(token, invoice);
    return { id, invoice };
}
const methodLabel = (method) => ({ check: "Check", cash: "Cash", ach: "Bank transfer", card: "Card", stripe: "Paid online", other: "Payment" }[method] ?? "Payment");
function openCheckout(invoice, now = Date.now()) {
    return !!invoice.checkout && invoice.checkout.expiresAt > now;
}
// What the customer sees. Never includes owner fields like who recorded a payment or other pay links.
async function customerView(invoice, settings) {
    const totals = (0, invoice_model_1.invoiceTotals)(invoice);
    const payable = invoice.status === "open" && totals.balanceCents >= 50;
    return {
        number: invoice.number, status: invoice.status, billTo: invoice.billTo.name, reference: invoice.reference,
        issueDate: invoice.issueDate, dueDate: invoice.dueDate, serviceDate: invoice.serviceDate,
        overdue: invoice.status === "open" && invoice.dueDate < easternDay(Date.now()),
        lines: invoice.lines.map((line, index) => ({ description: line.description, quantity: line.quantity, unitCents: line.unitCents, cents: totals.lineCents[index] })),
        taxRateBasisPoints: invoice.taxRateBasisPoints, credits: invoice.credits,
        payments: invoice.payments.map(payment => ({ label: methodLabel(payment.method), date: payment.date, cents: payment.cents, tipCents: payment.tipCents ?? 0 })),
        totals: { subtotalCents: totals.subtotalCents, taxCents: totals.taxCents, totalCents: totals.totalCents, creditCents: totals.creditCents,
            paidCents: totals.paidCents, balanceCents: totals.balanceCents },
        business: { name: settings.businessName, phone: settings.phone, email: settings.email },
        payOnline: payable && await onlinePaymentsReady(settings),
        tips: settings.invoiceTips, maxTipCents: Math.min(exports.MAX_TIP_CENTS, totals.balanceCents),
        checkoutOpen: openCheckout(invoice),
    };
}
// Brings a session's outcome onto the invoice. Called from the webhook, the pay page and the reconcile job,
// and safe to run more than once: a paid session is recorded once, keyed by its session ID.
async function applyInvoiceSession(db, session) {
    const id = session.metadata?.invoiceId;
    if (!id || !ID.test(id) || session.livemode !== (0, appointment_secrets_1.liveMode)() || !(0, appointment_stripe_1.isSessionId)(session.id) || session.metadata.kind !== "invoice")
        return;
    const ref = invoiceRef(db, id);
    const now = Date.now();
    const outcome = await db.runTransaction(async (tx) => {
        const invoice = (await tx.get(ref)).data();
        if (!invoice)
            return null;
        const ours = invoice.checkout?.attempt === session.metadata.attemptId;
        if (session.status === "expired") {
            if (ours)
                tx.update(ref, { checkout: null, checkoutReconcileAt: null });
            return null;
        }
        if (session.status !== "complete" || session.payment_status !== "paid" || !session.payment_intent || !/^pi_\w+$/.test(session.payment_intent))
            return null;
        if (invoice.payments.some(payment => payment.id === session.id))
            return null;
        const amount = Number(session.metadata.amountCents);
        const tipCents = Number(session.metadata.tipCents ?? 0);
        if (session.currency !== "usd" || !Number.isSafeInteger(amount) || !Number.isSafeInteger(tipCents) || amount <= 0 || tipCents < 0 ||
            amount + tipCents !== session.amount_total)
            throw new Error("stripe_amount_mismatch");
        // The email typed at Checkout fills in a missing bill-to email and the client's email. Reads come before writes.
        const paidEmail = (0, appointment_clients_1.clientEmail)(session.customer_details?.email);
        const client = paidEmail && invoice.source?.clientId ? await (0, appointment_clients_1.findClientForJob)(db, tx, invoice.source.clientId, "", "") : null;
        const before = (0, invoice_model_1.invoiceTotals)(invoice);
        const payment = {
            id: session.id, method: "stripe", reference: "", date: easternDay(now), cents: amount, recordedAt: now, by: "stripe",
            ...(tipCents ? { tipCents } : {}), stripe: { session: session.id, intent: session.payment_intent },
        };
        const revised = { ...invoice, payments: [...invoice.payments, payment] };
        const totals = (0, invoice_model_1.invoiceTotals)(revised);
        if (revised.status !== "void")
            revised.status = totals.balanceCents === 0 ? "paid" : "open";
        revised.paidAt = revised.status === "paid" ? invoice.paidAt ?? now : null;
        if (ours) {
            revised.checkout = null;
            revised.checkoutReconcileAt = null;
        }
        revised.updatedAt = now;
        if (paidEmail && !revised.billTo.email)
            revised.billTo = { ...revised.billTo, email: paidEmail };
        tx.set(ref, revised);
        (0, appointment_clients_1.saveCustomerEmail)(tx, client, paidEmail, "payment", now);
        return { invoice: revised, amount, tipCents, overpaid: amount > before.balanceCents, voided: invoice.status === "void" };
    });
    if (!outcome)
        return;
    const { invoice, amount, tipCents } = outcome;
    if (outcome.overpaid || outcome.voided) {
        await (0, ops_health_1.recordOpsEvent)(db, { source: "payments", code: outcome.voided ? "invoice_paid_after_void" : "invoice_overpaid", ref: id,
            detail: `Invoice ${invoice.number} took ${money(amount)} online${outcome.voided ? " after it was voided" : ", more than its balance"}. Check Stripe and refund if needed.` });
    }
    if ((0, telegram_1.telegramConfigured)()) {
        await (0, telegram_1.sendTelegramMessage)(`💳 Invoice ${invoice.number} (${invoice.billTo.name}) paid online: ${money(amount)}${tipCents ? ` + ${money(tipCents)} tip` : ""}.` +
            (invoice.status === "paid" ? " Paid in full." : ` ${money((0, invoice_model_1.invoiceTotals)(invoice).balanceCents)} still due.`)).catch(() => undefined);
    }
    if (invoice.billTo.email)
        await sendReceipt(db, id, invoice, session.id, amount, tipCents);
}
async function sendReceipt(db, id, invoice, sessionId, amount, tipCents) {
    const settings = await invoiceSettings(db);
    const totals = (0, invoice_model_1.invoiceTotals)(invoice);
    const pdf = await (0, invoice_pdf_1.invoicePdf)(invoice, settings, "receipt");
    const name = invoice.billTo.name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const sent = await (0, appointment_email_1.sendEmailNow)({
        to: invoice.billTo.email, subject: `Receipt for invoice ${invoice.number} from ${settings.businessName}`,
        idempotencyKey: `invoice/${id}/receipt/${sessionId}`,
        attachment: { filename: `Niemans-Detailing-Receipt-${invoice.number}${name ? `-${name}` : ""}.pdf`, content: pdf },
        content: {
            eyebrow: "Payment received", heading: "Thank you, your payment is in.",
            paragraphs: [`I received your online payment for invoice ${invoice.number}.${tipCents ? " Thank you so much for the tip!" : ""} Your receipt is attached as a PDF.`],
            details: [["Invoice", invoice.number], ["Paid", money(amount)], ...(tipCents ? [["Tip", money(tipCents)]] : []),
                ...(totals.balanceCents ? [["Balance remaining", money(totals.balanceCents)]] : [])],
        },
    });
    if (sent.ok) {
        const emails = [...(invoice.emails ?? []), { to: invoice.billTo.email, kind: "receipt", at: Date.now() }].slice(-20);
        await invoiceRef(db, id).update({ emails }).catch(() => undefined);
    }
    else if (sent.error !== "email_not_configured" && sent.error !== "test_recipient_only") {
        await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_failed", ref: id, detail: `Receipt for invoice ${invoice.number}: ${sent.error}` });
    }
}
async function startCheckout(db, idValue, token, tipValue) {
    const config = await (0, appointment_stripe_1.stripeConfig)();
    const origin = payOrigin();
    if (!config || !origin)
        throw new invoice_model_1.InvoiceError(503, "stripe_unavailable");
    const settings = await invoiceSettings(db);
    if (!settings.onlinePayments)
        throw new invoice_model_1.InvoiceError(409, "online_payments_off");
    const { id, invoice: current } = await readLinked(db, idValue, token);
    const tipCents = tipValue ?? 0;
    if (typeof tipCents !== "number" || !Number.isSafeInteger(tipCents) || tipCents < 0 || tipCents > exports.MAX_TIP_CENTS ||
        (tipCents > 0 && !settings.invoiceTips))
        throw new invoice_model_1.InvoiceError(400, "invalid_tip");
    // Settle or end a session that is already open, unless it is the same payment the customer is asking for again.
    if (current.checkout?.id) {
        let session = await (0, appointment_stripe_1.stripeSession)(config, current.checkout.id);
        const same = current.checkout.tipCents === tipCents && current.checkout.amount === (0, invoice_model_1.invoiceTotals)(current).balanceCents;
        if (session.status === "open" && same && session.url && current.checkout.expiresAt - Date.now() > 5 * MINUTE)
            return { url: session.url };
        if (session.status === "open")
            session = await (0, appointment_stripe_1.releaseStripeSession)(config, current.checkout.id);
        await applyInvoiceSession(db, session);
        if (session.status === "complete")
            throw new invoice_model_1.InvoiceError(409, "checkout_finished");
    }
    const ref = invoiceRef(db, id);
    const reservation = await db.runTransaction(async (tx) => {
        const invoice = (await tx.get(ref)).data();
        assertPayLink(token, invoice);
        const now = Date.now();
        if (invoice.status !== "open")
            throw new invoice_model_1.InvoiceError(409, invoice.status === "paid" ? "already_paid" : "invoice_void");
        const amount = (0, invoice_model_1.invoiceTotals)(invoice).balanceCents;
        if (amount < 50)
            throw new invoice_model_1.InvoiceError(409, "nothing_due");
        if (tipCents > amount)
            throw new invoice_model_1.InvoiceError(400, "invalid_tip");
        // A reservation whose session ID wasn't saved yet: reuse it, and Stripe's idempotency returns the same session.
        if (invoice.checkout && !invoice.checkout.id && invoice.checkout.expiresAt > now + 5 * MINUTE) {
            if (invoice.checkout.amount !== amount || invoice.checkout.tipCents !== tipCents)
                throw new invoice_model_1.InvoiceError(409, "checkout_active");
            return invoice.checkout;
        }
        const checkout = { attempt: (0, node_crypto_1.randomBytes)(16).toString("hex"), amount, tipCents, expiresAt: now + CHECKOUT_WINDOW };
        tx.update(ref, { checkout, checkoutReconcileAt: checkout.expiresAt + MINUTE });
        return checkout;
    });
    const session = await (0, appointment_stripe_1.createInvoiceSession)(config, {
        invoiceId: id, attempt: reservation.attempt, origin, number: current.number, amount: reservation.amount, tipCents: reservation.tipCents,
        expiresAt: reservation.expiresAt, email: current.billTo.email || undefined,
    });
    if (session.livemode !== (0, appointment_secrets_1.liveMode)() || session.metadata?.invoiceId !== id || session.metadata.attemptId !== reservation.attempt ||
        session.amount_total !== reservation.amount + reservation.tipCents || session.currency !== "usd")
        throw new Error("stripe_checkout_mismatch");
    await db.runTransaction(async (tx) => {
        const latest = (await tx.get(ref)).data();
        if (latest?.checkout?.attempt === reservation.attempt)
            tx.update(ref, { checkout: { ...reservation, id: session.id } });
    });
    if (session.status !== "open" || !session.url || new URL(session.url).origin !== "https://checkout.stripe.com") {
        await applyInvoiceSession(db, session);
        throw new invoice_model_1.InvoiceError(409, "checkout_finished");
    }
    return { url: session.url };
}
// Public pay-page API at /api/pay/<action>. Every action needs the invoice ID and a pay-link token.
async function handleInvoicePay(db, req, res, action) {
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }
    const body = req.body;
    if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) || req.rawBody.length > 4096) {
        res.status(400).json({ ok: false, error: "invalid_request" });
        return;
    }
    try {
        let result;
        if (action === "resolve") {
            result = await (0, appointment_short_links_1.resolveShortLink)(db, body.code, "invoice");
            if (!result)
                throw new invoice_model_1.InvoiceError(404, "link_unavailable");
        }
        else if (action === "details") {
            let { id, invoice } = await readLinked(db, body.id, body.token);
            // Coming back from Stripe: settle the session now instead of waiting for the webhook.
            if (invoice.checkout?.id) {
                const config = await (0, appointment_stripe_1.stripeConfig)().catch(() => null);
                if (config) {
                    await applyInvoiceSession(db, await (0, appointment_stripe_1.stripeSession)(config, invoice.checkout.id)).catch(error => firebase_functions_1.logger.warn("Invoice checkout check failed", { id, message: error instanceof Error ? error.message : String(error) }));
                    invoice = (await invoiceRef(db, id).get()).data();
                }
            }
            result = await customerView(invoice, await invoiceSettings(db));
        }
        else if (action === "pdf") {
            const { invoice } = await readLinked(db, body.id, body.token);
            const kind = body.kind === "receipt" && invoice.payments.length ? "receipt" : "invoice";
            const pdf = await (0, invoice_pdf_1.invoicePdf)(invoice, await invoiceSettings(db), kind);
            result = { filename: `Niemans-Detailing-${kind === "receipt" ? "Receipt" : "Invoice"}-${invoice.number}.pdf`, pdf: pdf.toString("base64") };
        }
        else if (action === "checkout") {
            result = await startCheckout(db, body.id, body.token, body.tipCents);
        }
        else
            throw new invoice_model_1.InvoiceError(404, "not_found");
        res.json({ ok: true, result });
    }
    catch (error) {
        if (error instanceof invoice_model_1.InvoiceError) {
            if (error.status >= 500)
                await (0, ops_health_1.recordOpsEvent)(db, { source: "payments", code: error.code, detail: `During invoice pay "${action}".` });
            res.status(error.status).json({ ok: false, error: error.code });
        }
        else {
            firebase_functions_1.logger.error("Invoice pay operation failed", { action, message: error instanceof Error ? error.message : String(error) });
            await (0, ops_health_1.recordOpsEvent)(db, { source: "payments", code: "invoice_pay_failed", detail: `invoice pay ${action}: ${error instanceof Error ? error.message : String(error)}` });
            res.status(500).json({ ok: false, error: "pay_operation_failed" });
        }
    }
}
// Settles invoice checkouts the customer abandoned or whose webhook never arrived. Runs from the 5-minute job.
async function reconcileInvoiceCheckouts(db, now = Date.now()) {
    const due = await db.collection("invoices").where("checkoutReconcileAt", "<=", now).where("checkoutReconcileAt", ">", 0)
        .orderBy("checkoutReconcileAt").limit(10).get();
    if (due.empty)
        return;
    const config = await (0, appointment_stripe_1.stripeConfig)();
    for (const doc of due.docs) {
        const checkout = doc.data().checkout;
        try {
            if (checkout?.id && config) {
                const session = await (0, appointment_stripe_1.stripeSession)(config, checkout.id);
                await applyInvoiceSession(db, session.status === "open" ? await (0, appointment_stripe_1.releaseStripeSession)(config, checkout.id) : session);
            }
            // Anything still parked here never got a session, or the session is gone. A late payment is still recorded
            // from the webhook, because applyInvoiceSession reads the amounts from the session itself.
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(doc.ref)).data();
                if (latest?.checkout?.attempt === checkout?.attempt)
                    tx.update(doc.ref, { checkout: null, checkoutReconcileAt: null });
            });
        }
        catch (error) {
            await (0, ops_health_1.recordOpsEvent)(db, { source: "payments", code: "reconcile_failed", ref: doc.id, detail: error instanceof Error ? error.message : String(error) });
            await doc.ref.update({ checkoutReconcileAt: now + 10 * MINUTE }).catch(() => undefined);
        }
    }
}
// Daily reminder emails for unpaid invoices, following reminderStep. Each one carries a fresh pay link and the PDF.
async function sendInvoiceReminders(db, now = Date.now()) {
    const settings = await invoiceSettings(db);
    if (!settings.autoReminders)
        return { sent: 0 };
    const online = await onlinePaymentsReady(settings);
    const today = easternDay(now);
    const rows = await db.collection("invoices").where("status", "==", "open").limit(300).get();
    let sent = 0;
    for (const row of rows.docs) {
        const invoice = row.data();
        const balance = (0, invoice_model_1.invoiceTotals)(invoice).balanceCents;
        const step = (0, invoice_model_1.reminderStep)(invoice, today);
        const last = Math.max(0, ...(invoice.reminders ?? []).map(entry => entry.at));
        if (!step || invoice.remindersPaused || !invoice.billTo.email || balance < 100 || openCheckout(invoice, now) || now - last < 3 * DAY)
            continue;
        try {
            const url = online ? await db.runTransaction(async (tx) => {
                const latest = (await tx.get(row.ref)).data();
                const link = mintPayLink(db, tx, row.id, latest, now);
                if (link)
                    tx.update(row.ref, { payLinks: link.payLinks });
                return link?.url ?? null;
            }) : null;
            const daysLate = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${invoice.dueDate}T12:00:00Z`)) / DAY));
            const payable = settings.payableTo || settings.businessName;
            const subject = step.overdue ? `Past due: invoice ${invoice.number} from ${settings.businessName}` : `Reminder: invoice ${invoice.number} is due ${(0, invoice_pdf_1.friendlyDate)(invoice.dueDate)}`;
            const how = [url ? "You can pay securely online by card with the button below." : "",
                settings.mailingAddress ? `Checks can be made payable to ${payable} with ${invoice.number} on the memo line.` : ""].filter(Boolean).join(" ");
            const pdf = await (0, invoice_pdf_1.invoicePdf)(invoice, settings, "invoice", url ?? undefined);
            const result = await (0, appointment_email_1.sendEmailNow)({
                to: invoice.billTo.email, subject, idempotencyKey: `invoice/${row.id}/reminder/${step.key}`,
                attachment: { filename: `Niemans-Detailing-Invoice-${invoice.number}.pdf`, content: pdf },
                content: {
                    eyebrow: step.overdue ? "Payment reminder" : "Friendly reminder",
                    heading: step.overdue ? `Invoice ${invoice.number} is past due` : `Invoice ${invoice.number} is due soon`,
                    paragraphs: [step.overdue
                            ? `This is a friendly reminder that invoice ${invoice.number} was due on ${(0, invoice_pdf_1.friendlyDate)(invoice.dueDate)}${daysLate > 1 ? `, ${daysLate} days ago` : ""}, and ${money(balance)} is still open.`
                            : `Just a heads-up that invoice ${invoice.number} for ${money(balance)} is due on ${(0, invoice_pdf_1.friendlyDate)(invoice.dueDate)}.`,
                        ...(how ? [how] : []),
                        "If you've already sent payment, thank you, and please disregard this note. A copy of the invoice is attached."],
                    details: [["Invoice", invoice.number], ["Amount due", money(balance)], ["Due", (0, invoice_pdf_1.friendlyDate)(invoice.dueDate)],
                        ...(invoice.reference ? [["PO / reference", invoice.reference]] : [])],
                    ...(url ? { action: { label: `Pay ${money(balance)} online`, url } } : {}),
                },
            });
            if (!result.ok) {
                if (result.error !== "email_not_configured" && result.error !== "test_recipient_only") {
                    await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_failed", ref: row.id, detail: `Reminder for invoice ${invoice.number}: ${result.error}` });
                }
                continue;
            }
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(row.ref)).data();
                const reminders = [...(latest.reminders ?? []), { key: step.key, at: now, to: invoice.billTo.email }].slice(-20);
                const emails = [...(latest.emails ?? []), { to: invoice.billTo.email, kind: "reminder", at: now }].slice(-20);
                tx.update(row.ref, { reminders, emails });
            });
            sent++;
        }
        catch (error) {
            await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "invoice_reminder_failed", ref: row.id, detail: error instanceof Error ? error.message : String(error) });
        }
    }
    return { sent };
}
// The next automatic reminder for the admin page, as a date and a label, or null when none is coming.
function nextReminder(invoice, settings, today = easternDay(Date.now())) {
    if (!settings.autoReminders || invoice.status !== "open" || invoice.remindersPaused || !invoice.billTo.email)
        return null;
    for (let day = 0; day <= 45; day++) {
        const date = (0, invoice_model_1.addDays)(today, day);
        const step = (0, invoice_model_1.reminderStep)(invoice, date);
        if (step)
            return { date, overdue: step.overdue };
    }
    return null;
}
