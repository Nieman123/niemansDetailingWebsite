import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

export class ContentError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const fields = {
  headline: 140, introduction: 1300, bookingNotice: 500, contactNote: 700,
  serviceAreas: 1200, testimonials: 3000, faq: 4500, serviceDescriptions: 7000,
} as const;
type Content = { [K in keyof typeof fields]: string };
const contentRef = (db: Firestore) => db.collection("siteContent").doc("appointments");

function validate(input: unknown): Content {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ContentError(400, "invalid_content");
  const value = input as Record<string, unknown>;
  const entries = Object.entries(fields).map(([key, max]) => {
    const entry = value[key] ?? "";
    if (typeof entry !== "string" || entry.length > max) throw new ContentError(400, "invalid_content");
    return [key, entry.trim()];
  });
  return Object.fromEntries(entries) as Content;
}

export async function publicSiteContent(db: Firestore) {
  return (await contentRef(db).get()).get("published")?.content ?? {};
}

export async function manageSiteContent(db: Firestore, uid: string, action: string, body: Record<string, unknown>) {
  const ref = contentRef(db);
  if (action === "cms-read") {
    const [doc, revisions] = await Promise.all([ref.get(), ref.collection("revisions").orderBy("publishedAt", "desc").limit(20).get()]);
    return { draft: doc.get("draft") ?? null, published: doc.get("published") ?? null,
      revisions: revisions.docs.map(row => ({ id: row.id, publishedAt: row.get("publishedAt") })) };
  }
  if (action !== "cms-save" && action !== "cms-publish" && action !== "cms-restore") throw new ContentError(404, "not_found");
  return db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if ((current.get("draft.revision") ?? "") !== (body.revision ?? "")) throw new ContentError(409, "content_changed");
    let content;
    if (action === "cms-restore") {
      if (typeof body.restoreId !== "string" || !/^[0-9a-f-]{36}$/.test(body.restoreId)) throw new ContentError(400, "invalid_content");
      const version = await tx.get(ref.collection("revisions").doc(body.restoreId));
      if (!version.exists) throw new ContentError(404, "not_found");
      content = validate(version.get("content"));
    } else content = validate(body.content);
    const revision = randomUUID();
    const draft = { content, revision, updatedAt: Date.now(), updatedBy: uid };
    if (action === "cms-publish") {
      const published = { content, revision, publishedAt: Date.now(), publishedBy: uid };
      tx.create(ref.collection("revisions").doc(revision), published);
      tx.set(ref, { draft, published }, { merge: true });
    } else tx.set(ref, { draft }, { merge: true });
    return { draft };
  });
}
