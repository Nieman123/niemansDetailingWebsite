import { appointmentsEnabled, auth } from "./firebase-client.js";
import { appointmentRequest, appointmentMoney, appointmentTime } from "./appointment-utils.mjs";

const el = id => document.getElementById(id);
const form = el("public-booking");
const fields = form.elements;
const state = el("booking-state");
const retry = el("booking-retry");
const eastern = "America/New_York";
const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: eastern, year: "numeric", month: "2-digit", day: "2-digit" });
const time = new Intl.DateTimeFormat("en-US", { timeZone: eastern, hour: "numeric", minute: "2-digit" });
const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const noon = date => new Date(date + "T12:00:00Z");
const today = dateKey.format(Date.now());
const minMonth = today.slice(0, 7);
let maxMonth, options, quote, quoteReceipt, service, day, start;
let month = minMonth;
let slots = new Map();
let revision = 0;
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

function shiftMonth(offset) {
  const first = noon(month + "-01");
  first.setUTCMonth(first.getUTCMonth() + offset);
  return first.toISOString().slice(0, 7);
}
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
function drawDays() {
  const first = noon(month + "-01");
  const grid = el("days");
  grid.replaceChildren();
  for (let i = 0; i < first.getUTCDay(); i++) grid.append(document.createElement("span"));
  for (let n = 1; n <= 31; n++) {
    const key = month + "-" + String(n).padStart(2,"0");
    const date = noon(key);
    if (date.getUTCMonth() !== first.getUTCMonth()) break;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = n;
    button.disabled = !slots.has(key);
    button.dataset.day = key;
    button.setAttribute("aria-label", dayName.format(date) + (button.disabled ? ", unavailable" : ", available"));
    button.setAttribute("aria-pressed", String(day === key));
    if (today === key) button.setAttribute("aria-current", "date");
    grid.append(button);
  }
}
function drawTimes() {
  el("times").replaceChildren();
  el("slot-heading").textContent = day ? dayName.format(noon(day)) : "Available times";
  el("slot-note").textContent = day ? "Choose a start time · Eastern time" : "";
  for (const value of slots.get(day) || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.start = value;
    button.textContent = time.format(value);
    button.setAttribute("aria-pressed", String(value === start));
    el("times").append(button);
  }
}
async function loadMonth(preferred) {
  const version = ++revision;
  service = options.services.find(item => item.id === fields.serviceId.value);
  day = start = null;
  slots = new Map();
  el("pick-time").hidden = false;
  el("contact-step").hidden = true;
  el("month-title").textContent = monthName.format(noon(month + "-01"));
  el("prev-month").disabled = month <= minMonth;
  el("next-month").disabled = month >= maxMonth;
  retry.hidden = true;
  el("days").setAttribute("aria-busy","true");
  drawDays(); drawTimes(); showSummary();
  state.textContent = "Checking openings for " + el("month-title").textContent + "…";
  try {
    const result = await appointmentRequest("availability", { serviceId: service.id, month });
    if (version !== revision) return;
    for (const value of result.slots) {
      const key = dateKey.format(value);
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(value);
    }
    day = slots.has(preferred) ? preferred : slots.keys().next().value;
    drawDays(); drawTimes();
    state.textContent = slots.size ? "" : (month < maxMonth ? "No openings this month. Try the next month or a different service." : "No openings this month. Try another service or text Nieman.");
  } catch (error) {
    if (version !== revision) return;
    state.textContent = errors[error.code] || "The calendar couldn’t load. Try again.";
    retry.hidden = false;
  } finally { if (version === revision) el("days").removeAttribute("aria-busy"); }
}
el("days").onclick = event => {
  const key = event.target.closest("button")?.dataset.day;
  if (!slots.has(key)) return;
  day = key; start = null; drawDays(); drawTimes(); showSummary();
  el("days").querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
};
el("times").onclick = event => {
  const value = Number(event.target.closest("button")?.dataset.start);
  if (!slots.get(day)?.includes(value)) return;
  start = value; showSummary(); drawTimes();
  el("contact-time").textContent = el("summary-time").textContent;
  el("pick-time").hidden = true;
  el("contact-step").hidden = false;
  el("contact-heading").focus();
};
el("change-time").onclick = () => {
  if (saving) return;
  el("contact-step").hidden = true; el("pick-time").hidden = false;
  el("times").querySelector('[aria-pressed="true"]')?.focus();
};
el("prev-month").onclick = () => { if (month > minMonth) {month = shiftMonth(-1); loadMonth();} };
el("next-month").onclick = () => { if (month < maxMonth) {month = shiftMonth(1); loadMonth();} };
fields.serviceId.onchange = () => loadMonth();
retry.onclick = () => options?.enabled && service ? loadMonth() : begin();

async function begin() {
  retry.hidden = true;
  try {
    if (!appointmentsEnabled) {state.textContent = "Text Nieman to arrange a detail."; return;}
    options = await appointmentRequest("booking-options");
    if (!options.enabled || !options.services.length) {state.textContent = errors.booking_unavailable; return;}
    maxMonth = dateKey.format(Date.now() + options.horizonDays * 86400000).slice(0,7);
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
      await loadMonth(day);
      state.textContent = "That time was just taken. Choose another opening.";
      fields.serviceId.focus();
    } else el("reserve-state").textContent = errors[error.code] || "We couldn’t reserve this time. Your details are here so you can try again.";
  } finally {saving = button.disabled = false;}
};
begin();
