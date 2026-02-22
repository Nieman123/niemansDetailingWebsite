"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.api = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebase_functions_1 = require("firebase-functions");
const params_1 = require("firebase-functions/params");
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
admin.initializeApp();
const db = admin.firestore();
const VEHICLE_LABELS = {
    sedan: "Sedan/Coupe",
    suv: "SUV/Crossover",
    truck: "Truck/Van",
};
const SERVICE_LABELS = {
    quick: "Quick Once Over",
    full: "Full Detail",
    interior: "Interior Refresh",
    other: "Other",
};
const ADDON_LABELS = {
    wax: "Wax/Sealant",
    pethair: "Pet Hair",
    odor: "Odor/Ozone",
    engine: "Engine Bay",
    soiled: "Heavily Soiled",
    ceramic: "Ceramic Consult",
    headlights: "Headlight Restoration",
};
const BASE = {
    sedan: { quick: 150, full: 300, interior: 99 },
    suv: { quick: 170, full: 350, interior: 99 },
    truck: { quick: 180, full: 380, interior: 99 },
};
const ADDONS = {
    wax: { sedan: 25, suv: 30, truck: 35 },
    pethair: { sedan: 30, suv: 40, truck: 50 },
    odor: { sedan: 35, suv: 45, truck: 55 },
    engine: { sedan: 25, suv: 25, truck: 30 },
    soiled: { sedan: 40, suv: 60, truck: 80 },
    ceramic: { sedan: 0, suv: 0, truck: 0 },
    headlights: { sedan: 75, suv: 85, truck: 95 },
};
const isConsult = (service) => service === "other";
function coerceVehicle(v) {
    const m = {
        sedan: "sedan", "sedan/coupe": "sedan", "sedan coupe": "sedan",
        suv: "suv", crossover: "suv", "suv/crossover": "suv",
        truck: "truck", van: "truck", "truck/van": "truck",
    };
    const key = String(v || "").toLowerCase().trim();
    return (m[key] || null);
}
function coerceService(s) {
    const m = {
        quick: "quick", "quick once over": "quick",
        full: "full", "full detail": "full",
        interior: "interior", "interior refresh": "interior", "interior-refresh": "interior",
        // Back-compat for any cached clients
        paint: "interior", "paint correction": "interior",
        other: "other",
    };
    const key = String(s || "").toLowerCase().trim();
    return (m[key] || null);
}
function coerceAddons(arr) {
    if (!Array.isArray(arr))
        return [];
    const valid = ["wax", "pethair", "odor", "engine", "soiled", "ceramic", "headlights"];
    return arr.map(x => String(x || "").toLowerCase().trim()).filter((x) => valid.includes(x));
}
function computeQuote(vehicle, service, addons) {
    if (isConsult(service))
        return { total: null, consult: true };
    let total = BASE[vehicle]?.[service] || 0;
    for (const a of addons)
        total += ADDONS[a]?.[vehicle] || 0;
    return { total, consult: false };
}
function stripHtml(input) {
    return String(input || "").replace(/<[^>]*>/g, "").trim().slice(0, 2000);
}
function normalizeUSPhone(input) {
    const digits = String(input || "").replace(/\D/g, "");
    if (digits.length === 10)
        return { e164: "+1" + digits, national: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` };
    if (digits.length === 11 && digits.startsWith("1"))
        return { e164: "+" + digits, national: `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}` };
    return { e164: null, national: null };
}
function getClientIP(req) {
    const xf = req.headers["x-forwarded-for"] || "";
    const ip = xf.split(",")[0]?.trim() || req.ip || null;
    return ip || null;
}
function coerceQuoteSessionId(input) {
    const value = String(input || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(value))
        return null;
    return value;
}
function coerceQuoteProgressEvent(input) {
    const value = String(input || "").toLowerCase().trim();
    if (value === "step_view")
        return "step_view";
    if (value === "lead_submitted")
        return "lead_submitted";
    return null;
}
function coerceQuoteStep(input) {
    const num = Number(input);
    if (!Number.isInteger(num) || num < 1 || num > 5)
        return null;
    return num;
}
function coerceUtm(input) {
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    const source = (typeof input === "object" && input !== null) ? input : {};
    const utm = {};
    for (const key of keys) {
        const value = String(source[key] || "").trim().slice(0, 120);
        if (value)
            utm[key] = value;
    }
    return utm;
}
const HOSTING_ORIGIN_PARAM = (0, params_1.defineString)("HOSTING_ORIGIN", { default: "https://niemansdetailing.com" });
const TELEGRAM_BOT_TOKEN = (0, params_1.defineString)("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = (0, params_1.defineString)("TELEGRAM_CHAT_ID");
exports.api = (0, https_1.onRequest)({ region: "us-east1" }, async (req, res) => {
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
    const origin = req.headers["origin"] || "";
    const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "";
    // CORS headers
    if (allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", allowOrigin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "3600");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    // Routes handled here
    const path = (req.path || req.originalUrl || "").toString().split("?")[0].replace(/\/+$/, "");
    const isCreateLeadRoute = path.endsWith("/createLead");
    const isQuoteProgressRoute = path.endsWith("/quoteProgress");
    if (!isCreateLeadRoute && !isQuoteProgressRoute) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
    }
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }
    if (isQuoteProgressRoute) {
        try {
            const body = (req.body || {});
            const sessionId = coerceQuoteSessionId(body.session_id);
            const event = coerceQuoteProgressEvent(body.event);
            const clientTimestamp = String(body.ts_client || "").trim().slice(0, 80) || null;
            const sessionStartedAt = String(body.session_started_at || "").trim().slice(0, 80) || null;
            if (!sessionId || !event) {
                res.status(400).json({ ok: false, error: "invalid_fields:session_id,event" });
                return;
            }
            const eventPayload = {
                session_id: sessionId,
                page: "quote",
                last_event: event,
                last_seen_at: firestore_1.FieldValue.serverTimestamp(),
                event_count: firestore_1.FieldValue.increment(1),
                referrer_last: String(body.referrer || req.headers["referer"] || "").toString().slice(0, 1024) || null,
                user_agent_last: String(req.headers["user-agent"] || "").toString().slice(0, 512),
                ip_last: getClientIP(req),
                utm: coerceUtm(body.utm),
            };
            if (clientTimestamp)
                eventPayload.ts_last_client = clientTimestamp;
            if (sessionStartedAt)
                eventPayload.session_started_at = sessionStartedAt;
            if (event === "step_view") {
                const step = coerceQuoteStep(body.step);
                if (!step) {
                    res.status(400).json({ ok: false, error: "invalid_fields:step" });
                    return;
                }
                const stepKey = `step_${step}`;
                eventPayload.last_step = stepKey;
                eventPayload.last_step_number = step;
                eventPayload.steps_seen = firestore_1.FieldValue.arrayUnion(stepKey);
            }
            if (event === "lead_submitted") {
                eventPayload.last_step = "submitted";
                eventPayload.last_step_number = 6;
                eventPayload.completed = true;
                eventPayload.completed_at = firestore_1.FieldValue.serverTimestamp();
                eventPayload.steps_seen = firestore_1.FieldValue.arrayUnion("step_5", "submitted");
            }
            await db.collection("quotePageSessions").doc(sessionId).set(eventPayload, { merge: true });
            res.status(200).json({ ok: true });
            return;
        }
        catch (e) {
            firebase_functions_1.logger.error("quoteProgress error", e);
            res.status(500).json({ ok: false, error: "internal" });
            return;
        }
    }
    try {
        const body = (req.body || {});
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
        const errors = [];
        if (!vehicle)
            errors.push("vehicle");
        if (!service)
            errors.push("service");
        if (!name)
            errors.push("name");
        if (!phone_normalized)
            errors.push("phone");
        if (zip && !/^\d{5}$/.test(zip))
            errors.push("zip");
        if (errors.length) {
            res.status(400).json({ ok: false, error: `invalid_fields:${errors.join(',')}` });
            return;
        }
        // TypeScript knows vehicle and service are not null here
        const quote = computeQuote(vehicle, service, addons);
        const payload = {
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
            created_at: firestore_1.FieldValue.serverTimestamp(),
        };
        // Write to Firestore
        const ref = await db.collection("leads").add(payload);
        // Send Telegram notification
        try {
            const botToken = TELEGRAM_BOT_TOKEN.value();
            const chatId = TELEGRAM_CHAT_ID.value();
            if (!botToken || !chatId) {
                firebase_functions_1.logger.error("Missing Telegram config via .env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
            }
            else if (!honeypot) {
                const vLabel = VEHICLE_LABELS[vehicle];
                const sLabel = SERVICE_LABELS[service];
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
                }).then(async (r) => { if (!r.ok)
                    throw new Error(await r.text()); });
            }
        }
        catch (e) {
            firebase_functions_1.logger.error("Telegram error", e);
        }
        res.status(200).json({ ok: true, id: ref.id });
    }
    catch (e) {
        firebase_functions_1.logger.error("createLead error", e);
        res.status(500).json({ ok: false, error: "internal" });
    }
});
