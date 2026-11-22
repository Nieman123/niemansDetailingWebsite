import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import type { Firestore, Transaction } from "firebase-admin/firestore";

// Short customer links: /a/<code> for appointments, /m/<code> for maintenance invitations and /i/<code> for invoices.
// The code is the secret. Firestore keys the row by a hash of the code and keeps the long link's
// token sealed with a key derived from the code, so stored data alone can't open an appointment.
// Revoking or replacing the long link also kills its short link, because the token stops working.

export type ShortLinkKind = "appointment" | "maintenance" | "invoice";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// 10 base62 characters is about 59 bits, far beyond online guessing.
const LENGTH = 10;
export const SHORT_CODE = /^[A-Za-z0-9]{10}$/;
const PREFIX: Record<ShortLinkKind, string> = { appointment: "a", maintenance: "m", invoice: "i" };
const HASH = /^[a-f0-9]{64}$/;

const sha = (value: string) => createHash("sha256").update(value).digest();
const rowId = (code: string) => sha(`short-link:${code}`).toString("hex");
const keyFor = (code: string) => sha(`short-link-key:${code}`);

function newCode() {
  let code = "";
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function seal(code: string, token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(code), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function unseal(code: string, sealed: string) {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyFor(code), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

export const shortLinkPath = (kind: ShortLinkKind, code: string) => `/${PREFIX[kind]}/${code}`;

// Writes the short link inside the caller's transaction and returns its code.
export function createShortLink(db: Firestore, tx: Transaction, kind: ShortLinkKind, appointmentId: string, token: string) {
  const code = newCode();
  tx.create(db.collection("appointmentShortLinks").doc(rowId(code)), {
    kind, appointmentId, sealed: seal(code, token), createdAt: Date.now(),
  });
  return code;
}

// Returns the long link's parts for a short code, or null when the code is unknown.
export async function resolveShortLink(db: Firestore, code: unknown, kind: ShortLinkKind) {
  if (typeof code !== "string" || !SHORT_CODE.test(code)) return null;
  const row = (await db.collection("appointmentShortLinks").doc(rowId(code)).get()).data();
  if (!row || row.kind !== kind || typeof row.appointmentId !== "string" || typeof row.sealed !== "string") return null;
  try {
    const token = unseal(code, row.sealed);
    return HASH.test(token) ? { id: row.appointmentId, token } : null;
  } catch {
    return null;
  }
}
