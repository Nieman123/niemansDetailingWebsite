import { appointmentMoney, appointmentRequest, appointmentTime, calendarFile, easternStart, googleCalendarUrl, taxRateLabel } from "./appointment-utils.mjs";

const byId = id => document.getElementById(id);
const status = byId("appointment-status");
const message = byId("appointment-message");
const returned = new URLSearchParams(location.search).get("checkout");
let fragment = location.hash;
if (!fragment) {
  try { fragment = sessionStorage.getItem("appointmentCheckoutReturn") ?? ""; } catch {}
}
const link = /^#([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(fragment);
if (link) {
  try { sessionStorage.setItem("appointmentCheckoutReturn", fragment); history.replaceState(null, "", location.pathname); } catch {}
}

const appointmentStatuses = {
  awaiting_deposit: "This time is on hold while the deposit is due.",
  pending_approval: "Deposit received. Nieman will review your appointment request.",
  confirmed: "Your appointment is confirmed.",
  in_progress: "Your detail is in progress.",
  completed: "Your detail is complete.",
  cancelled: "This appointment was cancelled.",
  no_show: "This appointment was marked as a no-show.",
};
const errors = {
  checkout_active: "A payment session is still open. Use its back link or wait for it to expire before cancelling.",
  checkout_finished: "Stripe has finished this session. Open your appointment again to check the result.",
  checkout_too_close: "The payment deadline is too close. Text Nieman to arrange a new time.",
  stripe_unavailable: "Online payments are currently unavailable. Please text Nieman.",
  calendar_unavailable: "We couldn't verify your appointment time right now. Try again in a few minutes.",
  time_unavailable: "This time needs to be reconfirmed. Please text Nieman before paying a deposit.",
  check_pending: "A check is pending clearance. Text Nieman for help with your balance.",
  status_changed: "The appointment status changed. Reopen your link for the latest details.",
  cancellation_terms_changed: "The cancellation terms changed. Reopen the appointment to review the latest terms.",
};
const statusLabels = {
  awaiting_deposit: "Deposit due", pending_approval: "Awaiting approval", confirmed: "Confirmed",
  in_progress: "In progress", completed: "Complete", cancelled: "Cancelled", no_show: "No-show",
};
let appointment;
let busy = false;

function render() {
  const { service, vehicle, address, estimateCents, finalCents, balanceCents, depositCents, paidDeposit, refundState } = appointment;
  status.textContent = appointmentStatuses[appointment.status] || "Appointment details";
  if (appointment.hasRescheduleRequest) status.textContent += " Your request for a new time is awaiting review.";
  byId("appointment-service").textContent = service;
  byId("appointment-time").textContent = appointmentTime(appointment);
  byId("appointment-when").textContent = appointmentTime(appointment);
  const badge = byId("appointment-badge");
  badge.textContent = statusLabels[appointment.status] || "";
  badge.dataset.status = appointment.status;
  badge.hidden = !badge.textContent;
  byId("appointment-address").textContent = address || "Nieman will text you to confirm the address.";
  byId("save-link-hint").hidden = appointment.hasEmail;
  byId("save-appointment-account").hidden = !appointment.hasEmail;
  byId("appointment-vehicle").textContent = vehicle;
  byId("vehicle-label").hidden = byId("appointment-vehicle").hidden = !vehicle;
  const price = finalCents ?? estimateCents;
  // Sales tax: the invoiced amount once the job is done, otherwise an estimate at the booking's rate.
  const tax = finalCents !== null ? appointment.taxCents ?? 0 : appointment.estimateTaxCents ?? 0;
  const final = finalCents !== null;
  byId("estimate-label").hidden = byId("appointment-estimate").hidden = price === null;
  byId("estimate-label").textContent = tax ? (final ? "Subtotal" : "Estimated subtotal") : final ? "Final total" : "Estimated total";
  if (price !== null) byId("appointment-estimate").textContent = appointmentMoney(price);
  byId("tax-label").hidden = byId("appointment-tax").hidden = byId("total-label").hidden = byId("appointment-total").hidden = !tax || price === null;
  if (tax && price !== null) {
    byId("tax-label").textContent = `${final ? "" : "Estimated "}Sales tax (${taxRateLabel(appointment.taxRateBasisPoints)})`;
    byId("appointment-tax").textContent = appointmentMoney(tax);
    byId("total-label").textContent = final ? "Final total" : "Estimated total";
    byId("appointment-total").textContent = appointmentMoney(price + tax) + (final && appointment.taxId ? ` · NC sales tax account ${appointment.taxId}` : "");
  }
  byId("balance-label").hidden = byId("appointment-balance").hidden = balanceCents === null;
  if (balanceCents !== null) {
    byId("appointment-balance").textContent = appointment.paymentUnderReview ? "Under review" : balanceCents ? appointmentMoney(balanceCents) : "Paid";
  }
  const invoiceLines = appointment.invoiceLines ?? [];
  byId("invoice-detail").hidden = !invoiceLines.length;
  byId("invoice-lines").replaceChildren(...invoiceLines.map(line =>
    Object.assign(document.createElement("li"), { textContent: `${line.description} · ${appointmentMoney(line.cents)}` })));
  const refunds = { queued: "Refund requested", pending: "Refund pending", succeeded: "Refund issued", failed: "Refund requires review" };
  byId("appointment-deposit").textContent = refunds[refundState] ||
    (paidDeposit ? `${appointmentMoney(paidDeposit)} received` : depositCents ? `${appointmentMoney(depositCents)} required` : "No deposit required");
  byId("appointment-preparation").textContent = appointment.preparation;
  byId("preparation").hidden = appointment.status === "cancelled" || !appointment.preparation;
  byId("appointment-details").hidden = false;
  byId("calendar-actions").hidden = appointment.status !== "confirmed";
  byId("google-calendar").href = googleCalendarUrl(appointment);
  const dueDeposit = appointment.status === "awaiting_deposit" && appointment.depositDeadline > Date.now();
  const dueBalance = appointment.status === "completed" && balanceCents >= 50;
  byId("payment-actions").hidden = appointment.paymentUnderReview || appointment.paymentPending || (!dueDeposit && !dueBalance);
  if (appointment.paymentUnderReview) status.textContent += " A payment is under review. Contact Nieman before paying again.";
  else if (appointment.paymentPending) status.textContent += " A check is pending clearance.";
  byId("payment-heading").textContent = dueDeposit ? `Pay ${appointmentMoney(depositCents)} deposit` : `Pay ${appointmentMoney(balanceCents)} balance`;
  byId("payment-policy").textContent = dueDeposit
    ? `${appointment.preapproved ? "Paying confirms this preapproved appointment. " : "Payment sends this appointment to Nieman for approval. "}${appointment.depositPolicy}`
    : "The final total and the amount already paid are shown above.";
  byId("manage-actions").hidden = !["awaiting_deposit", "pending_approval", "confirmed"].includes(appointment.status) || appointment.start <= Date.now();
  byId("request-move").hidden = appointment.status === "awaiting_deposit";
  const offer = appointment.alternateOffer;
  byId("alternate-offer").hidden = appointment.status !== "pending_approval" || !offer;
  if (offer) byId("alternate-time").textContent = `Nieman offered ${appointmentTime({ start: offer.start, end: offer.start + appointment.end - appointment.start })}.`;
}

function run(action, button) {
  return async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    button.disabled = true;
    message.textContent = "";
    try { await action(); }
    catch (error) { message.textContent = errors[error.code] || (error.code ? "The request could not be completed. Try again or text Nieman." : error.message); }
    finally { busy = false; button.disabled = false; }
  };
}

async function openAppointment() {
  if (!link) {
    status.textContent = "Open the appointment link Nieman sent you, or sign in to your account.";
    return;
  }
  const [, id, token] = link;
  const command = (name, body = {}) => appointmentRequest(name, { ...body, id, token });
  appointment = await command(returned === "complete" ? "recheck-payment" : "details");
  render();
  if (returned === "complete" && appointment.status === "awaiting_deposit") message.textContent = "Payment is being verified. Keep your appointment link to check again.";
  byId("download-calendar").onclick = () => {
    const file = new Blob([calendarFile(id, appointment)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(file);
    Object.assign(document.createElement("a"), { href: url, download: "detailing-appointment.ics" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  const pay = byId("pay-appointment");
  pay.onclick = run(async () => {
    if (!byId("accept-payment").checked) { message.textContent = "Accept the terms to continue."; return; }
    try { sessionStorage.setItem("appointmentCheckoutReturn", fragment); }
    catch { message.textContent = "Enable site storage so you can return from checkout."; return; }
    const { url } = await command("checkout", { accepted: true });
    location.assign(url);
  }, pay);
  const move = byId("request-move");
  move.onsubmit = run(async () => {
    appointment = await command("request-reschedule", { start: easternStart(move.elements.start.value) });
    render();
    message.textContent = "Request sent. Your current appointment time is still reserved.";
  }, move.querySelector("button"));
  const cancel = byId("cancel-appointment");
  cancel.onclick = run(async () => {
    const consequence = appointment.paidDeposit ?
      appointment.depositRefundable ? "Your deposit will be refunded." : "Your deposit is nonrefundable." : "";
    if (!confirm(`Cancel this appointment? ${consequence}`)) return;
    appointment = await command("customer-cancel", { accepted: true, expectedRefund: appointment.depositRefundable });
    render();
  }, cancel);
  const accept = byId("accept-alternate");
  accept.onclick = run(async () => {
    if (!appointment.alternateOffer || !confirm("Accept the proposed time and carry your deposit to it?")) return;
    appointment = await command("accept-alternate", { start: appointment.alternateOffer.start, accepted: true });
    render();
  }, accept);
  const account = byId("save-appointment-account");
  account.onclick = run(async () => {
    sessionStorage.setItem("appointmentAccountClaim", JSON.stringify({ id, token }));
    location.assign("/account");
  }, account);
  const copy = byId("copy-appointment-link");
  copy.onclick = run(async () => {
    await navigator.clipboard.writeText(`${location.origin}/appointment${fragment}`);
    message.textContent = "Appointment link copied.";
  }, copy);
}

openAppointment().catch(error => {
  status.textContent = error.code === "link_unavailable" || error.code === "not_found"
    ? "This link has expired or been replaced. Text Nieman for a fresh link."
    : "We couldn't load your appointment. Reopen the link to try again, or text Nieman.";
});
