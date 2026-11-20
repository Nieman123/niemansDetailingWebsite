import type { Firestore, Transaction } from "firebase-admin/firestore";
import { integrationConfig, liveMode } from "./appointment-secrets";
import { type EmailContent, emailHtml, emailText } from "./appointment-email-template";

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

export async function deliverAppointmentEmails(db: Firestore, now: number,
  maintenanceEligible: (details: MaintenanceEligibility) => Promise<boolean>) {
  const config = await integrationConfig<EmailConfig>("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
  const live = liveMode();
  if (!config?.apiKey?.startsWith("re_") || !config.from || (!live && !Array.isArray(config.testRecipients))) return;
  // Outside production, only allow-listed test inboxes receive mail.
  const recipients = new Set((config.testRecipients ?? []).map(value => value.toLowerCase()));
  const rows = await db.collection("appointmentEmails").where("nextAt", "<=", now).where("nextAt", ">", 0).orderBy("nextAt").limit(5).get();
  for (const row of rows.docs) {
    const email = row.data() as EmailMessage;
    if (email.sentAt || (!live && !recipients.has(email.to.toLowerCase())) || now - email.createdAt > 23 * 3_600_000) {
      await row.ref.update({ nextAt: null, state: email.sentAt ? "sent" : "needs_review" });
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
      if (!response.ok) throw new Error("email_delivery_failed");
      await row.ref.update({ nextAt: null, sentAt: Date.now(), state: "sent" });
    } catch {
      await row.ref.update({ nextAt: now + 15 * 60_000, state: "retry" });
    }
  }
}
