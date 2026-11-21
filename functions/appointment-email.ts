import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { integrationConfig, liveMode } from "./appointment-secrets";
import { type EmailContent, emailHtml, emailText } from "./appointment-email-template";
import { recordOpsEvent } from "./ops-health";

type EmailConfig = { apiKey: string; from: string; testRecipients?: string[] };
type MaintenanceEligibility = { appointmentId: string; inviteHash: string };
type EmailMessage = {
  to: string; subject: string; text: string; html?: string; createdAt: number; nextAt: number; sentAt?: number;
  maintenance?: MaintenanceEligibility;
};

export function queueAppointmentEmail(db: Firestore, tx: Transaction, key: string, to: string, subject: string, content: EmailContent,
  maintenance?: MaintenanceEligibility) {
  if (!to) return;
  const now = Date.now();
  tx.set(db.collection("appointmentEmails").doc(key), {
    to, subject, text: emailText(content), html: emailHtml(content, subject), createdAt: now, nextAt: now, ...(maintenance ? { maintenance } : {}),
  });
}

// Whether a usable Resend configuration is in place for this mode, for the Health page.
export async function emailConfigured() {
  const config = await integrationConfig<EmailConfig>("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
  return !!config?.apiKey?.startsWith("re_") && !!config.from && (liveMode() || Array.isArray(config.testRecipients));
}

export async function deliverAppointmentEmails(db: Firestore, now: number,
  maintenanceEligible: (details: MaintenanceEligibility) => Promise<boolean>) {
  const config = await integrationConfig<EmailConfig>("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
  const live = liveMode();
  if (!config?.apiKey?.startsWith("re_") || !config.from || (!live && !Array.isArray(config.testRecipients))) {
    // Mail is piling up with nowhere to go. Say so once the oldest waiting email is 15 minutes old.
    const waiting = await db.collection("appointmentEmails").where("nextAt", "<=", now - 15 * 60_000).where("nextAt", ">", 0).limit(1).get();
    if (!waiting.empty) await recordOpsEvent(db, { source: "email", code: "email_config_missing", detail: "APPOINTMENT_EMAIL_CONFIG is missing or invalid." });
    return;
  }
  // Outside production, only allow-listed test inboxes receive mail.
  const recipients = new Set((config.testRecipients ?? []).map(value => value.toLowerCase()));
  const rows = await db.collection("appointmentEmails").where("nextAt", "<=", now).where("nextAt", ">", 0).orderBy("nextAt").limit(5).get();
  for (const row of rows.docs) {
    const email = row.data() as EmailMessage;
    if (email.sentAt || (!live && !recipients.has(email.to.toLowerCase())) || now - email.createdAt > 23 * 3_600_000) {
      const expired = !email.sentAt && now - email.createdAt > 23 * 3_600_000;
      await row.ref.update({ nextAt: null, state: email.sentAt ? "sent" : expired ? "failed" : "skipped_test_recipient" });
      if (expired) await recordOpsEvent(db, { source: "email", code: "email_failed", ref: row.id, detail: `"${email.subject}" was never delivered.` });
      continue;
    }
    try {
      if (email.maintenance && !(await maintenanceEligible(email.maintenance))) {
        await row.ref.update({ nextAt: null, state: "ineligible" });
        continue;
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(6000),
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `detailing/${row.id}` },
        body: JSON.stringify({ from: config.from, to: [email.to], text: email.text, ...(email.html ? { html: email.html } : {}), subject: email.subject }),
      });
      if (!response.ok) {
        // Resend explains rejections in the body (bad address, unverified domain, rate limit). Keep a short reason.
        const reason = await response.json().then((body: { name?: string; message?: string }) => `${body.name ?? ""} ${body.message ?? ""}`.trim(), () => "");
        throw new Error(`email_delivery_failed_${response.status}${reason ? `: ${reason.slice(0, 200)}` : ""}`);
      }
      await row.ref.update({ nextAt: null, sentAt: Date.now(), state: "sent" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await row.ref.update({ nextAt: now + 15 * 60_000, state: "retry", lastError: reason.slice(0, 300), attempts: FieldValue.increment(1) });
      await recordOpsEvent(db, { source: "email", code: "email_retry", level: "warning", ref: row.id, detail: reason });
    }
  }
}

// Sends one email right away, with an optional PDF attachment, for owner actions like emailing an invoice.
// Follows the same rule as queued mail: outside production only allow-listed test inboxes receive it.
export async function sendEmailNow(input: {
  to: string; subject: string; content: EmailContent; idempotencyKey: string;
  attachment?: { filename: string; content: Buffer };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = await integrationConfig<EmailConfig>("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
  const live = liveMode();
  if (!config?.apiKey?.startsWith("re_") || !config.from || (!live && !Array.isArray(config.testRecipients))) {
    return { ok: false, error: "email_not_configured" };
  }
  if (!live && !(config.testRecipients ?? []).map(value => value.toLowerCase()).includes(input.to.toLowerCase())) {
    return { ok: false, error: "test_recipient_only" };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `detailing/${input.idempotencyKey}` },
      body: JSON.stringify({
        from: config.from, to: [input.to], subject: input.subject,
        text: emailText(input.content), html: emailHtml(input.content, input.subject),
        ...(input.attachment ? { attachments: [{ filename: input.attachment.filename, content: input.attachment.content.toString("base64") }] } : {}),
      }),
    });
    if (!response.ok) {
      const reason = await response.json().then((body: { name?: string; message?: string }) => `${body.name ?? ""} ${body.message ?? ""}`.trim(), () => "");
      return { ok: false, error: `email_delivery_failed:${response.status}${reason ? ` ${reason.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `email_delivery_failed:${error instanceof Error ? error.message : String(error)}` };
  }
}
