import { appointmentsEnabled, auth } from "./firebase-client.js";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { easternInput, slotPicker } from "./slot-picker.mjs";
import { appointmentMoney, appointmentRequest, appointmentTime, easternStart, fillDurationSelect, vehicleLabels } from "./appointment-utils.mjs";
import { servicePicker } from "./service-picker.mjs";
import { clearJobNotes, hasUnsavedJobNotes, jobScreen, jobWorkspace, rescheduleWorkspace, setupBookingSettings, statusLabels } from "./appointment-admin-tools.mjs";

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
const filter = byId("filter-appointments");
const detail = byId("owner-detail");
const detailStatus = byId("detail-status");
const params = new URLSearchParams(location.search);
let recordId = params.get("appointment");
let pickerReady = false;
let selectedSlot = null;
if ([...filter.options].some(option => option.value === params.get("filter"))) filter.value = params.get("filter");

function appointmentUrl(id) {
  const query = new URLSearchParams();
  if (id) query.set("appointment", id);
  if (filter.value !== "all") query.set("filter", filter.value);
  return "/admin/appointments" + (query.size ? "?" + query : "");
}
const feedback = () => recordId ? detailStatus : listStatus;
const refundBanner = Object.assign(document.createElement("p"), { className: "appointment-notice refund-banner", hidden: true });
listStatus.before(refundBanner);
// Keep the queue current when you come back to the app or leave it open.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !recordId && !byId("workspace").hidden) refreshList(); });
setInterval(() => { if (document.visibilityState === "visible" && !recordId && !byId("workspace").hidden && !byId("view-queue").hidden) refreshList(); }, 60000);
const messages = {
  access_denied: "This account isn’t on the admin list for this site.",
  sign_in_required: "Sign in to manage appointments.",
  record_not_found: "The selected client or lead could not be found.",
  invalid_identifier: "The selected client or lead link is invalid.",
  invalid_details: "Enter a name and either a valid US phone number or email address.",
  invalid_time: "Choose a future appointment with a duration from 15 minutes to seven days.",
  invalid_price: "Enter a valid estimated total.",
  time_unavailable: "This overlaps a confirmed appointment. Choose another time.",
  link_unavailable: "Share links are available for active, confirmed appointments.",
  calendar_unavailable: "The configured calendars couldn't be checked.",
  stripe_unavailable: "Configure Stripe test credentials before creating deposit links.",
  stripe_config_unavailable: "The booking API could not load a valid APPOINTMENT_STRIPE_CONFIG. Check its latest Secret Manager version and the runtime service account’s access.",
  calendar_config_unavailable: "Stripe configuration loaded. Check APPOINTMENT_GOOGLE_CONFIG, including three distinct calendar IDs and the runtime service account’s access.",
  booking_unavailable: "Stripe and all three calendars must be configured to enable public booking.",
  checkout_active: "A Stripe Checkout Session is active. Wait for reconciliation before changing payments or cancelling.",
  checkout_too_close: "Choose a time at least 36 minutes away to accept a deposit.",
  status_changed: "This appointment changed. Refresh the list and try again.",
  scope_acceptance_required: "Record the agreed scope changes and confirm customer approval for the price increase.",
  invalid_payment: "Enter a payment amount within the remaining balance and select its method.",
  invalid_line_items: "Check the invoice lines. Their amounts must add up to the final total.",
  check_pending: "Clear or return the pending check before recording another payment.",
  payment_review_required: "Reconcile the Stripe refund or dispute before recording another payment.",
  invalid_booking_settings: "Check the days, hours, ZIP codes, blocked dates, and service lines.",
  settings_updated: "These settings were updated elsewhere. Reload before saving.",
  maintenance_unavailable: "This job is outside the maintenance invitation window.",
};

let context = {};
let services = [];
let autoEstimate = null;
let requestId = crypto.randomUUID();
let scope = 0;
let authScope;
let saving = false;
let servicePickerView;

const explain = error => messages[error.code] || "Something went wrong. Try again.";
const ownerRequest = async (action, body = {}) => appointmentRequest(action, body, await auth.currentUser?.getIdToken());
const calendar = slotPicker(byId("owner-slot-calendar"), {
  status: byId("owner-calendar-status"), retry: byId("owner-calendar-retry"),
  getSlots(month) {
    const durationMinutes = Number(fields.durationMinutes.value);
    if (!fields.durationMinutes.validity.valid) return Promise.reject({ code: "invalid_time" });
    return ownerRequest("admin-availability", { month, durationMinutes, deposit: fields.deposit.value });
  },
  empty: "No openings this month for this duration. Try a different month or enter a custom time.",
  unavailable: error => error.code === "invalid_time" ? "Enter a valid duration to check openings." : explain(error),
  onClear() {
    if (selectedSlot && fields.start.value === easternInput(selectedSlot)) fields.start.value = "";
    selectedSlot = null;
  },
  onSelect(value) {
    selectedSlot = value;
    fields.start.value = easternInput(value);
  },
});
function refreshCalendar() {
  if (pickerReady) calendar.load();
}
function syncEstimate() {
  const service = services.find(item => item.name === fields.service.value);
  const vehicleType = fields.vehicleType.value;
  const prices = service?.vehiclePrices;
  const price = vehicleType ? prices?.[vehicleType] : prices && new Set(Object.values(prices)).size === 1 ? prices.sedan : undefined;
  if (fields.estimate.value && fields.estimate.value !== autoEstimate) return;
  autoEstimate = price == null ? "" : (price / 100).toFixed(2);
  fields.estimate.value = autoEstimate;
}
fields.service.onchange = () => {
  const service = services.find(item => item.name === fields.service.value);
  if (service) fillDurationSelect(fields.durationMinutes, service.duration);
  syncEstimate();
  refreshCalendar();
};
fields.vehicleType.onchange = () => { syncEstimate(); servicePickerView?.refreshPrices(); };
fields.durationMinutes.addEventListener("change", refreshCalendar);
fields.start.addEventListener("input", () => {
  selectedSlot = null;
  calendar.clearSelection();
});

function syncDeposit() {
  const waived = fields.deposit.value === "waived";
  form.querySelector("[type=submit]").textContent = waived ? "Confirm appointment" : "Save draft";
  byId("deposit-help").textContent = waived
    ? "This checks availability across all three calendars and confirms the appointment without collecting a deposit."
    : "Save a draft, then generate a deposit link to reserve the time and send it to your customer.";
}

function fillForm(prefill) {
  context = prefill;
  for (const key of ["name", "email", "phone", "address", "vehicle"]) fields[key].value = prefill[key] ?? "";
  if (prefill.service && ![...fields.service.options].some(option => option.value === prefill.service)) {
    fields.service.add(new Option(prefill.service, prefill.service));
  }
  fields.service.value = prefill.service || "";
  servicePickerView?.sync();
  fields.vehicleType.value = prefill.vehicleType || "";
  autoEstimate = null;
  fillDurationSelect(fields.durationMinutes, 60);
  fields.estimate.value = prefill.estimateCents == null ? "" : (prefill.estimateCents / 100).toFixed(2);
  fields.deposit.value = prefill.deposit || "required";
  byId("client-default").hidden = !prefill.clientId;
  syncDeposit();
}

function actionButton(label, handler) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "btn secondary", textContent: label });
  button.addEventListener("click", async () => {
    button.disabled = true;
    feedback().textContent = "";
    try { await handler(); } catch (error) { feedback().textContent = explain(error); }
    finally { button.disabled = false; }
  });
  return button;
}

function shareActions(record, url) {
  const input = Object.assign(document.createElement("input"), { type: "url", value: url, readOnly: true });
  input.setAttribute("aria-label", "Customer appointment link");
  const copy = actionButton("Copy link", async () => {
    try { await navigator.clipboard.writeText(url); feedback().textContent = "Appointment link copied."; }
    catch { input.focus(); input.select(); feedback().textContent = "Copy the selected link."; }
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

const contactKeys = ["name", "phone", "email", "vehicle", "address"];
function contactEditor(record) {
  const panel = document.createElement("details");
  const title = Object.assign(document.createElement("summary"), {textContent:"Customer and service address"});
  const editor = document.createElement("form");
  editor.className = "appointment-fields";
  const expected = {};
  for (const key of contactKeys) {
    const label = document.createElement("label");
    label.className = "field";
    const caption = Object.assign(document.createElement("span"), {textContent: key === "address" ? "Service address and ZIP" : key[0].toUpperCase() + key.slice(1)});
    expected[key] = record[key] ?? "";
    const input = Object.assign(document.createElement("input"), {name:key, value:expected[key], required:key === "name", type:key === "email" ? "email" : key === "phone" ? "tel" : "text"});
    input.maxLength = ({name:150,phone:48,email:250,vehicle:150,address:400})[key];
    label.append(caption,input); editor.append(label);
  }
  const save = Object.assign(document.createElement("button"), {type:"submit", className:"btn primary", textContent:"Save customer details"});
  const feedback = document.createElement("p");
  feedback.setAttribute("role","status");
  editor.append(save,feedback);
  editor.onsubmit = async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      await ownerRequest("update-contact",{id:record.id, expected, ...Object.fromEntries(new FormData(editor))});
      await refreshList(); detailStatus.textContent = "Customer details saved.";
    } catch (error) {feedback.textContent = explain(error);}
    finally {save.disabled = false;}
  };
  panel.append(title,editor);
  return panel;
}

function showView(name) {
  for (const button of workspace.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === name || (name === "detail" && button.dataset.view === "queue");
    button.setAttribute("aria-pressed", String(active));
    byId("view-" + button.dataset.view).hidden = button.dataset.view !== name;
  }
  byId("view-detail").hidden = name !== "detail";
  if (name === "new") refreshCalendar();
}

for (const button of workspace.querySelectorAll("[data-view]")) {
  button.onclick = () => {
    if (recordId) {
      recordId = null;
      history.replaceState(null, "", appointmentUrl());
      detail.replaceChildren();
      refreshList();
    }
    showView(button.dataset.view);
  };
}

const refundLabels = { queued: "refund queued", pending: "refund processing", succeeded: "deposit refunded", failed: "refund failed, needs attention" };
function recordStatus(record) {
  const status = statusLabels[record.status] ?? record.status;
  if (record.refundState) return status + " · " + (refundLabels[record.refundState] ?? "refund " + record.refundState);
  return status + (record.paidDeposit ? " · " + appointmentMoney(record.paidDeposit) + " deposit received" : "");
}
const refundOpen = record => ["queued", "pending", "failed"].includes(record.refundState);

function renderRow(record) {
  const row = Object.assign(document.createElement("a"), { className: "appointment-queue-row", href: appointmentUrl(record.id) });
  const dateMark = Object.assign(document.createElement("span"), { className: "date-mark" });
  dateMark.setAttribute("aria-hidden", "true");
  for (const part of ["month", "day"]) {
    const value = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", [part]: part === "month" ? "short" : "numeric" }).format(record.start);
    dateMark.append(Object.assign(document.createElement("span"), { textContent: value }));
  }
  const identity = document.createElement("span");
  const name = Object.assign(document.createElement("strong"), { textContent: record.name + " · " + record.service });
  const when = Object.assign(document.createElement("span"), { textContent: appointmentTime(record) });
  const state = Object.assign(document.createElement("span"), { className: "queue-status", textContent: recordStatus(record) });
  state.dataset.status = record.status;
  identity.append(name, when, state);
  row.append(dateMark, identity);
  return row;
}

const icons = {
  map: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.5-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.8 2z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
const quickLink = (label, href, name, external) => {
  const link = Object.assign(document.createElement("a"), { className: "quick-action", href });
  link.innerHTML = icon(name);
  link.append(Object.assign(document.createElement("span"), { textContent: label }));
  if (external) Object.assign(link, { target: "_blank", rel: "noopener noreferrer" });
  return link;
};
let openDetailView = null;

// Turn one of the older <details> workspaces into a view: the summary becomes its title.
function detailsAsView(details) {
  const summary = details.querySelector(":scope > summary");
  const title = summary?.textContent ?? "";
  summary?.remove();
  const body = document.createElement("div");
  body.append(...details.childNodes);
  return { title, body };
}

function renderDetail(record) {
  byId("owner-detail-heading").textContent = record.name;
  const card = Object.assign(document.createElement("article"), { className: "owner-record" });
  const hub = Object.assign(document.createElement("div"), { className: "record-hub" });
  const viewHost = Object.assign(document.createElement("section"), { className: "record-view", hidden: true });
  card.append(hub, viewHost);

  const views = new Map();
  function addView(key, label, iconName, build, { tone = "", hint = "" } = {}) {
    views.set(key, { label, build });
    const tile = Object.assign(document.createElement("button"), { type: "button", className: "record-tile" + (tone ? " record-tile--" + tone : "") });
    tile.innerHTML = icon(iconName);
    tile.append(Object.assign(document.createElement("strong"), { textContent: label }));
    if (hint) tile.append(Object.assign(document.createElement("span"), { textContent: hint }));
    tile.onclick = () => showRecordView(key);
    return tile;
  }
  function showRecordView(key) {
    const view = views.get(key);
    if (!view) return;
    openDetailView = { id: record.id, key };
    const back = Object.assign(document.createElement("button"), { type: "button", className: "record-view__back", textContent: "Back to appointment" });
    back.onclick = showHub;
    const heading = Object.assign(document.createElement("h3"), { textContent: view.label, tabIndex: -1 });
    const built = view.build();
    viewHost.replaceChildren(back, heading, ...(Array.isArray(built) ? built : [built]));
    hub.hidden = true;
    viewHost.hidden = false;
    document.body.dataset.recordView = key;
    heading.focus({ preventScroll: true });
    byId("view-detail").scrollIntoView({ block: "start" });
  }
  function showHub() {
    openDetailView = { id: record.id, key: null };
    delete document.body.dataset.recordView;
    viewHost.hidden = true;
    viewHost.replaceChildren();
    hub.hidden = false;
    byId("view-detail").scrollIntoView({ block: "start" });
  }

  // Summary
  const pill = Object.assign(document.createElement("span"), { className: "status-pill", textContent: statusLabels[record.status] ?? record.status });
  pill.dataset.status = record.status;
  const when = Object.assign(document.createElement("p"), { className: "record-when", textContent: record.service + " · " + appointmentTime(record) });
  hub.append(pill, when);

  // Quick contact and navigation
  const quick = Object.assign(document.createElement("div"), { className: "quick-actions" });
  if (record.address) {
    quick.append(quickLink("Directions", `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(record.address)}`, "map", true));
  }
  if (record.phone) quick.append(quickLink("Call", "tel:" + record.phone, "phone"), quickLink("Text", "sms:" + record.phone, "chat"));
  if (record.email) quick.append(quickLink("Email", "mailto:" + record.email, "mail"));
  if (quick.childElementCount) hub.append(quick);

  // Facts
  const facts = Object.assign(document.createElement("dl"), { className: "record-facts" });
  const fact = (label, value) => {
    if (value == null || value === "") return;
    facts.append(Object.assign(document.createElement("dt"), { textContent: label }), Object.assign(document.createElement("dd"), { textContent: value }));
  };
  if (record.address) {
    const dd = document.createElement("dd");
    dd.append(Object.assign(document.createElement("a"), {
      href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(record.address)}`, target: "_blank", rel: "noopener noreferrer", textContent: record.address,
    }));
    facts.append(Object.assign(document.createElement("dt"), { textContent: "Address" }), dd);
  }
  fact("Vehicle", record.vehicle);
  fact("Phone", record.phone);
  fact("Email", record.email);
  fact(record.finalCents != null ? "Final total" : "Estimate", record.finalCents != null ? appointmentMoney(record.finalCents) : record.estimateCents != null ? appointmentMoney(record.estimateCents) : "");
  fact("Deposit", record.paidDeposit ? appointmentMoney(record.paidDeposit) + " received" : record.depositCents ? appointmentMoney(record.depositCents) + " due" : "Waived");
  if (record.balanceCents != null) fact("Balance", record.balanceCents ? appointmentMoney(record.balanceCents) : "Paid");
  hub.append(facts);

  const alerts = [];
  if (record.rescheduleRequest) alerts.push("The customer asked for a different time. Open Reschedule to review it.");
  if (record.calendarFailed) alerts.push("Calendar sync failed and will retry.");
  if (record.refundState) alerts.push(`Deposit refund: ${record.refundState}`);
  if (record.paymentReview) alerts.push(`Stripe ${record.paymentReview.kind} needs review · ${appointmentMoney(record.paymentReview.amount)} · ${record.paymentReview.stripeObjectId}`);
  for (const text of alerts) hub.append(Object.assign(document.createElement("p"), { className: "appointment-notice", textContent: text }));

  // Primary actions
  const actions = Object.assign(document.createElement("div"), { className: "appointment-actions record-primary" });
  const share = document.createElement("div");
  const url = links.get(record.id);
  if (url && !["draft", "cancelled"].includes(record.status)) share.append(shareActions(record, url));
  if (record.status === "pending_approval") {
    const approve = actionButton("Approve appointment", async () => {
      if (!confirm("Check availability and approve this request?")) return;
      await ownerRequest("approve", { id: record.id }); await refreshList();
    });
    approve.className = "btn primary";
    actions.append(approve);
  }
  if (["draft", "awaiting_deposit", "confirmed", "in_progress", "pending_approval", "completed"].includes(record.status)) {
    const label = record.status === "draft" ? "Hold time and send deposit link" : record.status === "completed" ? "Send balance link" : "Send customer link";
    const linkButton = actionButton(label, async () => {
      const session = scope;
      const warning = record.status === "draft"
        ? "Check availability and hold this time for a $50 deposit?"
        : "Generate a customer link? This replaces any earlier shared link for this appointment.";
      if (!window.confirm(warning)) return;
      const sendEmail = !!record.email && window.confirm("Queue an email to the customer’s staging test inbox? Cancel to create the link only.");
      const { token } = await ownerRequest("issue-link", { id: record.id, sendEmail });
      if (session !== scope) return;
      const issued = `${location.origin}/appointment#${record.id}.${token}`;
      links.set(record.id, issued);
      share.replaceChildren(shareActions(record, issued));
      if (record.status === "draft") await refreshList();
      else share.querySelector("input").focus();
      feedback().textContent = "Customer link ready to copy or send.";
    });
    if (record.status === "draft") linkButton.className = "btn primary";
    actions.append(linkButton);
  }
  hub.append(actions, share);

  // Views
  const tiles = Object.assign(document.createElement("div"), { className: "record-tiles" });
  if (["confirmed", "in_progress", "completed"].includes(record.status)) {
    const completed = record.status === "completed";
    tiles.append(addView("job", completed ? "Balance and payments" : record.status === "in_progress" ? "Job in progress" : "Start job",
      completed ? "cash" : "wrench", () => completed ? detailsAsView(jobWorkspace(record, ownerRequest, refreshList, explain)).body : jobScreen(record, ownerRequest, refreshList, explain),
      { tone: "gold", hint: completed ? "Record payments and invitations" : "Notes, photos, and closeout" }));
  }
  const jobOpen = record.status === "in_progress";
  if (["confirmed", "pending_approval"].includes(record.status)) {
    const view = () => detailsAsView(rescheduleWorkspace(record, ownerRequest, refreshList, explain)).body;
    tiles.append(addView("reschedule", record.rescheduleRequest ? "Review time request" : record.status === "pending_approval" ? "Offer another time" : "Reschedule",
      "clock", view, { hint: record.rescheduleRequest ? "Customer asked to move" : "Move to a new time" }));
  }
  tiles.append(addView("customer", "Customer details", "user", () => detailsAsView(contactEditor(record)).body, { hint: "Name, phone, address" }));

  const more = [];
  if (!["draft", "cancelled", "no_show"].includes(record.status)) {
    more.push(actionButton("Revoke customer link", async () => {
      if (!window.confirm("Revoke access from the current customer link?")) return;
      await ownerRequest("revoke-link", { id: record.id });
      links.delete(record.id);
      share.replaceChildren();
      feedback().textContent = "Customer link revoked.";
    }));
  }
  if (["draft", "awaiting_deposit", "pending_approval", "confirmed"].includes(record.status)) {
    more.push(actionButton(record.status === "draft" ? "Discard draft" : "Cancel appointment", async () => {
      if (!window.confirm(record.status === "draft" ? "Discard this appointment draft?" : "Cancel this appointment and release its time?")) return;
      await ownerRequest("cancel", { id: record.id });
      links.delete(record.id);
      await refreshList();
    }));
  }
  if (record.paidDeposit && ["pending_approval", "confirmed"].includes(record.status)) {
    more.push(actionButton("Cancel and refund deposit", async () => {
      const reason = prompt("Why are you refunding this deposit?");
      if (!reason?.trim()) return;
      await ownerRequest("cancel", { id: record.id, refundOverride: true, reason }); await refreshList();
    }));
  }
  if (record.status === "confirmed" && record.start <= Date.now()) {
    more.push(actionButton("Record no-show", async () => {
      const reason = prompt("Add a brief reason.");
      if (!reason?.trim()) return;
      await ownerRequest("no-show", { id: record.id, reason }); await refreshList();
    }));
  }
  if (more.length) {
    tiles.append(addView("more", "Cancel or other actions", "dots", () => {
      const list = Object.assign(document.createElement("div"), { className: "record-danger-actions" });
      for (const button of more) { button.classList.add("btn-danger-outline"); list.append(button); }
      return list;
    }, { tone: "danger", hint: "Cancel, refund, no-show" }));
  }
  hub.append(tiles);

  if (openDetailView?.id === record.id && views.has(openDetailView.key)) showRecordView(openDetailView.key);
  else if (jobOpen && openDetailView?.id !== record.id && views.has("job")) showRecordView("job");
  else openDetailView = null;
  return card;
}

async function refreshList() {
  const session = scope;
  const id = recordId;
  const status = feedback();
  status.textContent = id ? "Loading appointment." : "Loading appointments.";
  try {
    if (id) {
      const record = await ownerRequest("owner-detail", { id });
      if (session !== scope || recordId !== id) return;
      detail.replaceChildren(renderDetail(record));
      status.textContent = "";
      return;
    }

    const records = await ownerRequest("list");
    if (session !== scope || recordId) return;
    const view = filter.value;
    const east = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "short" });
    const refunds = records.filter(refundOpen);
    const failed = refunds.filter(record => record.refundState === "failed").length;
    refundBanner.hidden = !refunds.length;
    refundBanner.textContent = refunds.length
      ? `${refunds.length} deposit refund${refunds.length === 1 ? "" : "s"} in progress${failed ? `, ${failed} failed and need${failed === 1 ? "s" : ""} attention in Stripe` : ""}. Choose "Refunds" in the filter to see them.`
      : "";
    const visible = records.filter(record => {
      if (view === "refunds") return refundOpen(record);
      if (view === "cancelled") return record.status === "cancelled";
      if (record.status === "cancelled") return false;
      if (view === "today") return east.format(record.start) === east.format(Date.now());
      if (view === "due") return record.balanceCents > 0;
      return view === "all" || record.status === view;
    });
    if (view === "today") visible.sort((a, b) => a.start - b.start);
    list.replaceChildren(...visible.map(renderRow));
    status.textContent = visible.length ? "" : records.length ? "No appointments match this filter." : "Your first appointment will appear here.";
  } catch (error) {
    if (session === scope && recordId === id) {
      status.textContent = id && error.code === "record_not_found" ? "This appointment could not be found." : explain(error);
    }
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
      ...payload, vehicle: payload.vehicle || vehicleLabels[payload.vehicleType] || "", start, useCalendarSlot: selectedSlot === start, durationMinutes: Number(payload.durationMinutes),
      estimateCents: payload.estimate ? Math.round(Number(payload.estimate) * 100) : null,
      saveClientDefault: !!context.clientId && fields.saveClientDefault.checked,
      clientId: context.clientId, leadId: context.leadId, requestId,
    });
    if (session !== scope) return;
    location.assign(appointmentUrl(record.id));
  } catch (error) {
    if (session === scope) formStatus.textContent = explain(error);
  } finally {
    saving = button.disabled = false;
  }
});

fields.deposit.addEventListener("change", () => { syncDeposit(); refreshCalendar(); });

if (!appointmentsEnabled) {
  authStatus.textContent = "Appointments are available on the staging site.";
} else {
  signIn.addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch { authStatus.textContent = "Couldn’t sign in. Try again."; }
  });
  signOutButton.addEventListener("click", () => {
    if (hasUnsavedJobNotes() && !confirm("Some job notes are still unsaved. Sign out and discard them?")) return;
    signOut(auth).catch(() => { authStatus.textContent = "Couldn't sign out. Try again."; });
  });
  onAuthStateChanged(auth, async user => {
    const session = ++scope;
    authScope?.abort();
    authScope = new AbortController();
    clearJobNotes();
    links.clear();
    list.replaceChildren();
    detail.replaceChildren();
    pickerReady = false;
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
    const initialView = recordId ? "detail" : params.has("client") || params.has("lead") ? "new" : "queue";
    byId("back-to-queue").href = appointmentUrl();
    showView(initialView);
    workspace.addEventListener("booking-settings-loaded", event => {
      if (session !== scope) return;
      const settings = event.detail;
      const previous = fields.service.value;
      services = settings.services;
      const labels = [...new Set(services.map(service => service.name))];
      if (previous && !labels.includes(previous)) labels.push(previous);
      fields.service.replaceChildren(new Option("Choose later", ""), ...labels.map(name => new Option(name, name)));
      fields.service.value = previous;
      const unique = labels.map(name => services.find(service => service.name === name) ?? { name, duration: 60, cents: 0 });
      servicePickerView = servicePicker(byId("owner-service-picker"), fields.service, unique, {
        valueFor: service => service.name, vehicle: () => fields.vehicleType.value, none: "Choose later",
      });
      const selectedService = services.find(service => service.name === previous);
      if (!pickerReady && selectedService) fillDurationSelect(fields.durationMinutes, selectedService.duration);
      calendar.setHorizon(settings.horizonDays);
      pickerReady = true;
      if (!byId("view-new").hidden) refreshCalendar();
    }, { signal: authScope.signal });
    setupBookingSettings(byId("booking-settings"), ownerRequest, explain);
    await refreshList();
  });
}

filter.addEventListener("change", () => {
  history.replaceState(null, "", appointmentUrl());
  refreshList();
});
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
