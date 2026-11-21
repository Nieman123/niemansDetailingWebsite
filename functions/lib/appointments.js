"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.depositWaived = depositWaived;
exports.applyStripeSession = applyStripeSession;
exports.reconcileAppointments = reconcileAppointments;
exports.handleAppointments = handleAppointments;
exports.handleStripeWebhook = handleStripeWebhook;
const node_crypto_1 = require("node:crypto");
const firebase_functions_1 = require("firebase-functions");
const appointment_email_1 = require("./appointment-email");
const appointment_secrets_1 = require("./appointment-secrets");
const appointment_email_template_1 = require("./appointment-email-template");
const appointment_content_1 = require("./appointment-content");
const appointment_calendar_1 = require("./appointment-calendar");
const appointment_booking_1 = require("./appointment-booking");
const appointment_stripe_1 = require("./appointment-stripe");
const appointment_tax_1 = require("./appointment-tax");
const DAY = 86400000;
const DEPOSIT_CENTS = 5000;
const ID = /^[\w-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MINUTE = 60000;
// Stripe requires a session to stay open at least 30 minutes, so the app ends it itself after the hold.
const CHECKOUT_WINDOW = 35 * MINUTE;
const CHECKOUT_HOLD = 10 * MINUTE;
const POLICY_VERSION = "deposit-v1";
const DEPOSIT_POLICY = "The $50 deposit applies toward service. Before approval, you can cancel for a full refund. After confirmation, cancel at least 96 hours before the appointment for a refund. Inside 96 hours or for a no-show, the deposit is nonrefundable. An approved reschedule carries your deposit forward without resetting a forfeiture that already applies. If we cancel, you may request a refund or agree to another time.";
const MANUAL_METHODS = new Set(["cash", "check", "venmo", "cash_app", "other"]);
const calendarUpdate = (now) => ({ calendarDueAt: now, calendarRevision: (0, node_crypto_1.randomBytes)(8).toString("hex") });
const reservationFor = (id, appointment) => ({
    id, start: appointment.start - (appointment.bufferMinutes ?? 0) * MINUTE,
    end: appointment.end + (appointment.bufferMinutes ?? 0) * MINUTE,
});
class AppointmentError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
const digest = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
function identifier(value, optional = false) {
    if (optional && (value == null || value === ""))
        return null;
    if (typeof value !== "string" || !ID.test(value))
        throw new AppointmentError(400, "invalid_identifier");
    return value;
}
function appointmentContact(body, requirePhone) {
    const name = text(body.name, 150);
    const address = text(body.address, 400);
    const email = text(body.email, 250);
    const digits = text(body.phone, 48).replace(/\D/g, "");
    if (!name || (requirePhone || !email || text(body.phone, 48)) && !/^1?\d{10}$/.test(digits) ||
        email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new AppointmentError(400, "invalid_details");
    return { name, email, address, phone: digits ? "+1" + digits.slice(-10) : "", vehicle: text(body.vehicle, 150) };
}
function buildAppointment(body, uid, now, requirePhone = false) {
    const start = body.start;
    const minutes = body.durationMinutes;
    if (typeof start !== "number" || !Number.isSafeInteger(start) || start % 60000 !== 0 || start <= now || start > now + 2 * 366 * DAY ||
        typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 1440) {
        throw new AppointmentError(400, "invalid_time");
    }
    const estimate = body.estimateCents ?? null;
    if (estimate !== null && (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0 || estimate > 10000000)) {
        throw new AppointmentError(400, "invalid_price");
    }
    const contact = appointmentContact(body, requirePhone);
    const service = text(body.service, 150) || "Detailing appointment";
    if (body.deposit !== "required" && body.deposit !== "waived")
        throw new AppointmentError(400, "invalid_deposit");
    const waived = body.deposit === "waived";
    return {
        clientId: identifier(body.clientId, true), leadId: identifier(body.leadId, true),
        ...contact, service, preparation: text(body.preparation, 1500),
        start, end: start + minutes * 60000, estimateCents: estimate,
        depositCents: waived ? 0 : DEPOSIT_CENTS, status: waived ? "confirmed" : "draft",
        createdAt: now, createdBy: uid,
    };
}
function reservationDays(db, { start, end }) {
    const refs = [];
    for (let day = Math.floor(start / DAY); day <= Math.floor((end - 1) / DAY); day++) {
        refs.push(db.collection("appointmentDays").doc(String(day)));
    }
    return refs;
}
async function updateReservation(db, tx, reservation, remove, now, before) {
    // Read fixed UTC-day documents, including missing ones, so concurrent bookings serialize.
    const next = reservationDays(db, reservation);
    const newPaths = new Set(next.map(ref => ref.path));
    const oldOnly = before ? reservationDays(db, before).filter(ref => !newPaths.has(ref.path)) : [];
    const days = await tx.getAll(...next, ...oldOnly);
    const activeByDay = days.map(day => (day.get("slots") ?? [])
        .filter(slot => slot.end > now && slot.id !== reservation.id));
    if (!remove && activeByDay.some(slots => slots.some(slot => slot.start < reservation.end && slot.end > reservation.start))) {
        throw new AppointmentError(409, "time_unavailable");
    }
    days.forEach((day, index) => tx.set(day.ref, { slots: remove || !newPaths.has(day.ref.path) ? activeByDay[index] : [...activeByDay[index], reservation] }));
}
async function assertCalendarOpen(appointment, except) {
    try {
        const config = await (0, appointment_calendar_1.calendarConfig)();
        if (!config) {
            if (process.env.FUNCTIONS_EMULATOR === "true")
                return;
            throw new AppointmentError(503, "calendar_unavailable");
        }
        const slot = reservationFor("", appointment);
        if ((await (0, appointment_calendar_1.busyWindows)(config, slot.start, slot.end, except)).some(busy => busy.start < slot.end && busy.end > slot.start)) {
            throw new AppointmentError(409, "time_unavailable");
        }
    }
    catch (error) {
        if (error instanceof AppointmentError)
            throw error;
        throw new AppointmentError(503, "calendar_unavailable");
    }
}
function customerDetails(appointment) {
    const { service, vehicle, address, preparation, start, end, estimateCents, depositCents, status } = appointment;
    const paidDeposit = appointment.refund?.state === "succeeded" ? 0 : appointment.paidDeposit ?? 0;
    return { service, vehicle, address, preparation, start, end, estimateCents, depositCents, status, paidDeposit, hasEmail: !!appointment.email,
        refundState: appointment.refund?.state ?? null,
        paymentPending: hasPendingCheck(appointment),
        finalCents: appointment.finalCents ?? null, balanceCents: remainingBalance(appointment),
        ...taxDetails(appointment),
        invoiceLines: appointment.invoiceLines ?? [],
        depositDeadline: appointment.depositDeadline ?? null, preapproved: !!appointment.preapproved,
        depositPolicy: appointment.acceptedPolicy ?? DEPOSIT_POLICY,
        calendarSequence: appointment.calendarSequence ?? 0,
        hasRescheduleRequest: !!appointment.rescheduleRequest,
        paymentUnderReview: !!appointment.paymentReview,
        alternateOffer: appointment.alternateOffer && appointment.alternateOffer.expiresAt > Date.now() ? appointment.alternateOffer : null,
        depositRefundable: (appointment.paidDeposit ?? 0) > 0 && (appointment.status === "pending_approval" ||
            (appointment.status === "confirmed" && !depositLock(appointment, Date.now()))),
    };
}
function adminDetails(id, appointment) {
    const { name, email, phone, clientId, leadId, createdAt } = appointment;
    return { ...customerDetails(appointment), id, name, email, phone, clientId, leadId, createdAt,
        workNotes: appointment.workNotes ?? "", scopeChanges: appointment.scopeChanges ?? "", payments: appointment.payments ?? [],
        rescheduleRequest: appointment.rescheduleRequest ?? null, checkoutActive: !!appointment.checkout,
        calendarFailed: !!appointment.calendarFailure, calendarPending: !!appointment.calendarDueAt,
        maintenanceEligible: !!maintenanceDeadline(appointment) && !appointment.maintenanceEnrolledAt,
        maintenanceEnrolled: !!appointment.maintenanceEnrolledAt,
        maintenanceInviteQueued: !!appointment.maintenanceInviteAfterPayment && !!appointment.maintenanceInvite,
        paymentReview: appointment.paymentReview ?? null,
        startedAt: appointment.startedAt ?? null, invoiceLines: appointment.invoiceLines ?? [],
    };
}
// Money already counted toward the invoice: the deposit plus payments that have not bounced and are not still clearing.
function paidSoFar(appointment) {
    return (appointment.paidDeposit ?? 0) +
        (appointment.payments ?? []).reduce((total, entry) => ["pending", "returned"].includes(entry.clearance ?? "") ? total : total + entry.amount, 0);
}
function remainingBalance(appointment) {
    if (appointment.finalCents === undefined)
        return null;
    return Math.max(0, appointment.finalCents + (appointment.taxCents ?? 0) - paidSoFar(appointment));
}
// Tax figures for customer and admin views. Before completion, a rate captured at booking gives an estimate.
function taxDetails(appointment) {
    const rate = appointment.taxRateBasisPoints ?? null;
    const final = appointment.finalCents;
    const taxCents = final !== undefined ? appointment.taxCents ?? 0 : null;
    return {
        taxRateBasisPoints: rate, taxCents, taxId: appointment.taxId ?? "",
        totalCents: final !== undefined ? final + (taxCents ?? 0) : null,
        estimateTaxCents: final === undefined && rate && appointment.estimateCents !== null ? (0, appointment_tax_1.taxOn)(appointment.estimateCents, rate) : null,
    };
}
const hasPendingCheck = (appointment) => (appointment.payments ?? []).some(entry => entry.clearance === "pending");
function depositLock(appointment, now) {
    return appointment.depositLockedAt || ((appointment.paidDeposit ?? 0) > 0 && appointment.start - now < 96 * 60 * MINUTE ? now : null);
}
const maintenanceService = (service) => /\b(full detail|the works)\b/i.test(service);
function maintenanceDeadline(appointment) {
    if (appointment.status !== "completed" || !appointment.completedAt || !appointment.email ||
        appointment.paymentReview || hasPendingCheck(appointment) || !(appointment.finalCents && appointment.finalCents > 0) ||
        remainingBalance(appointment) !== 0 || !maintenanceService(appointment.service))
        return null;
    const start = Date.parse(`${(0, appointment_booking_1.easternDate)(appointment.completedAt)}T12:00:00Z`);
    const through = new Date(start + 60 * DAY).toISOString().slice(0, 10);
    return (0, appointment_booking_1.easternDate)(Date.now()) <= through ? through : null;
}
function prepareMaintenanceInvite(db, tx, id, appointment, through, sendEmail) {
    const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
    const hash = digest(token);
    const url = `${checkoutOrigin()}/maintenance#${id}.${token}`;
    tx.update(db.collection("appointments").doc(id), { maintenanceInvite: { hash, through }, maintenanceInvitedAt: Date.now() });
    if (sendEmail)
        (0, appointment_email_1.queueAppointmentEmail)(db, tx, `maintenance-${id}-${hash.slice(0, 16)}`, appointment.email, "Your monthly maintenance invitation", {
            eyebrow: "Monthly maintenance", heading: "Keep it looking this good",
            paragraphs: [`Thanks for trusting me with your ${appointment.vehicle || "vehicle"}. You're invited to monthly maintenance details that keep it fresh between full details.`,
                `Review the plan and request your visits by ${through}.`],
            action: { label: "See monthly maintenance", url }, note: "Each visit is paid separately.",
        }, { appointmentId: id, inviteHash: hash });
    return url;
}
function queueOptedInMaintenance(db, tx, id, appointment) {
    if (!appointment.maintenanceInviteAfterPayment || appointment.maintenanceInvite || appointment.maintenanceEnrolledAt)
        return;
    const through = maintenanceDeadline(appointment);
    if (through)
        prepareMaintenanceInvite(db, tx, id, appointment, through, true);
}
async function adminUid(db, auth, req, contentOnly = false) {
    const token = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
    if (!token)
        throw new AppointmentError(401, "sign_in_required");
    const identity = await auth.verifyIdToken(token).catch(() => null);
    if (!identity)
        throw new AppointmentError(401, "sign_in_required");
    const admin = await db.collection("adminUsers").doc(identity.uid).get();
    if (!admin.exists || (!contentOnly && admin.get("role") === "editor")) {
        throw new AppointmentError(403, "access_denied");
    }
    return identity.uid;
}
async function appointmentContext(db, body) {
    const leadId = identifier(body.leadId, true);
    const lead = leadId ? (await db.collection("leads").doc(leadId).get()).data() : undefined;
    const clientId = identifier(body.clientId || lead?.client_id, true);
    const client = clientId ? (await db.collection("clients").doc(clientId).get()).data() : undefined;
    if ((leadId && !lead) || (clientId && !client))
        throw new AppointmentError(404, "record_not_found");
    return {
        clientId, leadId,
        name: client?.full_name || lead?.name || "",
        email: client?.email || lead?.email || "",
        phone: client?.phone_e164 || client?.phone || lead?.phone_normalized || lead?.phone || "",
        address: [client?.address, client?.city, [client?.state, client?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        service: { quick: "Quick Once Over", full: "Full Detail", interior_only: "Interior Only", ceramic: "Ceramic Coating" }[text(lead?.service, 50)] || "",
        vehicleType: (0, appointment_booking_1.bookingVehicle)(lead?.vehicle) ?? "",
        vehicle: lead?.vehicle_details || { sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "Van / 3-row SUV" }[text(lead?.vehicle, 50)] || "",
        estimateCents: typeof lead?.quoted_total === "number" ? Math.round(lead.quoted_total * 100) : null,
        deposit: client?.appointment_deposit_default === "waived" ? "waived" : "required",
    };
}
async function createAppointment(db, uid, body) {
    const requestId = identifier(body.requestId);
    const id = digest(`${uid}:${requestId}`);
    const ref = db.collection("appointments").doc(id);
    const previous = await readAppointment(db, id);
    if (previous)
        return adminDetails(id, previous);
    const bufferMinutes = body.useCalendarSlot === true ? (await getSettings(db)).bufferMinutes : undefined;
    const salesTax = await getTaxSettings(db);
    const requested = buildAppointment(body, uid, Date.now());
    if (bufferMinutes !== undefined)
        requested.bufferMinutes = bufferMinutes;
    if (requested.status === "confirmed")
        await assertCalendarOpen(requested);
    return db.runTransaction(async (tx) => {
        const existing = (await tx.get(ref)).data();
        if (existing)
            return adminDetails(id, existing);
        const now = Date.now();
        const appointment = buildAppointment(body, uid, now);
        if (bufferMinutes !== undefined)
            appointment.bufferMinutes = bufferMinutes;
        if (salesTax.enabled)
            appointment.taxRateBasisPoints = salesTax.rateBasisPoints;
        const client = appointment.clientId ? db.collection("clients").doc(appointment.clientId) : null;
        const lead = appointment.leadId ? db.collection("leads").doc(appointment.leadId) : null;
        if ((client && !(await tx.get(client)).exists) || (lead && !(await tx.get(lead)).exists)) {
            throw new AppointmentError(404, "record_not_found");
        }
        if (body.saveClientDefault === true && !client)
            throw new AppointmentError(400, "client_required");
        if (appointment.status === "confirmed")
            await updateReservation(db, tx, reservationFor(id, appointment), false, now);
        tx.create(ref, { ...appointment, ...(appointment.status === "confirmed" ? { confirmedAt: now, confirmedBy: uid, ...calendarUpdate(now) } : {}) });
        if (body.saveClientDefault === true && client) {
            tx.update(client, { appointment_deposit_default: body.deposit, appointment_deposit_updated_at: now, appointment_deposit_updated_by: uid });
        }
        return adminDetails(id, appointment);
    });
}
async function changeAppointment(db, uid, id, action, body) {
    const ref = db.collection("appointments").doc(id);
    const stripe = action === "issue-link" ? await (0, appointment_stripe_1.stripeConfig)() : null;
    const salesTax = action === "finish-job" ? await getTaxSettings(db) : null;
    let previous = await readAppointment(db, id);
    if (!previous)
        throw new AppointmentError(404, "record_not_found");
    if (action === "cancel" && previous.checkout?.id) {
        // Cancelling ends an open payment page first. A payment that already went through is recorded
        // before the cancellation, so its refund follows the normal deposit rules.
        const config = await (0, appointment_stripe_1.stripeConfig)();
        if (config) {
            await applyStripeSession(db, await (0, appointment_stripe_1.releaseStripeSession)(config, previous.checkout.id));
            previous = await readAppointment(db, id);
            if (!previous)
                throw new AppointmentError(404, "record_not_found");
        }
    }
    let newStart;
    if (action === "reschedule" || action === "offer-alternate") {
        newStart = validMoveStart(body.start ?? previous.rescheduleRequest?.start);
        await assertCalendarOpen({ ...previous, start: newStart, end: newStart + previous.end - previous.start }, id);
    }
    else if (action === "approve" || (action === "issue-link" && previous.status === "draft" && stripe)) {
        await assertCalendarOpen(previous, id);
    }
    return db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        if (!appointment)
            throw new AppointmentError(404, "record_not_found");
        const now = Date.now();
        if (action === "update-contact") {
            const contact = appointmentContact(body, false);
            const expected = body.expected;
            if (!expected || Object.keys(contact).some(key => expected[key] !== appointment[key])) {
                throw new AppointmentError(409, "status_changed");
            }
            tx.update(ref, { ...contact, ...calendarUpdate(now) });
            return adminDetails(id, { ...appointment, ...contact });
        }
        if (action === "offer-alternate") {
            if (!newStart || appointment.status !== "pending_approval" || appointment.start <= now || appointment.start !== previous.start) {
                throw new AppointmentError(409, "status_changed");
            }
            const offer = { start: newStart, offeredAt: now, expiresAt: Math.min(appointment.start, newStart, now + DAY) };
            tx.update(ref, { alternateOffer: offer, alternateOfferedBy: uid });
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `alternate-${id}-${now}`, appointment.email, "A different time for your detail", {
                eyebrow: "New time offered", heading: "Can we try a different time?",
                paragraphs: ["Your requested time didn't work out, so I've offered another one. Open your appointment link to accept it.", LINK_HINT],
                details: emailFacts(appointment, newStart),
            });
            return adminDetails(id, { ...appointment, alternateOffer: offer });
        }
        if (action === "reschedule") {
            if (newStart === undefined || !["confirmed", "pending_approval"].includes(appointment.status) ||
                appointment.start !== previous.start || appointment.end !== previous.end || newStart <= now ||
                (body.start == null && appointment.rescheduleRequest?.start !== newStart) ||
                (appointment.status === "pending_approval" && appointment.rescheduleRequest?.start !== newStart))
                throw new AppointmentError(409, "status_changed");
            const moved = { ...appointment, start: newStart, end: newStart + appointment.end - appointment.start };
            await updateReservation(db, tx, reservationFor(id, moved), false, now, reservationFor(id, appointment));
            const locked = appointment.status === "confirmed" ? depositLock(appointment, now) || depositLock(moved, now) : null;
            const update = { start: moved.start, end: moved.end, depositLockedAt: locked, rescheduleRequest: null, alternateOffer: null,
                calendarSequence: (appointment.calendarSequence ?? 0) + 1, ...calendarUpdate(now),
                ...(appointment.status === "pending_approval" ? { reconcileAt: moved.start } : {}),
                ...(appointment.linkHash ? { linkExpiresAt: moved.end + 30 * DAY } : {}),
            };
            tx.create(ref.collection("history").doc(), { kind: "reschedule", from: appointment.start, to: moved.start, at: now, by: uid });
            tx.update(ref, update);
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `moved-${id}-${update.calendarSequence}`, appointment.email, "Your detailing appointment time changed", {
                eyebrow: "Rescheduled", heading: "Your appointment has a new time",
                paragraphs: ["Your detail has moved. Here's the updated time.", LINK_HINT],
                details: emailFacts(moved),
            });
            return adminDetails(id, { ...appointment, ...update, rescheduleRequest: undefined });
        }
        if (action === "reject-reschedule") {
            tx.update(ref, { rescheduleRequest: null, rescheduleRejectedAt: now, rescheduleRejectedBy: uid });
            return {};
        }
        if (action === "cancel") {
            if (appointment.status === "cancelled")
                return adminDetails(id, appointment);
            if (["completed", "in_progress", "no_show"].includes(appointment.status))
                throw new AppointmentError(409, "status_changed");
            if (appointment.checkout)
                throw new AppointmentError(409, "checkout_active");
            const override = body.refundOverride === true;
            const reason = text(body.reason, 300);
            if (override && !reason)
                throw new AppointmentError(400, "refund_reason_required");
            return adminDetails(id, await cancelAppointment(db, tx, id, appointment, uid, override, reason, now));
        }
        if (action === "approve") {
            if (appointment.status !== "pending_approval" || appointment.start <= now || previous.start !== appointment.start || previous.end !== appointment.end) {
                throw new AppointmentError(409, "status_changed");
            }
            const update = { status: "confirmed", confirmedAt: now, confirmedBy: uid, depositLockedAt: depositLock(appointment, now), reconcileAt: null, ...calendarUpdate(now) };
            tx.update(ref, update);
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `approved-${id}`, appointment.email, "Your detailing appointment is confirmed", {
                eyebrow: "Confirmed", heading: "You're on the schedule",
                paragraphs: ["Your detail is confirmed. I come to you, so just make sure the vehicle is accessible.", LINK_HINT],
                details: emailFacts(appointment), ...preparationNote(appointment),
            });
            return adminDetails(id, { ...appointment, ...update });
        }
        if (action === "no-show") {
            if (appointment.status !== "confirmed" || appointment.start > now || !text(body.reason, 300))
                throw new AppointmentError(409, "status_changed");
            tx.update(ref, { status: "no_show", noShowAt: now, noShowBy: uid, noShowReason: text(body.reason, 300), depositLockedAt: depositLock(appointment, now) });
            return adminDetails(id, { ...appointment, status: "no_show" });
        }
        if (action === "start-job" || action === "save-job" || action === "finish-job") {
            if (!["confirmed", "in_progress"].includes(appointment.status))
                throw new AppointmentError(409, "status_changed");
            const work = { workNotes: text(body.workNotes, 5000), scopeChanges: text(body.scopeChanges, 1500), workUpdatedAt: now, workUpdatedBy: uid };
            if (action === "finish-job") {
                const final = body.finalCents;
                if (typeof final !== "number" || !Number.isSafeInteger(final) || final < (appointment.paidDeposit ?? 0) || final > 10000000) {
                    throw new AppointmentError(400, "invalid_price");
                }
                if (appointment.estimateCents !== null && final > appointment.estimateCents && (!work.scopeChanges || body.scopeAccepted !== true)) {
                    throw new AppointmentError(400, "scope_acceptance_required");
                }
                const supplied = body.invoiceLines ?? [{ description: appointment.service, cents: final }];
                if (!Array.isArray(supplied) || !supplied.length || supplied.length > 30 ||
                    !supplied.every(item => item && text(item.description, 140) && Number.isSafeInteger(item.cents) && Math.abs(item.cents) <= 10000000) ||
                    supplied.reduce((total, item) => total + item.cents, 0) !== final)
                    throw new AppointmentError(400, "invalid_line_items");
                const invoiceLines = supplied.map(item => ({ description: text(item.description, 140), cents: item.cents }));
                // The owner sees the tax line before completing; refuse if the setting changed since that screen loaded.
                const tax = salesTax ?? appointment_tax_1.defaultTaxSettings;
                const expectedRate = tax.enabled ? tax.rateBasisPoints : 0;
                if ((body.taxRateBasisPoints ?? 0) !== expectedRate)
                    throw new AppointmentError(409, "tax_settings_changed");
                const taxFields = tax.enabled
                    ? { taxCents: (0, appointment_tax_1.taxOn)(final, tax.rateBasisPoints), taxRateBasisPoints: tax.rateBasisPoints, taxId: tax.taxId }
                    : { taxCents: 0 };
                const update = { ...work, ...calendarUpdate(now), status: "completed", finalCents: final, ...taxFields, invoiceLines, completedAt: now, completedBy: uid,
                    maintenanceInviteAfterPayment: body.maintenanceInviteAfterPayment === true && !!appointment.email && maintenanceService(appointment.service), };
                const completed = { ...appointment, ...update };
                tx.update(ref, update);
                queueOptedInMaintenance(db, tx, id, completed);
                return adminDetails(id, completed);
            }
            const update = action === "start-job" ? { status: "in_progress", startedAt: now, startedBy: uid, ...calendarUpdate(now) } : work;
            tx.update(ref, update);
            return adminDetails(id, { ...appointment, ...update });
        }
        if (action === "record-payment" || action === "reverse-payment" || action === "clear-check" || action === "return-check") {
            if (appointment.status !== "completed" || appointment.checkout)
                throw new AppointmentError(409, "checkout_active");
            if (appointment.paymentReview)
                throw new AppointmentError(409, "payment_review_required");
            const operation = identifier(body.requestId);
            const payments = appointment.payments ?? [];
            if (payments.some(entry => entry.id === operation))
                return adminDetails(id, appointment);
            if (payments.length >= 100)
                throw new AppointmentError(409, "payment_limit");
            const method = text(body.method, 24);
            let amount = body.amountCents;
            let reference = text(body.reference, 300);
            let entryMethod = method;
            if (action === "clear-check" || action === "return-check") {
                const original = payments.find(entry => entry.id === body.paymentId && entry.method === "check");
                if (!original || original.clearance !== "pending")
                    throw new AppointmentError(409, "payment_unavailable");
                const clearance = action === "clear-check" ? "cleared" : "returned";
                const entry = { id: operation, amount: 0, method: clearance === "cleared" ? "check_cleared" : "check_returned", reference: original.id, by: uid, at: now };
                const revised = payments.map(payment => payment.id === original.id ? { ...payment, clearance } : payment);
                tx.create(ref.collection("ledger").doc(operation), { ...entry, kind: entry.method, status: clearance });
                const paid = { ...appointment, payments: [...revised, entry] };
                tx.update(ref, { payments: paid.payments });
                queueOptedInMaintenance(db, tx, id, paid);
                return adminDetails(id, paid);
            }
            if (action === "reverse-payment") {
                const original = payments.find(entry => entry.id === body.paymentId);
                if (!original || !MANUAL_METHODS.has(original.method) || original.clearance === "pending" || original.clearance === "returned" ||
                    payments.some(entry => entry.method === "reversal" && entry.reference === original.id)) {
                    throw new AppointmentError(409, "payment_unavailable");
                }
                amount = -original.amount;
                reference = original.id;
                entryMethod = "reversal";
            }
            else if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 ||
                amount > (remainingBalance(appointment) ?? 0) || !MANUAL_METHODS.has(method)) {
                throw new AppointmentError(400, "invalid_payment");
            }
            else if (hasPendingCheck(appointment)) {
                throw new AppointmentError(409, "check_pending");
            }
            // Record how much of each payment is sales tax so collected tax can be reported from the ledger.
            const reversed = entryMethod === "reversal" ? payments.find(payment => payment.id === reference) : undefined;
            const taxCents = reversed ? -(reversed.taxCents ?? 0)
                : (0, appointment_tax_1.taxPortion)(appointment.finalCents ?? 0, appointment.taxCents ?? 0, paidSoFar(appointment), amount);
            const entry = { id: operation, amount: amount, method: entryMethod, reference, by: uid, at: now,
                ...(entryMethod === "check" ? { clearance: "pending" } : {}), ...(taxCents ? { taxCents } : {}), };
            tx.create(ref.collection("ledger").doc(operation), entry);
            const paid = { ...appointment, payments: [...payments, entry] };
            tx.update(ref, { payments: paid.payments });
            queueOptedInMaintenance(db, tx, id, paid);
            return adminDetails(id, paid);
        }
        if (action === "maintenance-invite") {
            const through = maintenanceDeadline(appointment);
            if (!through || appointment.maintenanceEnrolledAt || body.permitted !== true)
                throw new AppointmentError(409, "maintenance_unavailable");
            const url = prepareMaintenanceInvite(db, tx, id, appointment, through, body.sendEmail === true);
            tx.update(ref, { maintenanceInvitedBy: uid });
            return { url };
        }
        if (action === "revoke-link") {
            tx.update(ref, { linkHash: null, linkRevokedAt: now, linkUpdatedBy: uid });
            return {};
        }
        if (appointment.status === "draft") {
            if (!stripe)
                throw new AppointmentError(503, "stripe_unavailable");
            if (appointment.start < now + 36 * MINUTE)
                throw new AppointmentError(409, "checkout_too_close");
            await updateReservation(db, tx, reservationFor(id, appointment), false, now);
            const deadline = Math.min(appointment.start, now + DAY);
            tx.update(ref, { status: "awaiting_deposit", preapproved: true, depositDeadline: deadline, reconcileAt: deadline, ...calendarUpdate(now) });
        }
        else if (!["awaiting_deposit", "confirmed", "in_progress", "completed", "pending_approval"].includes(appointment.status)) {
            throw new AppointmentError(409, "link_unavailable");
        }
        const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
        tx.update(ref, { linkHash: digest(token), linkExpiresAt: appointment.end + 30 * DAY, linkUpdatedAt: now, linkUpdatedBy: uid });
        if (body.sendEmail === true) {
            const url = `${checkoutOrigin()}/appointment#${id}.${token}`;
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `share-${id}-${now}`, appointment.email, "Your detailing appointment details", {
                eyebrow: "Your appointment", heading: "Here's your appointment",
                paragraphs: ["Open your appointment to see its status, add it to your calendar, pay a balance, or request a change."],
                details: emailFacts(appointment), action: { label: "Open my appointment", url },
            });
        }
        return { token };
    });
}
async function acceptAlternate(db, id, body) {
    const previous = await readAppointment(db, id);
    assertLink(id, body.token, previous);
    const offer = previous.alternateOffer;
    if (body.accepted !== true || previous.status !== "pending_approval" || !offer || offer.expiresAt <= Date.now() || offer.start !== body.start) {
        throw new AppointmentError(409, "status_changed");
    }
    const moved = { ...previous, start: offer.start, end: offer.start + previous.end - previous.start };
    await assertCalendarOpen(moved, id);
    const ref = db.collection("appointments").doc(id);
    return db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        assertLink(id, body.token, appointment);
        const now = Date.now();
        if (appointment.status !== "pending_approval" || appointment.alternateOffer?.offeredAt !== offer.offeredAt ||
            appointment.start !== previous.start || offer.expiresAt <= now)
            throw new AppointmentError(409, "status_changed");
        await updateReservation(db, tx, reservationFor(id, moved), false, now, reservationFor(id, appointment));
        const update = {
            start: moved.start, end: moved.end, status: "confirmed", depositLockedAt: depositLock(moved, now),
            confirmedAt: now, confirmedBy: "accepted_owner_offer", reconcileAt: null,
            alternateOffer: null, rescheduleRequest: null, calendarSequence: (appointment.calendarSequence ?? 0) + 1,
            linkExpiresAt: moved.end + 30 * DAY, ...calendarUpdate(now),
        };
        tx.create(ref.collection("history").doc(), { kind: "accepted_alternate", from: appointment.start, to: moved.start, at: now, by: "customer_link" });
        tx.update(ref, update);
        (0, appointment_email_1.queueAppointmentEmail)(db, tx, `approved-${id}`, appointment.email, "Your detailing appointment is confirmed", {
            eyebrow: "Confirmed", heading: "Your new time is locked in",
            paragraphs: ["Thanks for being flexible. Your detail is confirmed for the new time.", LINK_HINT],
            details: emailFacts(moved), ...preparationNote(appointment),
        });
        return customerDetails({ ...appointment, ...update, alternateOffer: undefined, rescheduleRequest: undefined });
    });
}
async function maintenanceEnrollment(db, body, enroll) {
    const id = identifier(body.id);
    const token = body.token;
    if (!HASH.test(id) || typeof token !== "string" || !HASH.test(token))
        throw new AppointmentError(404, "link_unavailable");
    const ref = db.collection("appointments").doc(id);
    return db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        if (!appointment?.maintenanceInvite || appointment.maintenanceInvite.hash !== digest(token) || !maintenanceDeadline(appointment)) {
            throw new AppointmentError(404, "link_unavailable");
        }
        const result = { eligibleThrough: appointment.maintenanceInvite.through, enrolled: !!appointment.maintenanceEnrolledAt };
        if (!enroll || result.enrolled)
            return result;
        if (body.accepted !== true)
            throw new AppointmentError(400, "policy_acceptance_required");
        const now = Date.now();
        tx.create(db.collection("maintenanceEnrollments").doc(id), {
            appointmentId: id, clientId: appointment.clientId, name: appointment.name, email: appointment.email,
            vehicle: appointment.vehicle, state: "requested", cadence: "monthly", billing: "per_visit", requestedAt: now,
        });
        tx.update(ref, { maintenanceEnrolledAt: now });
        return { ...result, enrolled: true };
    });
}
function validMoveStart(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value % MINUTE !== 0 || value <= Date.now() || value > Date.now() + 2 * 366 * DAY) {
        throw new AppointmentError(400, "invalid_time");
    }
    return value;
}
function assertLink(id, token, appointment) {
    if (!HASH.test(id) || typeof token !== "string" || !HASH.test(token))
        throw new AppointmentError(404, "link_unavailable");
    const hash = Buffer.from(digest(token), "hex");
    const now = Date.now();
    const candidates = [[appointment?.linkHash, appointment?.linkExpiresAt], [appointment?.accountLinkHash, appointment?.accountLinkExpiresAt]];
    if (!appointment || !candidates.some(([stored, expires]) => stored && HASH.test(stored) && (expires ?? 0) > now &&
        (0, node_crypto_1.timingSafeEqual)(Buffer.from(stored, "hex"), hash))) {
        throw new AppointmentError(404, "link_unavailable");
    }
}
async function detailsFromLink(db, id, token) {
    const appointment = await readAppointment(db, id);
    assertLink(id, token, appointment);
    return customerDetails(appointment);
}
async function readAppointment(db, id) {
    return (await db.collection("appointments").doc(id).get()).data();
}
const settingsDoc = (db) => db.collection("appointmentSettings").doc("booking");
const taxDoc = (db) => db.collection("appointmentSettings").doc("salesTax");
async function getTaxSettings(db) {
    return { ...appointment_tax_1.defaultTaxSettings, ...(await taxDoc(db).get()).data() };
}
async function getSettings(db) {
    return (await settingsDoc(db).get()).data() ?? appointment_booking_1.emptyBookingSettings;
}
async function getAvailability(db, body, owner = false) {
    const configured = await getSettings(db);
    const settings = owner ? { ...configured, enabled: true, minimumHours: body.deposit === "required" ? 0.6 : 0 } : configured;
    let service = settings.services.find(item => item.id === body.serviceId);
    if (owner) {
        const duration = body.durationMinutes;
        if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 15 || duration > 7 * 1440) {
            throw new AppointmentError(400, "invalid_time");
        }
        service = { id: "", name: "", cents: 0, duration };
    }
    const date = text(body.date, 10);
    if (!service || !settings.enabled)
        return { slots: [] };
    const now = Date.now();
    let dates = [date];
    if (body.month !== undefined) {
        if (typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month))
            throw new AppointmentError(400, "invalid_date");
        const month = body.month;
        const first = Date.parse(month + "-01T12:00:00Z");
        dates = Array.from({ length: 31 }, (_, index) => new Date(first + index * DAY).toISOString().slice(0, 10))
            .filter(day => day.startsWith(month));
    }
    const candidates = dates.flatMap(day => (0, appointment_booking_1.bookingSlots)(settings, day, service, now));
    if (!candidates.length)
        return { slots: [] };
    const lower = candidates[0] - settings.bufferMinutes * MINUTE;
    const upper = candidates[candidates.length - 1] + (settings.bufferMinutes + service.duration) * MINUTE;
    const [config, days] = await Promise.all([(0, appointment_calendar_1.calendarConfig)(), db.getAll(...reservationDays(db, { id: "", start: lower, end: upper }))]);
    if (!config)
        throw new AppointmentError(503, "calendar_unavailable");
    const google = await (0, appointment_calendar_1.busyWindows)(config, lower, upper).catch(() => { throw new AppointmentError(503, "calendar_unavailable"); });
    const all = [...google, ...days.flatMap(day => (day.get("slots") ?? []))];
    return {
        slots: candidates.filter(start => {
            const range = reservationFor("", { start, end: start + service.duration * MINUTE, bufferMinutes: settings.bufferMinutes });
            return !all.some(block => block.start < range.end && block.end > range.start);
        }),
    };
}
async function authenticatedCustomer(auth, req) {
    const bearer = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
    if (!bearer)
        return null;
    const user = await auth.verifyIdToken(bearer).catch(() => null);
    if (!user?.email_verified || !user.email)
        throw new AppointmentError(403, "verified_email_required");
    return { uid: user.uid, email: user.email.toLowerCase() };
}
// Returning customers skip the online deposit. Only a signed-in, verified email counts, so typing
// someone else's phone or email can't skip it: the email must match a past completed detail whose
// deposit was paid, or a client record the owner set to "No deposit required".
async function depositWaived(db, customer) {
    if (!customer)
        return false;
    const [byAccount, byEmail, clients] = await Promise.all([
        db.collection("appointments").where("customerUid", "==", customer.uid).limit(50).get(),
        db.collection("appointments").where("email", "==", customer.email).limit(50).get(),
        db.collection("clients").where("email", "==", customer.email).limit(10).get(),
    ]);
    if (clients.docs.some(client => client.get("appointment_deposit_default") === "waived"))
        return true;
    const past = [...byAccount.docs, ...byEmail.docs].map(doc => doc.data());
    if (past.some(appointment => appointment.status === "completed" && (appointment.paidDeposit ?? 0) > 0))
        return true;
    const linked = [...new Set(past.map(appointment => appointment.clientId).filter((id) => !!id))].slice(0, 10);
    if (!linked.length)
        return false;
    const records = await db.getAll(...linked.map(id => db.collection("clients").doc(id)));
    return records.some(client => client.get("appointment_deposit_default") === "waived");
}
async function bookingQuote(db, receipt) {
    if (!receipt || typeof receipt !== "object")
        return null;
    const { id, token } = receipt;
    if (typeof id !== "string" || typeof token !== "string" || !HASH.test(id) || !HASH.test(token))
        return null;
    const lead = (await db.collection("leads").doc(id).get()).data();
    if (!lead || lead.honeypot || lead.addon_token_hash !== digest(token) ||
        !Number.isFinite(lead.addon_token_expires_at) || lead.addon_token_expires_at <= Date.now())
        return null;
    const name = text(lead.name, 150);
    const phone = text(lead.phone_normalized || lead.phone, 48);
    const digits = phone.replace(/\D/g, "");
    const quote = Number.isFinite(lead.quoted_total) && lead.quoted_total >= 0 ? Math.round(lead.quoted_total * 100) : null;
    return {
        id, service: text(lead.service, 31), vehicle: (0, appointment_booking_1.bookingVehicle)(lead.vehicle), estimateCents: quote,
        phoneEnding: name && /^1?\d{10}$/.test(digits) ? digits.slice(-4) : null, name, phone,
    };
}
async function publicBooking(db, auth, req, body) {
    const settings = await getSettings(db);
    const service = settings.services.find(item => item.id === body.serviceId);
    if (!settings.enabled || !service || !(await (0, appointment_stripe_1.stripeConfig)()))
        throw new AppointmentError(503, "booking_unavailable");
    const postalCode = text(body.postalCode, 10);
    if (postalCode && !settings.postalCodes.includes(postalCode))
        throw new AppointmentError(400, "outside_service_area");
    const token = body.token;
    if (typeof token !== "string" || !HASH.test(token) || body.accepted !== true)
        throw new AppointmentError(400, "policy_acceptance_required");
    const id = digest(`public:${token}`);
    const previous = await readAppointment(db, id);
    if (previous) {
        assertLink(id, token, previous);
        return { id, ...customerDetails(previous) };
    }
    const customer = await authenticatedCustomer(auth, req);
    const email = customer?.email ?? text(body.email, 250);
    const quote = await bookingQuote(db, body.quoteReceipt);
    if (body.reuseQuoteContact === true && !quote?.phoneEnding)
        throw new AppointmentError(409, "quote_contact_expired");
    const vehicleType = (0, appointment_booking_1.bookingVehicle)(body.vehicleType);
    const prices = (0, appointment_booking_1.bookingPrices)(service);
    if ((body.vehicleType && !vehicleType) || (!vehicleType && new Set(Object.values(prices)).size > 1)) {
        throw new AppointmentError(400, "vehicle_required");
    }
    const quotedPrice = quote && quote.service === service.id && quote.vehicle === vehicleType ? quote.estimateCents : null;
    const waived = await depositWaived(db, customer);
    const appointment = buildAppointment({
        ...body, address: `${text(body.address, 390)} ${postalCode}`,
        ...(body.reuseQuoteContact === true ? { name: quote.name, phone: quote.phone } : {}),
        clientId: null, leadId: quote?.id ?? null, email, service: service.name,
        durationMinutes: service.duration, estimateCents: quotedPrice ?? prices[vehicleType ?? "sedan"], deposit: waived ? "waived" : "required",
    }, customer?.uid ?? "guest", Date.now(), true);
    if (!(0, appointment_booking_1.bookingSlots)(settings, (0, appointment_booking_1.easternDate)(appointment.start), service, Date.now()).includes(appointment.start)) {
        throw new AppointmentError(409, "time_unavailable");
    }
    appointment.bufferMinutes = settings.bufferMinutes;
    const salesTax = await getTaxSettings(db);
    if (salesTax.enabled)
        appointment.taxRateBasisPoints = salesTax.rateBasisPoints;
    await assertCalendarOpen(appointment);
    const ref = db.collection("appointments").doc(id);
    const holds = db.collection("appointmentBookingHolds");
    const throttles = [holds.doc(digest(appointment.phone))];
    if (email)
        throttles.push(holds.doc(digest(email.toLowerCase())));
    return db.runTransaction(async (tx) => {
        const existing = (await tx.get(ref)).data();
        if (existing) {
            assertLink(id, token, existing);
            return { id, ...customerDetails(existing) };
        }
        const latest = (await tx.get(settingsDoc(db))).data();
        if (!latest?.enabled || latest.revision !== settings.revision ||
            !(0, appointment_booking_1.bookingSlots)(latest, (0, appointment_booking_1.easternDate)(appointment.start), service, Date.now()).includes(appointment.start)) {
            throw new AppointmentError(409, "time_unavailable");
        }
        const now = Date.now();
        for (const hold of await tx.getAll(...throttles)) {
            if ((hold.get("until") ?? 0) <= now || hold.get("appointmentId") === id)
                continue;
            const held = await tx.get(db.collection("appointments").doc(hold.get("appointmentId")));
            if (held.get("status") === "awaiting_deposit")
                throw new AppointmentError(409, "existing_booking_hold");
        }
        await updateReservation(db, tx, reservationFor(id, appointment), false, now);
        const deadline = now + 40 * MINUTE;
        const record = {
            ...appointment, preapproved: false, linkHash: digest(token), linkExpiresAt: appointment.end + 30 * DAY,
            acceptedPolicy: DEPOSIT_POLICY, policyVersion: POLICY_VERSION,
            ...(waived
                // No payment step: the request goes straight to the owner for approval.
                ? { status: "pending_approval", depositWaivedReason: "returning_customer" }
                : { status: "awaiting_deposit", depositDeadline: deadline, reconcileAt: deadline }),
            ...(customer ? { customerUid: customer.uid } : {}),
        };
        tx.create(ref, { ...record, bookingChannel: "public", acceptedAt: now });
        if (waived) {
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `request-${id}`, email, "We got your booking request", {
                eyebrow: "Request received", heading: "No deposit needed this time",
                paragraphs: [`Thanks for coming back, ${record.name.split(" ")[0] || "there"}! As a returning customer you don't need a deposit. Nieman will review your request and text to confirm.`,
                    "Keep this email. The button below is your link to check status, add the appointment to your calendar, or request a change."],
                details: emailFacts(record), action: { label: "View appointment", url: `${checkoutOrigin()}/appointment#${id}.${token}` },
            });
            return { id, ...customerDetails(record) };
        }
        for (const throttle of throttles)
            tx.set(throttle, { until: deadline, appointmentId: id });
        (0, appointment_email_1.queueAppointmentEmail)(db, tx, `request-${id}`, email, "Finish booking your detail", {
            eyebrow: "Almost booked", heading: "Lock in your time with the deposit",
            paragraphs: [`Thanks, ${record.name.split(" ")[0] || "there"}! Pay the ${emailMoney(record.depositCents)} deposit to hold your spot. It goes toward the cost of your detail.`,
                "Keep this email. The button below is your link to check status, add the appointment to your calendar, or request a change."],
            details: emailFacts(record), action: { label: "Pay deposit and view appointment", url: `${checkoutOrigin()}/appointment#${id}.${token}` },
        });
        return { id, ...customerDetails(record) };
    });
}
async function customerAccount(db, auth, req, body, action) {
    const customer = await authenticatedCustomer(auth, req);
    if (!customer)
        throw new AppointmentError(401, "sign_in_required");
    if (action === "my-appointments") {
        const rows = await db.collection("appointments").where("customerUid", "==", customer.uid).limit(100).get();
        return rows.docs.map(row => ({ id: row.id, ...customerDetails(row.data()) })).sort((a, b) => b.start - a.start);
    }
    const id = identifier(body.id);
    const ref = db.collection("appointments").doc(id);
    return db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        if (!appointment)
            throw new AppointmentError(404, "link_unavailable");
        if (action === "claim-appointment") {
            assertLink(id, body.token, appointment);
            if (appointment.email.toLowerCase() !== customer.email || (appointment.customerUid && appointment.customerUid !== customer.uid)) {
                throw new AppointmentError(403, "appointment_email_mismatch");
            }
            tx.update(ref, { customerUid: customer.uid });
            return {};
        }
        if (appointment.customerUid !== customer.uid || appointment.status === "draft")
            throw new AppointmentError(404, "link_unavailable");
        const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
        tx.update(ref, { accountLinkHash: digest(token), accountLinkExpiresAt: Date.now() + 4 * 60 * MINUTE });
        return { token };
    });
}
async function cancelAppointment(db, tx, id, appointment, actor, override, reason, now) {
    if (appointment.status !== "draft")
        await updateReservation(db, tx, reservationFor(id, appointment), true, now);
    const locked = appointment.status === "confirmed" ? depositLock(appointment, now) : appointment.depositLockedAt ?? null;
    const refund = appointment.depositIntent && (override || !locked) && !appointment.refund
        ? { state: "queued", requestedAt: now } : undefined;
    const update = { status: "cancelled", cancelledAt: now, cancelledBy: actor, cancellationReason: reason,
        depositLockedAt: locked, reconcileAt: null,
        ...(refund ? { refund, refundAt: now } : {}), ...calendarUpdate(now), };
    tx.update(db.collection("appointments").doc(id), update);
    (0, appointment_email_1.queueAppointmentEmail)(db, tx, `cancel-${id}`, appointment.email, "Your detailing appointment was cancelled", {
        eyebrow: "Cancelled", heading: "Your appointment was cancelled",
        paragraphs: [refund ? "Your appointment is cancelled and your deposit refund has been requested. Refunds usually reach your account within 5 to 10 business days."
                : "Your appointment is cancelled. If you'd like a different time, book again anytime or call or text me."],
        details: emailFacts(appointment), action: { label: "Book a new time", url: `${(0, appointment_email_template_1.emailSiteOrigin)()}/quote` },
    });
    return { ...appointment, ...update };
}
const emailWhenFormat = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
});
const emailMoney = (cents) => `${(cents / 100).toFixed(2)}`;
const LINK_HINT = "Use the appointment link from your booking email to see everything, add it to your calendar, or request a change.";
const preparationNote = (appointment) => appointment.preparation ? { note: `Before I arrive: ${appointment.preparation}` } : {};
// The appointment at a glance, for the details card in customer emails.
function emailFacts(appointment, start = appointment.start) {
    const facts = [
        ["Service", appointment.service], ["When", emailWhenFormat.format(start)],
        ["Vehicle", appointment.vehicle], ["Address", appointment.address],
    ];
    // Before the job is done, say tax will be added when the booking captured a rate.
    if (appointment.finalCents === undefined && appointment.taxRateBasisPoints) {
        facts.push(["Sales tax", `${(0, appointment_tax_1.taxRateLabel)(appointment.taxRateBasisPoints)} added to the final invoice`]);
    }
    return facts.filter(([, value]) => !!value);
}
// Receipt lines: subtotal, sales tax and total when the invoice carries tax, plus the tax account number.
function invoiceFacts(appointment) {
    if (appointment.finalCents === undefined || !appointment.taxCents)
        return [];
    const facts = [
        ["Subtotal", emailMoney(appointment.finalCents)],
        [(0, appointment_tax_1.taxLineLabel)(appointment.taxRateBasisPoints ?? 0), emailMoney(appointment.taxCents)],
        ["Invoice total", emailMoney(appointment.finalCents + appointment.taxCents)],
    ];
    if (appointment.taxId)
        facts.push(["NC sales tax account", appointment.taxId]);
    return facts;
}
function checkoutOrigin() {
    const origin = process.env.HOSTING_ORIGIN ?? "";
    const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
    // Live checkout returns customers to the production domain; test checkout only to <project>.web.app.
    const expected = (0, appointment_secrets_1.liveMode)() ? /^https:\/\/[a-z0-9.-]+$/.test(origin) : origin === `https://${project}.web.app`;
    if (!project || !expected)
        throw new AppointmentError(503, "stripe_unavailable");
    return origin;
}
async function openCheckout(db, id, body) {
    const config = await (0, appointment_stripe_1.stripeConfig)();
    if (!config)
        throw new AppointmentError(503, "stripe_unavailable");
    const origin = checkoutOrigin();
    const ref = db.collection("appointments").doc(id);
    const current = await readAppointment(db, id);
    assertLink(id, body.token, current);
    if (current.checkout?.id) {
        const session = await (0, appointment_stripe_1.stripeSession)(config, current.checkout.id);
        await applyStripeSession(db, session);
        if (session.status === "complete")
            throw new AppointmentError(409, "checkout_finished");
    }
    if (current.status === "awaiting_deposit")
        await assertCalendarOpen(current, id);
    const reservation = await db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        assertLink(id, body.token, appointment);
        const now = Date.now();
        const deposit = appointment.status === "awaiting_deposit";
        if (appointment.paymentReview)
            throw new AppointmentError(409, "payment_review_required");
        if (hasPendingCheck(appointment))
            throw new AppointmentError(409, "check_pending");
        const amount = deposit ? appointment.depositCents : appointment.status === "completed" ? remainingBalance(appointment) : 0;
        if (!amount || amount < 50)
            throw new AppointmentError(409, "nothing_due");
        if (body.accepted !== true)
            throw new AppointmentError(400, "policy_acceptance_required");
        if (appointment.checkout) {
            if (!appointment.checkout.id && appointment.checkout.expiresAt <= now)
                throw new AppointmentError(409, "checkout_too_close");
            return appointment.checkout;
        }
        const expiresAt = Math.min(deposit ? appointment.depositDeadline ?? 0 : Infinity, now + CHECKOUT_WINDOW);
        if (expiresAt - now < 31 * MINUTE)
            throw new AppointmentError(409, "checkout_too_close");
        const kind = deposit ? "deposit" : "balance";
        // A balance that still includes unpaid tax shows the tax as its own line; the lines add up to the amount.
        const taxCents = deposit ? 0 : (0, appointment_tax_1.taxPortion)(appointment.finalCents ?? 0, appointment.taxCents ?? 0, paidSoFar(appointment), amount);
        const checkout = {
            attempt: (0, node_crypto_1.randomBytes)(16).toString("hex"), kind, expiresAt, amount, origin, holdUntil: now + CHECKOUT_HOLD,
            disclosure: deposit ? DEPOSIT_POLICY : "Pay the outstanding balance for your completed detail.",
            ...(taxCents > 0 ? { taxCents, taxLabel: (0, appointment_tax_1.taxLineLabel)(appointment.taxRateBasisPoints ?? 0) } : {}),
        };
        tx.update(ref, { checkout, reconcileAt: checkout.holdUntil,
            ...(deposit ? { policyVersion: POLICY_VERSION, acceptedPolicy: DEPOSIT_POLICY, acceptedAt: now } : {}),
        });
        return checkout;
    });
    const session = reservation.id
        ? await (0, appointment_stripe_1.stripeSession)(config, reservation.id)
        : await (0, appointment_stripe_1.createStripeSession)(config, { id, ...reservation });
    if (session.livemode !== (0, appointment_secrets_1.liveMode)() || session.metadata.appointmentId !== id || session.metadata.attemptId !== reservation.attempt ||
        session.amount_total !== reservation.amount || session.currency !== "usd")
        throw new Error("stripe_checkout_mismatch");
    await db.runTransaction(async (tx) => {
        const latest = (await tx.get(ref)).data();
        if (latest.checkout?.attempt === reservation.attempt)
            tx.update(ref, { checkout: { ...reservation, id: session.id } });
    });
    await applyStripeSession(db, session);
    if (session.status !== "open" || !session.url || new URL(session.url).origin !== "https://checkout.stripe.com") {
        throw new AppointmentError(409, "checkout_finished");
    }
    return { url: session.url };
}
async function applyStripeSession(db, session) {
    const id = session.metadata?.appointmentId;
    if (!HASH.test(id ?? "") || session.livemode !== (0, appointment_secrets_1.liveMode)() || !(0, appointment_stripe_1.isSessionId)(session.id))
        return;
    const ref = db.collection("appointments").doc(id);
    await db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        const checkout = appointment?.checkout;
        if (!appointment || !checkout || checkout.attempt !== session.metadata.attemptId || (checkout.id && checkout.id !== session.id))
            return;
        if (session.currency !== "usd" || session.amount_total !== checkout.amount || session.metadata.kind !== checkout.kind)
            throw new Error("stripe_amount_mismatch");
        const now = Date.now();
        if (session.status === "expired") {
            tx.update(ref, { checkout: null, reconcileAt: checkout.kind === "deposit" ? appointment.depositDeadline : null });
            return;
        }
        if (session.status !== "complete" || session.payment_status !== "paid" || !session.payment_intent || !/^pi_\w+$/.test(session.payment_intent))
            return;
        const ledger = ref.collection("ledger").doc(session.id);
        tx.create(ledger, { kind: checkout.kind, id: session.id, amount: checkout.amount, method: "stripe", at: now, intent: session.payment_intent, livemode: (0, appointment_secrets_1.liveMode)(),
            ...(checkout.taxCents ? { taxCents: checkout.taxCents } : {}) });
        if (checkout.kind === "balance") {
            const entry = { id: session.id, amount: checkout.amount, method: "stripe", at: now, by: "stripe", reference: session.payment_intent,
                ...(checkout.taxCents ? { taxCents: checkout.taxCents } : {}) };
            const paid = { ...appointment, payments: [...(appointment.payments ?? []), entry] };
            tx.update(ref, { checkout: null, reconcileAt: null, payments: paid.payments });
            queueOptedInMaintenance(db, tx, id, paid);
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `receipt-${session.id}`, appointment.email, "Detailing payment received", {
                eyebrow: "Receipt", heading: "Payment received. Thank you!",
                paragraphs: [`I received your payment of ${emailMoney(checkout.amount)}. It was a pleasure taking care of your ${appointment.vehicle || "vehicle"}.`],
                details: [...invoiceFacts(appointment), ["Paid", emailMoney(checkout.amount)], ...emailFacts(appointment)],
                action: { label: "Book your next detail", url: `${(0, appointment_email_template_1.emailSiteOrigin)()}/quote` },
            });
        }
        else {
            const late = appointment.start <= now;
            const status = late ? "cancelled" : appointment.preapproved ? "confirmed" : "pending_approval";
            tx.update(ref, { checkout: null, status, paidDeposit: checkout.amount, depositIntent: session.payment_intent,
                reconcileAt: status === "pending_approval" ? appointment.start : null,
                depositLockedAt: status === "confirmed" && appointment.start - now < 96 * 60 * MINUTE ? now : null,
                ...(late ? { refund: { state: "queued", requestedAt: now }, refundAt: now, cancellationReason: "Payment settled after the appointment start." } : {}),
                ...calendarUpdate(now),
            });
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `receipt-${session.id}`, appointment.email, "Detailing deposit received", late ? {
                eyebrow: "Refund on the way", heading: "Your deposit arrived too late",
                paragraphs: ["The deposit came through after the appointment start time, so a refund has been requested. Book a new time anytime."],
                details: [["Refunding", emailMoney(checkout.amount)], ...emailFacts(appointment)],
                action: { label: "Book a new time", url: `${(0, appointment_email_template_1.emailSiteOrigin)()}/quote` },
            } : {
                eyebrow: "Deposit received", heading: status === "confirmed" ? "You're booked!" : "Deposit received. You're almost set",
                paragraphs: [status === "confirmed" ? `Your ${emailMoney(checkout.amount)} deposit is in and your detail is confirmed.`
                        : `Your ${emailMoney(checkout.amount)} deposit is in. I'll review your request and confirm it shortly, and you'll get an email when I do.`, LINK_HINT],
                details: [["Deposit paid", emailMoney(checkout.amount)], ...emailFacts(appointment)],
                ...(status === "confirmed" ? preparationNote(appointment) : {}),
            });
        }
    });
}
async function reconcileAppointments(db) {
    const config = await (0, appointment_stripe_1.stripeConfig)();
    const now = Date.now();
    const collection = db.collection("appointments");
    await (0, appointment_email_1.deliverAppointmentEmails)(db, now, async ({ appointmentId, inviteHash }) => {
        const appointment = await readAppointment(db, appointmentId);
        return !!appointment && appointment.maintenanceInvite?.hash === inviteHash &&
            !appointment.maintenanceEnrolledAt && !!maintenanceDeadline(appointment);
    }).catch(() => firebase_functions_1.logger.error("Appointment email delivery needs review"));
    const calendar = await (0, appointment_calendar_1.calendarConfig)().catch(() => null);
    if (calendar) {
        const pending = await collection.where("calendarDueAt", "<=", now).where("calendarDueAt", ">", 0).orderBy("calendarDueAt").limit(5).get();
        for (const doc of pending.docs) {
            const appointment = doc.data();
            let failure = false;
            try {
                await (0, appointment_calendar_1.mirrorAppointment)(calendar, doc.id, appointment);
            }
            catch {
                failure = true;
            }
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(doc.ref)).data();
                if (!latest || latest.calendarRevision !== appointment.calendarRevision)
                    return;
                tx.update(doc.ref, failure ?
                    { calendarFailure: true, calendarDueAt: now + 10 * MINUTE } :
                    { calendarFailure: false, calendarDueAt: null, calendarSyncedAt: now });
            });
        }
    }
    const due = await collection.where("reconcileAt", "<=", now).where("reconcileAt", ">", 0).orderBy("reconcileAt").limit(5).get();
    for (const doc of due.docs) {
        try {
            const appointment = doc.data();
            if (appointment.checkout) {
                if (!config)
                    throw new Error("stripe_unavailable");
                const checkout = appointment.checkout;
                if (checkout.id) {
                    const holdOver = (checkout.holdUntil ?? checkout.expiresAt) <= now;
                    await applyStripeSession(db, holdOver ? await (0, appointment_stripe_1.releaseStripeSession)(config, checkout.id) : await (0, appointment_stripe_1.stripeSession)(config, checkout.id));
                }
                else if (checkout.expiresAt > now) {
                    // The session ID was never saved, so it can only be found once Stripe's own expiry has passed.
                    await doc.ref.update({ reconcileAt: checkout.expiresAt });
                    continue;
                }
                else if (checkout.expiresAt <= now) {
                    const session = await (0, appointment_stripe_1.findCheckoutAttempt)(config, doc.id, checkout.attempt, checkout.expiresAt - CHECKOUT_WINDOW - MINUTE, checkout.expiresAt);
                    if (session) {
                        await applyStripeSession(db, session);
                    }
                    else {
                        await db.runTransaction(async (tx) => {
                            const latest = (await tx.get(doc.ref)).data();
                            if (latest?.checkout?.attempt === checkout.attempt && !latest.checkout.id) {
                                tx.update(doc.ref, { checkout: null, reconcileAt: checkout.kind === "deposit" ? latest.depositDeadline : null });
                            }
                        });
                    }
                }
            }
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(doc.ref)).data();
                if (!latest || latest.checkout || (latest.reconcileAt ?? Infinity) > now)
                    return;
                if (["awaiting_deposit", "pending_approval"].includes(latest.status)) {
                    await cancelAppointment(db, tx, doc.id, latest, "system", false, "Appointment hold expired.", now);
                }
            });
        }
        catch (error) {
            firebase_functions_1.logger.error("Appointment payment needs reconciliation", { appointmentId: doc.id, reason: error instanceof Error ? error.message : String(error) });
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(doc.ref)).data();
                if (latest?.checkout && (latest.reconcileAt ?? Infinity) <= now)
                    tx.update(doc.ref, { reconcileAt: now + 5 * MINUTE });
            });
        }
    }
    if (!config)
        return;
    const refunds = await collection.where("refundAt", "<=", now).where("refundAt", ">", 0).orderBy("refundAt").limit(5).get();
    for (const doc of refunds.docs) {
        const appointment = doc.data();
        if (!appointment.depositIntent || !appointment.paidDeposit || !appointment.refund)
            continue;
        if (appointment.paymentReview?.kind === "dispute") {
            await doc.ref.update({ refundAt: now + 60 * MINUTE });
            continue;
        }
        try {
            if (!appointment.refund.id && now - appointment.refund.requestedAt > 23 * 60 * MINUTE) {
                await doc.ref.update({ refund: { ...appointment.refund, state: "failed" }, refundAt: null });
                continue;
            }
            const refund = await (0, appointment_stripe_1.stripeRefund)(config, { id: doc.id, intent: appointment.depositIntent, cents: appointment.paidDeposit, refundId: appointment.refund.id });
            const state = refund.status === "succeeded" ? "succeeded" : ["failed", "canceled"].includes(refund.status) ? "failed" : "pending";
            await db.runTransaction(async (tx) => {
                const latest = (await tx.get(doc.ref)).data();
                if (!latest?.refund || latest.refund.state === "succeeded")
                    return;
                tx.set(doc.ref.collection("ledger").doc(refund.id), { kind: "refund", id: refund.id, amount: -refund.amount, status: state, method: "stripe", at: now }, { merge: true });
                tx.update(doc.ref, { refund: { ...latest.refund, state, id: refund.id }, refundAt: state === "pending" ? now + 5 * MINUTE : null });
            });
        }
        catch (error) {
            firebase_functions_1.logger.error("Appointment refund needs reconciliation", { appointmentId: doc.id, reason: error instanceof Error ? error.message : String(error) });
        }
    }
}
async function handleAppointments(db, auth, req, res, action) {
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }
    const body = req.body;
    if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) || req.rawBody.length > 16384) {
        res.status(400).json({ ok: false, error: "invalid_request" });
        return;
    }
    try {
        let result;
        if (action === "details") {
            result = await detailsFromLink(db, identifier(body.id), body.token);
        }
        else if (action === "quote-context") {
            const quote = await bookingQuote(db, body.quoteReceipt);
            result = quote ? {
                service: quote.service, vehicle: quote.vehicle ?? null, estimateCents: quote.estimateCents, phoneEnding: quote.phoneEnding,
            } : null;
        }
        else if (action === "site-content") {
            result = await (0, appointment_content_1.publicSiteContent)(db);
        }
        else if (["maintenance-offer", "maintenance-enroll"].includes(action)) {
            result = await maintenanceEnrollment(db, body, action === "maintenance-enroll");
        }
        else if (action === "booking-options") {
            const settings = await getSettings(db);
            const enabled = settings.enabled && !!await (0, appointment_stripe_1.stripeConfig)() && !!await (0, appointment_calendar_1.calendarConfig)();
            const tax = await getTaxSettings(db);
            result = { enabled, services: enabled ? settings.services.map(service => ({ ...service, vehiclePrices: (0, appointment_booking_1.bookingPrices)(service) })) : [], horizonDays: settings.horizonDays, depositPolicy: DEPOSIT_POLICY, depositCents: DEPOSIT_CENTS,
                salesTax: { enabled: tax.enabled, rateBasisPoints: tax.enabled ? tax.rateBasisPoints : 0 } };
        }
        else if (action === "sales-tax") {
            const tax = await getTaxSettings(db);
            result = { enabled: tax.enabled, rateBasisPoints: tax.enabled ? tax.rateBasisPoints : 0 };
        }
        else if (action === "availability") {
            result = await getAvailability(db, body);
        }
        else if (action === "book") {
            result = await publicBooking(db, auth, req, body);
        }
        else if (action === "deposit-status") {
            // Lets the booking page tell a signed-in returning customer up front that no deposit is due.
            result = { waived: await depositWaived(db, await authenticatedCustomer(auth, req)) };
        }
        else if (["my-appointments", "my-link", "claim-appointment"].includes(action)) {
            result = await customerAccount(db, auth, req, body, action);
        }
        else if (action === "checkout") {
            result = await openCheckout(db, identifier(body.id), body);
        }
        else if (action === "recheck-payment") {
            const id = identifier(body.id);
            const appointment = await readAppointment(db, id);
            assertLink(id, body.token, appointment);
            const config = await (0, appointment_stripe_1.stripeConfig)();
            if (config && appointment.checkout?.id)
                await applyStripeSession(db, await (0, appointment_stripe_1.stripeSession)(config, appointment.checkout.id));
            result = await detailsFromLink(db, id, body.token);
        }
        else if (action === "customer-cancel") {
            const id = identifier(body.id);
            const ref = db.collection("appointments").doc(id);
            result = await db.runTransaction(async (tx) => {
                const appointment = (await tx.get(ref)).data();
                assertLink(id, body.token, appointment);
                if (appointment.status === "cancelled")
                    return customerDetails(appointment);
                if (appointment.checkout)
                    throw new AppointmentError(409, "checkout_active");
                const now = Date.now();
                if (appointment.start <= now || !["awaiting_deposit", "pending_approval", "confirmed"].includes(appointment.status)) {
                    throw new AppointmentError(409, "status_changed");
                }
                if (body.accepted !== true)
                    throw new AppointmentError(400, "policy_acceptance_required");
                if (body.expectedRefund !== customerDetails(appointment).depositRefundable) {
                    throw new AppointmentError(409, "cancellation_terms_changed");
                }
                return customerDetails(await cancelAppointment(db, tx, id, appointment, "customer_link", false, "Customer cancelled.", now));
            });
        }
        else if (action === "accept-alternate") {
            result = await acceptAlternate(db, identifier(body.id), body);
        }
        else if (action === "request-reschedule") {
            const id = identifier(body.id);
            const start = validMoveStart(body.start);
            const ref = db.collection("appointments").doc(id);
            result = await db.runTransaction(async (tx) => {
                const appointment = (await tx.get(ref)).data();
                assertLink(id, body.token, appointment);
                if (appointment.start <= Date.now() || !["confirmed", "pending_approval"].includes(appointment.status)) {
                    throw new AppointmentError(409, "status_changed");
                }
                const rescheduleRequest = { start, requestedAt: Date.now() };
                tx.update(ref, { rescheduleRequest });
                return customerDetails({ ...appointment, rescheduleRequest });
            });
        }
        else {
            const uid = await adminUid(db, auth, req, action.startsWith("cms-"));
            if (action.startsWith("cms-"))
                result = await (0, appointment_content_1.manageSiteContent)(db, uid, action, body);
            else if (action === "context")
                result = await appointmentContext(db, body);
            else if (action === "admin-availability")
                result = await getAvailability(db, body, true);
            else if (action === "owner-detail") {
                const id = identifier(body.id);
                const appointment = await readAppointment(db, id);
                if (!appointment)
                    throw new AppointmentError(404, "record_not_found");
                result = adminDetails(id, appointment);
            }
            else if (action === "create")
                result = await createAppointment(db, uid, body);
            else if (action === "booking-settings") {
                const settings = await getSettings(db);
                result = { ...settings, services: settings.services.map(service => ({ ...service, vehiclePrices: (0, appointment_booking_1.bookingPrices)(service) })) };
            }
            else if (action === "save-booking-settings") {
                const settings = (0, appointment_booking_1.parseBookingSettings)(body);
                if (!settings)
                    throw new AppointmentError(400, "invalid_booking_settings");
                if (settings.enabled) {
                    if (!(await (0, appointment_stripe_1.stripeConfig)().catch(() => null)))
                        throw new AppointmentError(503, "stripe_config_unavailable");
                    if (!(await (0, appointment_calendar_1.calendarConfig)().catch(() => null)))
                        throw new AppointmentError(503, "calendar_config_unavailable");
                }
                await db.runTransaction(async (tx) => {
                    const previous = await tx.get(settingsDoc(db));
                    if ((previous.get("revision") ?? "") !== (body.revision ?? ""))
                        throw new AppointmentError(409, "settings_updated");
                    result = { ...settings, revision: (0, node_crypto_1.randomBytes)(16).toString("hex") };
                    tx.set(settingsDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
                    tx.create(settingsDoc(db).collection("versions").doc(), { ...result, updatedBy: uid, updatedAt: Date.now() });
                });
            }
            else if (action === "tax-settings")
                result = await getTaxSettings(db);
            else if (action === "save-tax-settings") {
                const tax = (0, appointment_tax_1.parseTaxSettings)(body);
                if (!tax)
                    throw new AppointmentError(400, "invalid_tax_settings");
                await db.runTransaction(async (tx) => {
                    const previous = await tx.get(taxDoc(db));
                    if ((previous.get("revision") ?? "") !== (body.revision ?? ""))
                        throw new AppointmentError(409, "settings_updated");
                    result = { ...tax, revision: (0, node_crypto_1.randomBytes)(16).toString("hex") };
                    tx.set(taxDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
                    tx.create(taxDoc(db).collection("versions").doc(), { ...result, updatedBy: uid, updatedAt: Date.now() });
                });
            }
            else if (action === "list") {
                const recent = await db.collection("appointments").orderBy("createdAt", "desc").limit(50).get();
                result = recent.docs.map(doc => adminDetails(doc.id, doc.data()));
            }
            else if (action === "payment-export") {
                const from = typeof body.from === "number" && Number.isSafeInteger(body.from) ? body.from : Date.now() - 365 * DAY;
                const till = typeof body.till === "number" && Number.isSafeInteger(body.till) ? body.till : Date.now();
                const records = await db.collectionGroup("ledger").where("at", ">=", from).where("at", "<=", till).orderBy("at").limit(1001).get();
                if (records.size > 1000)
                    throw new AppointmentError(400, "export_range_too_large");
                const cell = (value) => `"${String(value ?? "").replace(/^[=+@\-\s]/, match => "'" + match).replace(/"/g, '""')}"`;
                const rows = records.docs.map(row => {
                    const { at, kind, method, amount, by, reference, status, clearance, taxCents } = row.data();
                    return [row.ref.parent.parent?.id, row.id, new Date(at).toISOString(), kind ?? "manual_payment", method, status ?? clearance ?? "recorded",
                        by, reference].map(cell).join(",") + `,${Number.isSafeInteger(amount) ? amount : ""},${Number.isSafeInteger(taxCents) ? taxCents : 0}`;
                });
                result = { csv: ["appointment,transaction,utc_time,kind,method,status,operator,reference,amount_cents,tax_cents", ...rows].join("\r\n") };
            }
            else if (["update-contact", "cancel", "issue-link", "revoke-link", "approve", "no-show", "start-job", "save-job", "finish-job", "record-payment", "reverse-payment", "clear-check", "return-check", "reschedule", "reject-reschedule", "offer-alternate", "maintenance-invite"].includes(action)) {
                result = await changeAppointment(db, uid, identifier(body.id), action, body);
            }
            else
                throw new AppointmentError(404, "not_found");
        }
        res.json({ ok: true, result });
    }
    catch (error) {
        if (error instanceof AppointmentError || error instanceof appointment_content_1.ContentError) {
            res.status(error.status).json({ ok: false, error: error.code });
        }
        else {
            firebase_functions_1.logger.error("Appointment operation failed", { action, code: error?.code });
            res.status(500).json({ ok: false, error: "appointment_operation_failed" });
        }
    }
}
async function handleStripeWebhook(db, req, res) {
    if (req.method !== "POST") {
        res.sendStatus(405);
        return;
    }
    try {
        const config = await (0, appointment_stripe_1.stripeConfig)();
        if (!config) {
            res.sendStatus(503);
            return;
        }
        const event = (0, appointment_stripe_1.verifyStripeEvent)(req.rawBody, req.get("Stripe-Signature") ?? "", config.webhookSecret);
        if (!event) {
            res.sendStatus(400);
            return;
        }
        const checkoutEvent = ["checkout.session.completed", "checkout.session.expired"].includes(event.type);
        const ledgerEvent = ["charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"].includes(event.type);
        if (!checkoutEvent && !ledgerEvent) {
            res.sendStatus(204);
            return;
        }
        const receipt = db.collection("appointmentStripeEvents").doc(event.id);
        const existing = await receipt.get();
        if (existing.get("completedAt")) {
            res.sendStatus(204);
            return;
        }
        const sessionId = event.data.object.id;
        await receipt.set({ sessionId, type: event.type, receivedAt: Date.now() }, { merge: true });
        if (checkoutEvent)
            await applyStripeSession(db, await (0, appointment_stripe_1.stripeSession)(config, sessionId));
        else {
            const change = await (0, appointment_stripe_1.stripeMoneyChange)(config, event);
            if (change && HASH.test(change.appointmentId)) {
                const ref = db.collection("appointments").doc(change.appointmentId);
                await db.runTransaction(async (tx) => {
                    const appointment = (await tx.get(ref)).data();
                    if (!appointment)
                        return;
                    const deposit = appointment.depositIntent === change.intent;
                    const balance = appointment.payments?.some(payment => payment.method === "stripe" && payment.reference === change.intent);
                    if (!deposit && !balance) {
                        if (appointment.checkout)
                            throw new Error("stripe_capture_pending");
                        return;
                    }
                    // An internally requested full deposit refund is already tracked by the refund worker.
                    if (deposit && appointment.refund && change.kind === "refund" && change.amount === appointment.paidDeposit)
                        return;
                    const existing = await tx.get(ref.collection("ledger").doc(event.id));
                    if (existing.exists)
                        return;
                    tx.create(existing.ref, { kind: `stripe_${change.kind}_review`, method: "stripe", amount: 0, at: Date.now(),
                        reference: change.stripeObjectId, status: change.stripeStatus, reportedAmount: change.amount });
                    if (appointment.paymentReview?.kind !== "dispute" || change.kind === "dispute") {
                        tx.update(ref, { paymentReview: change });
                    }
                });
            }
        }
        await receipt.set({ completedAt: Date.now() }, { merge: true });
        res.sendStatus(204);
    }
    catch {
        firebase_functions_1.logger.error("Stripe webhook processing failed");
        res.sendStatus(503);
    }
}
