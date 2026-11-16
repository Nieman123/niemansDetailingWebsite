import { appointmentsEnabled, auth } from "./firebase-client.js";
import { appointmentRequest, appointmentMoney, appointmentTime } from "./appointment-utils.mjs";

const state = document.getElementById("booking-state");
const form = document.getElementById("public-booking");
const fields = form.elements;
const times = document.getElementById("check-times");
const submit = form.querySelector("button[type=submit]");
const errors = {
  time_unavailable: "That time is no longer available. Check the date again.",
  calendar_unavailable: "Calendar availability is temporarily unavailable. Try again or text Nieman.",
  outside_service_area: "Online booking is unavailable for that ZIP code. Text Nieman to check travel options.",
  verified_email_required: "Verify your email before booking through your account.",
  booking_unavailable: "Online booking is temporarily unavailable. Text Nieman to arrange your detail.",
  existing_booking_hold: "An appointment is already on hold for this email. Use the original link or wait for it to expire.",
};
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
let token = randomToken();
let options;
let quoteReceipt;
let quote;
let lookup = 0;

function showPrice() {
  const service = options?.services.find(item => item.id === fields.serviceId.value);
  const cents = service && quote?.service === service.id && typeof quote.quoted_total === "number" ? Math.round(quote.quoted_total * 100) : service?.cents;
  document.getElementById("public-estimate").textContent = cents == null ? "" : `Estimated service total ${appointmentMoney(cents)}. Deposit ${appointmentMoney(options.depositCents)}.`;
}

function resetTimes() {
  lookup++;
  fields.start.replaceChildren(new Option("Check times for this date", ""));
  showPrice();
}

async function begin() {
  if (!appointmentsEnabled) { state.textContent = "Online appointment requests are currently available on staging."; return; }
  options = await appointmentRequest("booking-options");
  if (!options.enabled) { state.textContent = "Online booking is paused. Text Nieman to arrange your detail."; return; }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const day = value => {
    const parts = Object.fromEntries(formatter.formatToParts(value).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  fields.date.min = day(Date.now());
  fields.date.max = day(Date.now() + options.horizonDays * 86_400_000);
  fields.date.value = fields.date.min;
  fields.serviceId.replaceChildren(...options.services.map(service => new Option(service.name, service.id)));
  try {
    const receipt = JSON.parse(sessionStorage.getItem("quoteLeadReceipt") || "null");
    if (receipt?.id && receipt?.token) {
      const response = await fetch("/api/leadOptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...receipt, action: "read" }) });
      const result = await response.json();
      if (result.ok) {
        quoteReceipt = receipt;
        quote = result;
        if (options.services.some(item => item.id === quote.service)) fields.serviceId.value = quote.service;
        fields.vehicle.value = ({ sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "Van / 3-row SUV" })[quote.vehicle] || "";
      }
    }
  } catch {}
  await auth.authStateReady();
  if (auth.currentUser?.emailVerified && auth.currentUser.email) {
    fields.email.value = auth.currentUser.email;
    fields.email.readOnly = true;
  }
  resetTimes();
  document.getElementById("public-policy").textContent = `Payment sends your request for approval. ${options.depositPolicy}`;
  state.textContent = "Choose your service and check available times.";
  form.hidden = false;
}

fields.serviceId.onchange = fields.date.onchange = resetTimes;
times.onclick = async () => {
  if (!fields.date.reportValidity()) return;
  const version = ++lookup;
  const serviceId = fields.serviceId.value;
  const date = fields.date.value;
  times.disabled = true;
  state.textContent = "Checking calendars…";
  try {
    const result = await appointmentRequest("availability", { serviceId, date });
    if (version !== lookup) return;
    const service = options.services.find(item => item.id === serviceId);
    fields.start.replaceChildren(new Option("Choose a start time", ""), ...result.slots.map(start =>
      new Option(appointmentTime({ start, end: start + service.duration * 60_000 }), String(start))));
    state.textContent = result.slots.length ? "Choose an available time." : "No times are available on this date.";
  } catch (error) { if (version === lookup) state.textContent = errors[error.code] || "Couldn't check times. Try again."; }
  finally { times.disabled = false; }
};
form.onsubmit = async event => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  state.textContent = "Reserving your appointment…";
  try {
    const data = Object.fromEntries(new FormData(form));
    const bearer = auth.currentUser?.emailVerified ? await auth.currentUser.getIdToken() : undefined;
    const result = await appointmentRequest("book", { ...data, start: Number(data.start), accepted: fields.accepted.checked, token, quoteReceipt }, bearer);
    location.assign(`/appointment#${result.id}.${token}`);
  } catch (error) {
    if (error.code === "time_unavailable") { resetTimes(); token = randomToken(); }
    state.textContent = errors[error.code] || "The appointment could not be reserved. Check your details and try again.";
    submit.disabled = false;
  }
};
begin().catch(() => { state.textContent = "Online booking couldn't load. Text Nieman to arrange your detail."; });
