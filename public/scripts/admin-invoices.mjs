import { auth } from "./firebase-client.js";
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { appointmentRequest } from "./appointment-utils.mjs";

const byId = id => document.getElementById(id);
const authStatus = byId("auth-status");
const signInButton = byId("sign-in");
const signOutButton = byId("sign-out");
const workspace = byId("workspace");
const form = byId("invoice-form");
const settingsForm = byId("invoice-settings");
const views = ["list", "detail", "edit", "settings"];

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = cents => dollars.format(cents / 100);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
const shortDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "")
  ? new Date(value + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "";
const rateLabel = basisPoints => `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const requestId = () => crypto.getRandomValues(new Uint8Array(16)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
const toCents = value => {
  const number = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(number) ? Math.round(number * 100) : NaN;
};
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null && child !== false && child !== ""));
  return node;
};
const TERMS = { due_on_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60 };
const addDays = (date, days) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
const methodLabels = { check: "Check", cash: "Cash", ach: "Bank transfer (ACH)", card: "Card", other: "Other" };
const statusLabels = { open: "Unpaid", paid: "Paid", void: "Void" };

const messages = {
  access_denied: "This account isn’t on the admin list for this site.",
  sign_in_required: "Sign in again to continue.",
  bill_to_required: "Enter who the invoice is for.",
  invalid_email: "That email address doesn’t look right.",
  invalid_terms: "Choose payment terms.",
  invalid_issue_date: "Enter the invoice date.",
  invalid_due_date: "Enter a due date on or after the invoice date.",
  lines_required: "Add at least one line item.",
  invalid_line: "Each line needs a description, a quantity above zero and a price.",
  invalid_tax_rate: "Enter a tax rate between 0.01% and 20%.",
  invalid_credit: "Each credit needs a description and an amount.",
  credits_exceed_total: "Credits can’t be more than the invoice total.",
  negative_total: "The invoice total can’t be below zero.",
  invoice_changed: "This invoice changed in another window. Reload it and try again.",
  payments_exceed_total: "Payments already recorded are more than this new total. Remove a payment first.",
  invalid_payment: "Enter an amount up to the balance due, a date, and a payment method.",
  check_number_required: "Enter the check number.",
  remove_payments_first: "Remove the recorded payments before voiding this invoice.",
  invoice_void: "This invoice is void. Reopen it first.",
  no_payments: "Record a payment before making a receipt.",
  email_not_configured: "Email isn’t set up on this site yet. Download the PDF and attach it to an email yourself.",
  test_recipient_only: "This is the test site, so it only emails the allow-listed test inboxes. Production emails anyone.",
  email_delivery_failed: "The email service didn’t accept the message. Try again, or download the PDF and send it yourself.",
  settings_updated: "Settings changed in another window. Reload the page and try again.",
  business_name_required: "Enter your business name.",
  invoice_not_found: "That invoice wasn’t found.",
  record_not_found: "That appointment or client wasn’t found.",
};
const explain = error => messages[error?.code] || "Something went wrong. Try again in a minute.";

async function request(action, body = {}) {
  const token = await auth.currentUser?.getIdToken();
  const response = await fetch(`/api/invoices/${action}`, {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.error || "invoice_operation_failed");
    error.code = data?.error;
    throw error;
  }
  return data.result;
}

let settings = null;
let salesTax = { enabled: false, rateBasisPoints: 700 };
let invoices = [];
let current = null;
let editing = null; // { id, updatedAt, source } while editing
let returnTo = "list";

function show(view) {
  for (const name of views) byId(`view-${name}`).hidden = name !== view;
  for (const button of document.querySelectorAll(".work-switch [data-view]")) {
    const active = button.dataset.view === view || (view === "detail" && button.dataset.view === "list") || (view === "edit" && editing?.id && button.dataset.view === "list");
    button.setAttribute("aria-pressed", String(active));
  }
  window.scrollTo(0, 0);
}
function setUrl(params) {
  const url = new URL(location.href);
  url.search = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
  history.replaceState(null, "", url);
}

// ---- List ----
function renderList() {
  const filter = byId("invoice-filter").value;
  const term = byId("invoice-search").value.trim().toLowerCase();
  const visible = invoices.filter(invoice => {
    if (filter === "unpaid" && invoice.status !== "open") return false;
    if (filter === "overdue" && !invoice.overdue) return false;
    if (filter === "paid" && invoice.status !== "paid") return false;
    if (filter === "void" && invoice.status !== "void") return false;
    return !term || [invoice.number, invoice.billTo, invoice.reference].some(value => (value || "").toLowerCase().includes(term));
  });
  const unpaid = invoices.filter(invoice => invoice.status === "open");
  const owed = unpaid.reduce((total, invoice) => total + invoice.balanceCents, 0);
  const overdue = unpaid.filter(invoice => invoice.overdue).length;
  byId("invoice-summary").textContent = invoices.length
    ? `${unpaid.length} unpaid, ${money(owed)} outstanding${overdue ? `, ${overdue} overdue` : ""}.` : "";
  const list = byId("invoice-list");
  if (!visible.length) {
    list.replaceChildren(el("div", { className: "invoice-empty" },
      el("p", { textContent: invoices.length ? "No invoices match." : "No invoices yet." }),
      invoices.length ? null : el("p", { className: "sub", textContent: "Start one with New invoice, or from an appointment or a client record." })));
    return;
  }
  list.replaceChildren(...visible.map(invoice => {
    const row = el("a", { className: "invoice-row", href: `/admin/invoices?invoice=${encodeURIComponent(invoice.id)}` });
    row.onclick = event => { event.preventDefault(); openInvoice(invoice.id); };
    const state = invoice.status === "open" ? (invoice.overdue ? "overdue" : "open") : invoice.status;
    const pill = el("span", { className: "invoice-pill", textContent: invoice.overdue && invoice.status === "open" ? "Overdue" : statusLabels[invoice.status] });
    pill.dataset.state = state;
    row.append(
      el("span", { className: "invoice-row__main" },
        el("strong", { textContent: invoice.billTo }),
        el("span", { textContent: [`No. ${invoice.number}`, invoice.reference, invoice.status === "paid" ? `Issued ${shortDate(invoice.issueDate)}` : `Due ${shortDate(invoice.dueDate)}`].filter(Boolean).join(" · ") })),
      el("span", { className: "invoice-row__amount" },
        el("strong", { textContent: money(invoice.status === "open" ? invoice.balanceCents : invoice.totalCents) }), pill));
    return row;
  }));
}

async function loadList() {
  byId("invoice-summary").textContent = "Loading invoices…";
  try {
    ({ invoices } = await request("list"));
    renderList();
  } catch (error) {
    byId("invoice-summary").textContent = explain(error);
  }
}

// ---- Detail ----
async function downloadPdf(id, kind, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing PDF…";
  try {
    const { filename, pdf } = await request("pdf", { id, kind });
    const bytes = Uint8Array.from(atob(pdf), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = el("a", { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    byId("detail-status").textContent = `Downloaded ${filename}.`;
  } catch (error) {
    byId("detail-status").textContent = explain(error);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function renderDetail(invoice) {
  current = invoice;
  const { totals } = invoice;
  byId("detail-heading").textContent = `Invoice ${invoice.number}`;
  const host = byId("invoice-detail");
  const pill = el("span", { className: "invoice-pill", textContent: invoice.overdue ? "Overdue" : statusLabels[invoice.status] });
  pill.dataset.state = invoice.status === "open" && invoice.overdue ? "overdue" : invoice.status;

  const facts = el("dl", { className: "record-facts" });
  const fact = (label, value) => { if (value) facts.append(el("dt", { textContent: label }), el("dd", { textContent: value })); };
  fact("Bill to", [invoice.billTo.name, invoice.billTo.attention && `Attn: ${invoice.billTo.attention}`, invoice.billTo.address].filter(Boolean).join("\n"));
  fact("Email", invoice.billTo.email);
  fact("PO / reference", invoice.reference);
  fact("Invoice date", shortDate(invoice.issueDate));
  fact("Due", shortDate(invoice.dueDate));
  if (invoice.source?.appointmentId) {
    const dd = el("dd", {}, el("a", { href: `/admin/appointments?appointment=${encodeURIComponent(invoice.source.appointmentId)}`, textContent: "Open appointment" }));
    facts.append(el("dt", { textContent: "From" }), dd);
  }

  const lines = el("table", { className: "invoice-table" },
    el("thead", {}, el("tr", {}, el("th", { scope: "col", textContent: "Description" }), el("th", { scope: "col", textContent: "Qty" }), el("th", { scope: "col", textContent: "Amount" }))),
    el("tbody", {}, ...invoice.lines.map((line, index) => el("tr", {},
      el("td", { textContent: line.description }), el("td", { textContent: String(line.quantity) + (line.quantity !== 1 ? ` × ${money(line.unitCents)}` : "") }),
      el("td", { textContent: money(totals.lineCents[index]) })))));
  const sums = el("dl", { className: "invoice-totals" });
  const sum = (label, value, strong) => sums.append(el("dt", { textContent: label, className: strong ? "strong" : "" }), el("dd", { textContent: value, className: strong ? "strong" : "" }));
  sum("Subtotal", money(totals.subtotalCents));
  if (invoice.taxRateBasisPoints) sum(`Sales tax (${rateLabel(invoice.taxRateBasisPoints)})`, money(totals.taxCents));
  sum("Total", money(totals.totalCents), true);
  for (const credit of invoice.credits) sum(credit.description, "−" + money(credit.cents));
  for (const payment of invoice.payments) sum(`${methodLabels[payment.method] ?? payment.method}${payment.reference ? ` #${payment.reference}` : ""}, ${shortDate(payment.date)}`, "−" + money(payment.cents));
  sum(invoice.status === "paid" ? "Paid in full" : "Balance due", money(totals.balanceCents), true);

  const actions = el("div", { className: "appointment-actions record-primary" });
  if (invoice.status !== "void") {
    const pdf = el("button", { type: "button", className: "btn primary", textContent: "Download invoice PDF" });
    pdf.onclick = () => downloadPdf(invoice.id, "invoice", pdf);
    actions.append(pdf);
    if (invoice.payments.length) {
      const receipt = el("button", { type: "button", className: "btn " + (invoice.status === "paid" ? "primary" : "secondary"), textContent: "Download receipt PDF" });
      receipt.onclick = () => downloadPdf(invoice.id, "receipt", receipt);
      if (invoice.status === "paid") actions.prepend(receipt); else actions.append(receipt);
      if (invoice.status === "paid") pdf.className = "btn secondary";
    }
    const edit = el("button", { type: "button", className: "btn secondary", textContent: "Edit invoice" });
    edit.onclick = () => startEdit(invoice);
    actions.append(edit);
  }

  host.replaceChildren(el("div", { className: "invoice-head" }, pill, el("strong", { className: "invoice-head__due", textContent: money(invoice.status === "open" ? totals.balanceCents : totals.totalCents) })),
    actions, facts, lines, sums);
  if (invoice.status === "open") host.append(paymentForm(invoice));
  if (invoice.payments.length) host.append(paymentList(invoice));
  if (invoice.status !== "void") host.append(emailForm(invoice));
  host.append(moreActions(invoice));
}

function paymentForm(invoice) {
  const section = el("details", { className: "invoice-section", open: true });
  section.append(el("summary", { textContent: "Record a payment" }));
  const payment = el("form", { className: "invoice-payment", noValidate: true });
  payment.innerHTML = `
    <div class="appointment-fields">
      <label class="field"><span>Method</span><select name="method">${Object.entries(methodLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <label class="field" data-reference><span>Check number</span><input name="reference" maxlength="60" inputmode="numeric" autocomplete="off"></label>
    </div>
    <div class="appointment-fields">
      <label class="field"><span>Date received</span><input name="date" type="date" required></label>
      <label class="field"><span>Amount ($)</span><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required></label>
    </div>`;
  payment.elements.date.value = today();
  payment.elements.amount.value = (invoice.totals.balanceCents / 100).toFixed(2);
  const referenceLabel = payment.querySelector("[data-reference] span");
  payment.elements.method.onchange = () => {
    const method = payment.elements.method.value;
    referenceLabel.textContent = method === "check" ? "Check number" : "Reference (optional)";
    payment.elements.reference.inputMode = method === "check" ? "numeric" : "text";
  };
  let alsoAppointment = null;
  if (invoice.source?.appointmentId) {
    alsoAppointment = el("label", { className: "appointment-checkbox" }, el("input", { type: "checkbox", name: "alsoAppointment" }), " Also record it on the appointment’s balance");
    payment.append(alsoAppointment);
  }
  const submit = el("button", { type: "submit", className: "btn primary", textContent: "Mark payment received" });
  const status = el("p", { role: "status" });
  payment.append(submit, status);
  payment.onsubmit = async event => {
    event.preventDefault();
    const cents = toCents(payment.elements.amount.value);
    const method = payment.elements.method.value;
    const reference = payment.elements.reference.value.trim();
    if (!(cents > 0)) { status.textContent = "Enter the amount received."; return; }
    if (method === "check" && !reference) { status.textContent = messages.check_number_required; payment.elements.reference.focus(); return; }
    submit.disabled = true;
    status.textContent = "Saving…";
    try {
      const updated = await request("record-payment", { id: invoice.id, requestId: requestId(), method, reference, date: payment.elements.date.value, cents });
      let note = updated.status === "paid" ? "Marked paid. Your receipt is ready." : "Payment saved.";
      if (payment.elements.alsoAppointment?.checked) {
        try {
          await appointmentRequest("record-payment", {
            id: invoice.source.appointmentId, requestId: requestId(), method: ["check", "cash"].includes(method) ? method : "other",
            amountCents: cents, reference: [method === "check" && reference ? `Check #${reference}` : reference, `invoice ${invoice.number}`].filter(Boolean).join(", "),
          }, await auth.currentUser?.getIdToken());
          note += " Also recorded on the appointment.";
        } catch (error) {
          note += ` It wasn’t added to the appointment (${error.code === "invalid_payment" ? "more than its balance" : error.code === "checkout_active" ? "the job isn’t finished yet" : error.code === "check_pending" ? "a check there is still clearing" : "try it from the appointment"}).`;
        }
      }
      renderDetail(updated);
      byId("detail-status").textContent = note;
      loadList();
    } catch (error) {
      status.textContent = explain(error);
      submit.disabled = false;
    }
  };
  section.append(payment);
  return section;
}

function paymentList(invoice) {
  const section = el("details", { className: "invoice-section" });
  section.append(el("summary", { textContent: `Payments (${invoice.payments.length})` }));
  const list = el("ul", { className: "invoice-payments" });
  for (const payment of invoice.payments) {
    const remove = el("button", { type: "button", className: "btn secondary small", textContent: "Remove" });
    remove.onclick = async () => {
      if (remove.dataset.confirm !== "yes") { remove.dataset.confirm = "yes"; remove.textContent = "Tap again to remove"; return; }
      remove.disabled = true;
      try {
        renderDetail(await request("remove-payment", { id: invoice.id, paymentId: payment.id }));
        byId("detail-status").textContent = "Payment removed.";
        loadList();
      } catch (error) { byId("detail-status").textContent = explain(error); remove.disabled = false; }
    };
    list.append(el("li", {}, el("span", { textContent: `${methodLabels[payment.method] ?? payment.method}${payment.reference ? ` #${payment.reference}` : ""} · ${shortDate(payment.date)} · ${money(payment.cents)}` }), remove));
  }
  section.append(list);
  return section;
}

function emailForm(invoice) {
  const section = el("details", { className: "invoice-section" });
  section.append(el("summary", { textContent: "Email the PDF" }));
  const mail = el("form", { noValidate: true });
  const kinds = [["invoice", "Invoice"], ...(invoice.payments.length ? [["receipt", "Receipt"]] : [])];
  mail.innerHTML = `
    <div class="appointment-fields">
      <label class="field"><span>Send</span><select name="kind">${kinds.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <label class="field"><span>To</span><input name="to" type="email" maxlength="200" required autocomplete="off"></label>
    </div>
    <label class="field"><span>Message <small>Optional</small></span><textarea name="message" rows="2" maxlength="1000"></textarea></label>`;
  mail.elements.to.value = invoice.billTo.email || "";
  if (invoice.status === "paid" && invoice.payments.length) mail.elements.kind.value = "receipt";
  const submit = el("button", { type: "submit", className: "btn secondary", textContent: "Send email with PDF" });
  const status = el("p", { role: "status" });
  const sent = (invoice.emails ?? []).slice(-3).reverse().map(entry => `${entry.kind === "receipt" ? "Receipt" : "Invoice"} sent to ${entry.to} on ${new Date(entry.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
  mail.append(submit, status, ...sent.map(text => el("p", { className: "sub", textContent: text })));
  mail.onsubmit = async event => {
    event.preventDefault();
    const to = mail.elements.to.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { status.textContent = messages.invalid_email; return; }
    submit.disabled = true;
    status.textContent = "Sending…";
    try {
      const updated = await request("email", { id: invoice.id, kind: mail.elements.kind.value, to, message: mail.elements.message.value, requestId: requestId() });
      current = updated;
      status.textContent = `Sent to ${to}.`;
    } catch (error) {
      status.textContent = explain(error);
    } finally { submit.disabled = false; }
  };
  section.append(mail);
  return section;
}

function moreActions(invoice) {
  const section = el("details", { className: "invoice-section" });
  section.append(el("summary", { textContent: "More" }));
  const button = el("button", { type: "button", className: "btn secondary" });
  if (invoice.status === "void") {
    button.textContent = "Reopen invoice";
    button.onclick = () => change("reopen");
  } else {
    button.textContent = "Void invoice";
    button.onclick = () => {
      if (button.dataset.confirm !== "yes") { button.dataset.confirm = "yes"; button.textContent = "Tap again to void"; return; }
      change("void");
    };
  }
  const duplicate = el("button", { type: "button", className: "btn secondary", textContent: "Copy into a new invoice" });
  duplicate.onclick = () => startEdit({ ...invoice, id: null, number: null, issueDate: today(), dueDate: "", payments: [], reference: "" }, true);
  section.append(el("div", { className: "appointment-actions" }, button, duplicate),
    el("p", { className: "sub", textContent: "Voiding keeps the number on file so your invoice numbers stay in order." }));
  async function change(action) {
    button.disabled = true;
    try {
      renderDetail(await request(action, { id: invoice.id }));
      byId("detail-status").textContent = action === "void" ? "Invoice voided." : "Invoice reopened.";
      loadList();
    } catch (error) { byId("detail-status").textContent = explain(error); button.disabled = false; }
  }
  return section;
}

async function openInvoice(id) {
  show("detail");
  setUrl({ invoice: id });
  byId("detail-status").textContent = "Loading…";
  byId("invoice-detail").replaceChildren();
  try {
    renderDetail(await request("get", { id }));
    byId("detail-status").textContent = "";
    byId("detail-heading").focus({ preventScroll: true });
  } catch (error) {
    byId("detail-status").textContent = explain(error);
  }
}

// ---- Editor ----
function lineRow(line = { description: "", quantity: 1, unitCents: 0 }) {
  const row = el("div", { className: "invoice-line" });
  row.innerHTML = `
    <label class="field"><span class="sr-only">Description</span><input data-key="description" maxlength="300" placeholder="Description" autocomplete="off"></label>
    <label class="field"><span class="sr-only">Quantity</span><input data-key="quantity" placeholder="Qty" type="number" min="0.01" step="0.01" inputmode="decimal"></label>
    <label class="field"><span class="sr-only">Unit price in dollars</span><input data-key="unit" type="number" step="0.01" inputmode="decimal" placeholder="0.00"></label>
    <output class="invoice-line__amount"></output>
    <button type="button" class="invoice-line__remove" aria-label="Remove line">×</button>`;
  row.querySelector('[data-key="description"]').value = line.description;
  row.querySelector('[data-key="quantity"]').value = String(line.quantity);
  row.querySelector('[data-key="unit"]').value = line.unitCents ? (line.unitCents / 100).toFixed(2) : "";
  row.querySelector(".invoice-line__remove").onclick = () => {
    if (byId("line-items").children.length > 1) row.remove();
    else row.querySelectorAll("input").forEach(input => { input.value = input.dataset.key === "quantity" ? "1" : ""; });
    updateTotals();
  };
  return row;
}
function creditRow(credit = { description: "", cents: 0 }) {
  const row = el("div", { className: "invoice-credit" });
  row.innerHTML = `
    <label class="field"><span class="sr-only">Credit description</span><input data-key="description" maxlength="120" placeholder="Deposit paid" autocomplete="off"></label>
    <label class="field"><span class="sr-only">Credit amount in dollars</span><input data-key="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="0.00"></label>
    <button type="button" class="invoice-line__remove" aria-label="Remove credit">×</button>`;
  row.querySelector('[data-key="description"]').value = credit.description;
  row.querySelector('[data-key="amount"]').value = credit.cents ? (credit.cents / 100).toFixed(2) : "";
  row.querySelector(".invoice-line__remove").onclick = () => { row.remove(); updateTotals(); };
  return row;
}

function readDraft() {
  const f = form.elements;
  const lines = [...byId("line-items").children].map(row => ({
    description: row.querySelector('[data-key="description"]').value.trim(),
    quantity: Number(row.querySelector('[data-key="quantity"]').value),
    unitCents: toCents(row.querySelector('[data-key="unit"]').value || "0"),
  })).filter(line => line.description || line.unitCents);
  const credits = [...byId("credit-items").children].map(row => ({
    description: row.querySelector('[data-key="description"]').value.trim(),
    cents: toCents(row.querySelector('[data-key="amount"]').value || "0"),
  })).filter(credit => credit.description || credit.cents);
  const rate = Math.round(Number(f.taxRate.value) * 100);
  return {
    billTo: { name: f.billName.value, attention: f.billAttention.value, address: f.billAddress.value, email: f.billEmail.value, phone: f.billPhone.value },
    reference: f.reference.value, issueDate: f.issueDate.value, terms: f.terms.value, dueDate: f.dueDate.value,
    serviceDate: f.serviceDate.value, serviceDetail: f.serviceDetail.value, lines,
    taxRateBasisPoints: f.taxOn.checked && rate > 0 ? rate : 0, credits, notes: f.notes.value, receiptNote: editing?.receiptNote ?? "",
  };
}

function syncDueDate() {
  const f = form.elements;
  const days = TERMS[f.terms.value];
  f.dueDate.readOnly = days !== undefined;
  if (days !== undefined && f.issueDate.value) f.dueDate.value = addDays(f.issueDate.value, days);
}

function updateTotals() {
  const draft = readDraft();
  [...byId("line-items").children].forEach(row => {
    const quantity = Number(row.querySelector('[data-key="quantity"]').value) || 0;
    const unit = toCents(row.querySelector('[data-key="unit"]').value || "0") || 0;
    row.querySelector("output").textContent = money(Math.round(quantity * unit));
  });
  const subtotal = draft.lines.reduce((total, line) => total + Math.round((line.quantity || 0) * (line.unitCents || 0)), 0);
  const tax = Math.max(0, Math.round(subtotal * draft.taxRateBasisPoints / 10000));
  const credits = draft.credits.reduce((total, credit) => total + (credit.cents || 0), 0);
  const host = byId("edit-totals");
  const rows = [["Subtotal", money(subtotal)]];
  if (draft.taxRateBasisPoints) rows.push([`Sales tax (${rateLabel(draft.taxRateBasisPoints)})`, money(tax)]);
  rows.push(["Total", money(subtotal + tax), true]);
  if (credits) rows.push(["Credits", "−" + money(credits)]);
  rows.push(["Amount due", money(Math.max(0, subtotal + tax - credits)), true]);
  host.replaceChildren(...rows.flatMap(([label, value, strong]) => [el("dt", { textContent: label, className: strong ? "strong" : "" }), el("dd", { textContent: value, className: strong ? "strong" : "" })]));
}

function fillForm(draft) {
  const f = form.elements;
  f.billName.value = draft.billTo?.name ?? "";
  f.billAttention.value = draft.billTo?.attention ?? "";
  f.billAddress.value = draft.billTo?.address ?? "";
  f.billEmail.value = draft.billTo?.email ?? "";
  f.billPhone.value = draft.billTo?.phone ?? "";
  f.reference.value = draft.reference ?? "";
  f.issueDate.value = draft.issueDate || today();
  f.terms.value = draft.terms || settings?.defaultTerms || "net_30";
  f.dueDate.value = draft.dueDate || "";
  f.serviceDate.value = draft.serviceDate ?? "";
  f.serviceDetail.value = draft.serviceDetail ?? "";
  f.notes.value = draft.notes ?? "";
  f.taxOn.checked = (draft.taxRateBasisPoints ?? 0) > 0;
  f.taxRate.value = ((draft.taxRateBasisPoints || salesTax.rateBasisPoints || 700) / 100).toString();
  byId("tax-help").textContent = salesTax.enabled
    ? `Sales tax is on in your settings at ${rateLabel(salesTax.rateBasisPoints)}.`
    : `Sales tax is off in your settings, so new invoices start without it. Tick the box to add ${rateLabel(salesTax.rateBasisPoints)}.`;
  byId("line-items").replaceChildren(...(draft.lines?.length ? draft.lines : [undefined]).map(line => lineRow(line)));
  byId("credit-items").replaceChildren(...(draft.credits ?? []).map(credit => creditRow(credit)));
  syncDueDate();
  updateTotals();
}

function startEdit(invoice, copy = false) {
  editing = copy || !invoice.id ? { id: null, source: copy ? { kind: "custom", appointmentId: null, clientId: invoice.source?.clientId ?? null } : invoice.source, receiptNote: "" }
    : { id: invoice.id, updatedAt: invoice.updatedAt, source: invoice.source, receiptNote: invoice.receiptNote ?? "" };
  byId("edit-heading").textContent = editing.id ? `Edit invoice ${invoice.number}` : "New invoice";
  byId("edit-source").textContent = editing.id && invoice.payments?.length ? "Payments already recorded stay on this invoice." :
    editing.source?.kind === "appointment" ? "Filled in from the appointment. Change anything before saving." :
    editing.source?.kind === "client" ? "Filled in from the client record. Use the business name if a company is paying." : "";
  byId("edit-status").textContent = "";
  fillForm(invoice);
  returnTo = editing.id ? "detail" : "list";
  show("edit");
  form.elements.billName.focus({ preventScroll: true });
}

async function startNew(params = {}) {
  setUrl(params);
  byId("edit-status").textContent = "";
  try {
    const { draft, salesTax: tax } = await request("context", params);
    salesTax = tax;
    startEdit({ ...draft, id: null });
  } catch (error) {
    startEdit({ id: null, source: { kind: "custom", appointmentId: null, clientId: null }, lines: [], credits: [], taxRateBasisPoints: salesTax.enabled ? salesTax.rateBasisPoints : 0 });
    byId("edit-status").textContent = explain(error);
  }
}

form.addEventListener("input", event => {
  if (["terms", "issueDate"].includes(event.target.name)) syncDueDate();
  updateTotals();
});
form.addEventListener("change", event => { if (event.target.name === "terms") syncDueDate(); });
byId("add-line").onclick = () => { const row = lineRow(); byId("line-items").append(row); row.querySelector("input").focus(); updateTotals(); };
byId("add-credit").onclick = () => { const row = creditRow(); byId("credit-items").append(row); row.querySelector("input").focus(); };
byId("cancel-edit").onclick = () => {
  if (returnTo === "detail" && current) { show("detail"); setUrl({ invoice: current.id }); } else { show("list"); setUrl({}); }
};
form.onsubmit = async event => {
  event.preventDefault();
  const status = byId("edit-status");
  const submit = form.querySelector('[type="submit"]');
  const draft = readDraft();
  if (!draft.billTo.name.trim()) { status.textContent = messages.bill_to_required; form.elements.billName.focus(); return; }
  if (!draft.lines.length) { status.textContent = messages.lines_required; return; }
  if (draft.lines.some(line => !line.description || !(line.quantity > 0) || !Number.isFinite(line.unitCents))) { status.textContent = messages.invalid_line; return; }
  submit.disabled = true;
  status.textContent = "Saving…";
  try {
    const saved = editing.id
      ? await request("update", { id: editing.id, updatedAt: editing.updatedAt, draft })
      : await request("create", { requestId: editing.requestId ??= requestId(), source: editing.source, draft });
    editing = null;
    await loadList();
    show("detail");
    setUrl({ invoice: saved.id });
    renderDetail(saved);
    byId("detail-status").textContent = `Saved invoice ${saved.number}.`;
    byId("detail-heading").focus({ preventScroll: true });
  } catch (error) {
    status.textContent = explain(error);
  } finally { submit.disabled = false; }
};

// ---- Settings ----
function fillSettings() {
  for (const [key, value] of Object.entries(settings)) if (settingsForm.elements[key]) settingsForm.elements[key].value = value ?? "";
  byId("settings-tax").innerHTML = "";
  byId("settings-tax").append(`Sales tax is ${salesTax.enabled ? `on at ${rateLabel(salesTax.rateBasisPoints)}` : "off"}. New invoices start with that setting, and you can change it on each invoice. `,
    el("a", { href: "/admin/appointments", textContent: "Change it in Appointments settings" }), ".");
  byId("setup-notice").hidden = !!settings.mailingAddress;
}
settingsForm.onsubmit = async event => {
  event.preventDefault();
  const status = byId("settings-status");
  const body = Object.fromEntries([...new FormData(settingsForm)].map(([key, value]) => [key, String(value)]));
  status.textContent = "Saving…";
  try {
    ({ settings } = await request("save-settings", { ...body, revision: settings.revision }));
    fillSettings();
    status.textContent = "Saved.";
  } catch (error) { status.textContent = explain(error); }
};

// ---- Navigation and sign-in ----
for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (view === "edit") startNew();
    else if (view === "settings") { show("settings"); setUrl({}); }
    else { editing = null; show("list"); setUrl({}); renderList(); }
  });
}
byId("back-to-list").onclick = () => { show("list"); setUrl({}); renderList(); };
byId("invoice-filter").onchange = renderList;
byId("invoice-search").oninput = renderList;

signInButton.onclick = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch { authStatus.textContent = "Couldn’t sign in. Try again."; }
};
signOutButton.onclick = () => signOut(auth).catch(() => { authStatus.textContent = "Couldn’t sign out. Try again."; });

let started = false;
onAuthStateChanged(auth, async user => {
  workspace.hidden = true;
  signOutButton.hidden = !user;
  signInButton.hidden = !!user;
  authStatus.hidden = false;
  authStatus.textContent = user ? "Loading invoices…" : "Sign in to manage invoices.";
  if (!user) return;
  try {
    ({ settings, salesTax } = await request("settings"));
  } catch (error) {
    authStatus.textContent = explain(error);
    return;
  }
  fillSettings();
  authStatus.hidden = true;
  workspace.hidden = false;
  await loadList();
  if (started) return;
  started = true;
  const params = new URLSearchParams(location.search);
  if (params.get("invoice")) openInvoice(params.get("invoice"));
  else if (params.get("appointment")) startNew({ appointmentId: params.get("appointment") });
  else if (params.get("client")) startNew({ clientId: params.get("client") });
  else if (params.has("new")) startNew();
});
