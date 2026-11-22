import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { deliverAppointmentEmails, emailConfigured, queueAppointmentEmail } from "./appointment-email";
import { describeOpsEvent, pruneOpsEvents, recordOpsEvent } from "./ops-health";
import { telegramConfigured } from "./telegram";
import { createShortLink, resolveShortLink, shortLinkPath } from "./appointment-short-links";
import { liveMode } from "./appointment-secrets";
import { emailSiteOrigin } from "./appointment-email-template";
import { ContentError, manageSiteContent, publicSiteContent } from "./appointment-content";
import { busyWindows, calendarConfig, mirrorAppointment } from "./appointment-calendar";
import { bookingPrices, bookingSlots, bookingVehicle, businessHours, easternDate, emptyBookingSettings, parseBookingSettings, type BookingSettings } from "./appointment-booking";
import {
  createStripeSession, findCheckoutAttempt, isSessionId, releaseStripeSession, stripeConfig, stripeMoneyChange, stripeRefund, stripeSession, verifyStripeEvent,
  type StripeSession,
} from "./appointment-stripe";
import { bookingIdFor, clientChanges, clientEmail, findClientForJob, saveJobToClient, type ClientJob } from "./appointment-clients";
import { defaultTaxSettings, parseTaxSettings, taxLineLabel, taxOn, taxPortion, taxRateLabel, type TaxSettings } from "./appointment-tax";

const DAY = 86_400_000;
const DEPOSIT_CENTS = 5000;
const ID = /^[\w-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MINUTE = 60_000;
// Stripe requires a session to stay open at least 30 minutes, so the app ends it itself after the hold.
const CHECKOUT_WINDOW = 35 * MINUTE;
const CHECKOUT_HOLD = 10 * MINUTE;
const POLICY_VERSION = "deposit-v1";
const DEPOSIT_POLICY = "The $50 deposit applies toward service. Before approval, you can cancel for a full refund. After confirmation, cancel at least 96 hours before the appointment for a refund. Inside 96 hours or for a no-show, the deposit is nonrefundable. An approved reschedule carries your deposit forward without resetting a forfeiture that already applies. If we cancel, you may request a refund or agree to another time.";
const MANUAL_METHODS = new Set(["cash", "check", "venmo", "cash_app", "other"]);
type Checkout = {
  attempt: string; kind: "deposit" | "balance"; amount: number; expiresAt: number;
  id?: string; disclosure: string; origin: string; holdUntil?: number;
  // Part of a balance payment that is sales tax, shown as its own Stripe line.
  taxCents?: number; taxLabel?: string;
};
type PaymentEntry = {
  id: string; method: string; amount: number; at: number; by: string; reference: string; clearance?: "pending" | "cleared" | "returned";
  taxCents?: number;
};
type Refund = { state: "queued" | "pending" | "succeeded" | "failed"; requestedAt: number; id?: string };
type InvoiceLine = { description: string; cents: number };

type Appointment = {
  clientId: string | null;
  leadId: string | null;
  name: string;
  email: string;
  phone: string;
  address: string;
  service: string;
  vehicle: string;
  preparation: string;
  start: number;
  end: number;
  estimateCents: number | null;
  depositCents: number;
  depositWaivedReason?: "returning_customer";
  status: "draft" | "awaiting_deposit" | "pending_approval" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";
  createdAt: number;
  createdBy: string;
  linkHash?: string | null;
  linkExpiresAt?: number;
  accountLinkHash?: string;
  customerShortLinks?: number;
  accountLinkExpiresAt?: number;
  preapproved?: boolean;
  depositDeadline?: number;
  depositIntent?: string;
  paidDeposit?: number;
  refund?: Refund;
  refundAt?: number | null;
  depositLockedAt?: number | null;
  checkout?: Checkout | null;
  reconcileAt?: number | null;
  policyVersion?: string;
  acceptedPolicy?: string;
  // finalCents is the pre-tax invoice subtotal. taxCents is frozen on it at completion when sales tax is on.
  finalCents?: number;
  taxCents?: number;
  // Rate captured at booking for estimates, then the rate actually charged at completion.
  taxRateBasisPoints?: number;
  taxId?: string;
  invoiceLines?: InvoiceLine[];
  payments?: PaymentEntry[];
  workNotes?: string;
  scopeChanges?: string;
  completedAt?: number;
  rescheduleRequest?: { start: number; requestedAt: number };
  alternateOffer?: { start: number; offeredAt: number; expiresAt: number; allowOverlap?: boolean } | null;
  calendarSequence?: number;
  startedAt?: number;
  calendarDueAt?: number | null;
  calendarSyncedAt?: number;
  calendarFailure?: boolean;
  calendarRevision?: string;
  customerUid?: string;
  bufferMinutes?: number;
  // The owner chose to book this time even though it overlaps another booking or calendar event.
  overlapApproved?: boolean;
  maintenanceInvite?: { hash: string; through: string };
  maintenanceInviteAfterPayment?: boolean;
  maintenanceEnrolledAt?: number;
  paymentReview?: { kind: string; amount: number; stripeStatus: string; stripeObjectId: string };
  // What the customer typed in the booking notes box: gate codes, parking, anything Nieman should know.
  customerNotes?: string;
  confirmedAt?: number;
  // The start time the day-before reminder went out for, so a reschedule gets a fresh reminder.
  reminderSentFor?: number;
  reviewRequestedAt?: number;
  bookingChannel?: string;
  // When this finished job was added to the client record's booking history.
  clientBookingSyncedAt?: number;
};

type Reservation = { id: string; start: number; end: number };
const calendarUpdate = (now: number) => ({ calendarDueAt: now, calendarRevision: randomBytes(8).toString("hex") });
const reservationFor = (id: string, appointment: Pick<Appointment, "start" | "end" | "bufferMinutes">): Reservation => ({
  id, start: appointment.start - (appointment.bufferMinutes ?? 0) * MINUTE,
  end: appointment.end + (appointment.bufferMinutes ?? 0) * MINUTE,
});

class AppointmentError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function identifier(value: unknown, optional = false): string | null {
  if (optional && (value == null || value === "")) return null;
  if (typeof value !== "string" || !ID.test(value)) throw new AppointmentError(400, "invalid_identifier");
  return value;
}

function appointmentContact(body: Record<string, unknown>, requirePhone: boolean) {
  const name = text(body.name, 150);
  const address = text(body.address, 400);
  const email = text(body.email, 250);
  const digits = text(body.phone, 48).replace(/\D/g, "");
  if (!name || (requirePhone || !email || text(body.phone, 48)) && !/^1?\d{10}$/.test(digits) ||
      email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppointmentError(400, "invalid_details");
  return { name, email, address, phone: digits ? "+1" + digits.slice(-10) : "", vehicle: text(body.vehicle, 150) };
}

function buildAppointment(body: Record<string, unknown>, uid: string, now: number, requirePhone = false): Appointment {
  const start = body.start;
  const minutes = body.durationMinutes;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start % 60_000 !== 0 || start <= now || start > now + 2 * 366 * DAY ||
      typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 1440) {
    throw new AppointmentError(400, "invalid_time");
  }
  const estimate = body.estimateCents ?? null;
  if (estimate !== null && (typeof estimate !== "number" || !Number.isSafeInteger(estimate) || estimate < 0 || estimate > 10_000_000)) {
    throw new AppointmentError(400, "invalid_price");
  }
  const contact = appointmentContact(body, requirePhone);
  const service = text(body.service, 150) || "Detailing appointment";
  if (body.deposit !== "required" && body.deposit !== "waived") throw new AppointmentError(400, "invalid_deposit");
  const waived = body.deposit === "waived";
  return {
    clientId: identifier(body.clientId, true), leadId: identifier(body.leadId, true),
    ...contact, service, preparation: text(body.preparation, 1500),
    start, end: start + minutes * 60_000, estimateCents: estimate,
    depositCents: waived ? 0 : DEPOSIT_CENTS, status: waived ? "confirmed" : "draft",
    createdAt: now, createdBy: uid,
  };
}

function reservationDays(db: Firestore, { start, end }: Reservation) {
  const refs = [];
  for (let day = Math.floor(start / DAY); day <= Math.floor((end - 1) / DAY); day++) {
    refs.push(db.collection("appointmentDays").doc(String(day)));
  }
  return refs;
}

async function updateReservation(db: Firestore, tx: Transaction, reservation: Reservation, remove: boolean, now: number, before?: Reservation, allowOverlap = false) {
  // Read fixed UTC-day documents, including missing ones, so concurrent bookings serialize.
  const next = reservationDays(db, reservation);
  const newPaths = new Set(next.map(ref => ref.path));
  const oldOnly = before ? reservationDays(db, before).filter(ref => !newPaths.has(ref.path)) : [];
  const days = await tx.getAll(...next, ...oldOnly);
  const activeByDay = days.map(day => ((day.get("slots") ?? []) as Reservation[])
    .filter(slot => slot.end > now && slot.id !== reservation.id));
  if (!remove && !allowOverlap && activeByDay.some(slots => slots.some(slot => slot.start < reservation.end && slot.end > reservation.start))) {
    throw new AppointmentError(409, "time_unavailable");
  }
  days.forEach((day, index) => tx.set(day.ref, { slots: remove || !newPaths.has(day.ref.path) ? activeByDay[index] : [...activeByDay[index], reservation] }));
}

async function assertCalendarOpen(appointment: Pick<Appointment, "start" | "end" | "bufferMinutes">, except?: string) {
  try {
    const config = await calendarConfig();
    if (!config) {
      if (process.env.FUNCTIONS_EMULATOR === "true") return;
      throw new AppointmentError(503, "calendar_unavailable");
    }
    const slot = reservationFor("", appointment);
    if ((await busyWindows(config, slot.start, slot.end, except)).some(busy => busy.start < slot.end && busy.end > slot.start)) {
      throw new AppointmentError(409, "time_unavailable");
    }
  } catch (error) {
    if (error instanceof AppointmentError) throw error;
    throw new AppointmentError(503, "calendar_unavailable");
  }
}

function customerDetails(appointment: Appointment) {
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
    alternateOffer: appointment.alternateOffer && appointment.alternateOffer.expiresAt > Date.now()
      ? { start: appointment.alternateOffer.start, offeredAt: appointment.alternateOffer.offeredAt, expiresAt: appointment.alternateOffer.expiresAt } : null,
    depositRefundable: (appointment.paidDeposit ?? 0) > 0 && (appointment.status === "pending_approval" ||
      (appointment.status === "confirmed" && !depositLock(appointment, Date.now()))),
  };
}

function adminDetails(id: string, appointment: Appointment) {
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
    customerNotes: appointment.customerNotes ?? "",
  };
}

// Money already counted toward the invoice: the deposit plus payments that have not bounced and are not still clearing.
function paidSoFar(appointment: Appointment) {
  return (appointment.paidDeposit ?? 0) +
    (appointment.payments ?? []).reduce((total, entry) => ["pending", "returned"].includes(entry.clearance ?? "") ? total : total + entry.amount, 0);
}

function remainingBalance(appointment: Appointment) {
  if (appointment.finalCents === undefined) return null;
  return Math.max(0, appointment.finalCents + (appointment.taxCents ?? 0) - paidSoFar(appointment));
}

// Tax figures for customer and admin views. Before completion, a rate captured at booking gives an estimate.
function taxDetails(appointment: Appointment) {
  const rate = appointment.taxRateBasisPoints ?? null;
  const final = appointment.finalCents;
  const taxCents = final !== undefined ? appointment.taxCents ?? 0 : null;
  return {
    taxRateBasisPoints: rate, taxCents, taxId: appointment.taxId ?? "",
    totalCents: final !== undefined ? final + (taxCents ?? 0) : null,
    estimateTaxCents: final === undefined && rate && appointment.estimateCents !== null ? taxOn(appointment.estimateCents, rate) : null,
  };
}

const hasPendingCheck = (appointment: Appointment) => (appointment.payments ?? []).some(entry => entry.clearance === "pending");

function depositLock(appointment: Appointment, now: number) {
  return appointment.depositLockedAt || ((appointment.paidDeposit ?? 0) > 0 && appointment.start - now < 96 * 60 * MINUTE ? now : null);
}

const maintenanceService = (service: string) => /\b(full detail|the works)\b/i.test(service);

function maintenanceDeadline(appointment: Appointment) {
  if (appointment.status !== "completed" || !appointment.completedAt || !appointment.email ||
    appointment.paymentReview || hasPendingCheck(appointment) || !(appointment.finalCents && appointment.finalCents > 0) ||
    remainingBalance(appointment) !== 0 || !maintenanceService(appointment.service)) return null;
  const start = Date.parse(`${easternDate(appointment.completedAt)}T12:00:00Z`);
  const through = new Date(start + 60 * DAY).toISOString().slice(0, 10);
  return easternDate(Date.now()) <= through ? through : null;
}

function prepareMaintenanceInvite(db: Firestore, tx: Transaction, id: string, appointment: Appointment, through: string, sendEmail: boolean) {
  const token = randomBytes(32).toString("hex");
  const hash = digest(token);
  const url = checkoutOrigin() + shortLinkPath("maintenance", createShortLink(db, tx, "maintenance", id, token));
  tx.update(db.collection("appointments").doc(id), { maintenanceInvite: { hash, through }, maintenanceInvitedAt: Date.now() });
  if (sendEmail) queueAppointmentEmail(db, tx, `maintenance-${id}-${hash.slice(0, 16)}`, appointment.email,
    "Your monthly maintenance invitation", {
      eyebrow: "Monthly maintenance", heading: "Keep it looking this good",
      paragraphs: [`Thanks for trusting me with your ${appointment.vehicle || "vehicle"}. You're invited to monthly maintenance details that keep it fresh between full details.`,
        `Review the plan and request your visits by ${through}.`],
      action: { label: "See monthly maintenance", url }, note: "Each visit is paid separately.",
    },
    { appointmentId: id, inviteHash: hash });
  return url;
}

function queueOptedInMaintenance(db: Firestore, tx: Transaction, id: string, appointment: Appointment) {
  if (!appointment.maintenanceInviteAfterPayment || appointment.maintenanceInvite || appointment.maintenanceEnrolledAt) return;
  const through = maintenanceDeadline(appointment);
  if (through) prepareMaintenanceInvite(db, tx, id, appointment, through, true);
}

async function adminUid(db: Firestore, auth: Auth, req: Request, contentOnly = false): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
  if (!token) throw new AppointmentError(401, "sign_in_required");
  const identity = await auth.verifyIdToken(token).catch(() => null);
  if (!identity) throw new AppointmentError(401, "sign_in_required");
  const admin = await db.collection("adminUsers").doc(identity.uid).get();
  if (!admin.exists || (!contentOnly && admin.get("role") === "editor")) {
    throw new AppointmentError(403, "access_denied");
  }
  return identity.uid;
}

async function appointmentContext(db: Firestore, body: Record<string, unknown>) {
  const leadId = identifier(body.leadId, true);
  const lead = leadId ? (await db.collection("leads").doc(leadId).get()).data() : undefined;
  const clientId = identifier(body.clientId || lead?.client_id, true);
  const client = clientId ? (await db.collection("clients").doc(clientId).get()).data() : undefined;
  if ((leadId && !lead) || (clientId && !client)) throw new AppointmentError(404, "record_not_found");
  return {
    clientId, leadId,
    name: client?.full_name || lead?.name || "",
    email: client?.email || lead?.email || "",
    phone: client?.phone_e164 || client?.phone || lead?.phone_normalized || lead?.phone || "",
    address: [client?.address, client?.city, [client?.state, client?.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    service: ({ quick: "Quick Once Over", full: "Full Detail", interior_only: "Interior Only", ceramic: "Ceramic Coating" } as Record<string, string>)[text(lead?.service, 50)] || "",
    vehicleType: bookingVehicle(lead?.vehicle) ?? "",
    vehicle: lead?.vehicle_details || ({ sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "Van / 3-row SUV" } as Record<string, string>)[text(lead?.vehicle, 50)] || "",
    estimateCents: typeof lead?.quoted_total === "number" ? Math.round(lead.quoted_total * 100) : null,
    deposit: client?.appointment_deposit_default === "waived" ? "waived" : "required",
  };
}

function clientJob(id: string, appointment: Appointment): ClientJob {
  const totalCents = typeof appointment.finalCents === "number" ? appointment.finalCents + (appointment.taxCents ?? 0) : null;
  return {
    id, date: easternDate(appointment.start), service: appointment.service, totalCents, vehicle: appointment.vehicle ?? "",
    name: appointment.name, email: appointment.email, phone: appointment.phone, address: appointment.address, leadId: appointment.leadId,
  };
}

// A client's appointments for the Clients page: ones linked to the record, plus unlinked ones with
// the same email, which get linked here. Finished jobs that predate the automatic sync are added to
// the booking history once; a booking entry the owner removed afterwards stays removed.
async function clientHistory(db: Firestore, uid: string, body: Record<string, unknown>) {
  const clientId = identifier(body.clientId)!;
  const clientRef = db.collection("clients").doc(clientId);
  const client = (await clientRef.get()).data();
  if (!client) throw new AppointmentError(404, "record_not_found");
  const email = clientEmail(client.email);
  const appointments = db.collection("appointments");
  const [linked, sameEmail] = await Promise.all([
    appointments.where("clientId", "==", clientId).limit(200).get(),
    email ? appointments.where("email", "==", email).limit(200).get() : Promise.resolve(null),
  ]);
  const rows = new Map<string, Appointment>();
  for (const doc of [...linked.docs, ...(sameEmail?.docs ?? [])]) {
    const appointment = doc.data() as Appointment;
    if (!appointment.clientId || appointment.clientId === clientId) rows.set(doc.id, appointment);
  }
  const needsLink = [...rows].filter(([, appointment]) => !appointment.clientId).map(([id]) => id);
  const needsSync = [...rows].filter(([, appointment]) => appointment.status === "completed" && !appointment.clientBookingSyncedAt).map(([id]) => id);
  let record = client;
  if (needsLink.length || needsSync.length) {
    record = await db.runTransaction(async tx => {
      const fresh = (await tx.get(clientRef)).data();
      if (!fresh) throw new AppointmentError(404, "record_not_found");
      const touched = [...new Set([...needsLink, ...needsSync])].slice(0, 200);
      const current = await tx.getAll(...touched.map(id => appointments.doc(id)));
      const now = Date.now();
      const jobs: ClientJob[] = [];
      for (const snapshot of current) {
        const appointment = snapshot.data() as Appointment | undefined;
        if (!appointment || (appointment.clientId && appointment.clientId !== clientId)) continue;
        const sync = appointment.status === "completed" && !appointment.clientBookingSyncedAt;
        if (sync) jobs.push(clientJob(snapshot.id, appointment));
        tx.update(snapshot.ref, { clientId, ...(sync ? { clientBookingSyncedAt: now } : {}) });
        rows.set(snapshot.id, { ...appointment, clientId });
      }
      const changes = clientChanges(fresh, jobs, now);
      if (Object.keys(changes).length) tx.update(clientRef, { ...changes, updated_at: FieldValue.serverTimestamp(), updated_by: uid });
      return { ...fresh, ...changes };
    });
  }
  const list = [...rows].map(([id, appointment]) => {
    const details = adminDetails(id, appointment);
    return {
      id, start: appointment.start, end: appointment.end, status: appointment.status, service: appointment.service, vehicle: appointment.vehicle ?? "",
      totalCents: details.totalCents ?? null, estimateCents: appointment.estimateCents, balanceCents: details.balanceCents ?? null,
      inHistory: (Array.isArray(record.bookings) ? record.bookings : []).some((item: { id?: string }) => item?.id === bookingIdFor(id)),
    };
  }).sort((a, b) => b.start - a.start);
  return {
    appointments: list,
    client: {
      bookings: Array.isArray(record.bookings) ? record.bookings : [], last_service_date: record.last_service_date ?? null,
      next_followup_date: record.next_followup_date ?? null, status: record.status ?? null,
      email: record.email ?? null, phone: record.phone ?? null, phone_e164: record.phone_e164 ?? null,
      address: record.address ?? null, city: record.city ?? null, state: record.state ?? null, zip: record.zip ?? null,
    },
  };
}

async function createAppointment(db: Firestore, uid: string, body: Record<string, unknown>) {
  const requestId = identifier(body.requestId)!;
  const id = digest(`${uid}:${requestId}`);
  const ref = db.collection("appointments").doc(id);
  const previous = await readAppointment(db, id);
  if (previous) return adminDetails(id, previous);
  const bufferMinutes = body.useCalendarSlot === true ? (await getSettings(db)).bufferMinutes : undefined;
  const salesTax = await getTaxSettings(db);
  const requested = buildAppointment(body, uid, Date.now());
  const allowOverlap = body.allowOverlap === true;
  if (bufferMinutes !== undefined) requested.bufferMinutes = bufferMinutes;
  if (requested.status === "confirmed" && !allowOverlap) await assertCalendarOpen(requested);
  return db.runTransaction(async tx => {
    const existing = (await tx.get(ref)).data() as Appointment | undefined;
    if (existing) return adminDetails(id, existing);
    const now = Date.now();
    const appointment = buildAppointment(body, uid, now);
    if (bufferMinutes !== undefined) appointment.bufferMinutes = bufferMinutes;
    if (allowOverlap) appointment.overlapApproved = true;
    if (salesTax.enabled) appointment.taxRateBasisPoints = salesTax.rateBasisPoints;
    const client = appointment.clientId ? db.collection("clients").doc(appointment.clientId) : null;
    const lead = appointment.leadId ? db.collection("leads").doc(appointment.leadId) : null;
    if ((client && !(await tx.get(client)).exists) || (lead && !(await tx.get(lead)).exists)) {
      throw new AppointmentError(404, "record_not_found");
    }
    if (body.saveClientDefault === true && !client) throw new AppointmentError(400, "client_required");
    if (appointment.status === "confirmed") await updateReservation(db, tx, reservationFor(id, appointment), false, now, undefined, allowOverlap);
    tx.create(ref, { ...appointment, ...(appointment.status === "confirmed" ? { confirmedAt: now, confirmedBy: uid, ...calendarUpdate(now) } : {}) });
    if (body.saveClientDefault === true && client) {
      tx.update(client, { appointment_deposit_default: body.deposit, appointment_deposit_updated_at: now, appointment_deposit_updated_by: uid });
    }
    return adminDetails(id, appointment);
  });
}

async function changeAppointment(db: Firestore, uid: string, id: string, action: string, body: Record<string, unknown>) {
  const ref = db.collection("appointments").doc(id);
  const stripe = action === "issue-link" ? await stripeConfig() : null;
  const salesTax = action === "finish-job" ? await getTaxSettings(db) : null;
  let previous = await readAppointment(db, id);
  if (!previous) throw new AppointmentError(404, "record_not_found");
  if (action === "cancel" && previous.checkout?.id) {
    // Cancelling ends an open payment page first. A payment that already went through is recorded
    // before the cancellation, so its refund follows the normal deposit rules.
    const config = await stripeConfig();
    if (config) {
      await applyStripeSession(db, await releaseStripeSession(config, previous.checkout.id));
      previous = await readAppointment(db, id);
      if (!previous) throw new AppointmentError(404, "record_not_found");
    }
  }
  let newStart: number | undefined;
  // The owner can move a booking over a conflict on purpose ("Book it anyway"), as on New booking.
  const allowOverlap = body.allowOverlap === true;
  if (action === "reschedule" || action === "offer-alternate") {
    newStart = validMoveStart(body.start ?? previous.rescheduleRequest?.start);
    if (!allowOverlap) await assertCalendarOpen({ ...previous, start: newStart, end: newStart + previous.end - previous.start }, id);
  } else if ((action === "approve" || (action === "issue-link" && previous.status === "draft" && stripe)) && !previous.overlapApproved) {
    await assertCalendarOpen(previous, id);
  }
  return db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    if (!appointment) throw new AppointmentError(404, "record_not_found");
    const now = Date.now();
    if (action === "update-contact") {
      const contact = appointmentContact(body, false);
      const expected = body.expected as Record<string, unknown> | undefined;
      if (!expected || Object.keys(contact).some(key => expected[key] !== appointment[key as keyof typeof contact])) {
        throw new AppointmentError(409, "status_changed");
      }
      tx.update(ref, { ...contact, ...calendarUpdate(now) });
      return adminDetails(id, { ...appointment, ...contact });
    }
    if (action === "offer-alternate") {
      if (!newStart || appointment.status !== "pending_approval" || appointment.start <= now || appointment.start !== previous.start) {
        throw new AppointmentError(409, "status_changed");
      }
      const offer = { start: newStart, offeredAt: now, expiresAt: Math.min(appointment.start, newStart, now + DAY), ...(allowOverlap ? { allowOverlap: true } : {}) };
      tx.update(ref, { alternateOffer: offer, alternateOfferedBy: uid });
      queueAppointmentEmail(db, tx, `alternate-${id}-${now}`, appointment.email, "A different time for your detail", {
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
        (appointment.status === "pending_approval" && appointment.rescheduleRequest?.start !== newStart)) throw new AppointmentError(409, "status_changed");
      const moved = { ...appointment, start: newStart, end: newStart + appointment.end - appointment.start };
      await updateReservation(db, tx, reservationFor(id, moved), false, now, reservationFor(id, appointment), allowOverlap);
      const locked = appointment.status === "confirmed" ? depositLock(appointment, now) || depositLock(moved, now) : null;
      const update = { start: moved.start, end: moved.end, depositLockedAt: locked, rescheduleRequest: null, alternateOffer: null, overlapApproved: allowOverlap,
        calendarSequence: (appointment.calendarSequence ?? 0) + 1, ...calendarUpdate(now),
        ...(appointment.status === "pending_approval" ? { reconcileAt: moved.start } : {}),
        ...(appointment.linkHash ? { linkExpiresAt: moved.end + 30 * DAY } : {}),
      };
      tx.create(ref.collection("history").doc(), { kind: "reschedule", from: appointment.start, to: moved.start, at: now, by: uid, ...(allowOverlap ? { overlapApproved: true } : {}) });
      tx.update(ref, update);
      queueAppointmentEmail(db, tx, `moved-${id}-${update.calendarSequence}`, appointment.email, "Your detailing appointment time changed", {
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
      if (appointment.status === "cancelled") return adminDetails(id, appointment);
      if (["completed", "in_progress", "no_show"].includes(appointment.status)) throw new AppointmentError(409, "status_changed");
      if (appointment.checkout) throw new AppointmentError(409, "checkout_active");
      const override = body.refundOverride === true;
      const reason = text(body.reason, 300);
      if (override && !reason) throw new AppointmentError(400, "refund_reason_required");
      return adminDetails(id, await cancelAppointment(db, tx, id, appointment, uid, override, reason, now));
    }
    if (action === "approve") {
      if (appointment.status !== "pending_approval" || appointment.start <= now || previous.start !== appointment.start || previous.end !== appointment.end) {
        throw new AppointmentError(409, "status_changed");
      }
      const update = { status: "confirmed" as const, confirmedAt: now, confirmedBy: uid, depositLockedAt: depositLock(appointment, now), reconcileAt: null, ...calendarUpdate(now) };
      tx.update(ref, update);
      queueAppointmentEmail(db, tx, `approved-${id}`, appointment.email, "Your detailing appointment is confirmed", {
          eyebrow: "Confirmed", heading: "You're on the schedule",
          paragraphs: ["Your detail is confirmed. I come to you, so just make sure the vehicle is accessible.", LINK_HINT],
          details: emailFacts(appointment), ...preparationNote(appointment),
        });
      return adminDetails(id, { ...appointment, ...update });
    }
    if (action === "no-show") {
      if (appointment.status !== "confirmed" || appointment.start > now || !text(body.reason, 300)) throw new AppointmentError(409, "status_changed");
      tx.update(ref, { status: "no_show", noShowAt: now, noShowBy: uid, noShowReason: text(body.reason, 300), depositLockedAt: depositLock(appointment, now) });
      return adminDetails(id, { ...appointment, status: "no_show" });
    }
    if (action === "save-notes") {
      // The owner's private notes, editable on any appointment. Admin views and the owner's calendar only.
      const workNotes = text(body.workNotes, 5000);
      const shown = !["draft", "cancelled"].includes(appointment.status);
      const update = { workNotes, workUpdatedAt: now, workUpdatedBy: uid,
        ...(shown && workNotes !== (appointment.workNotes ?? "") ? calendarUpdate(now) : {}) };
      tx.update(ref, update);
      return adminDetails(id, { ...appointment, ...update });
    }
    if (action === "start-job" || action === "save-job" || action === "finish-job") {
      if (!["confirmed", "in_progress"].includes(appointment.status)) throw new AppointmentError(409, "status_changed");
      // A request without notes (an older screen, or a script) keeps the notes already saved.
      const work = { workNotes: typeof body.workNotes === "string" ? text(body.workNotes, 5000) : appointment.workNotes ?? "", scopeChanges: text(body.scopeChanges, 1500), workUpdatedAt: now, workUpdatedBy: uid };
      if (action === "finish-job") {
        const final = body.finalCents;
        if (typeof final !== "number" || !Number.isSafeInteger(final) || final < (appointment.paidDeposit ?? 0) || final > 10_000_000) {
          throw new AppointmentError(400, "invalid_price");
        }
        if (appointment.estimateCents !== null && final > appointment.estimateCents && (!work.scopeChanges || body.scopeAccepted !== true)) {
          throw new AppointmentError(400, "scope_acceptance_required");
        }
        const supplied = body.invoiceLines ?? [{ description: appointment.service, cents: final }];
        if (!Array.isArray(supplied) || !supplied.length || supplied.length > 30 ||
            !supplied.every(item => item && text(item.description, 140) && Number.isSafeInteger(item.cents) && Math.abs(item.cents) <= 10_000_000) ||
            supplied.reduce((total, item) => total + item.cents, 0) !== final) throw new AppointmentError(400, "invalid_line_items");
        const invoiceLines = supplied.map(item => ({ description: text(item.description, 140), cents: item.cents as number }));
        // The owner sees the tax line before completing; refuse if the setting changed since that screen loaded.
        const tax = salesTax ?? defaultTaxSettings;
        const expectedRate = tax.enabled ? tax.rateBasisPoints : 0;
        if ((body.taxRateBasisPoints ?? 0) !== expectedRate) throw new AppointmentError(409, "tax_settings_changed");
        const taxFields = tax.enabled
          ? { taxCents: taxOn(final, tax.rateBasisPoints), taxRateBasisPoints: tax.rateBasisPoints, taxId: tax.taxId }
          : { taxCents: 0 };
        // Transactions read before they write, so find the customer's client record first.
        const clientRecord = await findClientForJob(db, tx, appointment.clientId, appointment.email, appointment.phone);
        const job = clientJob(id, { ...appointment, finalCents: final, taxCents: taxFields.taxCents });
        const clientId = saveJobToClient(db, tx, clientRecord, job, uid, now);
        const update = { ...work, ...calendarUpdate(now), status: "completed" as const, finalCents: final, ...taxFields, invoiceLines, completedAt: now, completedBy: uid,
          maintenanceInviteAfterPayment: body.maintenanceInviteAfterPayment === true && !!appointment.email && maintenanceService(appointment.service),
          clientId, clientBookingSyncedAt: now,
        };
        const completed = { ...appointment, ...update };
        tx.update(ref, update);
        queueOptedInMaintenance(db, tx, id, completed);
        return adminDetails(id, completed);
      }
      const update = action === "start-job" ? { status: "in_progress" as const, startedAt: now, startedBy: uid, ...calendarUpdate(now) } : work;
      tx.update(ref, update);
      return adminDetails(id, { ...appointment, ...update });
    }
    if (action === "record-payment" || action === "reverse-payment" || action === "clear-check" || action === "return-check") {
      if (appointment.status !== "completed" || appointment.checkout) throw new AppointmentError(409, "checkout_active");
      if (appointment.paymentReview) throw new AppointmentError(409, "payment_review_required");
      const operation = identifier(body.requestId)!;
      const payments = appointment.payments ?? [];
      if (payments.some(entry => entry.id === operation)) return adminDetails(id, appointment);
      if (payments.length >= 100) throw new AppointmentError(409, "payment_limit");
      const method = text(body.method, 24);
      let amount = body.amountCents;
      let reference = text(body.reference, 300);
      let entryMethod = method;
      if (action === "clear-check" || action === "return-check") {
        const original = payments.find(entry => entry.id === body.paymentId && entry.method === "check");
        if (!original || original.clearance !== "pending") throw new AppointmentError(409, "payment_unavailable");
        const clearance = action === "clear-check" ? "cleared" as const : "returned" as const;
        const entry: PaymentEntry = { id: operation, amount: 0, method: clearance === "cleared" ? "check_cleared" : "check_returned", reference: original.id, by: uid, at: now };
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
      } else if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0 ||
        amount > (remainingBalance(appointment) ?? 0) || !MANUAL_METHODS.has(method)) {
        throw new AppointmentError(400, "invalid_payment");
      } else if (hasPendingCheck(appointment)) {
        throw new AppointmentError(409, "check_pending");
      }
      // Record how much of each payment is sales tax so collected tax can be reported from the ledger.
      const reversed = entryMethod === "reversal" ? payments.find(payment => payment.id === reference) : undefined;
      const taxCents = reversed ? -(reversed.taxCents ?? 0)
        : taxPortion(appointment.finalCents ?? 0, appointment.taxCents ?? 0, paidSoFar(appointment), amount as number);
      const entry: PaymentEntry = { id: operation, amount: amount as number, method: entryMethod, reference, by: uid, at: now,
        ...(entryMethod === "check" ? { clearance: "pending" as const } : {}), ...(taxCents ? { taxCents } : {}),
      };
      tx.create(ref.collection("ledger").doc(operation), entry);
      const paid = { ...appointment, payments: [...payments, entry] };
      tx.update(ref, { payments: paid.payments });
      queueOptedInMaintenance(db, tx, id, paid);
      return adminDetails(id, paid);
    }
    if (action === "maintenance-invite") {
      const through = maintenanceDeadline(appointment);
      if (!through || appointment.maintenanceEnrolledAt || body.permitted !== true) throw new AppointmentError(409, "maintenance_unavailable");
      const url = prepareMaintenanceInvite(db, tx, id, appointment, through, body.sendEmail === true);
      tx.update(ref, { maintenanceInvitedBy: uid });
      return { url };
    }
    if (action === "revoke-link") {
      tx.update(ref, { linkHash: null, linkRevokedAt: now, linkUpdatedBy: uid });
      return {};
    }
    if (appointment.status === "draft") {
      if (!stripe) throw new AppointmentError(503, "stripe_unavailable");
      if (appointment.start < now + 36 * MINUTE) throw new AppointmentError(409, "checkout_too_close");
      await updateReservation(db, tx, reservationFor(id, appointment), false, now, undefined, !!appointment.overlapApproved);
      const deadline = Math.min(appointment.start, now + DAY);
      tx.update(ref, { status: "awaiting_deposit", preapproved: true, depositDeadline: deadline, reconcileAt: deadline, ...calendarUpdate(now) });
    } else if (!["awaiting_deposit", "confirmed", "in_progress", "completed", "pending_approval"].includes(appointment.status)) {
      throw new AppointmentError(409, "link_unavailable");
    }
    const token = randomBytes(32).toString("hex");
    tx.update(ref, { linkHash: digest(token), linkExpiresAt: appointment.end + 30 * DAY, linkUpdatedAt: now, linkUpdatedBy: uid });
    const code = createShortLink(db, tx, "appointment", id, token);
    if (body.sendEmail === true) {
      const url = checkoutOrigin() + shortLinkPath("appointment", code);
      queueAppointmentEmail(db, tx, `share-${id}-${now}`, appointment.email, "Your detailing appointment details", {
          eyebrow: "Your appointment", heading: "Here's your appointment",
          paragraphs: ["Open your appointment to see its status, add it to your calendar, pay a balance, or request a change."],
          details: emailFacts(appointment), action: { label: "Open my appointment", url },
        });
    }
    return { token, code };
  });
}

async function acceptAlternate(db: Firestore, id: string, body: Record<string, unknown>) {
  const previous = await readAppointment(db, id);
  assertLink(id, body.token, previous);
  const offer = previous.alternateOffer;
  if (body.accepted !== true || previous.status !== "pending_approval" || !offer || offer.expiresAt <= Date.now() || offer.start !== body.start) {
    throw new AppointmentError(409, "status_changed");
  }
  const moved = { ...previous, start: offer.start, end: offer.start + previous.end - previous.start };
  if (!offer.allowOverlap) await assertCalendarOpen(moved, id);
  const ref = db.collection("appointments").doc(id);
  return db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    assertLink(id, body.token, appointment);
    const now = Date.now();
    if (appointment.status !== "pending_approval" || appointment.alternateOffer?.offeredAt !== offer.offeredAt ||
      appointment.start !== previous.start || offer.expiresAt <= now) throw new AppointmentError(409, "status_changed");
    await updateReservation(db, tx, reservationFor(id, moved), false, now, reservationFor(id, appointment), !!offer.allowOverlap);
    const update = {
      start: moved.start, end: moved.end, status: "confirmed" as const, depositLockedAt: depositLock(moved, now), overlapApproved: !!offer.allowOverlap,
      confirmedAt: now, confirmedBy: "accepted_owner_offer", reconcileAt: null,
      alternateOffer: null, rescheduleRequest: null, calendarSequence: (appointment.calendarSequence ?? 0) + 1,
      linkExpiresAt: moved.end + 30 * DAY, ...calendarUpdate(now),
    };
    tx.create(ref.collection("history").doc(), { kind: "accepted_alternate", from: appointment.start, to: moved.start, at: now, by: "customer_link" });
    tx.update(ref, update);
    queueAppointmentEmail(db, tx, `approved-${id}`, appointment.email, "Your detailing appointment is confirmed", {
        eyebrow: "Confirmed", heading: "Your new time is locked in",
        paragraphs: ["Thanks for being flexible. Your detail is confirmed for the new time.", LINK_HINT],
        details: emailFacts(moved), ...preparationNote(appointment),
      });
    return customerDetails({ ...appointment, ...update, alternateOffer: undefined, rescheduleRequest: undefined });
  });
}

async function maintenanceEnrollment(db: Firestore, body: Record<string, unknown>, enroll: boolean) {
  const id = identifier(body.id)!;
  const token = body.token;
  if (!HASH.test(id) || typeof token !== "string" || !HASH.test(token)) throw new AppointmentError(404, "link_unavailable");
  const ref = db.collection("appointments").doc(id);
  return db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    if (!appointment?.maintenanceInvite || appointment.maintenanceInvite.hash !== digest(token) || !maintenanceDeadline(appointment)) {
      throw new AppointmentError(404, "link_unavailable");
    }
    const result = { eligibleThrough: appointment.maintenanceInvite.through, enrolled: !!appointment.maintenanceEnrolledAt };
    if (!enroll || result.enrolled) return result;
    if (body.accepted !== true) throw new AppointmentError(400, "policy_acceptance_required");
    const now = Date.now();
    tx.create(db.collection("maintenanceEnrollments").doc(id), {
      appointmentId: id, clientId: appointment.clientId, name: appointment.name, email: appointment.email,
      vehicle: appointment.vehicle, state: "requested", cadence: "monthly", billing: "per_visit", requestedAt: now,
    });
    tx.update(ref, { maintenanceEnrolledAt: now });
    return { ...result, enrolled: true };
  });
}

async function movingAppointment(db: Firestore, value: unknown) {
  const id = identifier(value, true);
  if (!id) return undefined;
  const appointment = await readAppointment(db, id);
  if (!appointment) throw new AppointmentError(404, "record_not_found");
  return { id, minutes: Math.round((appointment.end - appointment.start) / MINUTE) };
}

const movable = (appointment: Appointment) => appointment.start > Date.now() && ["confirmed", "pending_approval"].includes(appointment.status);

// Open times a customer can ask to move to: the public booking rules (days, hours, notice, blocked dates,
// horizon) and calendars, for the appointment's own length, not counting the appointment itself.
async function customerMoveSlots(db: Firestore, id: string, appointment: Appointment, body: Record<string, unknown>) {
  if (!movable(appointment)) throw new AppointmentError(409, "status_changed");
  const { slots } = await getAvailability(db, body, false, { id, minutes: Math.round((appointment.end - appointment.start) / MINUTE) });
  return slots.filter(start => start !== appointment.start);
}

function validMoveStart(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value % MINUTE !== 0 || value <= Date.now() || value > Date.now() + 2 * 366 * DAY) {
    throw new AppointmentError(400, "invalid_time");
  }
  return value;
}

function assertLink(id: string, token: unknown, appointment?: Appointment): asserts appointment is Appointment {
  if (!HASH.test(id) || typeof token !== "string" || !HASH.test(token)) throw new AppointmentError(404, "link_unavailable");
  const hash = Buffer.from(digest(token), "hex");
  const now = Date.now();
  const candidates = [[appointment?.linkHash, appointment?.linkExpiresAt], [appointment?.accountLinkHash, appointment?.accountLinkExpiresAt]] as const;
  if (!appointment || !candidates.some(([stored, expires]) => stored && HASH.test(stored) && (expires ?? 0) > now &&
    timingSafeEqual(Buffer.from(stored, "hex"), hash))) {
    throw new AppointmentError(404, "link_unavailable");
  }
}

// Gives a customer who opened a long link a short one to copy. Capped so one link can't fill the table.
async function customerShortLink(db: Firestore, id: string, token: unknown) {
  const ref = db.collection("appointments").doc(id);
  return db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    assertLink(id, token, appointment);
    if (appointment.linkHash !== digest(token as string)) throw new AppointmentError(404, "link_unavailable");
    const issued = appointment.customerShortLinks ?? 0;
    if (issued >= 20) throw new AppointmentError(429, "short_link_limit");
    tx.update(ref, { customerShortLinks: issued + 1 });
    return { code: createShortLink(db, tx, "appointment", id, token as string) };
  });
}

async function detailsFromLink(db: Firestore, id: string, token: unknown) {
  const appointment = await readAppointment(db, id);
  assertLink(id, token, appointment);
  return customerDetails(appointment);
}

async function readAppointment(db: Firestore, id: string) {
  return (await db.collection("appointments").doc(id).get()).data() as Appointment | undefined;
}

const settingsDoc = (db: Firestore) => db.collection("appointmentSettings").doc("booking");
const taxDoc = (db: Firestore) => db.collection("appointmentSettings").doc("salesTax");

const followUpDoc = (db: Firestore) => db.collection("appointmentSettings").doc("followUps");

// Automatic customer emails around a job: a reminder the day before, and a review request once it's paid.
type FollowUpSettings = { reminders: boolean; reviewRequests: boolean; reviewUrl: string; revision: string };
const defaultFollowUps: FollowUpSettings = { reminders: true, reviewRequests: false, reviewUrl: "", revision: "" };

async function getFollowUpSettings(db: Firestore): Promise<FollowUpSettings> {
  return { ...defaultFollowUps, ...((await followUpDoc(db).get()).data() as Partial<FollowUpSettings> | undefined) };
}

function parseFollowUpSettings(body: Record<string, unknown>): Omit<FollowUpSettings, "revision"> | null {
  const { reminders, reviewRequests } = body;
  const reviewUrl = typeof body.reviewUrl === "string" ? body.reviewUrl.trim() : "";
  if (typeof reminders !== "boolean" || typeof reviewRequests !== "boolean" || reviewUrl.length > 500) return null;
  if (reviewUrl) {
    let url: URL;
    try { url = new URL(reviewUrl); } catch { return null; }
    if (url.protocol !== "https:") return null;
  }
  if (reviewRequests && !reviewUrl) return null;
  return { reminders, reviewRequests, reviewUrl };
}

async function getTaxSettings(db: Firestore): Promise<TaxSettings> {
  return { ...defaultTaxSettings, ...((await taxDoc(db).get()).data() as Partial<TaxSettings> | undefined) };
}

async function getSettings(db: Firestore) {
  return ((await settingsDoc(db).get()).data() as BookingSettings | undefined) ?? emptyBookingSettings;
}

// moving: an appointment being rescheduled. Its own reservation and calendar event don't block it,
// and its current length is used instead of a service's.
async function getAvailability(db: Firestore, body: Record<string, unknown>, owner = false, moving?: { id: string; minutes: number }) {
  const configured = await getSettings(db);
  const settings = owner ? { ...configured, enabled: true, minimumHours: body.deposit === "required" ? 0.6 : 0 } : configured;
  let service = settings.services.find(item => item.id === body.serviceId);
  if (moving) service = { id: "", name: "", cents: 0, duration: moving.minutes };
  else if (owner) {
    const duration = body.durationMinutes;
    if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 15 || duration > 7 * 1440) {
      throw new AppointmentError(400, "invalid_time");
    }
    service = { id: "", name: "", cents: 0, duration };
  }
  const date = text(body.date, 10);
  if (!service || !settings.enabled) return { slots: [] };
  const now = Date.now();
  let dates = [date];
  if (body.month !== undefined) {
    if (typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) throw new AppointmentError(400, "invalid_date");
    const month = body.month;
    const first = Date.parse(month + "-01T12:00:00Z");
    dates = Array.from({ length: 31 }, (_, index) => new Date(first + index * DAY).toISOString().slice(0, 10))
      .filter(day => day.startsWith(month));
  }
  const candidates = dates.flatMap(day => bookingSlots(settings, day, service, now));
  if (!candidates.length) return { slots: [] };
  const lower = candidates[0] - settings.bufferMinutes * MINUTE;
  const upper = candidates[candidates.length - 1] + (settings.bufferMinutes + service.duration) * MINUTE;
  const [config, days] = await Promise.all([calendarConfig(), db.getAll(...reservationDays(db, { id: "", start: lower, end: upper }))]);
  if (!config) throw new AppointmentError(503, "calendar_unavailable");
  const google = await busyWindows(config, lower, upper, moving?.id).catch(() => { throw new AppointmentError(503, "calendar_unavailable"); });
  const all = [...google, ...days.flatMap(day => ((day.get("slots") ?? []) as Reservation[]).filter(slot => slot.id !== moving?.id))];
  return {
    slots: candidates.filter(start => {
      const range = reservationFor("", { start, end: start + service.duration * MINUTE, bufferMinutes: settings.bufferMinutes });
      return !all.some(block => block.start < range.end && block.end > range.start);
    }),
  };
}

// Checks one owner-chosen start time against the same rules and calendars the booking calendar uses, and says
// why it isn't open. Owners may still book over a conflict; this only powers the warning on the New booking form.
async function checkOwnerTime(db: Firestore, body: Record<string, unknown>) {
  const start = body.start;
  // On a reschedule, the appointment being moved doesn't count as a conflict.
  const except = identifier(body.except, true) ?? undefined;
  const duration = body.durationMinutes;
  if (typeof start !== "number" || !Number.isSafeInteger(start) || typeof duration !== "number" || !Number.isInteger(duration) ||
      duration < 15 || duration > 7 * 1440) throw new AppointmentError(400, "invalid_time");
  const now = Date.now();
  const end = start + duration * MINUTE;
  const settings = await getSettings(db);
  const deposit = body.deposit === "required";
  const issues: string[] = [];
  const date = easternDate(start);
  const hours = businessHours(settings, date);
  if (start <= now) issues.push("past");
  else if (deposit && start < now + 36 * MINUTE) issues.push("too_soon_for_deposit");
  if (settings.blockedDates.includes(date)) issues.push("blocked_date");
  else if (!hours) issues.push("closed_day");
  else if (start < hours.start || end > hours.end) issues.push("outside_hours");
  const buffer = settings.bufferMinutes * MINUTE;
  const lower = start - buffer;
  const upper = end + buffer;
  const [config, days] = await Promise.all([calendarConfig(), db.getAll(...reservationDays(db, { id: "", start: lower, end: upper }))]);
  if (!config) throw new AppointmentError(503, "calendar_unavailable");
  const google = await busyWindows(config, lower, upper, except).catch(() => { throw new AppointmentError(503, "calendar_unavailable"); });
  const reservations = new Map<string, Reservation>();
  for (const slot of days.flatMap(day => (day.get("slots") ?? []) as Reservation[])) {
    if (slot.id !== except && slot.end > now && slot.start < upper && slot.end > lower) reservations.set(slot.id, slot);
  }
  const records = reservations.size ? await db.getAll(...[...reservations.keys()].map(id => db.collection("appointments").doc(id))) : [];
  const conflicts = records.map(record => {
    const slot = reservations.get(record.id)!;
    const appointment = record.data() as Appointment | undefined;
    return {
      kind: "appointment", name: appointment?.name ?? "", service: appointment?.service ?? "",
      start: appointment?.start ?? slot.start, end: appointment?.end ?? slot.end,
      // Overlapping the reservation itself (it already includes that booking's travel buffer) blocks a save.
      overlaps: slot.start < end && slot.end > start, reserved: slot,
    };
  });
  // Booked appointments are mirrored to the detailing calendar, so skip busy time they already explain.
  for (const busy of google) {
    if (busy.start >= upper || busy.end <= lower) continue;
    if (conflicts.some(item => item.reserved.start <= busy.start && item.reserved.end >= busy.end)) continue;
    conflicts.push({ kind: "calendar", name: "", service: "", start: busy.start, end: busy.end,
      overlaps: busy.start < end && busy.end > start, reserved: busy as Reservation });
  }
  conflicts.sort((a, b) => a.start - b.start);
  if (conflicts.some(item => item.overlaps)) issues.push("overlap");
  else if (conflicts.length) issues.push("buffer");
  return {
    open: !issues.length, issues, bufferMinutes: settings.bufferMinutes,
    conflicts: conflicts.map(({ reserved: _reserved, ...item }) => item),
  };
}

async function authenticatedCustomer(auth: Auth, req: Request) {
  const bearer = /^Bearer (\S+)$/.exec(req.get("Authorization") ?? "")?.[1];
  if (!bearer) return null;
  const user = await auth.verifyIdToken(bearer).catch(() => null);
  if (!user?.email_verified || !user.email) throw new AppointmentError(403, "verified_email_required");
  return { uid: user.uid, email: user.email.toLowerCase() };
}

// Returning customers skip the online deposit. Only a signed-in, verified email counts, so typing
// someone else's phone or email can't skip it: the email must match a past completed detail whose
// deposit was paid, or a client record the owner set to "No deposit required".
export async function depositWaived(db: Firestore, customer: { uid: string; email: string } | null) {
  if (!customer) return false;
  const [byAccount, byEmail, clients] = await Promise.all([
    db.collection("appointments").where("customerUid", "==", customer.uid).limit(50).get(),
    db.collection("appointments").where("email", "==", customer.email).limit(50).get(),
    db.collection("clients").where("email", "==", customer.email).limit(10).get(),
  ]);
  if (clients.docs.some(client => client.get("appointment_deposit_default") === "waived")) return true;
  const past = [...byAccount.docs, ...byEmail.docs].map(doc => doc.data() as Appointment);
  if (past.some(appointment => appointment.status === "completed" && (appointment.paidDeposit ?? 0) > 0)) return true;
  const linked = [...new Set(past.map(appointment => appointment.clientId).filter((id): id is string => !!id))].slice(0, 10);
  if (!linked.length) return false;
  const records = await db.getAll(...linked.map(id => db.collection("clients").doc(id)));
  return records.some(client => client.get("appointment_deposit_default") === "waived");
}

async function bookingQuote(db: Firestore, receipt: unknown) {
  if (!receipt || typeof receipt !== "object") return null;
  const { id, token } = receipt as { id?: unknown; token?: unknown };
  if (typeof id !== "string" || typeof token !== "string" || !HASH.test(id) || !HASH.test(token)) return null;
  const lead = (await db.collection("leads").doc(id).get()).data();
  if (!lead || lead.honeypot || lead.addon_token_hash !== digest(token) ||
      !Number.isFinite(lead.addon_token_expires_at) || lead.addon_token_expires_at <= Date.now()) return null;
  const name = text(lead.name, 150);
  const phone = text(lead.phone_normalized || lead.phone, 48);
  const digits = phone.replace(/\D/g, "");
  const quote = Number.isFinite(lead.quoted_total) && lead.quoted_total >= 0 ? Math.round(lead.quoted_total * 100) : null;
  return {
    id, service: text(lead.service, 31), vehicle: bookingVehicle(lead.vehicle), estimateCents: quote,
    phoneEnding: name && /^1?\d{10}$/.test(digits) ? digits.slice(-4) : null, name, phone,
  };
}
async function publicBooking(db: Firestore, auth: Auth, req: Request, body: Record<string, unknown>) {
  const settings = await getSettings(db);
  const service = settings.services.find(item => item.id === body.serviceId);
  if (!settings.enabled || !service || !(await stripeConfig())) throw new AppointmentError(503, "booking_unavailable");
  const postalCode = text(body.postalCode, 10);
  if (postalCode && !settings.postalCodes.includes(postalCode)) throw new AppointmentError(400, "outside_service_area");
  const token = body.token;
  if (typeof token !== "string" || !HASH.test(token) || body.accepted !== true) throw new AppointmentError(400, "policy_acceptance_required");
  const id = digest(`public:${token}`);
  const previous = await readAppointment(db, id);
  if (previous) {
    assertLink(id, token, previous);
    return { id, ...customerDetails(previous) };
  }
  const customer = await authenticatedCustomer(auth, req);
  const email = customer?.email ?? text(body.email, 250);
  // Email carries the confirmation, the appointment link and the day-before reminder, so online booking needs it.
  if (!email) throw new AppointmentError(400, "email_required");
  const quote = await bookingQuote(db, body.quoteReceipt);
  if (body.reuseQuoteContact === true && !quote?.phoneEnding) throw new AppointmentError(409, "quote_contact_expired");
  const vehicleType = bookingVehicle(body.vehicleType);
  const prices = bookingPrices(service);
  if ((body.vehicleType && !vehicleType) || (!vehicleType && new Set(Object.values(prices)).size > 1)) {
    throw new AppointmentError(400, "vehicle_required");
  }
  const quotedPrice = quote && quote.service === service.id && quote.vehicle === vehicleType ? quote.estimateCents : null;
  const waived = await depositWaived(db, customer);
  const appointment = buildAppointment({
    ...body, address: `${text(body.address, 390)} ${postalCode}`,
    ...(body.reuseQuoteContact === true ? { name: quote!.name, phone: quote!.phone } : {}),
    clientId: null, leadId: quote?.id ?? null, email, service: service.name,
    durationMinutes: service.duration, estimateCents: quotedPrice ?? prices[vehicleType ?? "sedan"], deposit: waived ? "waived" : "required",
  }, customer?.uid ?? "guest", Date.now(), true);
  if (!bookingSlots(settings, easternDate(appointment.start), service, Date.now()).includes(appointment.start)) {
    throw new AppointmentError(409, "time_unavailable");
  }
  appointment.bufferMinutes = settings.bufferMinutes;
  const customerNotes = text(body.customerNotes, 500);
  if (customerNotes) appointment.customerNotes = customerNotes;
  const salesTax = await getTaxSettings(db);
  if (salesTax.enabled) appointment.taxRateBasisPoints = salesTax.rateBasisPoints;
  await assertCalendarOpen(appointment);
  const ref = db.collection("appointments").doc(id);
  const holds = db.collection("appointmentBookingHolds");
  const throttles = [holds.doc(digest(appointment.phone))];
  if (email) throttles.push(holds.doc(digest(email.toLowerCase())));
  return db.runTransaction(async tx => {
    const existing = (await tx.get(ref)).data() as Appointment | undefined;
    if (existing) {
      assertLink(id, token, existing);
      return { id, ...customerDetails(existing) };
    }
    const latest = (await tx.get(settingsDoc(db))).data() as BookingSettings | undefined;
    if (!latest?.enabled || latest.revision !== settings.revision ||
        !bookingSlots(latest, easternDate(appointment.start), service, Date.now()).includes(appointment.start)) {
      throw new AppointmentError(409, "time_unavailable");
    }
    const now = Date.now();
    for (const hold of await tx.getAll(...throttles)) {
      if ((hold.get("until") ?? 0) <= now || hold.get("appointmentId") === id) continue;
      const held = await tx.get(db.collection("appointments").doc(hold.get("appointmentId")));
      if (held.get("status") === "awaiting_deposit") throw new AppointmentError(409, "existing_booking_hold");
    }
    await updateReservation(db, tx, reservationFor(id, appointment), false, now);
    const deadline = now + 40 * MINUTE;
    const record: Appointment = {
      ...appointment, preapproved: false, linkHash: digest(token), linkExpiresAt: appointment.end + 30 * DAY,
      acceptedPolicy: DEPOSIT_POLICY, policyVersion: POLICY_VERSION,
      ...(waived
        // No payment step: the request goes straight to the owner for approval.
        ? { status: "pending_approval" as const, depositWaivedReason: "returning_customer" }
        : { status: "awaiting_deposit" as const, depositDeadline: deadline, reconcileAt: deadline }),
      ...(customer ? { customerUid: customer.uid } : {}),
    };
    tx.create(ref, { ...record, bookingChannel: "public", acceptedAt: now });
    const link = checkoutOrigin() + shortLinkPath("appointment", createShortLink(db, tx, "appointment", id, token));
    if (waived) {
      queueAppointmentEmail(db, tx, `request-${id}`, email, "We got your booking request", {
        eyebrow: "Request received", heading: "No deposit needed this time",
        paragraphs: [`Thanks for coming back, ${record.name.split(" ")[0] || "there"}! As a returning customer you don't need a deposit. Nieman will review your request and text to confirm.`,
          "Keep this email. The button below is your link to check status, add the appointment to your calendar, or request a change."],
        details: emailFacts(record), action: { label: "View appointment", url: link },
      });
      return { id, ...customerDetails(record) };
    }
    for (const throttle of throttles) tx.set(throttle, { until: deadline, appointmentId: id });
    queueAppointmentEmail(db, tx, `request-${id}`, email, "Finish booking your detail", {
      eyebrow: "Almost booked", heading: "Lock in your time with the deposit",
      paragraphs: [`Thanks, ${record.name.split(" ")[0] || "there"}! Pay the ${emailMoney(record.depositCents)} deposit to hold your spot. It goes toward the cost of your detail.`,
        "Keep this email. The button below is your link to check status, add the appointment to your calendar, or request a change."],
      details: emailFacts(record), action: { label: "Pay deposit and view appointment", url: link },
    });
    return { id, ...customerDetails(record) };
  });
}

async function customerAccount(db: Firestore, auth: Auth, req: Request, body: Record<string, unknown>, action: string) {
  const customer = await authenticatedCustomer(auth, req);
  if (!customer) throw new AppointmentError(401, "sign_in_required");
  if (action === "my-appointments") {
    const rows = await db.collection("appointments").where("customerUid", "==", customer.uid).limit(100).get();
    return rows.docs.map(row => ({ id: row.id, ...customerDetails(row.data() as Appointment) })).sort((a, b) => b.start - a.start);
  }
  const id = identifier(body.id)!;
  const ref = db.collection("appointments").doc(id);
  return db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    if (!appointment) throw new AppointmentError(404, "link_unavailable");
    if (action === "claim-appointment") {
      assertLink(id, body.token, appointment);
      if (appointment.email.toLowerCase() !== customer.email || (appointment.customerUid && appointment.customerUid !== customer.uid)) {
        throw new AppointmentError(403, "appointment_email_mismatch");
      }
      tx.update(ref, { customerUid: customer.uid });
      return {};
    }
    if (appointment.customerUid !== customer.uid || appointment.status === "draft") throw new AppointmentError(404, "link_unavailable");
    const token = randomBytes(32).toString("hex");
    tx.update(ref, { accountLinkHash: digest(token), accountLinkExpiresAt: Date.now() + 4 * 60 * MINUTE });
    return { token };
  });
}

async function cancelAppointment(db: Firestore, tx: Transaction, id: string, appointment: Appointment, actor: string, override: boolean, reason: string, now: number) {
  if (appointment.status !== "draft") await updateReservation(db, tx, reservationFor(id, appointment), true, now);
  const locked = appointment.status === "confirmed" ? depositLock(appointment, now) : appointment.depositLockedAt ?? null;
  const refund: Refund | undefined = appointment.depositIntent && (override || !locked) && !appointment.refund
    ? { state: "queued", requestedAt: now } : undefined;
  const update = { status: "cancelled" as const, cancelledAt: now, cancelledBy: actor, cancellationReason: reason,
    depositLockedAt: locked, reconcileAt: null,
    ...(refund ? { refund, refundAt: now } : {}), ...calendarUpdate(now),
  };
  tx.update(db.collection("appointments").doc(id), update);
  queueAppointmentEmail(db, tx, `cancel-${id}`, appointment.email, "Your detailing appointment was cancelled", {
    eyebrow: "Cancelled", heading: "Your appointment was cancelled",
    paragraphs: [refund ? "Your appointment is cancelled and your deposit refund has been requested. Refunds usually reach your account within 5 to 10 business days."
      : "Your appointment is cancelled. If you'd like a different time, book again anytime or call or text me."],
    details: emailFacts(appointment), action: { label: "Book a new time", url: `${emailSiteOrigin()}/quote` },
  });
  return { ...appointment, ...update };
}

const emailWhenFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
});
const emailMoney = (cents: number) => `${(cents / 100).toFixed(2)}`;
const LINK_HINT = "Use the appointment link from your booking email to see everything, add it to your calendar, or request a change.";
const preparationNote = (appointment: Appointment) => appointment.preparation ? { note: `Before I arrive: ${appointment.preparation}` } : {};

// The appointment at a glance, for the details card in customer emails.
function emailFacts(appointment: Appointment, start = appointment.start): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ["Service", appointment.service], ["When", emailWhenFormat.format(start)],
    ["Vehicle", appointment.vehicle], ["Address", appointment.address],
  ];
  // Before the job is done, say tax will be added when the booking captured a rate.
  if (appointment.finalCents === undefined && appointment.taxRateBasisPoints) {
    facts.push(["Sales tax", `${taxRateLabel(appointment.taxRateBasisPoints)} added to the final invoice`]);
  }
  return facts.filter(([, value]) => !!value);
}

// Receipt lines: subtotal, sales tax and total when the invoice carries tax, plus the tax account number.
function invoiceFacts(appointment: Appointment): Array<[string, string]> {
  if (appointment.finalCents === undefined || !appointment.taxCents) return [];
  const facts: Array<[string, string]> = [
    ["Subtotal", emailMoney(appointment.finalCents)],
    [taxLineLabel(appointment.taxRateBasisPoints ?? 0), emailMoney(appointment.taxCents)],
    ["Invoice total", emailMoney(appointment.finalCents + appointment.taxCents)],
  ];
  if (appointment.taxId) facts.push(["NC sales tax account", appointment.taxId]);
  return facts;
}

function checkoutOrigin() {
  const origin = process.env.HOSTING_ORIGIN ?? "";
  const project = process.env.APPOINTMENT_INTEGRATIONS_PROJECT;
  // Live checkout returns customers to the production domain; test checkout only to <project>.web.app.
  const expected = liveMode() ? /^https:\/\/[a-z0-9.-]+$/.test(origin) : origin === `https://${project}.web.app`;
  if (!project || !expected) throw new AppointmentError(503, "stripe_unavailable");
  return origin;
}

async function openCheckout(db: Firestore, id: string, body: Record<string, unknown>) {
  const config = await stripeConfig();
  if (!config) throw new AppointmentError(503, "stripe_unavailable");
  const origin = checkoutOrigin();
  const ref = db.collection("appointments").doc(id);
  const current = await readAppointment(db, id);
  assertLink(id, body.token, current);
  if (current.checkout?.id) {
    const session = await stripeSession(config, current.checkout.id);
    await applyStripeSession(db, session);
    if (session.status === "complete") throw new AppointmentError(409, "checkout_finished");
  }
  if (current.status === "awaiting_deposit" && !current.overlapApproved) await assertCalendarOpen(current, id);
  const reservation = await db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    assertLink(id, body.token, appointment);
    const now = Date.now();
    const deposit = appointment.status === "awaiting_deposit";
    if (appointment.paymentReview) throw new AppointmentError(409, "payment_review_required");
    if (hasPendingCheck(appointment)) throw new AppointmentError(409, "check_pending");
    const amount = deposit ? appointment.depositCents : appointment.status === "completed" ? remainingBalance(appointment) : 0;
    if (!amount || amount < 50) throw new AppointmentError(409, "nothing_due");
    if (body.accepted !== true) throw new AppointmentError(400, "policy_acceptance_required");
    if (appointment.checkout) {
      if (!appointment.checkout.id && appointment.checkout.expiresAt <= now) throw new AppointmentError(409, "checkout_too_close");
      return appointment.checkout;
    }
    const expiresAt = Math.min(deposit ? appointment.depositDeadline ?? 0 : Infinity, now + CHECKOUT_WINDOW);
    if (expiresAt - now < 31 * MINUTE) throw new AppointmentError(409, "checkout_too_close");
    const kind = deposit ? "deposit" : "balance";
    // A balance that still includes unpaid tax shows the tax as its own line; the lines add up to the amount.
    const taxCents = deposit ? 0 : taxPortion(appointment.finalCents ?? 0, appointment.taxCents ?? 0, paidSoFar(appointment), amount);
    const checkout: Checkout = {
      attempt: randomBytes(16).toString("hex"), kind, expiresAt, amount, origin, holdUntil: now + CHECKOUT_HOLD,
      disclosure: deposit ? DEPOSIT_POLICY : "Pay the outstanding balance for your completed detail.",
      ...(taxCents > 0 ? { taxCents, taxLabel: taxLineLabel(appointment.taxRateBasisPoints ?? 0) } : {}),
    };
    tx.update(ref, { checkout, reconcileAt: checkout.holdUntil,
      ...(deposit ? { policyVersion: POLICY_VERSION, acceptedPolicy: DEPOSIT_POLICY, acceptedAt: now } : {}),
    });
    return checkout;
  });
  const session = reservation.id
    ? await stripeSession(config, reservation.id)
    : await createStripeSession(config, { id, ...reservation });
  if (session.livemode !== liveMode() || session.metadata.appointmentId !== id || session.metadata.attemptId !== reservation.attempt ||
      session.amount_total !== reservation.amount || session.currency !== "usd") throw new Error("stripe_checkout_mismatch");
  await db.runTransaction(async tx => {
    const latest = (await tx.get(ref)).data() as Appointment;
    if (latest.checkout?.attempt === reservation.attempt) tx.update(ref, { checkout: { ...reservation, id: session.id } });
  });
  await applyStripeSession(db, session);
  if (session.status !== "open" || !session.url || new URL(session.url).origin !== "https://checkout.stripe.com") {
    throw new AppointmentError(409, "checkout_finished");
  }
  return { url: session.url };
}

export async function applyStripeSession(db: Firestore, session: StripeSession) {
  const id = session.metadata?.appointmentId;
  if (!HASH.test(id ?? "") || session.livemode !== liveMode() || !isSessionId(session.id)) return;
  const ref = db.collection("appointments").doc(id);
  await db.runTransaction(async tx => {
    const appointment = (await tx.get(ref)).data() as Appointment | undefined;
    const checkout = appointment?.checkout;
    if (!appointment || !checkout || checkout.attempt !== session.metadata.attemptId || (checkout.id && checkout.id !== session.id)) return;
    if (session.currency !== "usd" || session.amount_total !== checkout.amount || session.metadata.kind !== checkout.kind) throw new Error("stripe_amount_mismatch");
    const now = Date.now();
    if (session.status === "expired") {
      tx.update(ref, { checkout: null, reconcileAt: checkout.kind === "deposit" ? appointment.depositDeadline : null });
      return;
    }
    if (session.status !== "complete" || session.payment_status !== "paid" || !session.payment_intent || !/^pi_\w+$/.test(session.payment_intent)) return;
    const ledger = ref.collection("ledger").doc(session.id);
    tx.create(ledger, { kind: checkout.kind, id: session.id, amount: checkout.amount, method: "stripe", at: now, intent: session.payment_intent, livemode: liveMode(),
      ...(checkout.taxCents ? { taxCents: checkout.taxCents } : {}) });
    if (checkout.kind === "balance") {
      const entry: PaymentEntry = { id: session.id, amount: checkout.amount, method: "stripe", at: now, by: "stripe", reference: session.payment_intent,
        ...(checkout.taxCents ? { taxCents: checkout.taxCents } : {}) };
      const paid = { ...appointment, payments: [...(appointment.payments ?? []), entry] };
      tx.update(ref, { checkout: null, reconcileAt: null, payments: paid.payments });
      queueOptedInMaintenance(db, tx, id, paid);
      queueAppointmentEmail(db, tx, `receipt-${session.id}`, appointment.email, "Detailing payment received", {
          eyebrow: "Receipt", heading: "Payment received. Thank you!",
          paragraphs: [`I received your payment of ${emailMoney(checkout.amount)}. It was a pleasure taking care of your ${appointment.vehicle || "vehicle"}.`],
          details: [...invoiceFacts(appointment), ["Paid", emailMoney(checkout.amount)], ...emailFacts(appointment)],
          action: { label: "Book your next detail", url: `${emailSiteOrigin()}/quote` },
        });
    } else {
      const late = appointment.start <= now;
      const status = late ? "cancelled" : appointment.preapproved ? "confirmed" : "pending_approval";
      tx.update(ref, { checkout: null, status, paidDeposit: checkout.amount, depositIntent: session.payment_intent,
        reconcileAt: status === "pending_approval" ? appointment.start : null,
        depositLockedAt: status === "confirmed" && appointment.start - now < 96 * 60 * MINUTE ? now : null,
        ...(late ? { refund: { state: "queued", requestedAt: now }, refundAt: now, cancellationReason: "Payment settled after the appointment start." } : {}),
        ...calendarUpdate(now),
      });
      queueAppointmentEmail(db, tx, `receipt-${session.id}`, appointment.email, "Detailing deposit received", late ? {
          eyebrow: "Refund on the way", heading: "Your deposit arrived too late",
          paragraphs: ["The deposit came through after the appointment start time, so a refund has been requested. Book a new time anytime."],
          details: [["Refunding", emailMoney(checkout.amount)], ...emailFacts(appointment)],
          action: { label: "Book a new time", url: `${emailSiteOrigin()}/quote` },
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

const HOUR = 60 * MINUTE;
const relativeDay = (start: number, now: number) => {
  const day = easternDate(start);
  if (day === easternDate(now)) return "today";
  if (day === easternDate(now + DAY)) return "tomorrow";
  return null;
};
const emailTimeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const emailDayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" });

// Day-before reminders for confirmed jobs, and one review request after a job is paid in full.
// Both run from the 5-minute scheduler and mark the appointment in the same transaction as the email,
// so each goes out at most once.
async function sendFollowUps(db: Firestore, now: number) {
  const settings = await getFollowUpSettings(db);
  const collection = db.collection("appointments");
  if (settings.reminders) {
    // Anything starting 2 to 26 hours from now.
    const upcoming = await collection.where("start", ">", now + 2 * HOUR).where("start", "<=", now + 26 * HOUR).orderBy("start").limit(40).get();
    for (const doc of upcoming.docs) {
      const appointment = doc.data() as Appointment;
      if (appointment.status !== "confirmed" || !appointment.email || appointment.reminderSentFor === appointment.start) continue;
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (!latest || latest.status !== "confirmed" || !latest.email || latest.reminderSentFor === latest.start) return;
        // An online booking confirmed in the last 6 hours just got its "You're booked" email, so skip the reminder.
        if (latest.bookingChannel === "public" && Math.max(latest.confirmedAt ?? 0, latest.createdAt) > now - 6 * HOUR) {
          tx.update(doc.ref, { reminderSentFor: latest.start });
          return;
        }
        const day = relativeDay(latest.start, now) ?? emailDayFormat.format(latest.start);
        const time = emailTimeFormat.format(latest.start);
        tx.update(doc.ref, { reminderSentFor: latest.start, reminderSentAt: now });
        queueAppointmentEmail(db, tx, `reminder-${doc.id}-${latest.start}`, latest.email, `Reminder: your detail is ${day} at ${time}`, {
          eyebrow: "Appointment reminder", heading: `See you ${day} at ${time}`,
          paragraphs: [`Hi ${latest.name.split(" ")[0] || "there"}, this is a reminder that I'll be detailing your ${latest.vehicle || "vehicle"} ${day} at ${time}.`,
            "If anything has changed, like the address, how to get in, or the time, text or call me before then.", LINK_HINT],
          details: emailFacts(latest), ...preparationNote(latest),
        });
      });
    }
  }
  if (settings.reviewRequests && settings.reviewUrl) {
    // Ask two hours after the job is finished and paid, and only once per customer.
    const finished = await collection.where("completedAt", ">=", now - 7 * DAY).where("completedAt", "<=", now - 2 * HOUR).orderBy("completedAt").limit(40).get();
    for (const doc of finished.docs) {
      const appointment = doc.data() as Appointment;
      if (appointment.status !== "completed" || !appointment.email || appointment.reviewRequestedAt || appointment.paymentReview ||
        hasPendingCheck(appointment) || remainingBalance(appointment) !== 0) continue;
      const earlier = await collection.where("email", "==", appointment.email).limit(50).get();
      const askedBefore = earlier.docs.some(row => row.id !== doc.id && row.get("reviewRequestedAt"));
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (!latest || latest.reviewRequestedAt || latest.status !== "completed" || remainingBalance(latest) !== 0) return;
        tx.update(doc.ref, { reviewRequestedAt: now, ...(askedBefore ? { reviewRequestSkipped: "asked_before" } : {}) });
        if (askedBefore) return;
        queueAppointmentEmail(db, tx, `review-${doc.id}`, latest.email, "How did your detail turn out?", {
          eyebrow: "Thank you", heading: "How does it look?",
          paragraphs: [`Thanks again for trusting me with your ${latest.vehicle || "vehicle"}, ${latest.name.split(" ")[0] || "there"}.`,
            "I'm a one-person local business, and reviews are how most people find me. If you were happy with the work, a quick Google review would mean a lot. It takes about a minute.",
            "If anything wasn't right, call or text me and I'll make it right."],
          action: { label: "Leave a Google review", url: settings.reviewUrl },
        });
      });
    }
  }
}

export async function reconcileAppointments(db: Firestore) {
  const config = await stripeConfig();
  const now = Date.now();
  const collection = db.collection("appointments");
  await deliverAppointmentEmails(db, now, async ({ appointmentId, inviteHash }) => {
    const appointment = await readAppointment(db, appointmentId);
    return !!appointment && appointment.maintenanceInvite?.hash === inviteHash &&
      !appointment.maintenanceEnrolledAt && !!maintenanceDeadline(appointment);
  }).catch(error => recordOpsEvent(db, { source: "email", code: "delivery_crashed", detail: error instanceof Error ? error.message : String(error) }));
  const calendar = await calendarConfig().catch(async error => {
    await recordOpsEvent(db, { source: "calendar", code: "calendar_unavailable", detail: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (calendar) {
    const pending = await collection.where("calendarDueAt", "<=", now).where("calendarDueAt", ">", 0).orderBy("calendarDueAt").limit(5).get();
    for (const doc of pending.docs) {
      const appointment = doc.data() as Appointment;
      let failure = false;
      try { await mirrorAppointment(calendar, doc.id, appointment); }
      catch (error) {
        failure = true;
        await recordOpsEvent(db, { source: "calendar", code: "sync_failed", level: appointment.calendarFailure ? "error" : "warning", ref: doc.id,
          detail: error instanceof Error ? error.message : String(error) });
      }
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (!latest || latest.calendarRevision !== appointment.calendarRevision) return;
        tx.update(doc.ref, failure ?
          { calendarFailure: true, calendarDueAt: now + 10 * MINUTE } :
          { calendarFailure: false, calendarDueAt: null, calendarSyncedAt: now });
      });
    }
  }
  const due = await collection.where("reconcileAt", "<=", now).where("reconcileAt", ">", 0).orderBy("reconcileAt").limit(5).get();
  for (const doc of due.docs) {
    try {
      const appointment = doc.data() as Appointment;
      if (appointment.checkout) {
        if (!config) throw new Error("stripe_unavailable");
        const checkout = appointment.checkout;
        if (checkout.id) {
          const holdOver = (checkout.holdUntil ?? checkout.expiresAt) <= now;
          await applyStripeSession(db, holdOver ? await releaseStripeSession(config, checkout.id) : await stripeSession(config, checkout.id));
        } else if (checkout.expiresAt > now) {
          // The session ID was never saved, so it can only be found once Stripe's own expiry has passed.
          await doc.ref.update({ reconcileAt: checkout.expiresAt });
          continue;
        } else if (checkout.expiresAt <= now) {
          const session = await findCheckoutAttempt(config, doc.id, checkout.attempt, checkout.expiresAt - CHECKOUT_WINDOW - MINUTE, checkout.expiresAt);
          if (session) {
            await applyStripeSession(db, session);
          } else {
            await db.runTransaction(async tx => {
              const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
              if (latest?.checkout?.attempt === checkout.attempt && !latest.checkout.id) {
                tx.update(doc.ref, { checkout: null, reconcileAt: checkout.kind === "deposit" ? latest.depositDeadline : null });
              }
            });
          }
        }
      }
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (!latest || latest.checkout || (latest.reconcileAt ?? Infinity) > now) return;
        if (["awaiting_deposit", "pending_approval"].includes(latest.status)) {
          await cancelAppointment(db, tx, doc.id, latest, "system", false, "Appointment hold expired.", now);
        }
      });
    } catch (error) {
      logger.error("Appointment payment needs reconciliation", { appointmentId: doc.id, reason: error instanceof Error ? error.message : String(error) });
      await recordOpsEvent(db, { source: "payments", code: "reconcile_failed", ref: doc.id, detail: error instanceof Error ? error.message : String(error) });
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (latest?.checkout && (latest.reconcileAt ?? Infinity) <= now) tx.update(doc.ref, { reconcileAt: now + 5 * MINUTE });
      });
    }
  }
  await sendFollowUps(db, now).catch(error =>
    recordOpsEvent(db, { source: "email", code: "follow_ups_failed", detail: error instanceof Error ? error.message : String(error) }));
  await pruneOpsEvents(db, now).catch(() => undefined);
  if (!config) return;
  const refunds = await collection.where("refundAt", "<=", now).where("refundAt", ">", 0).orderBy("refundAt").limit(5).get();
  for (const doc of refunds.docs) {
    const appointment = doc.data() as Appointment;
    if (!appointment.depositIntent || !appointment.paidDeposit || !appointment.refund) continue;
    if (appointment.paymentReview?.kind === "dispute") {
      await doc.ref.update({ refundAt: now + 60 * MINUTE });
      continue;
    }
    try {
      if (!appointment.refund.id && now - appointment.refund.requestedAt > 23 * 60 * MINUTE) {
        await doc.ref.update({ refund: { ...appointment.refund, state: "failed" }, refundAt: null });
        await recordOpsEvent(db, { source: "payments", code: "refund_failed", ref: doc.id, detail: "Stripe never accepted the refund request." });
        continue;
      }
      const refund = await stripeRefund(config, { id: doc.id, intent: appointment.depositIntent, cents: appointment.paidDeposit, refundId: appointment.refund.id });
      const state = refund.status === "succeeded" ? "succeeded" : ["failed", "canceled"].includes(refund.status) ? "failed" : "pending";
      await db.runTransaction(async tx => {
        const latest = (await tx.get(doc.ref)).data() as Appointment | undefined;
        if (!latest?.refund || latest.refund.state === "succeeded") return;
        tx.set(doc.ref.collection("ledger").doc(refund.id), { kind: "refund", id: refund.id, amount: -refund.amount, status: state, method: "stripe", at: now }, { merge: true });
        tx.update(doc.ref, { refund: { ...latest.refund, state, id: refund.id }, refundAt: state === "pending" ? now + 5 * MINUTE : null });
      });
    } catch (error) {
      logger.error("Appointment refund needs reconciliation", { appointmentId: doc.id, reason: error instanceof Error ? error.message : String(error) });
      await recordOpsEvent(db, { source: "payments", code: "refund_retry", level: "warning", ref: doc.id, detail: error instanceof Error ? error.message : String(error) });
    }
  }
}

const LIST_PAGE = 50;
const LIST_VIEWS = new Set(["all", "today", "pending_approval", "awaiting_deposit", "confirmed", "in_progress", "due", "refunds", "cancelled"]);
const refundOpenState = (appointment: Appointment) => !!appointment.refund && appointment.refund.state !== "succeeded";
const newestFirst = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;

// The admin queue. Each filter runs its own query so older records stay reachable, and search scans
// the most recent 1,000 bookings by name, phone, email, address, vehicle or notes.
async function listAppointments(db: Firestore, body: Record<string, unknown>) {
  const collection = db.collection("appointments");
  const view = typeof body.view === "string" && LIST_VIEWS.has(body.view) ? body.view : "all";
  const search = text(body.search, 80).toLowerCase();
  const before = typeof body.before === "number" && Number.isSafeInteger(body.before) ? body.before : null;
  const now = Date.now();
  const rows = (snapshot: FirebaseFirestore.QuerySnapshot) => snapshot.docs.map(doc => ({ id: doc.id, appointment: doc.data() as Appointment }));
  let records: Array<{ id: string; appointment: Appointment }>;
  let next: number | null = null;
  if (search) {
    const digits = search.replace(/\D/g, "");
    const recent = rows(await collection.orderBy("createdAt", "desc").limit(1000).get());
    records = recent.filter(({ appointment: a }) =>
      [a.name, a.email, a.address, a.vehicle, a.service, a.customerNotes, a.workNotes].some(value => (value ?? "").toLowerCase().includes(search)) ||
      (digits.length >= 4 && (a.phone ?? "").replace(/\D/g, "").includes(digits))).slice(0, 100);
  } else if (view === "all") {
    let query = collection.orderBy("createdAt", "desc");
    if (before !== null) query = query.startAfter(before);
    records = rows(await query.limit(LIST_PAGE).get());
    if (records.length === LIST_PAGE) next = records[records.length - 1].appointment.createdAt;
  } else if (view === "today") {
    const today = easternDate(now);
    const from = now - 36 * HOUR;
    records = rows(await collection.where("start", ">=", from).where("start", "<=", now + 36 * HOUR).limit(200).get())
      .filter(({ appointment }) => easternDate(appointment.start) === today);
  } else if (view === "due") {
    records = rows(await collection.where("status", "==", "completed").limit(500).get())
      .filter(({ appointment }) => (remainingBalance(appointment) ?? 0) > 0);
  } else if (view === "refunds") {
    records = rows(await collection.where("refund.state", "in", ["queued", "pending", "failed"]).limit(100).get());
  } else {
    records = rows(await collection.where("status", "==", view).limit(300).get());
  }
  const details = records.map(({ id, appointment }) => adminDetails(id, appointment));
  if (view === "today") details.sort((a, b) => a.start - b.start);
  else details.sort(newestFirst);
  const refunds = rows(await collection.where("refund.state", "in", ["queued", "pending", "failed"]).limit(100).get())
    .filter(({ appointment }) => refundOpenState(appointment));
  return {
    records: details, next,
    refunds: { open: refunds.length, failed: refunds.filter(({ appointment }) => appointment.refund?.state === "failed").length },
  };
}

type HealthCheck = { id: string; label: string; ok: boolean; detail: string };

async function check(id: string, label: string, test: () => Promise<boolean | string>, failure: string): Promise<HealthCheck> {
  try {
    const outcome = await test();
    return { id, label, ok: outcome === true, detail: outcome === true ? "OK" : typeof outcome === "string" ? outcome : failure };
  } catch (error) {
    return { id, label, ok: false, detail: `${failure} (${error instanceof Error ? error.message : String(error)})`.slice(0, 300) };
  }
}

// Everything the admin Health page shows, gathered in one request.
async function healthReport(db: Firestore) {
  const now = Date.now();
  const week = now - 7 * DAY;
  const collection = db.collection("appointments");
  const [settings, followUps, scheduler, events, emails, webhooks, calendarFailures, disputes, refundRows, pendingApproval] = await Promise.all([
    getSettings(db), getFollowUpSettings(db),
    db.collection("opsStatus").doc("scheduler").get(),
    db.collection("opsEvents").where("lastAt", ">=", week).orderBy("lastAt", "desc").limit(150).get(),
    db.collection("appointmentEmails").where("createdAt", ">=", week).orderBy("createdAt", "desc").limit(500).get(),
    db.collection("appointmentStripeEvents").where("receivedAt", ">=", week).limit(500).get(),
    collection.where("calendarFailure", "==", true).limit(50).get(),
    collection.where("paymentReview.kind", "in", ["refund", "dispute"]).limit(50).get(),
    collection.where("refund.state", "==", "failed").limit(50).get(),
    collection.where("status", "==", "pending_approval").limit(100).get(),
  ]);
  const checks = await Promise.all([
    check("stripe", "Stripe payments", async () => !!await stripeConfig() || "APPOINTMENT_STRIPE_CONFIG is missing or doesn't match this mode.", "Stripe configuration could not be loaded"),
    check("calendar", "Google Calendar", async () => !!await calendarConfig() || "APPOINTMENT_GOOGLE_CONFIG is missing.", "Google Calendar sign-in failed. The refresh token may have expired"),
    check("email", "Customer email (Resend)", async () => await emailConfigured() || "APPOINTMENT_EMAIL_CONFIG is missing or invalid.", "Email configuration could not be loaded"),
    check("telegram", "Telegram alerts", async () => telegramConfigured() || (liveMode() ? "Telegram isn't configured, so you won't get alerts." : "Off on staging."), "Telegram check failed"),
    check("booking", "Online booking", async () => settings.enabled || "Public booking is turned off in Settings.", "Booking settings could not be read"),
    check("reviews", "Review requests", async () => followUps.reviewRequests && !!followUps.reviewUrl || "Off. Add your Google review link in Settings to turn them on.", "Review settings could not be read"),
  ]);
  const schedulerData = scheduler.data() ?? {};
  const lastRunAt = typeof schedulerData.lastRunAt === "number" ? schedulerData.lastRunAt : null;
  const schedulerHealthy = lastRunAt !== null && now - lastRunAt < 15 * MINUTE &&
    !(typeof schedulerData.lastErrorAt === "number" && schedulerData.lastErrorAt > (schedulerData.lastOkAt ?? 0));
  const emailRows = emails.docs.map(doc => ({ id: doc.id, ...doc.data() } as Record<string, unknown> & { id: string }));
  const emailCount = (state: string) => emailRows.filter(row => row.state === state).length;
  const stuck = emailRows.filter(row => !row.sentAt && typeof row.nextAt === "number" && row.nextAt > 0 && row.nextAt < now - 30 * MINUTE);
  const problemEmails = emailRows.filter(row => ["failed", "retry"].includes(String(row.state)) || stuck.includes(row)).slice(0, 25).map(row => ({
    id: row.id, to: String(row.to ?? ""), subject: String(row.subject ?? ""),
    state: stuck.includes(row) && row.state !== "retry" ? "stuck" : String(row.state), createdAt: row.createdAt, lastError: String(row.lastError ?? ""),
  }));
  const webhookRows = webhooks.docs.map(doc => doc.data());
  const unfinished = webhookRows.filter(row => !row.completedAt && typeof row.receivedAt === "number" && row.receivedAt < now - 10 * MINUTE);
  const attention: Array<{ id: string; name: string; start: number; issue: string }> = [];
  const add = (docs: FirebaseFirestore.QueryDocumentSnapshot[], issue: (appointment: Appointment) => string | null) => {
    for (const doc of docs) {
      const appointment = doc.data() as Appointment;
      const message = issue(appointment);
      if (message && !attention.some(item => item.id === doc.id && item.issue === message)) attention.push({ id: doc.id, name: appointment.name, start: appointment.start, issue: message });
    }
  };
  add(calendarFailures.docs, () => "Not on Google Calendar yet (sync keeps failing)");
  add(disputes.docs, appointment => appointment.paymentReview?.kind === "dispute" ? "Payment disputed in Stripe" : "Refund made in Stripe needs review");
  add(refundRows.docs, () => "Deposit refund failed. Refund it in Stripe");
  add(pendingApproval.docs, appointment => appointment.start - now < DAY ? "Waiting for your approval and starts within a day" : null);
  const eventRows = events.docs.map(doc => {
    const row = doc.data();
    return { id: doc.id, source: row.source, code: row.code, level: row.level, ref: row.ref ?? "", detail: row.detail ?? "",
      count: row.count ?? 1, firstAt: row.firstAt, lastAt: row.lastAt, title: describeOpsEvent(String(row.source), String(row.code)) };
  });
  const errors24h = eventRows.filter(row => row.level === "error" && row.lastAt >= now - DAY).reduce((total, row) => total + row.count, 0);
  const warnings24h = eventRows.filter(row => row.level !== "error" && row.lastAt >= now - DAY).reduce((total, row) => total + row.count, 0);
  return {
    generatedAt: now, mode: liveMode() ? "live" : "test",
    scheduler: { healthy: schedulerHealthy, lastRunAt, lastOkAt: schedulerData.lastOkAt ?? null, lastDurationMs: schedulerData.lastDurationMs ?? null,
      lastError: schedulerData.lastErrorAt > (schedulerData.lastOkAt ?? 0) ? schedulerData.lastError ?? "" : "" },
    checks,
    summary: { errors24h, warnings24h, attention: attention.length },
    emails: { sent: emailCount("sent"), failed: emailCount("failed"), retrying: emailCount("retry"), stuck: stuck.length, total: emailRows.length, problems: problemEmails },
    webhooks: { received: webhookRows.length, unfinished: unfinished.length },
    attention: attention.sort((a, b) => a.start - b.start),
    events: eventRows,
  };
}

export async function handleAppointments(db: Firestore, auth: Auth, req: Request, res: Response, action: string) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  const body = req.body as Record<string, unknown> | undefined;
  if (!req.is("application/json") || !body || typeof body !== "object" || Array.isArray(body) || req.rawBody.length > 16_384) {
    res.status(400).json({ ok: false, error: "invalid_request" });
    return;
  }
  try {
    let result;
    if (action === "details") {
      result = await detailsFromLink(db, identifier(body.id)!, body.token);
    } else if (action === "resolve-short-link") {
      result = await resolveShortLink(db, body.code, body.kind === "maintenance" ? "maintenance" : "appointment");
      if (!result) throw new AppointmentError(404, "link_unavailable");
    } else if (action === "short-link") {
      result = await customerShortLink(db, identifier(body.id)!, body.token);
    } else if (action === "quote-context") {
      const quote = await bookingQuote(db, body.quoteReceipt);
      result = quote ? {
        service: quote.service, vehicle: quote.vehicle ?? null, estimateCents: quote.estimateCents, phoneEnding: quote.phoneEnding,
      } : null;
    } else if (action === "site-content") {
      result = await publicSiteContent(db);
    } else if (["maintenance-offer", "maintenance-enroll"].includes(action)) {
      result = await maintenanceEnrollment(db, body, action === "maintenance-enroll");
    } else if (action === "booking-options") {
      const settings = await getSettings(db);
      const enabled = settings.enabled && !!await stripeConfig() && !!await calendarConfig();
      const tax = await getTaxSettings(db);
      result = { enabled, services: enabled ? settings.services.map(service => ({ ...service, vehiclePrices: bookingPrices(service) })) : [], horizonDays: settings.horizonDays, depositPolicy: DEPOSIT_POLICY, depositCents: DEPOSIT_CENTS,
        salesTax: { enabled: tax.enabled, rateBasisPoints: tax.enabled ? tax.rateBasisPoints : 0 } };
    } else if (action === "sales-tax") {
      const tax = await getTaxSettings(db);
      result = { enabled: tax.enabled, rateBasisPoints: tax.enabled ? tax.rateBasisPoints : 0 };
    } else if (action === "availability") {
      result = await getAvailability(db, body);
    } else if (action === "book") {
      result = await publicBooking(db, auth, req, body);
    } else if (action === "deposit-status") {
      // Lets the booking page tell a signed-in returning customer up front that no deposit is due.
      result = { waived: await depositWaived(db, await authenticatedCustomer(auth, req)) };
    } else if (["my-appointments", "my-link", "claim-appointment"].includes(action)) {
      result = await customerAccount(db, auth, req, body, action);
    } else if (action === "checkout") {
      result = await openCheckout(db, identifier(body.id)!, body);
    } else if (action === "recheck-payment") {
      const id = identifier(body.id)!;
      const appointment = await readAppointment(db, id);
      assertLink(id, body.token, appointment);
      const config = await stripeConfig();
      if (config && appointment.checkout?.id) await applyStripeSession(db, await stripeSession(config, appointment.checkout.id));
      result = await detailsFromLink(db, id, body.token);
    } else if (action === "customer-cancel") {
      const id = identifier(body.id)!;
      const ref = db.collection("appointments").doc(id);
      result = await db.runTransaction(async tx => {
        const appointment = (await tx.get(ref)).data() as Appointment | undefined;
        assertLink(id, body.token, appointment);
        if (appointment.status === "cancelled") return customerDetails(appointment);
        if (appointment.checkout) throw new AppointmentError(409, "checkout_active");
        const now = Date.now();
        if (appointment.start <= now || !["awaiting_deposit", "pending_approval", "confirmed"].includes(appointment.status)) {
          throw new AppointmentError(409, "status_changed");
        }
        if (body.accepted !== true) throw new AppointmentError(400, "policy_acceptance_required");
        if (body.expectedRefund !== customerDetails(appointment).depositRefundable) {
          throw new AppointmentError(409, "cancellation_terms_changed");
        }
        return customerDetails(await cancelAppointment(db, tx, id, appointment, "customer_link", false, "Customer cancelled.", now));
      });
    } else if (action === "accept-alternate") {
      result = await acceptAlternate(db, identifier(body.id)!, body);
    } else if (action === "reschedule-availability") {
      const id = identifier(body.id)!;
      const appointment = await readAppointment(db, id);
      assertLink(id, body.token, appointment);
      const settings = await getSettings(db);
      result = { slots: await customerMoveSlots(db, id, appointment, { month: body.month }), horizonDays: settings.horizonDays };
    } else if (action === "request-reschedule") {
      const id = identifier(body.id)!;
      const start = validMoveStart(body.start);
      const ref = db.collection("appointments").doc(id);
      // Only a time the booking calendar would offer: within hours and notice, not blocked, and free.
      const current = await readAppointment(db, id);
      assertLink(id, body.token, current);
      if (!(await customerMoveSlots(db, id, current, { date: easternDate(start) })).includes(start)) throw new AppointmentError(409, "time_unavailable");
      result = await db.runTransaction(async tx => {
        const appointment = (await tx.get(ref)).data() as Appointment | undefined;
        assertLink(id, body.token, appointment);
        if (!movable(appointment)) {
          throw new AppointmentError(409, "status_changed");
        }
        const rescheduleRequest = { start, requestedAt: Date.now() };
        tx.update(ref, { rescheduleRequest });
        return customerDetails({ ...appointment, rescheduleRequest });
      });
    } else {
      const uid = await adminUid(db, auth, req, action.startsWith("cms-"));
      if (action.startsWith("cms-")) result = await manageSiteContent(db, uid, action, body);
      else if (action === "context") result = await appointmentContext(db, body);
      else if (action === "admin-availability") {
        // The horizon lets the reschedule calendar page past this month.
        const moving = await movingAppointment(db, body.except);
        result = { ...await getAvailability(db, body, true, moving), ...(moving ? { horizonDays: (await getSettings(db)).horizonDays } : {}) };
      }
      else if (action === "admin-check-time") result = await checkOwnerTime(db, body);
      else if (action === "owner-detail") {
        const id = identifier(body.id)!;
        const appointment = await readAppointment(db, id);
        if (!appointment) throw new AppointmentError(404, "record_not_found");
        result = adminDetails(id, appointment);
      }
      else if (action === "create") result = await createAppointment(db, uid, body);
      else if (action === "booking-settings") {
        const settings = await getSettings(db);
        result = { ...settings, services: settings.services.map(service => ({ ...service, vehiclePrices: bookingPrices(service) })) };
      } else if (action === "save-booking-settings") {
        const settings = parseBookingSettings(body);
        if (!settings) throw new AppointmentError(400, "invalid_booking_settings");
        if (settings.enabled) {
          if (!(await stripeConfig().catch(() => null))) throw new AppointmentError(503, "stripe_config_unavailable");
          if (!(await calendarConfig().catch(() => null))) throw new AppointmentError(503, "calendar_config_unavailable");
        }
        await db.runTransaction(async tx => {
          const previous = await tx.get(settingsDoc(db));
          if ((previous.get("revision") ?? "") !== (body.revision ?? "")) throw new AppointmentError(409, "settings_updated");
          result = { ...settings, revision: randomBytes(16).toString("hex") };
          tx.set(settingsDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
          tx.create(settingsDoc(db).collection("versions").doc(), { ...result, updatedBy: uid, updatedAt: Date.now() });
        });
      }
      else if (action === "tax-settings") result = await getTaxSettings(db);
      else if (action === "save-tax-settings") {
        const tax = parseTaxSettings(body);
        if (!tax) throw new AppointmentError(400, "invalid_tax_settings");
        await db.runTransaction(async tx => {
          const previous = await tx.get(taxDoc(db));
          if ((previous.get("revision") ?? "") !== (body.revision ?? "")) throw new AppointmentError(409, "settings_updated");
          result = { ...tax, revision: randomBytes(16).toString("hex") };
          tx.set(taxDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
          tx.create(taxDoc(db).collection("versions").doc(), { ...result, updatedBy: uid, updatedAt: Date.now() });
        });
      }
      else if (action === "list") result = await listAppointments(db, body);
      else if (action === "client-history") result = await clientHistory(db, uid, body);
      else if (action === "health") result = await healthReport(db);
      else if (action === "follow-up-settings") result = await getFollowUpSettings(db);
      else if (action === "save-follow-up-settings") {
        const followUps = parseFollowUpSettings(body);
        if (!followUps) throw new AppointmentError(400, "invalid_follow_up_settings");
        await db.runTransaction(async tx => {
          const previous = await tx.get(followUpDoc(db));
          if ((previous.get("revision") ?? "") !== (body.revision ?? "")) throw new AppointmentError(409, "settings_updated");
          result = { ...followUps, revision: randomBytes(16).toString("hex") };
          tx.set(followUpDoc(db), { ...result, updatedBy: uid, updatedAt: Date.now() });
        });
      } else if (action === "payment-export") {
        const from = typeof body.from === "number" && Number.isSafeInteger(body.from) ? body.from : Date.now() - 365 * DAY;
        const till = typeof body.till === "number" && Number.isSafeInteger(body.till) ? body.till : Date.now();
        const records = await db.collectionGroup("ledger").where("at", ">=", from).where("at", "<=", till).orderBy("at").limit(1001).get();
        if (records.size > 1000) throw new AppointmentError(400, "export_range_too_large");
        const cell = (value: unknown) => `"${String(value ?? "").replace(/^[=+@\-\s]/, match => "'" + match).replace(/"/g, '""')}"`;
        const rows = records.docs.map(row => {
          const { at, kind, method, amount, by, reference, status, clearance, taxCents } = row.data();
          return [row.ref.parent.parent?.id, row.id, new Date(at).toISOString(), kind ?? "manual_payment", method, status ?? clearance ?? "recorded",
            by, reference].map(cell).join(",") + `,${Number.isSafeInteger(amount) ? amount : ""},${Number.isSafeInteger(taxCents) ? taxCents : 0}`;
        });
        result = { csv: ["appointment,transaction,utc_time,kind,method,status,operator,reference,amount_cents,tax_cents", ...rows].join("\r\n") };
      } else if (["update-contact", "cancel", "issue-link", "revoke-link", "approve", "no-show", "start-job", "save-job", "save-notes", "finish-job", "record-payment", "reverse-payment", "clear-check", "return-check", "reschedule", "reject-reschedule", "offer-alternate", "maintenance-invite"].includes(action)) {
        result = await changeAppointment(db, uid, identifier(body.id)!, action, body);
      } else throw new AppointmentError(404, "not_found");
    }
    res.json({ ok: true, result });
  } catch (error) {
    if (error instanceof AppointmentError || error instanceof ContentError) {
      // 503s mean an integration (Stripe, Google Calendar, Secret Manager) let a customer or the owner down.
      if (error.status >= 500) {
        const source = error.code.startsWith("calendar") ? "calendar" : "api";
        await recordOpsEvent(db, { source, code: error.code, detail: `During "${action}".` });
      }
      res.status(error.status).json({ ok: false, error: error.code });
    } else {
      logger.error("Appointment operation failed", { action, code: (error as { code?: unknown })?.code });
      await recordOpsEvent(db, { source: "api", code: "operation_failed", ref: action,
        detail: `${action}: ${error instanceof Error ? error.message : String(error)}` });
      res.status(500).json({ ok: false, error: "appointment_operation_failed" });
    }
  }
}

export async function handleStripeWebhook(db: Firestore, req: Request, res: Response) {
  if (req.method !== "POST") { res.sendStatus(405); return; }
  try {
    const config = await stripeConfig();
    if (!config) {
      await recordOpsEvent(db, { source: "stripe", code: "webhook_config_missing" });
      res.sendStatus(503);
      return;
    }
    const event = verifyStripeEvent(req.rawBody, req.get("Stripe-Signature") ?? "", config.webhookSecret);
    if (!event) {
      // Usually noise from the internet, but a run of these after rotating the webhook secret means a stale secret.
      await recordOpsEvent(db, { source: "stripe", code: "webhook_signature", level: "warning" });
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
    if (existing.get("completedAt")) { res.sendStatus(204); return; }
    const sessionId = event.data.object.id;
    await receipt.set({ sessionId, type: event.type, receivedAt: Date.now() }, { merge: true });
    if (checkoutEvent) await applyStripeSession(db, await stripeSession(config, sessionId));
    else {
      const change = await stripeMoneyChange(config, event);
      if (change && HASH.test(change.appointmentId)) {
        const ref = db.collection("appointments").doc(change.appointmentId);
        await db.runTransaction(async tx => {
          const appointment = (await tx.get(ref)).data() as Appointment | undefined;
          if (!appointment) return;
          const deposit = appointment.depositIntent === change.intent;
          const balance = appointment.payments?.some(payment => payment.method === "stripe" && payment.reference === change.intent);
          if (!deposit && !balance) {
            if (appointment.checkout) throw new Error("stripe_capture_pending");
            return;
          }
          // An internally requested full deposit refund is already tracked by the refund worker.
          if (deposit && appointment.refund && change.kind === "refund" && change.amount === appointment.paidDeposit) return;
          const existing = await tx.get(ref.collection("ledger").doc(event.id));
          if (existing.exists) return;
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
  } catch (error) {
    logger.error("Stripe webhook processing failed");
    // Stripe retries for up to three days, so this is recoverable once the cause is fixed.
    await recordOpsEvent(db, { source: "stripe", code: "webhook_failed", detail: error instanceof Error ? error.message : String(error) });
    res.sendStatus(503);
  }
}
