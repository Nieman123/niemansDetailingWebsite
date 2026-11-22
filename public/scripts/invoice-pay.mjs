// Customer invoice page. Opened from a short /i/<code> link in an invoice or reminder email, or /pay#<id>.<token>.
import { tipPicker } from "./tip-picker.mjs";

const byId = id => document.getElementById(id);
const status = byId("pay-status");
const message = byId("pay-message");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = cents => dollars.format(cents / 100);
const longDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "")
  ? new Date(value + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }) : "";
const rateLabel = basisPoints => `${(basisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const RETURN_KEY = "invoicePayReturn";
const returned = new URLSearchParams(location.search).get("checkout");

const errors = {
  link_unavailable: "This link has expired or isn't valid. Text Nieman for a fresh one.",
  stripe_unavailable: "Online payments aren't available right now. Text Nieman and he'll help you pay another way.",
  online_payments_off: "Online payments are turned off for this invoice. Text Nieman to pay another way.",
  already_paid: "This invoice is already paid. Thank you!",
  invoice_void: "This invoice was cancelled, so there's nothing to pay.",
  nothing_due: "There's nothing left to pay on this invoice.",
  invalid_tip: "That tip amount doesn't work. Pick another amount, up to the amount due.",
  checkout_active: "A payment is already in progress. Wait a minute, then reload this page.",
  checkout_finished: "That payment just finished. Reload the page to see the latest.",
};
const explain = error => errors[error?.code] || "Something went wrong. Reload the page to try again, or text Nieman.";

async function request(action, body) {
  const response = await fetch(`/api/pay/${action}`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.error || "pay_operation_failed");
    error.code = data?.error;
    throw error;
  }
  return data.result;
}

// Find the invoice ID and token: from a short link, the URL fragment, or the tab we left for Stripe.
async function linkParts() {
  const code = /^\/i\/([A-Za-z0-9]{10})\/?$/.exec(location.pathname)?.[1];
  let fragment = location.hash;
  if (code) {
    const { id, token } = await request("resolve", { code });
    fragment = `#${id}.${token}`;
  } else if (!fragment) {
    try { fragment = sessionStorage.getItem(RETURN_KEY) ?? ""; } catch {}
  }
  const match = /^#([\w-]{1,128})\.([a-f0-9]{64})$/.exec(fragment);
  if (!match) { const error = new Error("link_unavailable"); error.code = "link_unavailable"; throw error; }
  try { sessionStorage.setItem(RETURN_KEY, fragment); } catch {}
  if (!code) history.replaceState(null, "", location.pathname);
  return { id: match[1], token: match[2] };
}

let invoice;
let tips = null;
let tipsFor = null;

function render() {
  const { totals } = invoice;
  const state = invoice.status === "open" ? (invoice.overdue ? "overdue" : "open") : invoice.status;
  const badge = byId("invoice-badge");
  badge.dataset.status = state;
  badge.textContent = { open: "Unpaid", overdue: "Past due", paid: "Paid", void: "Cancelled" }[state];
  byId("invoice-title").textContent = `Invoice ${invoice.number}`;
  byId("invoice-for").textContent = [invoice.billTo, invoice.reference].filter(Boolean).join(" · ");
  const due = byId("invoice").querySelector(".pay-due");
  due.dataset.state = state;
  byId("due-label").textContent = invoice.status === "paid" ? "Paid in full" : invoice.status === "void" ? "Cancelled" : "Amount due";
  byId("due-amount").textContent = money(invoice.status === "paid" ? totals.totalCents - totals.creditCents : totals.balanceCents);
  byId("due-date").textContent = invoice.status === "open" ? `${invoice.overdue ? "Was due" : "Due"} ${longDate(invoice.dueDate)}` : "";

  const facts = byId("invoice-facts");
  const fact = (label, value) => { if (value) facts.append(Object.assign(document.createElement("dt"), { textContent: label }), Object.assign(document.createElement("dd"), { textContent: value })); };
  facts.replaceChildren();
  fact("From", invoice.business.name);
  fact("Invoice date", longDate(invoice.issueDate));
  fact("Service date", longDate(invoice.serviceDate));
  fact("Due", longDate(invoice.dueDate));

  byId("invoice-lines").tBodies[0].replaceChildren(...invoice.lines.map(line => {
    const row = document.createElement("tr");
    const description = document.createElement("td");
    description.append(line.description);
    if (line.quantity !== 1) description.append(Object.assign(document.createElement("small"), { textContent: `${line.quantity} × ${money(line.unitCents)}` }));
    row.append(description, Object.assign(document.createElement("td"), { textContent: money(line.cents) }));
    return row;
  }));
  const sums = byId("invoice-totals");
  const sum = (label, value, strong) => sums.append(
    Object.assign(document.createElement("dt"), { textContent: label, className: strong ? "strong" : "" }),
    Object.assign(document.createElement("dd"), { textContent: value, className: strong ? "strong" : "" }));
  sums.replaceChildren();
  sum("Subtotal", money(totals.subtotalCents));
  if (invoice.taxRateBasisPoints) sum(`Sales tax (${rateLabel(invoice.taxRateBasisPoints)})`, money(totals.taxCents));
  sum("Total", money(totals.totalCents), true);
  for (const credit of invoice.credits) sum(credit.description, "−" + money(credit.cents));
  for (const payment of invoice.payments) {
    sum(`${payment.label}, ${longDate(payment.date)}`, "−" + money(payment.cents));
    if (payment.tipCents) sum("Tip (thank you!)", money(payment.tipCents));
  }
  if (invoice.status !== "void") sum(invoice.status === "paid" ? "Balance" : "Balance due", money(totals.balanceCents), true);
  byId("download-receipt").hidden = !invoice.payments.length;
  byId("download-invoice").hidden = invoice.status === "void";

  const payable = invoice.status === "open" && invoice.payOnline;
  byId("pay-online").hidden = !payable;
  if (payable) {
    const button = byId("pay-button");
    const label = tip => { button.textContent = `Pay ${money(totals.balanceCents + tip)}`; };
    byId("tip-options").hidden = !invoice.tips;
    if (invoice.tips && tipsFor === totals.balanceCents) label(tips.tipCents);
    else if (invoice.tips) {
      tipsFor = totals.balanceCents;
      tips = tipPicker(byId("tip-picker"), {
        baseCents: totals.subtotalCents, maxCents: invoice.maxTipCents,
        onChange: tip => {
          label(tip);
          byId("tip-total").hidden = !tip;
          byId("tip-total").textContent = `${money(totals.balanceCents)} invoice + ${money(tip)} tip`;
        },
      });
    } else { tips = null; label(0); }
  }
  if (invoice.status === "paid") status.textContent = returned === "complete" ? "Payment received. Thank you! A receipt is on its way to your email." : "This invoice is paid. Thank you!";
  else if (invoice.status === "void") status.textContent = "This invoice was cancelled. There's nothing to pay.";
  else if (returned === "complete") status.textContent = "Your payment is processing. This page will update in a moment.";
  else if (invoice.status === "open" && !invoice.payOnline) status.textContent = `Questions about this invoice? Text or call ${invoice.business.phone || "Nieman"}.`;
  else status.textContent = invoice.overdue ? "This invoice is past due. You can pay it securely by card below." : "You can pay this invoice securely by card below.";
  byId("invoice").hidden = false;
}

async function download(link, kind, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Preparing PDF…";
  try {
    const { filename, pdf } = await request("pdf", { ...link, kind });
    const bytes = Uint8Array.from(atob(pdf), char => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const anchor = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) { message.textContent = explain(error); }
  finally { button.disabled = false; button.textContent = label; }
}

async function open() {
  const link = await linkParts();
  invoice = await request("details", link);
  render();
  // Back from Stripe before the webhook landed: check again a few times.
  if (returned === "complete" && invoice.status === "open") {
    for (const wait of [2000, 4000, 8000]) {
      await new Promise(resolve => setTimeout(resolve, wait));
      invoice = await request("details", link).catch(() => invoice);
      render();
      if (invoice.status !== "open") break;
    }
  }
  const pay = byId("pay-button");
  pay.onclick = async () => {
    if (tips?.overMax) { message.textContent = "A tip can be up to the amount due."; return; }
    pay.disabled = true;
    message.textContent = "Opening secure checkout…";
    try {
      const { url } = await request("checkout", { ...link, tipCents: tips?.tipCents ?? 0 });
      location.assign(url);
    } catch (error) {
      message.textContent = explain(error);
      pay.disabled = false;
    }
  };
  byId("download-invoice").onclick = () => download(link, "invoice", byId("download-invoice"));
  byId("download-receipt").onclick = () => download(link, "receipt", byId("download-receipt"));
}

open().catch(error => { status.textContent = explain(error); });
