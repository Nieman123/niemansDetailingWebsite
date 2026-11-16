"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueAppointmentEmail = queueAppointmentEmail;
exports.deliverAppointmentEmails = deliverAppointmentEmails;
const appointment_secrets_1 = require("./appointment-secrets");
function queueAppointmentEmail(db, tx, key, to, subject, text) {
    if (!to)
        return;
    const now = Date.now();
    tx.set(db.collection("appointmentEmails").doc(key), { to, subject, text, createdAt: now, nextAt: now });
}
async function deliverAppointmentEmails(db, now) {
    const config = await (0, appointment_secrets_1.integrationConfig)("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
    if (!config?.apiKey?.startsWith("re_") || !config.from || !Array.isArray(config.testRecipients))
        return;
    const recipients = new Set(config.testRecipients.map(value => value.toLowerCase()));
    const rows = await db.collection("appointmentEmails").where("nextAt", "<=", now).where("nextAt", ">", 0).orderBy("nextAt").limit(5).get();
    for (const row of rows.docs) {
        const email = row.data();
        if (email.sentAt || !recipients.has(email.to.toLowerCase()) || now - email.createdAt > 23 * 3600000) {
            await row.ref.update({ nextAt: null, state: email.sentAt ? "sent" : "needs_review" });
            continue;
        }
        try {
            const response = await fetch("https://api.resend.com/emails", {
                method: "POST", signal: AbortSignal.timeout(6000),
                headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": `detailing/${row.id}` },
                body: JSON.stringify({ from: config.from, to: [email.to], text: email.text, subject: email.subject }),
            });
            if (!response.ok)
                throw new Error("email_delivery_failed");
            await row.ref.update({ nextAt: null, sentAt: Date.now(), state: "sent" });
        }
        catch {
            await row.ref.update({ nextAt: now + 15 * 60000, state: "retry" });
        }
    }
}
