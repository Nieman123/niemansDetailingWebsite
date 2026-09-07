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
const node_crypto_1 = require("node:crypto");
const firestore_1 = require("firebase-admin/firestore");
admin.initializeApp();
const db = admin.firestore();
const VEHICLE_LABELS = {
    sedan: "Sedan/Coupe",
    suv_truck: "SUV/Truck",
    van_3row: "Van/3-Row SUV",
};
const SERVICE_LABELS = {
    quick: "Quick Once Over",
    full: "Full Detail",
    interior_only: "Interior Only",
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
    sedan: { quick: 200, full: 300, interior_only: 200 },
    suv_truck: { quick: 250, full: 350, interior_only: 250 },
    van_3row: { quick: 300, full: 400, interior_only: 300 },
};
const ADDONS = {
    wax: { sedan: 25, suv_truck: 30, van_3row: 35 },
    pethair: { sedan: 30, suv_truck: 40, van_3row: 50 },
    odor: { sedan: 35, suv_truck: 45, van_3row: 55 },
    engine: { sedan: 25, suv_truck: 25, van_3row: 30 },
    soiled: { sedan: 40, suv_truck: 60, van_3row: 80 },
    ceramic: { sedan: 0, suv_truck: 0, van_3row: 0 },
    headlights: { sedan: 75, suv_truck: 85, van_3row: 95 },
};
const INTERIOR_ONLY_ADDONS = new Set(["pethair", "soiled", "headlights"]);
const isConsult = (service) => service === "other";
function coerceVehicle(v) {
    const m = {
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
function coerceService(s) {
    const m = {
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
function coerceAddons(arr) {
    if (!Array.isArray(arr))
        return [];
    const valid = ["wax", "pethair", "odor", "engine", "soiled", "ceramic", "headlights"];
    return [...new Set(arr.map(x => String(x || "").toLowerCase().trim()).filter((x) => valid.includes(x)))];
}
function filterAddonsForService(service, addons) {
    if (service !== "interior_only")
        return addons;
    return addons.filter((addon) => INTERIOR_ONLY_ADDONS.has(addon));
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
    const isLeadOptionsRoute = path.endsWith("/leadOptions");
    res.setHeader("Cache-Control", "no-store");
    if (!isCreateLeadRoute && !isQuoteProgressRoute && !isLeadOptionsRoute) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
    }
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "method_not_allowed" });
        return;
    }
    // A short-lived capability grants access only to this lead's package and add-ons.
    // Contact details are never returned and public Firestore writes remain denied.
    if (isLeadOptionsRoute) {
        try {
            const { id, token, action, addons: requestedAddons } = req.body || {};
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(id || "")) || !/^[a-f0-9]{64}$/.test(String(token || ""))) {
                res.status(403).json({ ok: false, error: "invalid_or_expired" });
                return;
            }
            if (action !== "read" && action !== "save") {
                res.status(400).json({ ok: false, error: "invalid_action" });
                return;
            }
            const allowed = ["wax", "pethair", "soiled", "headlights"];
            if (action === "save" && (!Array.isArray(requestedAddons) || requestedAddons.length > 4 || requestedAddons.some((a) => !allowed.includes(String(a))))) {
                res.status(400).json({ ok: false, error: "invalid_addons" });
                return;
            }
            const ref = db.collection("leads").doc(id);
            const result = await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const lead = snap.data();
                if (!lead || lead.honeypot || lead.addon_token_hash !== (0, node_crypto_1.createHash)("sha256").update(token).digest("hex") || (!Number.isFinite(lead.addon_token_expires_at) || lead.addon_token_expires_at <= Date.now()))
                    return null;
                const vehicle = coerceVehicle(lead.vehicle);
                const service = coerceService(lead.service);
                const addons = action === "save" ? filterAddonsForService(service, coerceAddons(requestedAddons)) : lead.addons;
                const quote = computeQuote(vehicle, service, addons);
                if (action === "save")
                    tx.update(ref, {
                        addons, quoted_total: quote.total, quote_note: quote.consult ? "consult" : null,
                        addons_updated_at: firestore_1.FieldValue.serverTimestamp(),
                    });
                return { vehicle, service, addons, quoted_total: quote.total, consult: quote.consult,
                    addon_prices: Object.fromEntries(allowed.filter(a => filterAddonsForService(service, [a]).length).map(a => [a, ADDONS[a][vehicle]])) };
            });
            if (!result) {
                res.status(403).json({ ok: false, error: "invalid_or_expired" });
                return;
            }
            res.status(200).json({ ok: true, ...result });
        }
        catch (e) {
            firebase_functions_1.logger.error("leadOptions error", e);
            res.status(500).json({ ok: false, error: "internal" });
        }
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
                flow_version: body.flow_version === "5" ? "5" : "4",
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
                eventPayload.last_step_number = 5;
                eventPayload.completed = true;
                eventPayload.completed_at = firestore_1.FieldValue.serverTimestamp();
                eventPayload.steps_seen = firestore_1.FieldValue.arrayUnion(body.flow_version === "5" ? "step_3" : "step_4", "submitted");
                eventPayload.capture_method = body.capture_method === "exit_intent" ? "exit_intent" : "quiz";
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
        const errors = [];
        if (!vehicle)
            errors.push("vehicle");
        if (!service)
            errors.push("service");
        if (!name && !isRecovery)
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
        const suppliedToken = body.update_token;
        if (suppliedToken !== undefined && !/^[a-f0-9]{64}$/.test(String(suppliedToken))) {
            res.status(400).json({ ok: false, error: "invalid_token" });
            return;
        }
        const updateToken = suppliedToken || (0, node_crypto_1.randomBytes)(32).toString("hex");
        const tokenHash = (0, node_crypto_1.createHash)("sha256").update(updateToken).digest("hex");
        const quote = computeQuote(vehicle, service, addons);
        const payload = {
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
            created_at: firestore_1.FieldValue.serverTimestamp(),
        };
        // Write to Firestore
        const ref = db.collection("leads").doc(tokenHash);
        const created = await db.runTransaction(async (tx) => {
            if ((await tx.get(ref)).exists)
                return false;
            tx.create(ref, payload);
            const sessionId = coerceQuoteSessionId(body.session_id);
            if (sessionId && !honeypot)
                tx.set(db.collection("quotePageSessions").doc(sessionId), {
                    session_id: sessionId, page: "quote", flow_version: payload.flow_version,
                    session_started_at: String(body.session_started_at || payload.ts).slice(0, 80),
                    completed: true, completed_at: firestore_1.FieldValue.serverTimestamp(), last_seen_at: firestore_1.FieldValue.serverTimestamp(),
                    capture_method: payload.capture_method, utm: coerceUtm(body.utm),
                    steps_seen: firestore_1.FieldValue.arrayUnion("submitted"),
                }, { merge: true });
            return true;
        });
        if (!created) {
            res.status(200).json({ ok: true, id: ref.id, update_token: updateToken });
            return;
        }
        // Send Telegram notification
        try {
            const botToken = TELEGRAM_BOT_TOKEN.value();
            const chatId = TELEGRAM_CHAT_ID.value();
            if (!botToken || !chatId) {
                firebase_functions_1.logger.error("Missing Telegram config via .env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
            }
            else if (!honeypot && !process.env.FUNCTIONS_EMULATOR) {
                const vLabel = VEHICLE_LABELS[vehicle];
                const sLabel = SERVICE_LABELS[service];
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
                }).then(async (r) => { if (!r.ok)
                    throw new Error(await r.text()); });
            }
        }
        catch (e) {
            firebase_functions_1.logger.error("Telegram error", e);
        }
        res.status(200).json({ ok: true, id: ref.id, update_token: updateToken });
    }
    catch (e) {
        firebase_functions_1.logger.error("createLead error", e);
        res.status(500).json({ ok: false, error: "internal" });
    }
});
