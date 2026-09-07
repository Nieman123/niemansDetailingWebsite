import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";

admin.initializeApp();
const db = admin.firestore();

type Vehicle = "sedan" | "suv_truck" | "van_3row";
type Service = "quick" | "full" | "interior_only" | "other";
type Addon = "wax" | "pethair" | "odor" | "engine" | "soiled" | "ceramic" | "headlights";
type QuoteProgressEvent = "step_view" | "lead_submitted";

const VEHICLE_LABELS: Record<Vehicle, string> = {
  sedan: "Sedan/Coupe",
  suv_truck: "SUV/Truck",
  van_3row: "Van/3-Row SUV",
};
const SERVICE_LABELS: Record<Service, string> = {
  quick: "Quick Once Over",
  full: "Full Detail",
  interior_only: "Interior Only",
  other: "Other",
};
const ADDON_LABELS: Record<Addon, string> = {
  wax: "Wax/Sealant",
  pethair: "Pet Hair",
  odor: "Odor/Ozone",
  engine: "Engine Bay",
  soiled: "Heavily Soiled",
  ceramic: "Ceramic Consult",
  headlights: "Headlight Restoration",
};

const BASE: Record<Vehicle, Partial<Record<Service, number>>> = {
  sedan: { quick: 200, full: 300, interior_only: 200 },
  suv_truck: { quick: 250, full: 350, interior_only: 250 },
  van_3row: { quick: 300, full: 400, interior_only: 300 },
};
const ADDONS: Record<Addon, Record<Vehicle, number>> = {
  wax: { sedan: 25, suv_truck: 30, van_3row: 35 },
  pethair: { sedan: 30, suv_truck: 40, van_3row: 50 },
  odor: { sedan: 35, suv_truck: 45, van_3row: 55 },
  engine: { sedan: 25, suv_truck: 25, van_3row: 30 },
  soiled: { sedan: 40, suv_truck: 60, van_3row: 80 },
  ceramic: { sedan: 0, suv_truck: 0, van_3row: 0 },
  headlights: { sedan: 75, suv_truck: 85, van_3row: 95 },
};

const INTERIOR_ONLY_ADDONS = new Set<Addon>(["pethair", "soiled", "headlights"]);

const isConsult = (service: Service) => service === "other";

function coerceVehicle(v: unknown): Vehicle | null {
  const m: Record<string, Vehicle> = {
    sedan: "sedan", "sedan/coupe": "sedan", "sedan coupe": "sedan",
    suv_truck: "suv_truck", "suv/truck": "suv_truck", "suv truck": "suv_truck",
    suv: "suv_truck", crossover: "suv_truck", "suv/crossover": "suv_truck",
    truck: "suv_truck", pickup: "suv_truck", "pickup truck": "suv_truck", "truck/van": "suv_truck",
    van_3row: "van_3row", "van/3-row suv": "van_3row", "van/3 row suv": "van_3row",
    van: "van_3row", "3-row suv": "van_3row", "three-row suv": "van_3row",
  };
  const key = String(v || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
}
function coerceService(s: unknown): Service | null {
  const m: Record<string, Service> = {
    quick: "quick", "quick once over": "quick",
    full: "full", "full detail": "full",
    interior_only: "interior_only", "interior only": "interior_only", "interior-only": "interior_only",
    interior: "interior_only", "interior refresh": "interior_only", "interior-refresh": "interior_only",
    // Back-compat for any cached clients
    paint: "interior_only", "paint correction": "interior_only",
    other: "other",
  };
  const key = String(s || "").toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
}
function coerceAddons(arr: unknown): Addon[] {
  if (!Array.isArray(arr)) return [];
  const valid: Addon[] = ["wax","pethair","odor","engine","soiled","ceramic","headlights"];
  return [...new Set(arr.map(x => String(x||"").toLowerCase().trim()).filter((x): x is Addon => (valid as string[]).includes(x)))];
}

function filterAddonsForService(service: Service | null, addons: Addon[]): Addon[] {
  if (service !== "interior_only") return addons;
  return addons.filter((addon) => INTERIOR_ONLY_ADDONS.has(addon));
}

function computeQuote(vehicle: Vehicle, service: Service, addons: Addon[]) {
  if (isConsult(service)) return { total: null as number | null, consult: true as const };
  let total = BASE[vehicle]?.[service] || 0;
  for (const a of addons) total += ADDONS[a]?.[vehicle] || 0;
  return { total, consult: false as const };
}

function stripHtml(input: unknown): string {
  return String(input || "").replace(/<[^>]*>/g, "").trim().slice(0, 2000);
}

function normalizeUSPhone(input: unknown): { e164: string | null, national: string | null } {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.length === 10) return { e164: "+1" + digits, national: `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}` };
  if (digits.length === 11 && digits.startsWith("1")) return { e164: "+" + digits, national: `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}` };
  return { e164: null, national: null };
}

function getClientIP(req: any): string | null {
  const xf = (req.headers["x-forwarded-for"] as string) || "";
  const ip = xf.split(",")[0]?.trim() || (req.ip as string) || null;
  return ip || null;
}

function coerceQuoteSessionId(input: unknown): string | null {
  const value = String(input || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(value)) return null;
  return value;
}

function coerceQuoteProgressEvent(input: unknown): QuoteProgressEvent | null {
  const value = String(input || "").toLowerCase().trim();
  if (value === "step_view") return "step_view";
  if (value === "lead_submitted") return "lead_submitted";
  return null;
}

function coerceQuoteStep(input: unknown): number | null {
  const num = Number(input);
  if (!Number.isInteger(num) || num < 1 || num > 5) return null;
  return num;
}

function coerceUtm(input: unknown): Record<string, string> {
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
  const source = (typeof input === "object" && input !== null) ? input as Record<string, unknown> : {};
  const utm: Record<string, string> = {};
  for (const key of keys) {
    const value = String(source[key] || "").trim().slice(0, 120);
    if (value) utm[key] = value;
  }
  return utm;
}

const HOSTING_ORIGIN_PARAM = defineString("HOSTING_ORIGIN", { default: "https://niemansdetailing.com" });
const TELEGRAM_BOT_TOKEN = defineString("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineString("TELEGRAM_CHAT_ID");

export const api = onRequest({ region: "us-east1" }, async (req, res) => {
  const HOSTING_ORIGIN = HOSTING_ORIGIN_PARAM.value();
  const ALLOWED_ORIGINS = new Set([
    HOSTING_ORIGIN,
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:5010",
    "http://127.0.0.1:5010",
  ]);
  const origin = (req.headers["origin"] as string) || "";
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";

  // CORS headers
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") { res.status(204).send(""); return; }

  // Routes handled here
  const path = (req.path || req.originalUrl || "").toString().split("?")[0].replace(/\/+$/, "");
  const isCreateLeadRoute = path.endsWith("/createLead");
  const isQuoteProgressRoute = path.endsWith("/quoteProgress");
  const isLeadOptionsRoute = path.endsWith("/leadOptions");
  res.setHeader("Cache-Control", "no-store");
  if (!isCreateLeadRoute && !isQuoteProgressRoute && !isLeadOptionsRoute) { res.status(404).json({ ok: false, error: "not_found" }); return; }

  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }

  // A short-lived capability grants access only to this lead's package and add-ons.
  // Contact details are never returned and public Firestore writes remain denied.
  if (isLeadOptionsRoute) {
    try {
      const { id, token, action, addons: requestedAddons } = req.body || {};
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(id || "")) || !/^[a-f0-9]{64}$/.test(String(token || ""))) {
        res.status(403).json({ ok: false, error: "invalid_or_expired" }); return;
      }
      if (action !== "read" && action !== "save") {
        res.status(400).json({ ok: false, error: "invalid_action" }); return;
      }
      const allowed = ["wax", "pethair", "soiled", "headlights"];
      if (action === "save" && (!Array.isArray(requestedAddons) || requestedAddons.length > 4 || requestedAddons.some((a: unknown) => !allowed.includes(String(a))))) {
        res.status(400).json({ ok: false, error: "invalid_addons" }); return;
      }
      const ref = db.collection("leads").doc(id);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const lead = snap.data();
        if (!lead || lead.honeypot || lead.addon_token_hash !== createHash("sha256").update(token).digest("hex") || (!Number.isFinite(lead.addon_token_expires_at) || lead.addon_token_expires_at <= Date.now())) return null;
        const vehicle = coerceVehicle(lead.vehicle)!;
        const service = coerceService(lead.service)!;
        const addons = action === "save" ? filterAddonsForService(service, coerceAddons(requestedAddons)) : lead.addons;
        const quote = computeQuote(vehicle, service, addons);
        if (action === "save") tx.update(ref, {
          addons, quoted_total: quote.total, quote_note: quote.consult ? "consult" : null,
          addons_updated_at: FieldValue.serverTimestamp(),
        });
        return { vehicle, service, addons, quoted_total: quote.total, consult: quote.consult,
          addon_prices: Object.fromEntries(allowed.filter(a => filterAddonsForService(service, [a as Addon]).length).map(a => [a, ADDONS[a as Addon][vehicle]])) };
      });
      if (!result) { res.status(403).json({ ok: false, error: "invalid_or_expired" }); return; }
      res.status(200).json({ ok: true, ...result });
    } catch (e) {
      logger.error("leadOptions error", e);
      res.status(500).json({ ok: false, error: "internal" });
    }
    return;
  }

  if (isQuoteProgressRoute) {
    try {
      const body = (req.body || {}) as any;
      const sessionId = coerceQuoteSessionId(body.session_id);
      const event = coerceQuoteProgressEvent(body.event);
      const clientTimestamp = String(body.ts_client || "").trim().slice(0, 80) || null;
      const sessionStartedAt = String(body.session_started_at || "").trim().slice(0, 80) || null;

      if (!sessionId || !event) {
        res.status(400).json({ ok: false, error: "invalid_fields:session_id,event" });
        return;
      }

      const eventPayload: any = {
        session_id: sessionId,
        page: "quote",
        flow_version: body.flow_version === "5" ? "5" : "4",
        last_event: event,
        last_seen_at: FieldValue.serverTimestamp(),
        event_count: FieldValue.increment(1),
        referrer_last: String(body.referrer || req.headers["referer"] || "").toString().slice(0, 1024) || null,
        user_agent_last: String(req.headers["user-agent"] || "").toString().slice(0, 512),
        ip_last: getClientIP(req),
        utm: coerceUtm(body.utm),
      };

      if (clientTimestamp) eventPayload.ts_last_client = clientTimestamp;
      if (sessionStartedAt) eventPayload.session_started_at = sessionStartedAt;

      if (event === "step_view") {
        const step = coerceQuoteStep(body.step);
        if (!step) {
          res.status(400).json({ ok: false, error: "invalid_fields:step" });
          return;
        }
        const stepKey = `step_${step}`;
        eventPayload.last_step = stepKey;
        eventPayload.last_step_number = step;
        eventPayload.steps_seen = FieldValue.arrayUnion(stepKey);
      }

      if (event === "lead_submitted") {
        eventPayload.last_step = "submitted";
        eventPayload.last_step_number = 5;
        eventPayload.completed = true;
        eventPayload.completed_at = FieldValue.serverTimestamp();
        eventPayload.steps_seen = FieldValue.arrayUnion(body.flow_version === "5" ? "step_3" : "step_4", "submitted");
        eventPayload.capture_method = body.capture_method === "exit_intent" ? "exit_intent" : "quiz";
      }

      await db.collection("quotePageSessions").doc(sessionId).set(eventPayload, { merge: true });
      res.status(200).json({ ok: true });
      return;
    } catch (e) {
      logger.error("quoteProgress error", e as any);
      res.status(500).json({ ok: false, error: "internal" });
      return;
    }
  }

  try {
    const body = (req.body || {}) as any;

    const vehicle = coerceVehicle(body.vehicle);
    const service = coerceService(body.service);
    const addons = filterAddonsForService(service, coerceAddons(body.addons));
    const isRecovery = body.capture_method === "exit_intent";
    const name = String(body.name || "").trim().slice(0, 120);
    const phoneRaw = String(body.phone || "").trim();
    const { e164: phone_normalized } = normalizeUSPhone(phoneRaw);
    const zip = String(body.zip || "").replace(/\D/g, "").slice(0, 5) || null;
    const notes = stripHtml(body.notes);
    const utm = typeof body.utm === "object" && body.utm !== null ? body.utm : {};
    const honeypot = Boolean(body.honeypot);

    // Validate required fields
    const errors: string[] = [];
    if (!vehicle) errors.push("vehicle");
    if (!service) errors.push("service");
    if (!name && !isRecovery) errors.push("name");
    if (!phone_normalized) errors.push("phone");
    if (zip && !/^\d{5}$/.test(zip)) errors.push("zip");
    if (errors.length) { res.status(400).json({ ok: false, error: `invalid_fields:${errors.join(',')}` }); return; }

    // TypeScript knows vehicle and service are not null here
    const suppliedToken = body.update_token;
    if (suppliedToken !== undefined && !/^[a-f0-9]{64}$/.test(String(suppliedToken))) {
      res.status(400).json({ ok: false, error: "invalid_token" }); return;
    }
    const updateToken = suppliedToken || randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(updateToken).digest("hex");
    const quote = computeQuote(vehicle as Vehicle, service as Service, addons);
    const payload: any = {
      vehicle,
      service,
      addons,
      capture_method: isRecovery ? "exit_intent" : "quiz",
      flow_version: body.flow_version === "5" ? "5" : "4",
      addon_token_hash: tokenHash,
      addon_token_expires_at: Date.now() + 24 * 60 * 60 * 1000,
      zip,
      notes,
      name,
      phone: phoneRaw,
      phone_normalized: phone_normalized || null,
      quoted_total: quote.consult ? null : quote.total,
      quote_note: quote.consult ? "consult" : null,
      utm,
      ts: new Date().toISOString(),
      status: honeypot ? "spam" : "new",
      honeypot,
      user_agent: (body.user_agent || req.headers["user-agent"] || "").toString().slice(0, 512),
      referrer: (body.referrer || req.headers["referer"] || "").toString().slice(0, 1024),
      ip: getClientIP(req),
      created_at: FieldValue.serverTimestamp(),
    };

    // Write to Firestore
    const ref = db.collection("leads").doc(tokenHash);
    const created = await db.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) return false;
      tx.create(ref, payload);
      const sessionId = coerceQuoteSessionId(body.session_id);
      if (sessionId && !honeypot) tx.set(db.collection("quotePageSessions").doc(sessionId), {
        session_id: sessionId, page: "quote", flow_version: payload.flow_version,
        session_started_at: String(body.session_started_at || payload.ts).slice(0, 80),
        completed: true, completed_at: FieldValue.serverTimestamp(), last_seen_at: FieldValue.serverTimestamp(),
        capture_method: payload.capture_method, utm: coerceUtm(body.utm),
        steps_seen: FieldValue.arrayUnion("submitted"),
      }, { merge: true });
      return true;
    });
    if (!created) {
      res.status(200).json({ ok: true, id: ref.id, update_token: updateToken }); return;
    }

    // Send Telegram notification
    try {
      const botToken = TELEGRAM_BOT_TOKEN.value();
      const chatId = TELEGRAM_CHAT_ID.value();
      if (!botToken || !chatId) {
        logger.error("Missing Telegram config via .env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
      } else if (!honeypot && !process.env.FUNCTIONS_EMULATOR) {
        const vLabel = VEHICLE_LABELS[vehicle as Vehicle];
        const sLabel = SERVICE_LABELS[service as Service];
        const pricePart = quote.consult ? "consult" : `$${quote.total}`;
        const addonsList = addons.map(a => ADDON_LABELS[a]).join(", ") || "None";
        const phonePretty = payload.phone_normalized ? payload.phone_normalized : payload.phone;
        const openLink = `${HOSTING_ORIGIN}/admin/index.html?id=${encodeURIComponent(ref.id)}`;

        const text = [
          `New Lead: ${vLabel} • ${sLabel} • ${pricePart}`,
          `Name: ${name || "Not provided (text quote request)"}`,
          isRecovery ? "Source: mobile exit-intent quote request" : null,
          `${zip ? `ZIP ${zip}` : "ZIP —"} • ${phonePretty}`,
          `Add-ons: ${addonsList}`,
          notes ? `Notes: ${notes}` : null,
          `Open: ${openLink}`,
        ].filter(Boolean).join("\n");

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(5000),
        }).then(async r => { if (!r.ok) throw new Error(await r.text()); });
      }
    } catch (e) {
      logger.error("Telegram error", e as any);
    }

    res.status(200).json({ ok: true, id: ref.id, update_token: updateToken });
  } catch (e) {
    logger.error("createLead error", e as any);
    res.status(500).json({ ok: false, error: "internal" });
  }
});
