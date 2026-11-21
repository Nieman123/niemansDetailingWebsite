import { appointmentsEnabled, auth } from "./firebase-client.js";
import { slotPicker } from "./slot-picker.mjs";
import { servicePicker } from "./service-picker.mjs";
import { appointmentRequest, appointmentMoney, appointmentTime, durationLabel, taxRateLabel, vehicleLabels } from "./appointment-utils.mjs";
import { rememberBooking } from "./booking-analytics.mjs";

const el = id => document.getElementById(id);
const form = el("public-booking");
const fields = form.elements;
const state = el("booking-state");
const retry = el("booking-retry");
let options, quote, quoteReceipt, service, start, calendar, picker;
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
  booking_unavailable: "Online booking is paused. Text Nieman for help."
};

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
  const prices = service.vehiclePrices ?? { sedan: service.cents, suv_truck: service.cents, van_3row: service.cents };
  const tiers = Object.values(prices);
  const min = Math.min(...tiers), max = Math.max(...tiers);
  const quoted = quote?.service === service.id && quote.vehicle === vehicle && Number.isFinite(quote.estimateCents);
  const estimate = quoted ? appointmentMoney(quote.estimateCents) : vehicle || min === max
    ? appointmentMoney(prices[vehicle] ?? min) : appointmentMoney(min) + " to " + appointmentMoney(max);
  fields.vehicleType.required = min !== max;
  const duration = service.duration;
  const length = durationLabel(duration);
  const deposit = depositWaived ? "No deposit" : appointmentMoney(options.depositCents);
  // Sales tax goes on the final invoice, so the estimate is shown before tax with the rate beside it.
  const taxRate = options.salesTax?.enabled ? options.salesTax.rateBasisPoints : 0;
  const plusTax = taxRate ? " + tax" : "";
  el("summary-tax-label").hidden = el("summary-tax").hidden = !taxRate;
  if (taxRate) el("summary-tax").textContent = taxRateLabel(taxRate) + " added to the final invoice";
  el("summary-service").textContent = service.name;
  el("summary-duration").textContent = length;
  el("summary-price").textContent = estimate;
  el("summary-deposit").textContent = deposit;
  const depositFact = depositWaived ? "no deposit (returning customer)" : deposit + " deposit";
  el("service-facts").textContent = length + " · " + estimate + plusTax + " estimated · " + depositFact;
  el("contact-cost").textContent = service.name + " · " + estimate + plusTax + " estimated · " + depositFact;
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
fields.vehicleType.onchange = () => {
  el("vehicle-selection-hint").textContent = "";
  syncVehicle();
  picker?.refreshPrices();
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
    await auth.authStateReady();
    if (auth.currentUser?.emailVerified) {
      fields.email.value = auth.currentUser.email || ""; fields.email.readOnly = true;
      try { depositWaived = (await appointmentRequest("deposit-status", {}, await auth.currentUser.getIdToken())).waived === true; } catch {}
    }
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
        showStep(0);
        showSummary();
      },
      onSelect(value) {
        if (fields.vehicleType.required && !fields.vehicleType.value) {
          calendar.clearSelection();
          el("vehicle-selection-hint").textContent = errors.vehicle_required;
          vehicleChoices[0]?.focus();
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
    const result = await appointmentRequest("book", {
      ...payload, start, accepted: fields.accepted.checked, token, quoteReceipt, reuseQuoteContact,
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
      fields.serviceId.focus();
    } else {
      if (error.code === "quote_contact_expired") { quote = null; quoteReceipt = null; setQuoteContact(false); showSummary(); fields.name.focus(); }
      el("reserve-state").textContent = errors[error.code] || "We couldn’t reserve this time. Your details are here so you can try again.";
    }
  } finally {saving = button.disabled = false;}
};
begin();
