"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeConfig = stripeConfig;
exports.createStripeSession = createStripeSession;
exports.stripeSession = stripeSession;
exports.stripeRefund = stripeRefund;
exports.verifyStripeEvent = verifyStripeEvent;
const node_crypto_1 = require("node:crypto");
const appointment_secrets_1 = require("./appointment-secrets");
async function stripeConfig() {
    const config = await (0, appointment_secrets_1.integrationConfig)("APPOINTMENT_STRIPE_CONFIG");
    if (!config || !/^(sk|rk)_test_\w+$/.test(config.secretKey) || !/^whsec_\w+$/.test(config.webhookSecret))
        return null;
    return config;
}
async function stripeRequest(config, path, body, key) {
    const headers = {
        Authorization: `Bearer ${config.secretKey}`, "Stripe-Version": "2026-10-28.endive",
    };
    if (body)
        headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (key)
        headers["Idempotency-Key"] = key;
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method: body ? "POST" : "GET", headers,
        body: body ? new URLSearchParams(body) : undefined,
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
        throw new Error(`stripe_request_${response.status}`);
    return await response.json();
}
function createStripeSession(config, input) {
    const { id, attempt, origin, kind, amount, expiresAt, disclosure } = input;
    return stripeRequest(config, "checkout/sessions", {
        mode: "payment",
        "payment_method_types[0]": "card",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(amount),
        "line_items[0][price_data][product_data][name]": kind === "deposit" ? "Detailing appointment deposit" : "Detailing appointment balance",
        "metadata[appointmentId]": id,
        "metadata[attemptId]": attempt,
        "metadata[kind]": kind,
        "payment_intent_data[metadata][appointmentId]": id,
        "payment_intent_data[metadata][kind]": kind,
        "custom_text[submit][message]": disclosure,
        expires_at: String(Math.floor(expiresAt / 1000)),
        success_url: `${origin}/appointment?checkout=complete`,
        cancel_url: `${origin}/appointment?checkout=back`,
    }, `detail-${id}-${attempt}`);
}
function stripeSession(config, id) {
    if (!/^cs_test_\w+$/.test(id))
        throw new Error("invalid_stripe_session");
    return stripeRequest(config, `checkout/sessions/${id}`);
}
function stripeRefund(config, input) {
    if (input.refundId) {
        if (!/^re_\w+$/.test(input.refundId))
            throw new Error("invalid_refund_id");
        return stripeRequest(config, `refunds/${input.refundId}`);
    }
    return stripeRequest(config, "refunds", {
        payment_intent: input.intent, amount: String(input.cents), "metadata[appointmentId]": input.id,
    }, `detail-deposit-refund-${input.intent}`);
}
function verifyStripeEvent(raw, signature, secret, now = Date.now()) {
    const parts = signature.split(",").map(part => part.trim());
    const timestamps = parts.filter(part => /^t=\d+$/.test(part));
    if (timestamps.length !== 1)
        return null;
    const timestamp = timestamps[0].slice(2);
    if (Math.abs(now - Number(timestamp) * 1000) > 300000)
        return null;
    const expected = (0, node_crypto_1.createHmac)("sha256", secret).update(timestamp).update(".").update(raw).digest();
    if (!parts.some(part => /^v1=[a-f0-9]{64}$/.test(part) && (0, node_crypto_1.timingSafeEqual)(expected, Buffer.from(part.slice(3), "hex"))))
        return null;
    try {
        const event = JSON.parse(raw.toString("utf8"));
        return event.livemode === false && /^evt_\w+$/.test(event.id) && typeof event.type === "string" &&
            typeof event.data?.object?.id === "string" ? event : null;
    }
    catch {
        return null;
    }
}
