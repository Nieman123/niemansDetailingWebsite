import { appointmentsEnabled, auth } from "./firebase-client.js";
import { slotPicker } from "./slot-picker.mjs";
import { servicePicker } from "./service-picker.mjs";
import { appointmentRequest, appointmentMoney, appointmentTime, durationLabel, taxRateLabel, vehicleLabels } from "./appointment-utils.mjs";
import { rememberBooking } from "./booking-analytics.mjs";
import { bookingExtras, priceRange } from "./booking-extras.mjs";

const el = id => document.getElementById(id);
const form = el("public-booking");
const fields = form.elements;
const state = el("booking-state");
const retry = el("booking-retry");
let options, quote, quoteReceipt, service, start, calendar, picker, extras;
let saving = false;
let reuseQuoteContact = false;
// A signed-in returning customer books without a deposit; the server decides and enforces it.
let depositWaived = false;
const makeToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
let token = makeToken();
const errors = {
  outside_service_area: "That ZIP is outside the online booking area. Text Nieman to check travel options.",
  existing_booking_hold: "You already have a time on hold. Use your appointment link or text Nieman for help.",
  invalid_details: "Enter your name, a 10-digit US phone number and a valid email address.",
  email_required: "Enter your email so we can send your confirmation and appointment link.",
  verified_email_required: "Please verify your account email or book while signed out.",
  calendar_unavailable: "We couldn’t check the calendars. Try again or text Nieman.",
  vehicle_required: "Select your vehicle size to see your estimate and book.",
  quote_contact_expired: "This quote link expired. Enter your current contact details to continue.",
  booking_unavailable: "Online booking is paused. Text Nieman for help.",
  invalid_items: "Check the services you added. Each vehicle needs at least one service.",
};

// Everything on this booking: the main service on the first vehicle, then any add-ons and other vehicles.
function bookingItems() {
  if (!service) return [];
  const vehicleType = fields.vehicleType.value;
  const main = { serviceId: service.id, vehicleIndex: 0, ...(vehicleType ? { vehicleType } : {}), vehicle: fields.vehicle.value.trim() };
  const added = (extras?.read() ?? []).map(row => row.vehicleIndex === 0 ? { ...row, ...(vehicleType ? { vehicleType } : {}), vehicle: main.vehicle } : row);
  return [main, ...added];
}
const serviceFor = item => options.services.find(entry => entry.id === item.serviceId);

function showStep(current) {
  el("booking-steps").querySelectorAll("li").forEach((item, index) => {
    item.classList.toggle("is-done", index < current);
    item.classList.toggle("is-current", index === current);
    if (index === current) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
  });
}

function setQuoteContact(reuse) {
  reuseQuoteContact = reuse;
  el("quote-contact").hidden = !reuse;
  el("contact-fields").hidden = reuse;
  fields.name.disabled = fields.phone.disabled = reuse;
  el("use-quote-contact").hidden = reuse || !quote?.phoneEnding;
  if (reuse) el("quote-contact-label").textContent = "We'll text the number from your quote ending in " + quote.phoneEnding + ".";
}
el("edit-quote-contact").onclick = () => { setQuoteContact(false); fields.name.focus(); };
el("use-quote-contact").onclick = () => { setQuoteContact(true); el("edit-quote-contact").focus(); };

function showSummary() {
  const vehicle = fields.vehicleType.value;
  const mainRange = priceRange(service);
  const quoted = quote?.service === service.id && quote.vehicle === vehicle && Number.isFinite(quote.estimateCents);
  const items = bookingItems();
  // Each service is priced for its vehicle's size; one without a size counts as its price range.
  const ranges = items.map((item, index) => index === 0 && quoted ? { min: quote.estimateCents, max: quote.estimateCents } : priceRange(serviceFor(item), item.vehicleType));
  const min = ranges.reduce((total, range) => total + range.min, 0), max = ranges.reduce((total, range) => total + range.max, 0);
  const estimate = min === max ? appointmentMoney(min) : appointmentMoney(min) + " to " + appointmentMoney(max);
  fields.vehicleType.required = mainRange.min !== mainRange.max || items.some(item => item.vehicleIndex === 0 && (() => { const range = priceRange(serviceFor(item)); return range.min !== range.max; })());
  const duration = items.reduce((total, item) => total + serviceFor(item).duration, 0);
  const several = new Set(items.map(item => item.vehicleIndex)).size > 1;
  const lines = el("summary-lines");
  lines.hidden = items.length < 2;
  lines.replaceChildren(...(items.length < 2 ? [] : items.map((item, index) => {
    const range = ranges[index];
    const name = serviceFor(item).name + (several ? ` (vehicle ${item.vehicleIndex + 1})` : "");
    const row = document.createElement("li");
    row.append(Object.assign(document.createElement("span"), { textContent: name }),
      Object.assign(document.createElement("span"), { textContent: range.min === range.max ? appointmentMoney(range.min) : "from " + appointmentMoney(range.min) }));
    return row;
  })));
  const length = durationLabel(duration);
  const deposit = depositWaived ? "No deposit" : appointmentMoney(options.depositCents);
  // Sales tax goes on the final invoice, so the estimate is shown before tax with the rate beside it.
  const taxRate = options.salesTax?.enabled ? options.salesTax.rateBasisPoints : 0;
  const plusTax = taxRate ? " + tax" : "";
  el("summary-tax-label").hidden = el("summary-tax").hidden = !taxRate;
  if (taxRate) el("summary-tax").textContent = taxRateLabel(taxRate) + " added to the final invoice";
  el("summary-service").textContent = items.length > 1 ? `${service.name} + ${items.length - 1} more` : service.name;
  el("summary-duration").textContent = length;
  el("summary-price").textContent = estimate;
  el("summary-deposit").textContent = deposit;
  const depositFact = depositWaived ? "no deposit (returning customer)" : deposit + " deposit";
  el("service-facts").textContent = length + " · " + estimate + plusTax + " estimated · " + depositFact;
  el("contact-cost").textContent = el("summary-service").textContent + " · " + estimate + plusTax + " estimated · " + depositFact;
  el("deposit-note").textContent = depositWaived
    ? "Welcome back! As a returning customer you don't need a deposit. Nieman reviews your request and texts to confirm."
    : "The deposit goes toward your total. Nieman reviews your request after payment and texts to confirm.";
  el("summary-time").textContent = start ? appointmentTime({ start, end: start + duration * 60000 }) : "Choose a date and start time.";
}
const vehicleChoices = [...document.querySelectorAll('[name="vehicleChoice"]')];
const syncVehicle = () => vehicleChoices.forEach(input => { input.checked = input.value === fields.vehicleType.value; });
vehicleChoices.forEach(input => input.addEventListener("change", () => {
  fields.vehicleType.value = input.value;
  fields.vehicleType.dispatchEvent(new Event("change"));
}));
const vehicleStep = el("booking-vehicle");
const extrasHint = Object.assign(document.createElement("p"), { id: "extras-hint", className: "picker-alert" });
extrasHint.setAttribute("role", "alert");
const vehicleHint = el("vehicle-selection-hint");
const calmMotion = matchMedia("(prefers-reduced-motion: reduce)");
vehicleChoices.forEach(input => input.setAttribute("aria-describedby", vehicleHint.id));

// A required step the customer skipped: bring it on screen, outline it, say what to do, and focus it.
// Programmatic focus after a tap shows no focus ring, so the outline comes from .is-missing instead.
function flagMissingStep(step, hint, message, focusTarget) {
  hint.textContent = message;
  step.classList.remove("is-missing");
  void step.offsetWidth; // restart the nudge if the customer taps a time again
  step.classList.add("is-missing");
  step.scrollIntoView({ block: "center", behavior: calmMotion.matches ? "auto" : "smooth" });
  focusTarget?.focus({ preventScroll: true });
}

fields.vehicleType.onchange = () => {
  vehicleHint.textContent = "";
  vehicleStep.classList.remove("is-missing");
  syncVehicle();
  picker?.refreshPrices();
  extras?.refresh();
  if (service) showSummary();
};

function getReceipt() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has("id") && hash.has("token")) {
    const receipt = { id: hash.get("id"), token: hash.get("token") };
    try {
      sessionStorage.setItem("quoteLeadReceipt", JSON.stringify(receipt));
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
    return receipt;
  }
  try { return JSON.parse(sessionStorage.getItem("quoteLeadReceipt") || "null"); } catch { return null; }
}

function loadMonth() {
  service = options.services.find(item => item.id === fields.serviceId.value);
  el("schedule-calendar").hidden = !service;
  el("booking-vehicle").hidden = false;
  el("service-facts").hidden = !service;
  el("schedule-summary").hidden = !service;
  el("booking-extras-field").hidden = !service || options.services.length < 2;
  extras?.refresh();
  if (!service) {
    state.textContent = "Choose a service to see available times.";
    return;
  }
  return calendar.load();
}
el("change-time").onclick = () => {
  if (saving) return;
  el("contact-step").hidden = true;
  el("pick-time").hidden = false;
  showStep(0);
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
    const receipt = getReceipt();
    if (receipt?.id && receipt.token) {
      try {
        quote = await appointmentRequest("quote-context", { quoteReceipt: receipt });
        if (quote) {
          quoteReceipt = receipt;
          if (options.services.some(service => service.id === quote.service)) fields.serviceId.value = quote.service;
          else {
            fields.serviceId.prepend(new Option("Choose a service", ""));
            fields.serviceId.value = "";
          }
          if (quote.vehicle) { fields.vehicleType.value = quote.vehicle; syncVehicle(); }
          setQuoteContact(!!quote.phoneEnding);
        }
      } catch {}
    }
    const featured = options.services.find(item => item.featured) ?? options.services[0];
    if (!quote && featured) fields.serviceId.value = featured.id;
    picker = servicePicker(el("service-picker"), fields.serviceId, options.services, { vehicle: () => fields.vehicleType.value });
    // Adding or removing a service changes the price and how long a slot has to be, so reload openings.
    extras = bookingExtras(el("booking-extras"), {
      services: options.services, mainService: () => service, mainSize: () => fields.vehicleType.value,
      onChange() {
        extrasHint.textContent = "";
        if (!service) return;
        showSummary();
        calendar?.load();
      },
    });
    el("booking-extras").after(extrasHint);
    await auth.authStateReady();
    if (auth.currentUser?.emailVerified) {
      fields.email.value = auth.currentUser.email || ""; fields.email.readOnly = true;
      try { depositWaived = (await appointmentRequest("deposit-status", {}, await auth.currentUser.getIdToken())).waived === true; } catch {}
    }
    el("public-policy").textContent = options.depositPolicy;
    form.hidden = false;
    calendar = slotPicker(el("pick-time"), {
      status: state, retry,
      getSlots: month => appointmentRequest("availability", { serviceId: service.id, serviceIds: bookingItems().map(item => item.serviceId), month }),
      empty: "No openings this month. Try another month or service, or text Nieman.",
      unavailable: error => errors[error.code] || "The calendar couldn't load. Try again.",
      onClear() {
        start = null;
        el("pick-time").hidden = false;
        el("contact-step").hidden = true;
        showStep(0);
        showSummary();
      },
      onSelect(value) {
        if (fields.vehicleType.required && !fields.vehicleType.value) {
          calendar.clearSelection();
          flagMissingStep(vehicleStep, vehicleHint, "Pick your vehicle type first, then choose your time.", vehicleChoices[0]);
          return;
        }
        const problem = extras?.problem();
        if (problem) {
          calendar.clearSelection();
          el("booking-extras-field").open = true;
          flagMissingStep(problem.node, extrasHint, problem.message, problem.focus);
          return;
        }
        start = value;
        showSummary();
        el("contact-time").textContent = el("summary-time").textContent;
        el("pick-time").hidden = true;
        el("contact-step").hidden = false;
        showStep(1);
        el("contact-heading").focus();
      },
    });
    calendar.setHorizon(options.horizonDays);
    await loadMonth();
  } catch {state.textContent = "Booking couldn’t load. Try again or text Nieman."; retry.hidden = false;}
}
fields.phone.oninput = () => fields.phone.setCustomValidity("");
// The browser can't focus an invalid field inside a closed <details> (the optional ZIP code), so open it first.
form.addEventListener("invalid", event => { const details = event.target.closest("details"); if (details) details.open = true; }, true);
form.onsubmit = async event => {
  event.preventDefault();
  if (!start || saving) return;
  if (!reuseQuoteContact && !/^1?\d{10}$/.test(fields.phone.value.replace(/\D/g,""))) {
    fields.phone.setCustomValidity("Enter a 10-digit US mobile number."); fields.phone.reportValidity(); return;
  }
  const button = form.querySelector("button[type=submit]");
  saving = button.disabled = true;
  el("reserve-state").textContent = "Holding your appointment time…";
  try {
    const bearer = auth.currentUser?.emailVerified ? await auth.currentUser.getIdToken() : undefined;
    const payload = Object.fromEntries(new FormData(form));
    payload.vehicle ||= vehicleLabels[payload.vehicleType] || "";
    const items = bookingItems();
    const result = await appointmentRequest("book", {
      ...payload, ...(items.length > 1 ? { items: items.map(item => item.vehicleIndex === 0 ? { ...item, vehicle: payload.vehicle } : item) } : {}), start, accepted: fields.accepted.checked, token, quoteReceipt, reuseQuoteContact,
    }, bearer);
    const fragment = "#" + result.id + "." + token;
    rememberBooking(result.id, result.estimateCents, result.service);
    if (!result.depositCents) {
      el("reserve-state").textContent = "Request sent.";
      location.assign("/appointment" + fragment);
      return;
    }
    el("reserve-state").textContent = "Opening payment.";
    showStep(2);
    try {
      sessionStorage.setItem("appointmentCheckoutReturn", fragment);
      const { url } = await appointmentRequest("checkout", { id: result.id, token, accepted: true });
      location.assign(url);
    } catch {
      location.assign("/appointment" + fragment);
    }
  } catch (error) {
    if (error.code === "time_unavailable") {
      token = makeToken(); el("reserve-state").textContent = "";
      await loadMonth();
      state.textContent = "That time was just taken. Choose another opening.";
      state.focus();
    } else {
      if (error.code === "quote_contact_expired") { quote = null; quoteReceipt = null; setQuoteContact(false); showSummary(); fields.name.focus(); }
      el("reserve-state").textContent = errors[error.code] || "We couldn’t reserve this time. Your details are here so you can try again.";
    }
  } finally {saving = button.disabled = false;}
};
begin();
