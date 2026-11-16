import { appointmentsEnabled, auth } from "./firebase-client.js";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { appointmentMoney, appointmentRequest, appointmentTime, easternStart } from "./appointment-utils.mjs";
import { jobWorkspace, rescheduleWorkspace, setupBookingSettings, statusLabels } from "./appointment-admin-tools.mjs";

const byId = id => document.getElementById(id);
const form = byId("create-booking");
const fields = form.elements;
const formStatus = byId("form-status");
const authStatus = byId("auth-status");
const listStatus = byId("list-status");
const workspace = byId("workspace");
const list = byId("appointments-list");
const signIn = byId("sign-in");
const signOutButton = byId("sign-out");
const links = new Map();
const messages = {
  access_denied: "This account isn’t on the admin list for this site.",
  sign_in_required: "Sign in to manage appointments.",
  record_not_found: "The selected client or lead could not be found.",
  invalid_identifier: "The selected client or lead link is invalid.",
  invalid_details: "Enter a name, service, address, and at least one valid contact method.",
  invalid_time: "Choose a future appointment with a duration from 15 minutes to seven days.",
  invalid_price: "Enter a valid estimated total.",
  time_unavailable: "This overlaps a confirmed appointment. Choose another time.",
  calendar_check_required: "Check your calendars before confirming the time.",
  link_unavailable: "Share links are available for active, confirmed appointments.",
  calendar_unavailable: "The configured calendars couldn't be checked.",
  stripe_unavailable: "Configure Stripe test credentials before creating deposit links.",
  booking_unavailable: "Stripe and all three calendars must be configured to enable public booking.",
  checkout_active: "A Stripe Checkout Session is active. Wait for reconciliation before changing payments or cancelling.",
  checkout_too_close: "Choose a time at least 36 minutes away to accept a deposit.",
  status_changed: "This appointment changed. Refresh the list and try again.",
  scope_acceptance_required: "Record the agreed scope changes and confirm customer approval for the price increase.",
  invalid_payment: "Enter a payment amount within the remaining balance and select its method.",
  invalid_line_items: "Check the invoice lines. Their amounts must add up to the final total.",
  check_pending: "Clear or return the pending check before recording another payment.",
  invalid_booking_settings: "Check the days, hours, ZIP codes, blocked dates, and service lines.",
  settings_updated: "These settings were updated elsewhere. Reload before saving.",
  maintenance_unavailable: "This job is outside the maintenance invitation window.",
};

let context = {};
let requestId = crypto.randomUUID();
let scope = 0;
let saving = false;

const explain = error => messages[error.code] || "Something went wrong. Try again.";
const ownerRequest = async (action, body = {}) => appointmentRequest(action, body, await auth.currentUser?.getIdToken());

function syncDeposit() {
  const waived = fields.deposit.value === "waived";
  byId("calendar-check").hidden = !waived;
  fields.calendarChecked.required = waived;
  form.querySelector("[type=submit]").textContent = waived ? "Confirm appointment" : "Save draft";
  byId("deposit-help").textContent = waived
    ? "The customer can open an appointment link and add the booking to their calendar."
    : "Save a draft, then generate a deposit link to reserve the time and send it to your customer.";
}

function fillForm(prefill) {
  context = prefill;
  for (const key of ["name", "email", "phone", "address", "service", "vehicle"]) fields[key].value = prefill[key] ?? "";
  fields.estimate.value = prefill.estimateCents == null ? "" : (prefill.estimateCents / 100).toFixed(2);
  fields.deposit.value = prefill.deposit || "required";
  byId("client-default").hidden = !prefill.clientId;
  syncDeposit();
}

function actionButton(label, handler) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "btn secondary", textContent: label });
  button.addEventListener("click", async () => {
    button.disabled = true;
    listStatus.textContent = "";
    try { await handler(); } catch (error) { listStatus.textContent = explain(error); }
    finally { button.disabled = false; }
  });
  return button;
}

function shareActions(record, url) {
  const input = Object.assign(document.createElement("input"), { type: "url", value: url, readOnly: true });
  input.setAttribute("aria-label", "Customer appointment link");
  const copy = actionButton("Copy link", async () => {
    try { await navigator.clipboard.writeText(url); listStatus.textContent = "Appointment link copied."; }
    catch { input.focus(); input.select(); listStatus.textContent = "Copy the selected link."; }
  });
  const actions = Object.assign(document.createElement("div"), { className: "appointment-actions" });
  const message = `Hi ${record.name}, here are your detailing appointment details for ${appointmentTime(record)}. ${url}`;
  actions.append(copy);
  if (record.phone) {
    const phone = record.phone.replace(/[^\d+]/g, "");
    actions.append(Object.assign(document.createElement("a"), { href: `sms:${phone}?body=${encodeURIComponent(message)}`, textContent: "Text link" }));
  }
  if (record.email) {
    const to = encodeURIComponent(record.email).replace(/%40/g, "@");
    actions.append(Object.assign(document.createElement("a"), {
      href: `mailto:${to}?subject=${encodeURIComponent("Your Nieman’s Detailing appointment")}&body=${encodeURIComponent(message)}`,
      textContent: "Email link",
    }));
  }
  if (navigator.share) actions.append(actionButton("Share link", () => navigator.share({ title: "Detailing appointment", url })));
  const section = Object.assign(document.createElement("div"), { className: "field" });
  section.append(input, actions);
  return section;
}

function renderRecord(record) {
  const card = Object.assign(document.createElement("article"), { className: "appointment-record" });
  const status = (statusLabels[record.status] ?? record.status) +
    (record.paidDeposit ? ` · ${appointmentMoney(record.paidDeposit)} deposit received` : record.depositCents ? "" : " · No deposit");
  const heading = Object.assign(document.createElement("h3"), { textContent: `${record.name} · ${record.service}` });
  const summary = Object.assign(document.createElement("p"), { textContent: `${appointmentTime(record)} · ${status}` });
  const actions = Object.assign(document.createElement("div"), { className: "appointment-actions" });
  const share = document.createElement("div");
  const url = links.get(record.id);
  if (url && !["draft", "cancelled"].includes(record.status)) share.append(shareActions(record, url));

  if (["draft", "awaiting_deposit", "confirmed", "in_progress", "pending_approval", "completed"].includes(record.status)) {
    const label = record.status === "draft" ? "Hold time and generate deposit link" : record.status === "completed" ? "Generate balance link" : "Generate customer link";
    actions.append(actionButton(label, async () => {
      const session = scope;
      const warning = record.status === "draft"
        ? "I checked Detailing, personal, and Pluto Events. Hold this time for a $50 deposit?"
        : "Generate a customer link? This replaces any earlier shared link for this appointment.";
      if (!window.confirm(warning)) return;
      const sendEmail = !!record.email && window.confirm("Queue an email to the customer’s staging test inbox? Cancel to create the link only.");
      const { token } = await ownerRequest("issue-link", { id: record.id, calendarChecked: true, sendEmail });
      if (session !== scope) return;
      const issued = `${location.origin}/appointment#${record.id}.${token}`;
      links.set(record.id, issued);
      share.replaceChildren(shareActions(record, issued));
      if (record.status === "draft") await refreshList();
      else share.querySelector("input").focus();
      listStatus.textContent = "Customer link ready to copy or send.";
    }));
  }
  if (record.status !== "draft") {
    actions.append(actionButton("Revoke link", async () => {
      if (!window.confirm("Revoke access from the current customer link?")) return;
      await ownerRequest("revoke-link", { id: record.id });
      links.delete(record.id);
      share.replaceChildren();
      listStatus.textContent = "Customer link revoked.";
    }));
  }
  if (record.status === "pending_approval") {
    actions.append(actionButton("Approve appointment", async () => {
      if (!confirm("I checked Detailing, personal, and Pluto Events. Approve this request?")) return;
      await ownerRequest("approve", { id: record.id, calendarChecked: true }); await refreshList();
    }));
  }
  if (["draft", "awaiting_deposit", "pending_approval", "confirmed"].includes(record.status)) {
    actions.append(actionButton(record.status === "draft" ? "Discard draft" : "Cancel appointment", async () => {
      if (!window.confirm(record.status === "draft" ? "Discard this appointment draft?" : "Cancel this appointment and release its time?")) return;
      await ownerRequest("cancel", { id: record.id });
      links.delete(record.id);
      await refreshList();
    }));
  }
  if (record.paidDeposit && ["pending_approval", "confirmed"].includes(record.status)) {
    actions.append(actionButton("Cancel and refund deposit", async () => {
      const reason = prompt("Why are you refunding this deposit?");
      if (!reason?.trim()) return;
      await ownerRequest("cancel", { id: record.id, refundOverride: true, reason }); await refreshList();
    }));
  }
  if (record.status === "confirmed" && record.start <= Date.now()) {
    actions.append(actionButton("Record no-show", async () => {
      const reason = prompt("Add a brief reason.");
      if (!reason?.trim()) return;
      await ownerRequest("no-show", { id: record.id, reason }); await refreshList();
    }));
  }
  card.append(heading, summary, actions, share);
  if (record.calendarFailed) card.append(Object.assign(document.createElement("p"), { textContent: "Calendar sync failed and will retry." }));
  if (record.refundState) card.append(Object.assign(document.createElement("p"), { textContent: `Deposit refund: ${record.refundState}` }));
  if (["confirmed", "pending_approval"].includes(record.status)) card.append(rescheduleWorkspace(record, ownerRequest, refreshList, explain));
  if (["confirmed", "in_progress", "completed"].includes(record.status)) card.append(jobWorkspace(record, ownerRequest, refreshList, explain));
  return card;
}

async function refreshList() {
  const session = scope;
  listStatus.textContent = "Loading appointments…";
  try {
    const records = await ownerRequest("list");
    if (session !== scope) return;
    const filter = byId("filter-appointments").value;
    const east = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "short" });
    const visible = filter === "all" ? records : filter === "today" ?
      records.filter(record => east.format(record.start) === east.format(Date.now()) && record.status !== "cancelled").sort((a, b) => a.start - b.start) :
      filter === "due" ? records.filter(record => record.balanceCents > 0) : records.filter(record => record.status === filter);
    list.replaceChildren(...visible.map(renderRecord));
    listStatus.textContent = records.length ? "" : "No appointments yet.";
  } catch (error) {
    if (session === scope) listStatus.textContent = explain(error);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (saving) return;
  const payload = Object.fromEntries(new FormData(form));
  const button = form.querySelector("[type=submit]");
  const session = scope;
  saving = button.disabled = true;
  formStatus.textContent = "Saving…";
  try {
    let start;
    try { start = easternStart(payload.start); }
    catch (error) { formStatus.textContent = error.message; return; }
    const record = await ownerRequest("create", {
      ...payload, start, durationMinutes: Number(payload.durationMinutes),
      estimateCents: payload.estimate ? Math.round(Number(payload.estimate) * 100) : null,
      calendarChecked: fields.calendarChecked.checked,
      saveClientDefault: !!context.clientId && fields.saveClientDefault.checked,
      clientId: context.clientId, leadId: context.leadId, requestId,
    });
    if (session !== scope) return;
    requestId = crypto.randomUUID();
    form.reset();
    fillForm({});
    history.replaceState(null, "", location.pathname);
    formStatus.textContent = record.status === "confirmed" ? "Appointment confirmed. Generate a link under Recent appointments." : "Appointment draft saved.";
    await refreshList();
  } catch (error) {
    if (session === scope) formStatus.textContent = explain(error);
  } finally {
    saving = button.disabled = false;
  }
});

fields.deposit.addEventListener("change", syncDeposit);
for (const name of ["start", "durationMinutes"]) fields[name].addEventListener("input", () => { fields.calendarChecked.checked = false; });

if (!appointmentsEnabled) {
  authStatus.textContent = "Appointments are available on the staging site.";
} else {
  signIn.addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch { authStatus.textContent = "Couldn’t sign in. Try again."; }
  });
  signOutButton.addEventListener("click", () => signOut(auth).catch(() => { authStatus.textContent = "Couldn’t sign out. Try again."; }));
  onAuthStateChanged(auth, async user => {
    const session = ++scope;
    links.clear();
    list.replaceChildren();
    form.reset();
    requestId = crypto.randomUUID();
    fillForm({});
    formStatus.textContent = "";
    workspace.hidden = true;
    signOutButton.hidden = !user;
    signIn.hidden = !!user;
    authStatus.hidden = false;
    authStatus.textContent = user ? "Checking admin access…" : "Sign in to manage appointments.";
    if (!user) return;
    let prefill;
    const params = new URLSearchParams(location.search);
    try { prefill = await ownerRequest("context", { clientId: params.get("client"), leadId: params.get("lead") }); }
    catch (error) {
      if (session !== scope) return;
      if (error.code !== "record_not_found" && error.code !== "invalid_identifier") {
        authStatus.textContent = explain(error);
        return;
      }
      formStatus.textContent = explain(error);
      prefill = {};
    }
    if (session !== scope) return;
    fillForm(prefill);
    authStatus.hidden = true;
    workspace.hidden = false;
    setupBookingSettings(byId("booking-settings"), ownerRequest, explain);
    await refreshList();
  });
}

byId("filter-appointments").addEventListener("change", refreshList);
byId("export-payments").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const { csv } = await ownerRequest("payment-export");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    Object.assign(document.createElement("a"), { href: url, download: "detailing-payments.csv" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) { listStatus.textContent = explain(error); }
  finally { button.disabled = false; }
});
