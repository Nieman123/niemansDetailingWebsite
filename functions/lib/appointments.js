"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyStripeSession = applyStripeSession;
exports.reconcileAppointments = reconcileAppointments;
exports.handleAppointments = handleAppointments;
exports.handleStripeWebhook = handleStripeWebhook;
const node_crypto_1 = require("node:crypto");
const firebase_functions_1 = require("firebase-functions");
const appointment_email_1 = require("./appointment-email");
const appointment_content_1 = require("./appointment-content");
const appointment_calendar_1 = require("./appointment-calendar");
const appointment_booking_1 = require("./appointment-booking");
const appointment_stripe_1 = require("./appointment-stripe");
const DAY = 86400000;
const DEPOSIT_CENTS = 5000;
const ID = /^[\w-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MINUTE = 60000;
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
function buildAppointment(body, uid, now) {
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
    const name = text(body.name, 150);
    const service = text(body.service, 150);
    const address = text(body.address, 400);
    const email = text(body.email, 250);
    const rawPhone = text(body.phone, 48);
    const digits = rawPhone.replace(/\D/g, "");
    if (!name || !service || !address || (!email && !rawPhone) || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
        (rawPhone && !/^1?\d{10}$/.test(digits))) {
        throw new AppointmentError(400, "invalid_details");
    }
    if (body.deposit !== "required" && body.deposit !== "waived")
        throw new AppointmentError(400, "invalid_deposit");
    const waived = body.deposit === "waived";
    if (waived && body.calendarChecked !== true)
        throw new AppointmentError(400, "calendar_check_required");
    return {
        clientId: identifier(body.clientId, true), leadId: identifier(body.leadId, true),
        name, service, address, email, phone: digits ? `+1${digits.slice(-10)}` : "",
        vehicle: text(body.vehicle, 150), preparation: text(body.preparation, 1500),
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
async function assertCalendarOpen(appointment, manual, except) {
    try {
        const config = await (0, appointment_calendar_1.calendarConfig)();
        if (!config) {
            if (manual)
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
    return { service, vehicle, address, preparation, start, end, estimateCents, depositCents, status, paidDeposit,
        refundState: appointment.refund?.state ?? null,
        finalCents: appointment.finalCents ?? null, balanceCents: remainingBalance(appointment),
        invoiceLines: appointment.invoiceLines ?? [],
        depositDeadline: appointment.depositDeadline ?? null, preapproved: !!appointment.preapproved,
        depositPolicy: appointment.acceptedPolicy ?? DEPOSIT_POLICY,
        calendarSequence: appointment.calendarSequence ?? 0,
        hasRescheduleRequest: !!appointment.rescheduleRequest,
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
    };
}
function remainingBalance(appointment) {
    if (appointment.finalCents === undefined)
        return null;
    return Math.max(0, appointment.finalCents - (appointment.paidDeposit ?? 0) -
        (appointment.payments ?? []).reduce((total, entry) => ["pending", "returned"].includes(entry.clearance ?? "") ? total : total + entry.amount, 0));
}
const hasPendingCheck = (appointment) => (appointment.payments ?? []).some(entry => entry.clearance === "pending");
function depositLock(appointment, now) {
    return appointment.depositLockedAt || ((appointment.paidDeposit ?? 0) > 0 && appointment.start - now < 96 * 60 * MINUTE ? now : null);
}
function maintenanceDeadline(appointment) {
    if (appointment.status !== "completed" || !appointment.completedAt || !appointment.email ||
        remainingBalance(appointment) !== 0 || !/\b(full detail|the works)\b/i.test(appointment.service))
        return null;
    const start = Date.parse(`${(0, appointment_booking_1.easternDate)(appointment.completedAt)}T12:00:00Z`);
    const through = new Date(start + 60 * DAY).toISOString().slice(0, 10);
    return (0, appointment_booking_1.easternDate)(Date.now()) <= through ? through : null;
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
    const requested = buildAppointment(body, uid, Date.now());
    if (requested.status === "confirmed")
        await assertCalendarOpen(requested, body.calendarChecked === true);
    return db.runTransaction(async (tx) => {
        const existing = (await tx.get(ref)).data();
        if (existing)
            return adminDetails(id, existing);
        const now = Date.now();
        const appointment = buildAppointment(body, uid, now);
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
    const previous = await readAppointment(db, id);
    if (!previous)
        throw new AppointmentError(404, "record_not_found");
    let newStart;
    if (action === "reschedule" || action === "offer-alternate") {
        newStart = validMoveStart(body.start ?? previous.rescheduleRequest?.start);
        await assertCalendarOpen({ ...previous, start: newStart, end: newStart + previous.end - previous.start }, body.calendarChecked === true, id);
    }
    else if (action === "approve" || (action === "issue-link" && previous.status === "draft" && stripe)) {
        await assertCalendarOpen(previous, body.calendarChecked === true, id);
    }
    return db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        if (!appointment)
            throw new AppointmentError(404, "record_not_found");
        const now = Date.now();
        if (action === "offer-alternate") {
            if (!newStart || appointment.status !== "pending_approval" || appointment.start <= now || appointment.start !== previous.start) {
                throw new AppointmentError(409, "status_changed");
            }
            const offer = { start: newStart, offeredAt: now, expiresAt: Math.min(appointment.start, newStart, now + DAY) };
            tx.update(ref, { alternateOffer: offer, alternateOfferedBy: uid });
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
                const update = { ...work, status: "completed", finalCents: final, invoiceLines, completedAt: now, completedBy: uid };
                tx.update(ref, update);
                return adminDetails(id, { ...appointment, ...update });
            }
            const update = action === "start-job" ? { status: "in_progress", startedAt: now, startedBy: uid } : work;
            tx.update(ref, update);
            return adminDetails(id, { ...appointment, ...update });
        }
        if (action === "record-payment" || action === "reverse-payment" || action === "clear-check" || action === "return-check") {
            if (appointment.status !== "completed" || appointment.checkout)
                throw new AppointmentError(409, "checkout_active");
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
                tx.update(ref, { payments: [...revised, entry] });
                return adminDetails(id, { ...appointment, payments: [...revised, entry] });
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
            const entry = { id: operation, amount: amount, method: entryMethod, reference, by: uid, at: now,
                ...(entryMethod === "check" ? { clearance: "pending" } : {}),
            };
            tx.create(ref.collection("ledger").doc(operation), entry);
            tx.update(ref, { payments: [...payments, entry] });
            return adminDetails(id, { ...appointment, payments: [...payments, entry] });
        }
        if (action === "maintenance-invite") {
            const through = maintenanceDeadline(appointment);
            if (!through || appointment.maintenanceEnrolledAt || body.permitted !== true)
                throw new AppointmentError(409, "maintenance_unavailable");
            const token = (0, node_crypto_1.randomBytes)(32).toString("hex");
            const url = `${checkoutOrigin()}/maintenance#${id}.${token}`;
            tx.update(ref, { maintenanceInvite: { hash: digest(token), through }, maintenanceInvitedBy: uid, maintenanceInvitedAt: now });
            if (body.sendEmail === true)
                (0, appointment_email_1.queueAppointmentEmail)(db, tx, `maintenance-${id}-${now}`, appointment.email, "Monthly maintenance detailing invitation", `Review and request monthly detailing by ${through}: ${url}\n\nEach visit is paid separately.`);
            return { url };
        }
        if (action === "revoke-link") {
            tx.update(ref, { linkHash: null, linkRevokedAt: now, linkUpdatedBy: uid });
            return {};
        }
        if (appointment.status === "draft") {
            if (!stripe)
                throw new AppointmentError(503, "stripe_unavailable");
            if (body.calendarChecked !== true)
                throw new AppointmentError(400, "calendar_check_required");
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
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `share-${id}-${now}`, appointment.email, "Your detailing appointment details", `View the details and status of your ${appointment.service} appointment here: ${url}`);
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
    await assertCalendarOpen(moved, false, id);
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
async function getSettings(db) {
    return (await settingsDoc(db).get()).data() ?? appointment_booking_1.emptyBookingSettings;
}
async function getAvailability(db, body) {
    const settings = await getSettings(db);
    const service = settings.services.find(item => item.id === body.serviceId);
    const date = text(body.date, 10);
    if (!service || !settings.enabled)
        return { slots: [] };
    const candidates = (0, appointment_booking_1.bookingSlots)(settings, date, service, Date.now());
    if (!candidates.length)
        return { slots: [] };
    const lower = candidates[0] - settings.bufferMinutes * MINUTE;
    const upper = candidates[candidates.length - 1] + (settings.bufferMinutes + service.duration) * MINUTE;
    const [config, ...days] = await Promise.all([(0, appointment_calendar_1.calendarConfig)(), ...reservationDays(db, { id: "", start: lower, end: upper }).map(ref => ref.get())]);
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
async function publicBooking(db, auth, req, body) {
    const settings = await getSettings(db);
    const service = settings.services.find(item => item.id === body.serviceId);
    if (!settings.enabled || !service || !(await (0, appointment_stripe_1.stripeConfig)()))
        throw new AppointmentError(503, "booking_unavailable");
    if (!settings.postalCodes.includes(text(body.postalCode, 5)))
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
    if (!email)
        throw new AppointmentError(400, "invalid_details");
    const postalCode = text(body.postalCode, 5);
    const appointment = buildAppointment({
        ...body, address: `${text(body.address, 390)} ${postalCode}`,
        clientId: null, leadId: null, email, service: service.name,
        durationMinutes: service.duration, estimateCents: service.cents, deposit: "required",
    }, customer?.uid ?? "guest", Date.now());
    if (!text(body.address, 390) || !(0, appointment_booking_1.bookingSlots)(settings, (0, appointment_booking_1.easternDate)(appointment.start), service, Date.now()).includes(appointment.start)) {
        throw new AppointmentError(409, "time_unavailable");
    }
    appointment.bufferMinutes = settings.bufferMinutes;
    const receipt = body.quoteReceipt;
    if (HASH.test(receipt?.id ?? "") && HASH.test(receipt?.token ?? "")) {
        const lead = (await db.collection("leads").doc(receipt.id).get()).data();
        if (lead && !lead.honeypot && lead.addon_token_hash === digest(receipt.token) && lead.addon_token_expires_at > Date.now()) {
            appointment.leadId = receipt.id;
            if (lead.service === service.id && typeof lead.quoted_total === "number")
                appointment.estimateCents = Math.round(lead.quoted_total * 100);
        }
    }
    await assertCalendarOpen(appointment, false);
    const ref = db.collection("appointments").doc(id);
    const throttle = db.collection("appointmentBookingHolds").doc(digest(email.toLowerCase()));
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
        const hold = await tx.get(throttle);
        if ((hold.get("until") ?? 0) > now && hold.get("appointmentId") !== id) {
            const held = await tx.get(db.collection("appointments").doc(hold.get("appointmentId")));
            if (held.get("status") === "awaiting_deposit")
                throw new AppointmentError(409, "existing_booking_hold");
        }
        await updateReservation(db, tx, reservationFor(id, appointment), false, now);
        const deadline = now + 40 * MINUTE;
        const record = {
            ...appointment, status: "awaiting_deposit", preapproved: false,
            depositDeadline: deadline, reconcileAt: deadline, linkHash: digest(token), linkExpiresAt: appointment.end + 30 * DAY,
            acceptedPolicy: DEPOSIT_POLICY, policyVersion: POLICY_VERSION,
            ...(customer ? { customerUid: customer.uid } : {}),
        };
        tx.create(ref, { ...record, bookingChannel: "public", acceptedAt: now });
        tx.set(throttle, { until: deadline, appointmentId: id });
        (0, appointment_email_1.queueAppointmentEmail)(db, tx, `request-${id}`, email, "Continue your detailing appointment request", `Open your appointment to pay the deposit and follow its status: ${checkoutOrigin()}/appointment#${id}.${token}`);
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
    return { ...appointment, ...update };
}
function checkoutOrigin() {
    const origin = process.env.HOSTING_ORIGIN ?? "";
    const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
    if (!project || origin !== `https://${project}.web.app`)
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
    if (current.checkout?.id)
        await applyStripeSession(db, await (0, appointment_stripe_1.stripeSession)(config, current.checkout.id));
    const reservation = await db.runTransaction(async (tx) => {
        const appointment = (await tx.get(ref)).data();
        assertLink(id, body.token, appointment);
        const now = Date.now();
        const deposit = appointment.status === "awaiting_deposit";
        if (hasPendingCheck(appointment))
            throw new AppointmentError(409, "check_pending");
        const amount = deposit ? appointment.depositCents : appointment.status === "completed" ? remainingBalance(appointment) : 0;
        if (!amount || amount < 50)
            throw new AppointmentError(409, "nothing_due");
        if (body.accepted !== true)
            throw new AppointmentError(400, "policy_acceptance_required");
        if (appointment.checkout)
            return appointment.checkout;
        const expiresAt = Math.min(deposit ? appointment.depositDeadline ?? 0 : Infinity, now + 35 * MINUTE);
        if (expiresAt - now < 31 * MINUTE)
            throw new AppointmentError(409, "checkout_too_close");
        const kind = deposit ? "deposit" : "balance";
        const checkout = {
            attempt: (0, node_crypto_1.randomBytes)(16).toString("hex"), kind, expiresAt, amount, origin,
            disclosure: deposit ? DEPOSIT_POLICY : "Pay the outstanding balance for your completed detail.",
        };
        tx.update(ref, { checkout, reconcileAt: expiresAt,
            ...(deposit ? { policyVersion: POLICY_VERSION, acceptedPolicy: DEPOSIT_POLICY, acceptedAt: now } : {}),
        });
        return checkout;
    });
    const session = reservation.id
        ? await (0, appointment_stripe_1.stripeSession)(config, reservation.id)
        : await (0, appointment_stripe_1.createStripeSession)(config, { id, ...reservation });
    if (session.livemode !== false || session.metadata.appointmentId !== id || session.metadata.attemptId !== reservation.attempt ||
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
    if (!HASH.test(id ?? "") || session.livemode !== false || !/^cs_test_\w+$/.test(session.id))
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
        tx.create(ledger, { kind: checkout.kind, id: session.id, amount: checkout.amount, method: "stripe", at: now, intent: session.payment_intent, livemode: false });
        if (checkout.kind === "balance") {
            const entry = { id: session.id, amount: checkout.amount, method: "stripe", at: now, by: "stripe", reference: session.payment_intent };
            tx.update(ref, { checkout: null, reconcileAt: null, payments: [...(appointment.payments ?? []), entry] });
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `receipt-${session.id}`, appointment.email, "Detailing payment received", `We received your payment of $${(checkout.amount / 100).toFixed(2)} for ${appointment.service}.`);
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
            (0, appointment_email_1.queueAppointmentEmail)(db, tx, `receipt-${session.id}`, appointment.email, "Detailing deposit received", late ? "The deposit arrived after the appointment start, and a refund has been queued." :
                `Your $50 deposit was received. ${status === "confirmed" ? "Your appointment is confirmed." : "Your appointment is pending approval."}`);
        }
    });
}
async function reconcileAppointments(db) {
    const config = await (0, appointment_stripe_1.stripeConfig)();
    const now = Date.now();
    const collection = db.collection("appointments");
    await (0, appointment_email_1.deliverAppointmentEmails)(db, now).catch(() => firebase_functions_1.logger.error("Appointment email delivery needs review"));
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
                const session = checkout.id ? await (0, appointment_stripe_1.stripeSession)(config, checkout.id) : await (0, appointment_stripe_1.createStripeSession)(config, { id: doc.id, ...checkout });
                await applyStripeSession(db, session);
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
        catch {
            firebase_functions_1.logger.error("Appointment payment needs reconciliation", { appointmentId: doc.id });
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
        catch {
            firebase_functions_1.logger.error("Appointment refund needs reconciliation", { appointmentId: doc.id });
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
        else if (action === "site-content") {
            result = await (0, appointment_content_1.publicSiteContent)(db);
        }
        else if (["maintenance-offer", "maintenance-enroll"].includes(action)) {
            result = await maintenanceEnrollment(db, body, action === "maintenance-enroll");
        }
        else if (action === "booking-options") {
            const settings = await getSettings(db);
            const enabled = settings.enabled && !!await (0, appointment_stripe_1.stripeConfig)() && !!await (0, appointment_calendar_1.calendarConfig)();
            result = { enabled, services: enabled ? settings.services : [], horizonDays: settings.horizonDays, depositPolicy: DEPOSIT_POLICY, depositCents: DEPOSIT_CENTS };
        }
        else if (action === "availability") {
            result = await getAvailability(db, body);
        }
        else if (action === "book") {
            result = await publicBooking(db, auth, req, body);
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
            else if (action === "create")
                result = await createAppointment(db, uid, body);
            else if (action === "booking-settings")
                result = await getSettings(db);
            else if (action === "save-booking-settings") {
                const settings = (0, appointment_booking_1.parseBookingSettings)(body);
                if (!settings)
                    throw new AppointmentError(400, "invalid_booking_settings");
                if (settings.enabled && (!(await (0, appointment_stripe_1.stripeConfig)()) || !(await (0, appointment_calendar_1.calendarConfig)())))
                    throw new AppointmentError(503, "booking_unavailable");
                await db.runTransaction(async (tx) => {
                    const previous = await tx.get(settingsDoc(db));
                    if ((previous.get("revision") ?? "") !== (body.revision ?? ""))
                        throw new AppointmentError(409, "settings_updated");
                    result = { ...settings, revision: (0, node_crypto_1.randomBytes)(16).toString("hex") };
                    tx.set(settingsDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
                    tx.create(settingsDoc(db).collection("versions").doc(), { ...result, updatedBy: uid, updatedAt: Date.now() });
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
                    const { at, kind, method, amount, by, reference, status, clearance } = row.data();
                    return [row.ref.parent.parent?.id, row.id, new Date(at).toISOString(), kind ?? "manual_payment", method, status ?? clearance ?? "recorded",
                        by, reference].map(cell).join(",") + `,${Number.isSafeInteger(amount) ? amount : ""}`;
                });
                result = { csv: ["appointment,transaction,utc_time,kind,method,status,operator,reference,amount_cents", ...rows].join("\r\n") };
            }
            else if (["cancel", "issue-link", "revoke-link", "approve", "no-show", "start-job", "save-job", "finish-job", "record-payment", "reverse-payment", "clear-check", "return-check", "reschedule", "reject-reschedule", "offer-alternate", "maintenance-invite"].includes(action)) {
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
        if (!["checkout.session.completed", "checkout.session.expired"].includes(event.type)) {
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
        await applyStripeSession(db, await (0, appointment_stripe_1.stripeSession)(config, sessionId));
        await receipt.set({ completedAt: Date.now() }, { merge: true });
        res.sendStatus(204);
    }
    catch {
        firebase_functions_1.logger.error("Stripe webhook processing failed");
        res.sendStatus(503);
    }
}
