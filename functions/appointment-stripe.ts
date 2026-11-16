import { createHmac, timingSafeEqual } from "node:crypto";
import { integrationConfig } from "./appointment-secrets";

type StripeConfig = { secretKey: string; webhookSecret: string };
export type StripeSession = {
  id: string;
  livemode: boolean;
  status: "open" | "complete" | "expired";
  payment_status: string;
  amount_total: number;
  currency: string;
  payment_intent: string | null;
  metadata: Record<string, string>;
  url: string | null;
};
export type StripeRefund = { id: string; status: string; amount: number };
export type StripeEvent = {
  id: string;
  livemode: boolean;
  type: string;
  data: { object: { id: string; metadata?: Record<string, string> } };
};

export async function stripeConfig(): Promise<StripeConfig | null> {
  const config = await integrationConfig<StripeConfig>("APPOINTMENT_STRIPE_CONFIG");
  if (!config || !/^(sk|rk)_test_\w+$/.test(config.secretKey) || !/^whsec_\w+$/.test(config.webhookSecret)) return null;
  return config;
}

async function stripeRequest<T>(config: StripeConfig, path: string, body?: Record<string, string>, key?: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`, "Stripe-Version": "2026-10-28.endive",
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET", headers,
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`stripe_request_${response.status}`);
  return await response.json() as T;
}

export function createStripeSession(config: StripeConfig, input: {
  id: string; attempt: string; origin: string; kind: "deposit" | "balance";
  amount: number; expiresAt: number; disclosure: string;
}) {
  const { id, attempt, origin, kind, amount, expiresAt, disclosure } = input;
  return stripeRequest<StripeSession>(config, "checkout/sessions", {
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

export function stripeSession(config: StripeConfig, id: string) {
  if (!/^cs_test_\w+$/.test(id)) throw new Error("invalid_stripe_session");
  return stripeRequest<StripeSession>(config, `checkout/sessions/${id}`);
}

export function stripeRefund(config: StripeConfig, input: { id: string; intent: string; cents: number; refundId?: string }) {
  if (input.refundId) {
    if (!/^re_\w+$/.test(input.refundId)) throw new Error("invalid_refund_id");
    return stripeRequest<StripeRefund>(config, `refunds/${input.refundId}`);
  }
  return stripeRequest<StripeRefund>(config, "refunds", {
    payment_intent: input.intent, amount: String(input.cents), "metadata[appointmentId]": input.id,
  }, `detail-deposit-refund-${input.intent}`);
}

export function verifyStripeEvent(raw: Buffer, signature: string, secret: string, now = Date.now()): StripeEvent | null {
  const parts = signature.split(",").map(part => part.trim());
  const timestamps = parts.filter(part => /^t=\d+$/.test(part));
  if (timestamps.length !== 1) return null;
  const timestamp = timestamps[0].slice(2);
  if (Math.abs(now - Number(timestamp) * 1000) > 300_000) return null;
  const expected = createHmac("sha256", secret).update(timestamp).update(".").update(raw).digest();
  if (!parts.some(part => /^v1=[a-f0-9]{64}$/.test(part) && timingSafeEqual(expected, Buffer.from(part.slice(3), "hex")))) return null;
  try {
    const event = JSON.parse(raw.toString("utf8")) as StripeEvent;
    return event.livemode === false && /^evt_\w+$/.test(event.id) && typeof event.type === "string" &&
      typeof event.data?.object?.id === "string" ? event : null;
  } catch { return null; }
}
