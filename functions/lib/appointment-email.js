"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueAppointmentEmail = queueAppointmentEmail;
exports.deliverAppointmentEmails = deliverAppointmentEmails;
const appointment_secrets_1 = require("./appointment-secrets");
const appointment_email_template_1 = require("./appointment-email-template");
function queueAppointmentEmail(db, tx, key, to, subject, content, maintenance) {
    if (!to)
        return;
    const now = Date.now();
    tx.set(db.collection("appointmentEmails").doc(key), {
        to, subject, text: (0, appointment_email_template_1.emailText)(content), html: (0, appointment_email_template_1.emailHtml)(content, subject), createdAt: now, nextAt: now, ...(maintenance ? { maintenance } : {}),
    });
}
async function deliverAppointmentEmails(db, now, maintenanceEligible) {
    const config = await (0, appointment_secrets_1.integrationConfig)("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
    const live = (0, appointment_secrets_1.liveMode)();
    if (!config?.apiKey?.startsWith("re_") || !config.from || (!live && !Array.isArray(config.testRecipients)))
        return;
    // Outside production, only allow-listed test inboxes receive mail.
    const recipients = new Set((config.testRecipients ?? []).map(value => value.toLowerCase()));
    const rows = await db.collection("appointmentEmails").where("nextAt", "<=", now).where("nextAt", ">", 0).orderBy("nextAt").limit(5).get();
    for (const row of rows.docs) {
        const email = row.data();
        if (email.sentAt || (!live && !recipients.has(email.to.toLowerCase())) || now - email.createdAt > 23 * 3600000) {
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
            if (!response.ok)
                throw new Error("email_delivery_failed");
            await row.ref.update({ nextAt: null, sentAt: Date.now(), state: "sent" });
        }
        catch {
            await row.ref.update({ nextAt: now + 15 * 60000, state: "retry" });
        }
    }
}
