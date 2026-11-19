import { appointmentsEnabled, auth } from "./firebase-client.js";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { loadVacation } from "./admin-vacation.mjs";
import { appointmentRequest } from "./appointment-utils.mjs";

const id = name => document.getElementById(name);
const form = id("cms-form");
const status = id("cms-status");
const picker = id("cms-revision");
let revision = "";
let busy = false;
let originalCopy = {};
let publishedCopy = {};
let accessVersion = 0;
const fields = [...form.querySelectorAll("input[name], textarea[name]")];
const request = async (action, body = {}) => appointmentRequest(action, body, await auth.currentUser?.getIdToken());
const content = () => Object.fromEntries(fields.map(field => [field.name, field.value.trim() === originalCopy[field.name] ? "" : field.value]));
function loadDraft(draft) {
  revision = draft?.revision || "";
  for (const field of fields) {
    const effective = draft?.content?.[field.name] ?? publishedCopy[field.name];
    field.value = effective || originalCopy[field.name] || "";
  }
}
function run(handler) {
  return async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try { await handler(event); }
    catch (error) { status.textContent = error.code === "content_changed" ? "A newer draft exists. Reload to see it." : "The change couldn't be saved."; }
    finally { busy = false; document.getElementById("cms-feedback").textContent = status.textContent; }
  };
}

async function read() {
  const version = accessVersion;
  const [snapshot, defaults] = await Promise.all([
    request("cms-read"),
    fetch("/scripts/site-copy-defaults.json").then(response => response.ok ? response.json() : {}).catch(() => ({})),
  ]);
  if (version !== accessVersion) return;
  originalCopy = defaults;
  publishedCopy = snapshot.published?.content || {};
  loadDraft(snapshot.draft);
  picker.replaceChildren(new Option("Choose a revision", ""), ...snapshot.revisions.map(version =>
    new Option(new Date(version.publishedAt).toLocaleString("en-US", { timeZone: "America/New_York" }), version.id)));
}
form.onsubmit = run(async event => {
  const publish = event.submitter?.value === "publish";
  if (publish && !confirm("Publish this content to the staging site?")) return;
  const result = await request(publish ? "cms-publish" : "cms-save", { revision, content: content() });
  loadDraft(result.draft);
  if (publish) await read();
  status.textContent = publish ? "Published to staging." : "Draft saved.";
});
id("cms-restore").onclick = run(async () => {
  if (!picker.value) { status.textContent = "Choose a published revision."; return; }
  const result = await request("cms-restore", { revision, restoreId: picker.value });
  loadDraft(result.draft);
  status.textContent = "Restored to draft. Publish when you're ready.";
});
id("cms-preview").onclick = () => {
  const panel = id("cms-draft-preview");
  panel.replaceChildren();
  for (const field of fields) {
    if (!field.value.trim()) continue;
    const title = document.createElement("h2");
    title.textContent = field.closest("label").querySelector("span").textContent;
    const value = document.createElement("p");
    value.textContent = field.value;
    panel.append(title, value);
  }
  if (!panel.children.length) panel.append("Add content to a field to see a preview.");
  panel.hidden = false; panel.tabIndex = -1; panel.focus();
};

id("cms-sign-in").onclick = run(() => signInWithPopup(auth, new GoogleAuthProvider()));
onAuthStateChanged(auth, async user => {
  const version = ++accessVersion;
  form.hidden = true;
  form.reset();
  id("cms-draft-preview").hidden = true;
  id("cms-sign-in").hidden = !!user;
  loadVacation(user).catch(() => {});
  if (!user) { status.textContent = "Sign in to edit site content."; return; }
  if (!appointmentsEnabled) { status.textContent = "Site copy editing is available on staging."; return; }
  try {
    await read();
    if (version !== accessVersion) return;
    status.textContent = "";
    form.hidden = false;
  } catch {
    if (version === accessVersion) status.textContent = "This account couldn't open the site copy editor. Reload to try again.";
  }
});
