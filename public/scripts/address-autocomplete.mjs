// Google-style address suggestions for any <input data-address-autocomplete>
// (or <textarea data-address-autocomplete="multiline">, which fills "Street\nCity, ST ZIP").
// Uses Places API (New) through the Maps JavaScript API and renders its own dark dropdown,
// so the input stays a normal text field that existing form code reads. If Google can't
// load (blocked key, offline), the field simply works as plain text.
import { mapsApiKey } from "./maps-config.mjs";

const ASHEVILLE = { lat: 35.5951, lng: -82.5515 };
let placesLibrary;

function loadPlaces() {
  if (placesLibrary) return placesLibrary;
  placesLibrary = new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) return resolve(window.google.maps.importLibrary("places"));
    const callback = "__ndMapsReady" + Math.random().toString(36).slice(2);
    window[callback] = () => { delete window[callback]; resolve(window.google.maps.importLibrary("places")); };
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsApiKey)}&loading=async&v=weekly&callback=${callback}`;
    script.async = true;
    script.onerror = () => reject(new Error("maps_unavailable"));
    document.head.append(script);
  });
  return placesLibrary;
}

let stylesAdded = false;
function addStyles() {
  if (stylesAdded) return;
  stylesAdded = true;
  const style = document.createElement("style");
  style.textContent = `
.address-ac { position: relative; }
.address-ac__list {
  position: absolute; z-index: 60; left: 0; right: 0; top: calc(100% + 6px); margin: 0; padding: 6px; list-style: none;
  max-height: 320px; overflow-y: auto; border: 1px solid var(--nd-gold-line, rgba(228,187,92,.45)); border-radius: 14px;
  background: var(--nd-surface, #16132a); box-shadow: 0 18px 40px rgba(0,0,0,.55);
}
.address-ac__item {
  display: grid; gap: 2px; padding: 10px 12px; border-radius: 10px; cursor: pointer;
  color: var(--nd-text, #f5f2fb); font: 500 15px/1.35 var(--nd-font-sans, system-ui, sans-serif);
}
.address-ac__item small { color: var(--nd-text-2, #c9c3da); font-size: 13px; font-weight: 400; }
.address-ac__item[aria-selected="true"], .address-ac__item:hover { background: var(--nd-purple-tint, rgba(124,82,255,.16)); }
.address-ac__item[aria-selected="true"] { box-shadow: inset 3px 0 0 var(--nd-gold, #e4bb5c); }
.address-ac__credit { padding: 6px 12px 2px; color: var(--nd-muted, #a59fba); font: 400 11px/1.2 var(--nd-font-sans, system-ui, sans-serif); text-align: right; }
`;
  document.head.append(style);
}

function componentFiller(input) {
  // Fill sibling city / state / ZIP fields when a form has them.
  const scope = input.form ?? input.closest("[data-address-scope]") ?? document;
  const pick = selector => input.dataset[selector] ? document.querySelector(input.dataset[selector]) : null;
  const zip = pick("zipField") ?? scope.querySelector('[name="postalCode"]');
  return {
    zip,
    city: pick("cityField"),
    state: pick("stateField"),
    country: pick("countryField"),
  };
}

export function attachAddressAutocomplete(input) {
  if (input.dataset.addressReady) return;
  input.dataset.addressReady = "1";
  addStyles();
  const wrap = document.createElement("div");
  wrap.className = "address-ac";
  input.replaceWith(wrap);
  wrap.append(input);
  const list = Object.assign(document.createElement("ul"), { className: "address-ac__list", hidden: true });
  const listId = "address-ac-" + Math.random().toString(36).slice(2, 8);
  list.id = listId;
  list.setAttribute("role", "listbox");
  wrap.append(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");

  const fields = componentFiller(input);
  // Only use the street line when separate city/state/ZIP fields exist.
  const streetOnly = input.dataset.addressAutocomplete === "street";
  const multiline = input.dataset.addressAutocomplete === "multiline";
  let suggestions = [];
  let active = -1;
  let token;
  let timer;
  let request = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const highlight = index => {
    active = index;
    [...list.querySelectorAll(".address-ac__item")].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
    if (index >= 0) input.setAttribute("aria-activedescendant", `${listId}-${index}`);
  };

  async function choose(index) {
    const prediction = suggestions[index]?.placePrediction;
    if (!prediction) return;
    close();
    const fallback = prediction.text.toString();
    input.value = fallback;
    try {
      const place = prediction.toPlace();
      await place.fetchFields({ fields: ["formattedAddress", "addressComponents"] });
      const parts = Object.fromEntries((place.addressComponents ?? []).flatMap(part => part.types.map(type => [type, part])));
      const street = [parts.street_number?.longText, parts.route?.shortText].filter(Boolean).join(" ");
      const zip = parts.postal_code?.longText ?? "";
      const city = parts.locality?.longText ?? parts.sublocality?.longText ?? parts.postal_town?.longText ?? "";
      const state = parts.administrative_area_level_1?.shortText ?? "";
      const cityLine = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      const unit = parts.subpremise?.longText ? ` #${parts.subpremise.longText.replace(/^#/, "")}` : "";
      if (multiline && street && cityLine) input.value = `${street}${unit}\n${cityLine}`;
      else input.value = streetOnly && street ? street : (place.formattedAddress ?? fallback).replace(/, USA$/, "");
      if (fields.zip && zip) fields.zip.value = zip;
      if (fields.city) fields.city.value = parts.locality?.longText ?? parts.sublocality?.longText ?? fields.city.value;
      if (fields.state) fields.state.value = parts.administrative_area_level_1?.shortText ?? fields.state.value;
      if (fields.country) fields.country.value = parts.country?.shortText ?? fields.country.value;
    } catch { /* keep the suggestion text */ }
    token = undefined;
    for (const target of [input, fields.zip, fields.city, fields.state, fields.country]) {
      target?.dispatchEvent(new Event("input", { bubbles: true }));
      target?.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  async function lookup() {
    const text = (multiline ? input.value.split("\n").map(line => line.trim()).filter(Boolean).join(", ") : input.value).trim();
    if (text.length < 3) { close(); return; }
    const mine = ++request;
    let places;
    try { places = await loadPlaces(); } catch { return; }
    token ??= new places.AutocompleteSessionToken();
    let result;
    try {
      result = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: text, sessionToken: token, includedRegionCodes: ["us"],
        locationBias: { center: ASHEVILLE, radius: 50000 }, includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
      });
    } catch { close(); return; }
    if (mine !== request || document.activeElement !== input) return;
    suggestions = (result.suggestions ?? []).filter(item => item.placePrediction).slice(0, 5);
    list.replaceChildren(...suggestions.map((item, index) => {
      const prediction = item.placePrediction;
      const row = Object.assign(document.createElement("li"), { className: "address-ac__item", id: `${listId}-${index}` });
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.append(document.createTextNode(prediction.mainText?.toString() ?? prediction.text.toString()));
      if (prediction.secondaryText) row.append(Object.assign(document.createElement("small"), { textContent: prediction.secondaryText.toString() }));
      row.addEventListener("pointerdown", event => { event.preventDefault(); choose(index); });
      return row;
    }));
    if (!suggestions.length) { close(); return; }
    list.append(Object.assign(document.createElement("li"), { className: "address-ac__credit", textContent: "Suggestions by Google", role: "presentation" }));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight(-1);
  }

  input.addEventListener("input", event => {
    if (!event.isTrusted) return;
    clearTimeout(timer);
    timer = setTimeout(lookup, 220);
  });
  input.addEventListener("keydown", event => {
    if (list.hidden) return;
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(Math.min(active + 1, suggestions.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(Math.max(active - 1, 0)); }
    else if (event.key === "Enter" && active >= 0) { event.preventDefault(); choose(active); }
    else if (event.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  // Warm the library on first focus so the first keystroke is fast.
  input.addEventListener("focus", () => { loadPlaces().catch(() => {}); }, { once: true });
}

const SELECTOR = "input[data-address-autocomplete], textarea[data-address-autocomplete]";
function scan(root = document) {
  root.querySelectorAll?.(SELECTOR).forEach(attachAddressAutocomplete);
}
scan();
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType !== 1) continue;
    if (node.matches?.(SELECTOR)) attachAddressAutocomplete(node);
    else scan(node);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
