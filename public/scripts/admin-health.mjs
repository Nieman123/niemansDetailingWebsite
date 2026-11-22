import { appointmentsEnabled, auth } from "./firebase-client.js";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { appointmentRequest } from "./appointment-utils.mjs";

const byId = id => document.getElementById(id);
const authStatus = byId("auth-status");
const signIn = byId("sign-in");
const signOutButton = byId("sign-out");
const refreshButton = byId("refresh-health");
const panel = byId("health");
const eventFilter = byId("event-filter");
let report = null;
let scope = 0;

const ownerRequest = async (action, body = {}) => appointmentRequest(action, body, await auth.currentUser?.getIdToken());
const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function ago(ms) {
  if (ms == null) return "never";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return when.format(ms);
}
const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null && child !== ""));
  return node;
};
function row(tone, title, detail, meta, link) {
  const dot = element("span", { className: "health-dot" });
  dot.dataset.tone = tone;
  dot.setAttribute("aria-label", tone === "ok" ? "OK" : tone === "error" ? "Problem" : "Warning");
  dot.setAttribute("role", "img");
  const body = element("div", { className: "health-item" },
    link ? element("a", { href: link }, element("strong", { textContent: title })) : element("strong", { textContent: title }),
    detail ? element("span", { textContent: detail }) : null,
    meta ? element("small", { textContent: meta }) : null);
  return element("li", {}, dot, body);
}
const empty = text => element("li", { className: "health-empty", textContent: text });
function tile(id, value, tone) {
  const node = byId(id);
  node.querySelector("strong").textContent = String(value);
  node.dataset.tone = tone;
}
const messages = {
  access_denied: "This account isn’t on the admin list for this site.",
  sign_in_required: "Sign in to see your dashboard.",
  not_found: "The health report isn’t available on this deployment yet.",
};
const explain = error => messages[error.code] || "Couldn’t load the health report. Try again in a minute.";

// Links from a log entry to the record it is about.
function refLink(event) {
  if (/^[a-f0-9]{64}$/.test(event.ref) && ["calendar", "payments", "booking"].includes(event.source)) return `/admin/appointments?appointment=${event.ref}`;
  if (event.source === "leads" && event.ref) return `/admin?id=${encodeURIComponent(event.ref)}`;
  return "";
}

function renderEvents() {
  const list = byId("events");
  const view = eventFilter.value;
  const events = (report?.events ?? []).filter(event => view === "all" || (view === "error" ? event.level === "error" : event.source === "browser"));
  list.replaceChildren(...events.map(event => row(event.level === "error" ? "error" : "warning", event.title,
    [event.detail, event.source === "browser" && event.ref ? `Page: ${event.ref}` : ""].filter(Boolean).join(" · "),
    `${event.count > 1 ? `${event.count} times, ` : ""}last ${ago(event.lastAt)}`, refLink(event))));
  if (!events.length) list.append(empty(view === "all" ? "Nothing logged in the last 7 days." : "Nothing of this kind in the last 7 days."));
}

function render() {
  const { summary, scheduler, checks, emails, webhooks, attention } = report;
  const failingChecks = checks.filter(check => !check.ok && !["reviews", "booking"].includes(check.id) && !(check.id === "telegram" && report.mode !== "live"));
  const problems = [];
  if (!scheduler.healthy) problems.push(scheduler.lastRunAt ? `The maintenance job last ran ${ago(scheduler.lastRunAt)}${scheduler.lastError ? " and failed" : ""}.` : "The maintenance job hasn't reported in yet.");
  if (failingChecks.length) problems.push(`${failingChecks.map(check => check.label).join(", ")} ${failingChecks.length === 1 ? "needs" : "need"} attention.`);
  if (summary.errors24h) problems.push(`${summary.errors24h} error${summary.errors24h === 1 ? "" : "s"} in the last 24 hours.`);
  if (emails.failed || emails.stuck) problems.push(`${emails.failed + emails.stuck} customer email${emails.failed + emails.stuck === 1 ? "" : "s"} didn't go out.`);
  if (webhooks.unfinished) problems.push(`${webhooks.unfinished} Stripe notification${webhooks.unfinished === 1 ? "" : "s"} didn't finish processing.`);
  const banner = byId("health-banner");
  const tone = problems.length ? "error" : summary.warnings24h || summary.attention ? "warning" : "ok";
  banner.dataset.tone = tone;
  byId("banner-title").textContent = problems.length ? "Something needs a look" : summary.attention ? "Systems are healthy. A booking needs you." : "Everything is working";
  byId("banner-detail").textContent = problems.length ? problems.join(" ") :
    `Maintenance job ran ${ago(scheduler.lastRunAt)}. ${report.mode === "live" ? "Live payments." : "Test mode (staging)."}`;

  tile("tile-errors", summary.errors24h, summary.errors24h ? "error" : "ok");
  tile("tile-warnings", summary.warnings24h, summary.warnings24h ? "warning" : "ok");
  tile("tile-attention", summary.attention, summary.attention ? "warning" : "ok");
  tile("tile-emails", emails.sent, emails.failed || emails.stuck ? "error" : "ok");

  const attentionList = byId("attention-list");
  attentionList.replaceChildren(...attention.map(item => row("warning", `${item.name || "Customer"} · ${when.format(item.start)}`, item.issue, "", `/admin/appointments?appointment=${item.id}`)));
  if (!attention.length) attentionList.append(empty("Nothing waiting on you."));

  const checkList = byId("checks");
  checkList.replaceChildren(
    row(scheduler.healthy ? "ok" : "error", "Maintenance job (every 5 minutes)",
      scheduler.lastError ? `Last run failed: ${scheduler.lastError}` : scheduler.healthy ? "Sending emails, syncing the calendar and settling payments." : "Not running on schedule. Check Cloud Scheduler in the Firebase console.",
      `Last run ${ago(scheduler.lastRunAt)}${scheduler.lastDurationMs != null ? `, took ${(scheduler.lastDurationMs / 1000).toFixed(1)} s` : ""}`),
    ...checks.map(check => row(check.ok ? "ok" : ["reviews", "booking"].includes(check.id) || (check.id === "telegram" && report.mode !== "live") ? "warning" : "error",
      check.label, check.ok ? "Working" : check.detail, "")),
    row(webhooks.unfinished ? "error" : "ok", "Stripe notifications",
      webhooks.unfinished ? `${webhooks.unfinished} didn't finish. Stripe retries for 3 days, so check the problems log below.` : "All processed.",
      `${webhooks.received} received in the last 7 days`),
  );

  byId("email-summary").textContent = `${emails.sent} sent, ${emails.retrying} retrying, ${emails.failed} failed, ${emails.stuck} stuck, out of ${emails.total} queued.`;
  const emailList = byId("email-problems");
  emailList.replaceChildren(...emails.problems.map(email => row(email.state === "retry" ? "warning" : "error",
    `${email.subject} → ${email.to}`,
    email.lastError || (email.state === "stuck" ? "Waiting to send for over 30 minutes. Is the maintenance job running?" : ""),
    `${email.state === "retry" ? "Retrying" : email.state === "stuck" ? "Stuck" : "Never delivered"} · queued ${ago(email.createdAt)}`)));
  if (!emails.problems.length) emailList.append(empty("No delivery problems."));

  renderEvents();
  byId("generated").textContent = `Updated ${when.format(report.generatedAt)} Eastern.`;
}

async function load() {
  const session = scope;
  refreshButton.disabled = true;
  try {
    const result = await ownerRequest("health");
    if (session !== scope) return;
    report = result;
    render();
    authStatus.hidden = true;
    panel.hidden = false;
  } catch (error) {
    if (session !== scope) return;
    authStatus.hidden = false;
    authStatus.textContent = explain(error);
  } finally { refreshButton.disabled = false; }
}

eventFilter.addEventListener("change", renderEvents);
refreshButton.addEventListener("click", load);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !panel.hidden) load(); });
setInterval(() => { if (document.visibilityState === "visible" && !panel.hidden) load(); }, 60000);

if (!appointmentsEnabled) {
  authStatus.textContent = "The dashboard needs the appointments backend, which isn't turned on for this site yet.";
} else {
  signIn.addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch { authStatus.textContent = "Couldn’t sign in. Try again."; }
  });
  signOutButton.addEventListener("click", () => signOut(auth).catch(() => { authStatus.textContent = "Couldn't sign out. Try again."; }));
  onAuthStateChanged(auth, async user => {
    ++scope;
    panel.hidden = true;
    signOutButton.hidden = refreshButton.hidden = !user;
    signIn.hidden = !!user;
    authStatus.hidden = false;
    authStatus.textContent = user ? "Loading your dashboard…" : "Sign in to see your dashboard.";
    if (user) await load();
  });
}
