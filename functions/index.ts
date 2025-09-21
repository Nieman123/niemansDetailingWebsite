import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

admin.initializeApp();
const db = admin.firestore();

type Vehicle = "sedan" | "suv" | "truck";
type Service = "quick" | "full" | "interior" | "other";
type Addon = "wax" | "pethair" | "odor" | "engine" | "soiled" | "ceramic" | "headlights";

const VEHICLE_LABELS: Record<Vehicle, string> = {
  sedan: "Sedan/Coupe",
  suv: "SUV/Crossover",
  truck: "Truck/Van",
};
const SERVICE_LABELS: Record<Service, string> = {
  quick: "Quick Once Over",
  full: "Full Detail",
  interior: "Interior Refresh",
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
  sedan: { quick: 150, full: 300, interior: 99 },
  suv: { quick: 170, full: 350, interior: 99 },
  truck: { quick: 180, full: 380, interior: 99 },
};
const ADDONS: Record<Addon, Record<Vehicle, number>> = {
  wax: { sedan: 25, suv: 30, truck: 35 },
  pethair: { sedan: 30, suv: 40, truck: 50 },
  odor: { sedan: 35, suv: 45, truck: 55 },
  engine: { sedan: 25, suv: 25, truck: 30 },
  soiled: { sedan: 40, suv: 60, truck: 80 },
  ceramic: { sedan: 0, suv: 0, truck: 0 },
  headlights: { sedan: 75, suv: 85, truck: 95 },
};

const isConsult = (service: Service) => service === "other";

function coerceVehicle(v: unknown): Vehicle | null {
  const m: Record<string, Vehicle> = {
    sedan: "sedan", "sedan/coupe": "sedan", "sedan coupe": "sedan",
    suv: "suv", crossover: "suv", "suv/crossover": "suv",
    truck: "truck", van: "truck", "truck/van": "truck",
  };
  const key = String(v || "").toLowerCase().trim();
  return (m[key] || null) as Vehicle | null;
}
function coerceService(s: unknown): Service | null {
  const m: Record<string, Service> = {
    quick: "quick", "quick once over": "quick",
    full: "full", "full detail": "full",
    interior: "interior", "interior refresh": "interior", "interior-refresh": "interior",
    // Back-compat for any cached clients
    paint: "interior", "paint correction": "interior",
    other: "other",
  };
  const key = String(s || "").toLowerCase().trim();
  return (m[key] || null) as Service | null;
}
function coerceAddons(arr: unknown): Addon[] {
  if (!Array.isArray(arr)) return [];
  const valid: Addon[] = ["wax","pethair","odor","engine","soiled","ceramic","headlights"];
  return arr.map(x => String(x||"").toLowerCase().trim()).filter((x): x is Addon => (valid as string[]).includes(x));
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
  if (String(input || "").startsWith("+")) return { e164: String(input), national: null };
  return { e164: null, national: null };
}

function getClientIP(req: any): string | null {
  const xf = (req.headers["x-forwarded-for"] as string) || "";
  const ip = xf.split(",")[0]?.trim() || (req.ip as string) || null;
  return ip || null;
}

const HOSTING_ORIGIN_PARAM = defineString("HOSTING_ORIGIN", { default: "https://niemansdetailing.com" });
const TELEGRAM_BOT_TOKEN = defineString("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = defineString("TELEGRAM_CHAT_ID");

export const api = onRequest({ region: "us-central1" }, async (req, res) => {
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

  // Route only /api/createLead
  const path = (req.path || req.originalUrl || "").toString();
  if (!path.endsWith("/api/createLead")) { res.status(404).json({ ok: false, error: "not_found" }); return; }

  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }

  try {
    const body = (req.body || {}) as any;

    const vehicle = coerceVehicle(body.vehicle);
    const service = coerceService(body.service);
    const addons = coerceAddons(body.addons);
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
    if (!name) errors.push("name");
    if (!phoneRaw) errors.push("phone");
    if (zip && !/^\d{5}$/.test(zip)) errors.push("zip");
    if (errors.length) { res.status(400).json({ ok: false, error: `invalid_fields:${errors.join(',')}` }); return; }

    // TypeScript knows vehicle and service are not null here
    const quote = computeQuote(vehicle as Vehicle, service as Service, addons);
    const payload: any = {
      vehicle,
      service,
      addons,
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
    const ref = await db.collection("leads").add(payload);

    // Send Telegram notification
    try {
      const botToken = TELEGRAM_BOT_TOKEN.value();
      const chatId = TELEGRAM_CHAT_ID.value();
      if (!botToken || !chatId) {
        logger.error("Missing Telegram config via .env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
      } else if (!honeypot) {
        const vLabel = VEHICLE_LABELS[vehicle as Vehicle];
        const sLabel = SERVICE_LABELS[service as Service];
        const pricePart = quote.consult ? "consult" : `$${quote.total}`;
        const addonsList = addons.map(a => ADDON_LABELS[a]).join(", ") || "None";
        const phonePretty = payload.phone_normalized ? payload.phone_normalized : payload.phone;
        const openLink = `${HOSTING_ORIGIN}/admin/index.html?id=${encodeURIComponent(ref.id)}`;

        const text = [
          `New Lead: ${vLabel} • ${sLabel} • ${pricePart}`,
          `Name: ${name}`,
          `${zip ? `ZIP ${zip}` : "ZIP —"} • ${phonePretty}`,
          `Add-ons: ${addonsList}`,
          notes ? `Notes: ${notes}` : null,
          `Open: ${openLink}`,
        ].filter(Boolean).join("\n");

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        }).then(async r => { if (!r.ok) throw new Error(await r.text()); });
      }
    } catch (e) {
      logger.error("Telegram error", e as any);
    }

    res.status(200).json({ ok: true, id: ref.id });
  } catch (e) {
    logger.error("createLead error", e as any);
    res.status(500).json({ ok: false, error: "internal" });
  }
});
