"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shortLinkPath = exports.SHORT_CODE = void 0;
exports.createShortLink = createShortLink;
exports.resolveShortLink = resolveShortLink;
const node_crypto_1 = require("node:crypto");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// 10 base62 characters is about 59 bits, far beyond online guessing.
const LENGTH = 10;
exports.SHORT_CODE = /^[A-Za-z0-9]{10}$/;
const PREFIX = { appointment: "a", maintenance: "m" };
const HASH = /^[a-f0-9]{64}$/;
const sha = (value) => (0, node_crypto_1.createHash)("sha256").update(value).digest();
const rowId = (code) => sha(`short-link:${code}`).toString("hex");
const keyFor = (code) => sha(`short-link-key:${code}`);
function newCode() {
    let code = "";
    for (let i = 0; i < LENGTH; i++)
        code += ALPHABET[(0, node_crypto_1.randomInt)(ALPHABET.length)];
    return code;
}
function seal(code, token) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)("aes-256-gcm", keyFor(code), iv);
    const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function unseal(code, sealed) {
    const raw = Buffer.from(sealed, "base64");
    const decipher = (0, node_crypto_1.createDecipheriv)("aes-256-gcm", keyFor(code), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
const shortLinkPath = (kind, code) => `/${PREFIX[kind]}/${code}`;
exports.shortLinkPath = shortLinkPath;
// Writes the short link inside the caller's transaction and returns its code.
function createShortLink(db, tx, kind, appointmentId, token) {
    const code = newCode();
    tx.create(db.collection("appointmentShortLinks").doc(rowId(code)), {
        kind, appointmentId, sealed: seal(code, token), createdAt: Date.now(),
    });
    return code;
}
// Returns the long link's parts for a short code, or null when the code is unknown.
async function resolveShortLink(db, code, kind) {
    if (typeof code !== "string" || !exports.SHORT_CODE.test(code))
        return null;
    const row = (await db.collection("appointmentShortLinks").doc(rowId(code)).get()).data();
    if (!row || row.kind !== kind || typeof row.appointmentId !== "string" || typeof row.sealed !== "string")
        return null;
    try {
        const token = unseal(code, row.sealed);
        return HASH.test(token) ? { id: row.appointmentId, token } : null;
    }
    catch {
        return null;
    }
}
