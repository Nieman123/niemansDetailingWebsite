import { appointmentsEnabled, auth } from "./firebase-client.js";
import { slotPicker } from "./slot-picker.mjs";
import { appointmentRequest, appointmentMoney, appointmentTime } from "./appointment-utils.mjs";

const el = id => document.getElementById(id);
const form = el("public-booking");
const fields = form.elements;
const state = el("booking-state");
const retry = el("booking-retry");
let options, quote, quoteReceipt, service, start, calendar;
let saving = false;
const makeToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
let token = makeToken();
const errors = {
  outside_service_area: "That ZIP is outside the online booking area. Text Nieman to check travel options.",
  existing_booking_hold: "You already have a time on hold. Use your appointment link or text Nieman for help.",
  invalid_details: "Enter your name and a 10-digit US phone number. Check your email if you included one.",
  verified_email_required: "Please verify your account email or book while signed out.",
  calendar_unavailable: "We couldn’t check the calendars. Try again or text Nieman.",
  booking_unavailable: "Online booking is paused. Text Nieman for help."
};

function showSummary() {
  const quoted = quote?.service === service.id && Number.isFinite(quote.quoted_total);
  el("summary-service").textContent = service.name;
  const hours = Math.floor(service.duration / 60), minutes = service.duration % 60;
  el("summary-duration").textContent = [hours && hours + (hours === 1 ? " hour" : " hours"), minutes && minutes + " min"].filter(Boolean).join(" ");
  el("summary-price").textContent = appointmentMoney(quoted ? Math.round(quote.quoted_total * 100) : service.cents);
  el("summary-deposit").textContent = appointmentMoney(options.depositCents);
  el("service-facts").textContent = el("summary-duration").textContent + " · " + el("summary-price").textContent + " estimated · " + el("summary-deposit").textContent + " deposit";
  el("contact-cost").textContent = service.name + " · " + el("summary-price").textContent + " estimated · " + el("summary-deposit").textContent + " deposit";
  el("summary-time").textContent = start ? appointmentTime({start, end: start + service.duration * 60000}) : "Choose a date and start time.";
}
function loadMonth() {
  service = options.services.find(item => item.id === fields.serviceId.value);
  return calendar.load();
}
el("change-time").onclick = () => {
  if (saving) return;
  el("contact-step").hidden = true;
  el("pick-time").hidden = false;
  calendar.focusTime();
};
fields.serviceId.onchange = loadMonth;
retry.onclick = begin;

async function begin() {
  retry.hidden = true;
  try {
    if (!appointmentsEnabled) {state.textContent = "Text Nieman to arrange a detail."; return;}
    options = await appointmentRequest("booking-options");
    if (!options.enabled || !options.services.length) {state.textContent = errors.booking_unavailable; return;}
    fields.serviceId.replaceChildren(...options.services.map(s => new Option(s.name, s.id)));
    try {
      const receipt = JSON.parse(sessionStorage.getItem("quoteLeadReceipt") || "null");
      if (receipt?.id && receipt.token) {
        const response = await fetch("/api/leadOptions", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({...receipt,action:"read"})});
        const result = await response.json();
        if (result.ok) {
          quoteReceipt = receipt; quote = result;
          if (options.services.some(s => s.id === quote.service)) fields.serviceId.value = quote.service;
          fields.vehicle.value = ({sedan:"Sedan / coupe", suv_truck:"SUV / truck", van_3row:"Van / 3-row SUV"})[quote.vehicle] || "";
        }
      }
    } catch {}
    await auth.authStateReady();
    if (auth.currentUser?.emailVerified) { fields.email.value = auth.currentUser.email || ""; fields.email.readOnly = true; }
    el("public-policy").textContent = options.depositPolicy;
    form.hidden = false;
    calendar = slotPicker(el("pick-time"), {
      status: state, retry,
      getSlots: month => appointmentRequest("availability", { serviceId: service.id, month }),
      empty: "No openings this month. Try another month or service, or text Nieman.",
      unavailable: error => errors[error.code] || "The calendar couldn't load. Try again.",
      onClear() {
        start = null;
        el("pick-time").hidden = false;
        el("contact-step").hidden = true;
        showSummary();
      },
      onSelect(value) {
        start = value;
        showSummary();
        el("contact-time").textContent = el("summary-time").textContent;
        el("pick-time").hidden = true;
        el("contact-step").hidden = false;
        el("contact-heading").focus();
      },
    });
    calendar.setHorizon(options.horizonDays);
    await loadMonth();
  } catch {state.textContent = "Booking couldn’t load. Try again or text Nieman."; retry.hidden = false;}
}
fields.phone.oninput = () => fields.phone.setCustomValidity("");
form.onsubmit = async event => {
  event.preventDefault();
  if (!start || saving) return;
  if (!/^1?\d{10}$/.test(fields.phone.value.replace(/\D/g,""))) {
    fields.phone.setCustomValidity("Enter a 10-digit US mobile number."); fields.phone.reportValidity(); return;
  }
  const button = form.querySelector("button[type=submit]");
  saving = button.disabled = true;
  el("reserve-state").textContent = "Holding your appointment time…";
  try {
    const bearer = auth.currentUser?.emailVerified ? await auth.currentUser.getIdToken() : undefined;
    const result = await appointmentRequest("book", {...Object.fromEntries(new FormData(form)), start, accepted:fields.accepted.checked, token, quoteReceipt}, bearer);
    location.assign("/appointment#" + result.id + "." + token);
  } catch (error) {
    if (error.code === "time_unavailable") {
      token = makeToken(); el("reserve-state").textContent = "";
      await loadMonth();
      state.textContent = "That time was just taken. Choose another opening.";
      fields.serviceId.focus();
    } else el("reserve-state").textContent = errors[error.code] || "We couldn’t reserve this time. Your details are here so you can try again.";
  } finally {saving = button.disabled = false;}
};
begin();
