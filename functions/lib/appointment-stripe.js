"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeConfig = stripeConfig;
exports.createStripeSession = createStripeSession;
exports.stripeSession = stripeSession;
exports.findCheckoutAttempt = findCheckoutAttempt;
exports.stripeMoneyChange = stripeMoneyChange;
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
    if (!response.ok) {
        // Keep Stripe's error code and message (never the request) so failures can be diagnosed from logs.
        const detail = await Promise.resolve().then(() => response.json()).catch(() => null);
        const reason = detail?.error?.code ?? detail?.error?.type ?? "unknown";
        throw new Error(`stripe_request_${response.status}:${reason}:${(detail?.error?.message ?? "").slice(0, 200)}`);
    }
    return await response.json();
}
function createStripeSession(config, input) {
    const { id, attempt, origin, kind, amount, expiresAt, disclosure } = input;
    return stripeRequest(config, "checkout/sessions", {
        mode: "payment",
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
// A create request can succeed at Stripe before its session ID is saved in Firestore.
async function findCheckoutAttempt(config, id, attempt, from, until) {
    const query = new URLSearchParams({
        "created[gte]": String(Math.floor(from / 1000)), "created[lte]": String(Math.ceil(until / 1000)), limit: "100",
    });
    for (;;) {
        const page = await stripeRequest(config, `checkout/sessions?${query}`);
        const match = page.data.find(session => session.livemode === false && session.metadata?.appointmentId === id &&
            session.metadata.attemptId === attempt);
        if (match)
            return match;
        if (page.has_more === false)
            return null;
        const cursor = page.data[page.data.length - 1]?.id;
        if (!cursor || query.get("starting_after") === cursor)
            throw new Error("invalid_stripe_page");
        query.set("starting_after", cursor);
    }
}
async function stripeMoneyChange(config, event) {
    const id = event.data.object.id;
    const isRefund = event.type === "charge.refunded";
    if (!(isRefund ? /^ch_\w+$/ : /^dp_\w+$/).test(id))
        return null;
    const object = await stripeRequest(config, `${isRefund ? "charges" : "disputes"}/${id}`);
    if (object.livemode !== false || object.currency !== "usd" || !/^pi_\w+$/.test(object.payment_intent))
        return null;
    const intent = await stripeRequest(config, `payment_intents/${object.payment_intent}`);
    if (intent.livemode !== false || !intent.metadata?.appointmentId)
        return null;
    const amount = isRefund ? object.amount_refunded : object.amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0)
        return null;
    return { appointmentId: intent.metadata.appointmentId, intent: object.payment_intent, kind: isRefund ? "refund" : "dispute",
        amount, stripeStatus: isRefund ? "refunded" : object.status, stripeObjectId: id };
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
