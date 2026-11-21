// Site health log for the admin Health page. Problems the backend runs into (failed emails, Stripe webhook
// errors, calendar sync failures, scheduler crashes, browser errors) land in the opsEvents collection.
// The same problem within an hour folds into one row with a count, so a broken integration can't flood
// Firestore. The first time an error shows up in a six-hour window, the owner also gets a Telegram alert.
import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { sendTelegramMessage, telegramConfigured } from "./telegram";

export type OpsLevel = "error" | "warning";
export type OpsEventInput = {
  source: string;
  code: string;
  level?: OpsLevel;
  // Short, human-readable context. Never put secrets or full customer records here.
  detail?: string;
  // An appointment or lead ID, or a page path, so the dashboard can link to it.
  ref?: string;
  // Extra identity for the hourly roll-up, such as a browser error message, so distinct problems get their own rows.
  fingerprint?: string;
};

const HOUR = 3_600_000;
const clean = (value: unknown, max: number) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const key = (...parts: Array<string | number>) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
const opsEventId = (source: string, code: string, ref: string, fingerprint: string, hour: number) => key(source, code, ref, fingerprint, hour);

function alreadyExists(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === "already-exists" || code === "ALREADY_EXISTS";
}

// Records a problem and never throws: health logging must not break the work that reported it.
export async function recordOpsEvent(db: Firestore, input: OpsEventInput, now = Date.now()): Promise<boolean> {
  const level: OpsLevel = input.level ?? "error";
  const source = clean(input.source, 40) || "unknown";
  const code = clean(input.code, 80) || "unknown";
  const ref = clean(input.ref, 160);
  const detail = clean(input.detail, 500);
  const hour = Math.floor(now / HOUR);
  const doc = db.collection("opsEvents").doc(opsEventId(source, code, ref, input.fingerprint ?? "", hour));
  let created = false;
  try {
    await doc.create({ source, code, level, ref, detail, count: 1, firstAt: now, lastAt: now, hour });
    created = true;
  } catch (error) {
    if (!alreadyExists(error)) {
      logger.error("Health event not recorded", { source, code, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
    await doc.update({ count: FieldValue.increment(1), lastAt: now, ...(detail ? { detail } : {}) }).catch(() => undefined);
  }
  if (level === "error") logger.error("Site health problem", { source, code, ref, detail });
  else logger.warn("Site health warning", { source, code, ref, detail });
  if (created && level === "error") await alertOwner(db, { source, code, ref, detail }, now);
  return created;
}

async function alertOwner(db: Firestore, event: { source: string; code: string; ref: string; detail: string }, now: number) {
  if (!telegramConfigured()) return;
  const window = Math.floor(now / (6 * HOUR));
  try {
    await db.collection("opsAlerts").doc(key(event.source, event.code, window)).create({ at: now, source: event.source, code: event.code });
  } catch {
    return; // Already alerted about this problem in this window, or Firestore is down.
  }
  const origin = (process.env.HOSTING_ORIGIN ?? "").replace(/\/$/, "");
  const text = [
    `Site problem: ${describeOpsEvent(event.source, event.code)}`,
    event.detail ? `Detail: ${event.detail}` : null,
    event.ref ? `Ref: ${event.ref}` : null,
    origin ? `Health page: ${origin}/admin/health` : null,
  ].filter(Boolean).join("\n");
  await sendTelegramMessage(text).catch(error => logger.error("Health alert not sent", { reason: error instanceof Error ? error.message : String(error) }));
}

const descriptions: Record<string, string> = {
  "email:email_failed": "A customer email could not be delivered after a day of retries",
  "email:email_retry": "A customer email failed to send and will be retried",
  "email:email_config_missing": "Customer emails are queued but the email provider is not configured",
  "stripe:webhook_failed": "A Stripe payment notification could not be processed",
  "stripe:webhook_signature": "A Stripe notification had an invalid signature",
  "stripe:webhook_config_missing": "Stripe notifications arrived but Stripe is not configured",
  "payments:reconcile_failed": "A payment could not be reconciled",
  "payments:refund_failed": "A deposit refund could not be processed",
  "calendar:sync_failed": "An appointment could not be copied to Google Calendar",
  "calendar:calendar_unavailable": "Google Calendar could not be reached, so booking was blocked",
  "api:operation_failed": "A booking or admin request crashed",
  "api:stripe_unavailable": "Stripe could not be reached during a request",
  "scheduler:run_failed": "The 5-minute maintenance job crashed",
  "leads:create_failed": "A quote request could not be saved",
  "leads:telegram_failed": "A new quote request was saved but its Telegram alert failed",
  "booking:telegram_failed": "A new booking alert could not be sent to Telegram",
  "browser:script_error": "A page hit a JavaScript error in a visitor's browser",
};

export function describeOpsEvent(source: string, code: string) {
  return descriptions[`${source}:${code}`] ?? `${source}: ${code.replace(/_/g, " ")}`;
}

// Heartbeat for the scheduled maintenance job, shown on the Health page.
export async function recordSchedulerRun(db: Firestore, startedAt: number, error?: unknown) {
  const finishedAt = Date.now();
  const update: Record<string, unknown> = { lastRunAt: startedAt, lastFinishedAt: finishedAt, lastDurationMs: finishedAt - startedAt };
  if (error) {
    update.lastError = clean(error instanceof Error ? error.message : String(error), 300);
    update.lastErrorAt = finishedAt;
  } else update.lastOkAt = finishedAt;
  await db.collection("opsStatus").doc("scheduler").set(update, { merge: true }).catch(() => undefined);
  if (error) await recordOpsEvent(db, { source: "scheduler", code: "run_failed", detail: String(update.lastError ?? "") });
}

// Browser error reports are anonymous, so cap how many distinct new ones are stored each hour.
const BROWSER_EVENTS_PER_HOUR = 40;

export async function recordBrowserError(db: Firestore, body: unknown, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const report = body as Record<string, unknown>;
  const message = clean(report.message, 300);
  const page = clean(report.page, 120).replace(/[?#].*$/, "");
  if (!message || !/^\/[\w\-./]*$/.test(page || "/")) return;
  const where = clean(report.source, 160).replace(/[?#].*$/, "");
  const line = Number.isInteger(report.line) ? `:${report.line}` : "";
  const hour = Math.floor(now / HOUR);
  const counter = db.collection("opsStatus").doc(`browser-${hour}`);
  const ref = page || "/";
  const existing = await db.collection("opsEvents").doc(opsEventId("browser", "script_error", ref, message, hour)).get();
  if (!existing.exists) {
    const allowed = await db.runTransaction(async tx => {
      const count = (await tx.get(counter)).get("count") ?? 0;
      if (count >= BROWSER_EVENTS_PER_HOUR) return false;
      tx.set(counter, { count: count + 1, hour, expiresAt: now + 2 * HOUR }, { merge: true });
      return true;
    });
    if (!allowed) return;
  }
  // Browser errors are warnings: they show on the dashboard but don't page the owner.
  await recordOpsEvent(db, {
    source: "browser", code: "script_error", level: "warning", ref, fingerprint: message,
    detail: `${message}${where ? ` (${where}${line})` : ""}`,
  }, now);
}

// Keep the health log small: drop rows older than 30 days, a batch per scheduler run.
export async function pruneOpsEvents(db: Firestore, now = Date.now()) {
  const cutoff = now - 30 * 24 * HOUR;
  const [events, alerts, counters] = await Promise.all([
    db.collection("opsEvents").where("lastAt", "<", cutoff).limit(100).get(),
    db.collection("opsAlerts").where("at", "<", cutoff).limit(100).get(),
    db.collection("opsStatus").where("expiresAt", "<", now).limit(100).get(),
  ]);
  const old = [...events.docs, ...alerts.docs, ...counters.docs];
  if (!old.length) return;
  const batch = db.batch();
  for (const doc of old) batch.delete(doc.ref);
  await batch.commit();
}
