"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueAppointmentEmail = queueAppointmentEmail;
exports.emailConfigured = emailConfigured;
exports.deliverAppointmentEmails = deliverAppointmentEmails;
const firestore_1 = require("firebase-admin/firestore");
const appointment_secrets_1 = require("./appointment-secrets");
const appointment_email_template_1 = require("./appointment-email-template");
const ops_health_1 = require("./ops-health");
function queueAppointmentEmail(db, tx, key, to, subject, content, maintenance) {
    if (!to)
        return;
    const now = Date.now();
    tx.set(db.collection("appointmentEmails").doc(key), {
        to, subject, text: (0, appointment_email_template_1.emailText)(content), html: (0, appointment_email_template_1.emailHtml)(content, subject), createdAt: now, nextAt: now, ...(maintenance ? { maintenance } : {}),
    });
}
// Whether a usable Resend configuration is in place for this mode, for the Health page.
async function emailConfigured() {
    const config = await (0, appointment_secrets_1.integrationConfig)("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
    return !!config?.apiKey?.startsWith("re_") && !!config.from && ((0, appointment_secrets_1.liveMode)() || Array.isArray(config.testRecipients));
}
async function deliverAppointmentEmails(db, now, maintenanceEligible) {
    const config = await (0, appointment_secrets_1.integrationConfig)("APPOINTMENT_EMAIL_CONFIG").catch(() => null);
    const live = (0, appointment_secrets_1.liveMode)();
    if (!config?.apiKey?.startsWith("re_") || !config.from || (!live && !Array.isArray(config.testRecipients))) {
        // Mail is piling up with nowhere to go. Say so once the oldest waiting email is 15 minutes old.
        const waiting = await db.collection("appointmentEmails").where("nextAt", "<=", now - 15 * 60000).where("nextAt", ">", 0).limit(1).get();
        if (!waiting.empty)
            await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_config_missing", detail: "APPOINTMENT_EMAIL_CONFIG is missing or invalid." });
        return;
    }
    // Outside production, only allow-listed test inboxes receive mail.
    const recipients = new Set((config.testRecipients ?? []).map(value => value.toLowerCase()));
    const rows = await db.collection("appointmentEmails").where("nextAt", "<=", now).where("nextAt", ">", 0).orderBy("nextAt").limit(5).get();
    for (const row of rows.docs) {
        const email = row.data();
        if (email.sentAt || (!live && !recipients.has(email.to.toLowerCase())) || now - email.createdAt > 23 * 3600000) {
            const expired = !email.sentAt && now - email.createdAt > 23 * 3600000;
            await row.ref.update({ nextAt: null, state: email.sentAt ? "sent" : expired ? "failed" : "skipped_test_recipient" });
            if (expired)
                await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_failed", ref: row.id, detail: `"${email.subject}" was never delivered.` });
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
                const reason = await response.json().then((body) => `${body.name ?? ""} ${body.message ?? ""}`.trim(), () => "");
                throw new Error(`email_delivery_failed_${response.status}${reason ? `: ${reason.slice(0, 200)}` : ""}`);
            }
            await row.ref.update({ nextAt: null, sentAt: Date.now(), state: "sent" });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await row.ref.update({ nextAt: now + 15 * 60000, state: "retry", lastError: reason.slice(0, 300), attempts: firestore_1.FieldValue.increment(1) });
            await (0, ops_health_1.recordOpsEvent)(db, { source: "email", code: "email_retry", level: "warning", ref: row.id, detail: reason });
        }
    }
}
