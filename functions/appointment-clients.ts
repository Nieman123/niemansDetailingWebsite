import { FieldValue, type DocumentReference, type DocumentSnapshot, type Firestore, type Transaction } from "firebase-admin/firestore";

// Keeps admin Clients in step with appointments. A finished job becomes a booking entry on the
// customer's client record, creating that record when the customer is new, so booking history,
// Last Service Date and the next follow-up don't need typing in by hand.

export type ClientJob = {
  id: string; date: string; service: string; totalCents: number | null; vehicle: string;
  name: string; email: string; phone: string; address: string; leadId: string | null;
};
type Booking = {
  id: string; date: string; service: string; amount: number | null; notes: string | null; source: string;
  lead_id: string | null; appointment_id?: string | null; created_at: string;
};

const DEFAULT_REPEAT_MONTHS = 6;
const MAX_BOOKINGS = 120;
const str = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";

export const bookingIdFor = (appointmentId: string) => `appt_${appointmentId.slice(0, 64)}`;

export function clientEmail(value: unknown) {
  const email = str(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

// Matches the Clients page: ten US digits, stored as +1XXXXXXXXXX.
export function clientPhone(value: unknown) {
  let digits = str(value, 40).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? `+1${digits}` : "";
}

const displayPhone = (e164: string) => e164 ? `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}` : "";

export function addMonths(dateIso: string, months: number) {
  const [year, month, day] = dateIso.split("-").map(Number);
  if (!year || !month || !day || !Number.isFinite(months) || months <= 0) return "";
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))).toISOString().slice(0, 10);
}

// "12 Oak St, Asheville, NC 28801" → street, city, state and ZIP for a new client record.
export function splitAddress(address: string) {
  const match = /^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?(?:,\s*(?:USA|US|United States))?$/i.exec(address.trim());
  if (!match) return { address: address.trim().slice(0, 180), city: "", state: "", zip: "" };
  return { address: match[1].slice(0, 180), city: match[2].slice(0, 80), state: match[3].toUpperCase(), zip: match[4] ?? "" };
}

function lookupKeys(fullName: string, email: string, phoneE164: string, zip: string) {
  const slug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return [phoneE164 && `phone:${phoneE164}`, email && `email:${email}`, slug && `name:${slug}`, slug && zip && `namezip:${slug}|${zip}`]
    .filter((key): key is string => !!key);
}

function bookingFor(job: ClientJob, now: number): Booking {
  return {
    id: bookingIdFor(job.id), date: job.date, service: job.service.slice(0, 120) || "Detail",
    amount: job.totalCents === null ? null : Math.round(job.totalCents) / 100,
    notes: job.vehicle ? job.vehicle.slice(0, 280) : null, source: "appointment",
    lead_id: job.leadId, appointment_id: job.id, created_at: new Date(now).toISOString(),
  };
}

// Fields to write so a client record includes these finished jobs. Jobs already in the booking
// history are skipped, so repeating a sync changes nothing.
export function clientChanges(existing: Record<string, unknown>, jobs: ClientJob[], now: number) {
  const bookings: Booking[] = Array.isArray(existing.bookings) ? existing.bookings.filter(item => item && typeof item === "object") : [];
  const known = new Set(bookings.map(item => item.id));
  const added = jobs.filter(job => !known.has(bookingIdFor(job.id))).map(job => bookingFor(job, now));
  const latest = jobs.map(job => job.date).sort().pop() ?? "";
  const lastService = [isoDate(existing.last_service_date), latest].sort().pop() ?? "";
  const changes: Record<string, unknown> = {};
  if (added.length) {
    changes.bookings = [...bookings, ...added]
      .sort((a, b) => a.date === b.date ? String(a.service).localeCompare(String(b.service)) : a.date < b.date ? 1 : -1)
      .slice(0, MAX_BOOKINGS);
  }
  if (lastService && lastService !== existing.last_service_date) changes.last_service_date = lastService;
  const repeat = typeof existing.repeat_interval_months === "number" ? existing.repeat_interval_months : DEFAULT_REPEAT_MONTHS;
  const nextFollowup = isoDate(existing.next_followup_date);
  if (changes.last_service_date && repeat > 0 && (!nextFollowup || nextFollowup <= lastService)) {
    changes.next_followup_date = addMonths(lastService, repeat);
  }
  if (added.length && ["", "prospect", "new", "contacted", "dormant"].includes(str(existing.status, 40).toLowerCase())) changes.status = "active";
  // Fill in contact details the record is missing, never overwriting ones already there.
  const job = [...jobs].sort((a, b) => a.date < b.date ? 1 : -1)[0];
  if (job) {
    const email = clientEmail(job.email);
    const phone = clientPhone(job.phone);
    if (email && !existing.email) changes.email = email;
    if (phone && !existing.phone_e164) { changes.phone_e164 = phone; if (!existing.phone) changes.phone = displayPhone(phone); }
    if (job.address && !existing.address) Object.assign(changes, Object.fromEntries(Object.entries(splitAddress(job.address)).filter(([key, value]) => value && !existing[key])));
    if (changes.email || changes.phone_e164 || changes.zip) {
      const merged = { ...existing, ...changes };
      changes.lookup_keys = lookupKeys(str(merged.full_name, 140), str(merged.email, 254), str(merged.phone_e164, 16), str(merged.zip, 5));
    }
  }
  return changes;
}

export type EmailSource = "sign-in" | "payment";

// Fields to write when a customer hands over an email by signing in or paying online. A record with no
// email takes it. A different email already on file is never replaced: the new one waits as
// email_suggestion for the owner to accept or dismiss on the Clients page.
export function customerEmailChanges(existing: Record<string, unknown>, emailValue: unknown, source: EmailSource, now: number) {
  const email = clientEmail(emailValue);
  if (!email) return {};
  const current = clientEmail(existing.email);
  if (current === email) return {};
  if (!current) {
    return { email, lookup_keys: lookupKeys(str(existing.full_name, 140), email, str(existing.phone_e164, 16), str(existing.zip, 5)) };
  }
  const pending = existing.email_suggestion as { email?: unknown } | null | undefined;
  if (pending && clientEmail(pending.email) === email) return {};
  return { email_suggestion: { email, source, at: new Date(now).toISOString() } };
}

// Applies customerEmailChanges to a client found inside a transaction (reads must already be done).
export function saveCustomerEmail(tx: Transaction, found: DocumentSnapshot | null, email: unknown, source: EmailSource, now: number) {
  if (!found?.exists) return;
  const changes = customerEmailChanges(found.data() ?? {}, email, source, now);
  if (Object.keys(changes).length) tx.update(found.ref, { ...changes, updated_at: new Date(now), updated_by: "customer" });
}

export function newClientRecord(job: ClientJob, uid: string, now: number) {
  const fullName = str(job.name, 140) || "Customer";
  const parts = fullName.split(/\s+/);
  const email = clientEmail(job.email);
  const phoneE164 = clientPhone(job.phone);
  const place = job.address ? splitAddress(job.address) : { address: "", city: "", state: "", zip: "" };
  const base = {
    full_name: fullName, first_name: parts[0] ?? "", last_name: parts.slice(1).join(" "),
    email: email || null, phone_e164: phoneE164 || null, phone: phoneE164 ? displayPhone(phoneE164) : str(job.phone, 24) || null,
    address: place.address || null, city: place.city || null, state: place.state || null, zip: place.zip || null, country: "US",
    status: "active", source: "Appointment", repeat_interval_months: DEFAULT_REPEAT_MONTHS, tags: [], bookings: [],
    notes: null, followup_note: null, source_lead_id: job.leadId, lookup_keys: lookupKeys(fullName, email, phoneE164, place.zip),
  };
  return { ...base, ...clientChanges(base, [job], now), created_by: uid, updated_by: uid };
}

// Reads (inside the transaction, before any write) the client record a finished job belongs to:
// the linked one, else one with the same email, else the same phone.
export async function findClientForJob(db: Firestore, tx: Transaction, clientId: string | null, email: string, phone: string) {
  const clients = db.collection("clients");
  if (clientId) {
    const linked = await tx.get(clients.doc(clientId));
    if (linked.exists) return linked;
  }
  const byEmail = clientEmail(email);
  if (byEmail) {
    const match = await tx.get(clients.where("email", "==", byEmail).limit(1));
    if (!match.empty) return match.docs[0];
  }
  const byPhone = clientPhone(phone);
  if (byPhone) {
    const match = await tx.get(clients.where("phone_e164", "==", byPhone).limit(1));
    if (!match.empty) return match.docs[0];
  }
  return null;
}

// Writes the finished job onto the client found by findClientForJob, or a new client. Returns the client's id.
export function saveJobToClient(db: Firestore, tx: Transaction, found: DocumentSnapshot | null, job: ClientJob, uid: string, now: number) {
  if (found?.exists) {
    const changes = clientChanges(found.data() ?? {}, [job], now);
    if (Object.keys(changes).length) tx.update(found.ref, { ...changes, updated_at: FieldValue.serverTimestamp(), updated_by: uid });
    return found.id;
  }
  const ref: DocumentReference = db.collection("clients").doc();
  tx.create(ref, { ...newClientRecord(job, uid, now), created_at: FieldValue.serverTimestamp(), updated_at: FieldValue.serverTimestamp() });
  return ref.id;
}
