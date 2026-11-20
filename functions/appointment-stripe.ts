import { createHmac, timingSafeEqual } from "node:crypto";
import { integrationConfig, liveMode } from "./appointment-secrets";

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
  // Keys must match the mode, so a test key can never run production or a live key staging.
  const keyPattern = liveMode() ? /^(sk|rk)_live_\w+$/ : /^(sk|rk)_test_\w+$/;
  if (!config || !keyPattern.test(config.secretKey) || !/^whsec_\w+$/.test(config.webhookSecret)) return null;
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
  if (!response.ok) {
    // Keep Stripe's error code and message (never the request) so failures can be diagnosed from logs.
    const detail = await Promise.resolve().then(() => response.json()).catch(() => null) as { error?: { code?: string; type?: string; message?: string } } | null;
    const reason = detail?.error?.code ?? detail?.error?.type ?? "unknown";
    throw new Error(`stripe_request_${response.status}:${reason}:${(detail?.error?.message ?? "").slice(0, 200)}`);
  }
  return await response.json() as T;
}

// Hosted Checkout matches the site: dark ground, royal purple button, Inter, logo and icon from the site.
export function checkoutBranding(origin: string): Record<string, string> {
  return {
    "branding_settings[background_color]": "#0a0912",
    "branding_settings[button_color]": "#6b3fd8",
    "branding_settings[border_style]": "rounded",
    "branding_settings[font_family]": "inter",
    "branding_settings[display_name]": "Nieman's Detailing",
    "branding_settings[logo][type]": "url",
    "branding_settings[logo][url]": `${origin}/images/ND-logo-white-transparentbg-horizontal.png`,
    "branding_settings[icon][type]": "url",
    "branding_settings[icon][url]": `${origin}/admin/appointment-icon-512.png`,
  };
}

export async function createStripeSession(config: StripeConfig, input: {
  id: string; attempt: string; origin: string; kind: "deposit" | "balance";
  amount: number; expiresAt: number; disclosure: string; taxCents?: number; taxLabel?: string;
}) {
  const { id, attempt, origin } = input;
  const body = checkoutSessionBody(input);
  try {
    return await stripeRequest<StripeSession>(config, "checkout/sessions", { ...body, ...checkoutBranding(origin) }, `detail-${id}-${attempt}-branded`);
  } catch (error) {
    // Branding is cosmetic: if Stripe rejects it, still take the payment with Dashboard branding.
    if (!(error instanceof Error) || !error.message.startsWith("stripe_request_400")) throw error;
    return stripeRequest<StripeSession>(config, "checkout/sessions", body, `detail-${id}-${attempt}`);
  }
}

function checkoutSessionBody(input: {
  id: string; attempt: string; origin: string; kind: "deposit" | "balance";
  amount: number; expiresAt: number; disclosure: string; taxCents?: number; taxLabel?: string;
}): Record<string, string> {
  const { id, attempt, origin, kind, amount, expiresAt, disclosure } = input;
  // Sales tax is its own line on a balance; the lines always add up to the reserved amount.
  const tax = kind === "balance" && input.taxCents && input.taxCents > 0 && input.taxCents <= amount ? input.taxCents : 0;
  const lines: Array<[string, number]> = [
    [kind === "deposit" ? "Detailing appointment deposit" : "Detailing appointment balance", amount - tax],
    [input.taxLabel || "Sales tax", tax],
  ].filter(([, cents]) => (cents as number) > 0) as Array<[string, number]>;
  const items: Record<string, string> = {};
  lines.forEach(([name, cents], index) => {
    items[`line_items[${index}][quantity]`] = "1";
    items[`line_items[${index}][price_data][currency]`] = "usd";
    items[`line_items[${index}][price_data][unit_amount]`] = String(cents);
    items[`line_items[${index}][price_data][product_data][name]`] = name;
  });
  return {
    mode: "payment",
    ...items,
    "metadata[appointmentId]": id,
    "metadata[attemptId]": attempt,
    "metadata[kind]": kind,
    "payment_intent_data[metadata][appointmentId]": id,
    "payment_intent_data[metadata][kind]": kind,
    "custom_text[submit][message]": disclosure,
    expires_at: String(Math.floor(expiresAt / 1000)),
    success_url: `${origin}/appointment?checkout=complete`,
    cancel_url: `${origin}/appointment?checkout=back`,
  };
}

export function isSessionId(id: string) {
  return (liveMode() ? /^cs_live_\w+$/ : /^cs_test_\w+$/).test(id);
}

// Ends an open session early so an abandoned payment page stops holding the appointment.
// Stripe refuses to expire a session that already completed or expired; then return its current state.
export async function releaseStripeSession(config: StripeConfig, id: string) {
  if (!isSessionId(id)) throw new Error("invalid_stripe_session");
  try {
    return await stripeRequest<StripeSession>(config, `checkout/sessions/${id}/expire`, {});
  } catch {
    return stripeSession(config, id);
  }
}

export function stripeSession(config: StripeConfig, id: string) {
  if (!isSessionId(id)) throw new Error("invalid_stripe_session");
  return stripeRequest<StripeSession>(config, `checkout/sessions/${id}`);
}

// A create request can succeed at Stripe before its session ID is saved in Firestore.
export async function findCheckoutAttempt(config: StripeConfig, id: string, attempt: string, from: number, until: number) {
  const query = new URLSearchParams({
    "created[gte]": String(Math.floor(from / 1000)), "created[lte]": String(Math.ceil(until / 1000)), limit: "100",
  });
  for (;;) {
    const page = await stripeRequest<{ data: StripeSession[]; has_more: boolean }>(config, `checkout/sessions?${query}`);
    const match = page.data.find(session => session.livemode === liveMode() && session.metadata?.appointmentId === id &&
      session.metadata.attemptId === attempt);
    if (match) return match;
    if (page.has_more === false) return null;
    const cursor = page.data[page.data.length - 1]?.id;
    if (!cursor || query.get("starting_after") === cursor) throw new Error("invalid_stripe_page");
    query.set("starting_after", cursor);
  }
}

export async function stripeMoneyChange(config: StripeConfig, event: StripeEvent) {
  const id = event.data.object.id;
  const isRefund = event.type === "charge.refunded";
  // Non-card payment methods report charges with a py_ prefix.
  if (!(isRefund ? /^(ch|py)_\w+$/ : /^dp_\w+$/).test(id)) return null;
  const object = await stripeRequest<{
    livemode: boolean; currency: string; payment_intent: string; status: string; amount: number; amount_refunded?: number;
  }>(config, `${isRefund ? "charges" : "disputes"}/${id}`);
  if (object.livemode !== liveMode() || object.currency !== "usd" || !/^pi_\w+$/.test(object.payment_intent)) return null;
  const intent = await stripeRequest<{ livemode: boolean; metadata?: Record<string, string> }>(config, `payment_intents/${object.payment_intent}`);
  if (intent.livemode !== liveMode() || !intent.metadata?.appointmentId) return null;
  const amount = isRefund ? object.amount_refunded : object.amount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  return { appointmentId: intent.metadata.appointmentId, intent: object.payment_intent, kind: isRefund ? "refund" : "dispute",
    amount, stripeStatus: isRefund ? "refunded" : object.status, stripeObjectId: id };
}

export function stripeRefund(config: StripeConfig, input: { id: string; intent: string; cents: number; refundId?: string }) {
  if (input.refundId) {
    // Card refunds use re_; other payment methods (Link, Cash App, and so on) use prefixes such as pyr_.
    if (!/^[a-z]{2,6}_[A-Za-z0-9]+$/.test(input.refundId)) throw new Error("invalid_refund_id");
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
    return event.livemode === liveMode() && /^evt_\w+$/.test(event.id) && typeof event.type === "string" &&
      typeof event.data?.object?.id === "string" ? event : null;
  } catch { return null; }
}
