import { appointmentMoney, durationLabel, vehicleLabels } from "./appointment-utils.mjs";

// Owner editor for the services on a booking: each row is one service on one vehicle, with its price and
// time. Rows start from the booking catalog but stay editable, so add-ons and custom work fit too.
//
// firstVehicle: "external" when the New booking form's own vehicle fields describe vehicle 1, so only
// vehicles 2 and up get size and description fields here.
export const MAX_VEHICLES = 4;
// Fields carry data-field instead of a name so they stay out of the surrounding form's elements and FormData.
const make = (tag, { dataset_field: field, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  if (field) node.dataset.field = field;
  node.append(...children);
  return node;
};
const dollars = cents => cents == null ? "" : (cents / 100).toFixed(2);
const toCents = value => value === "" || value == null ? null : Math.round(Number(value) * 100);

export function itemsEditor(container, { services = [], items = [], firstVehicle = "editable", vehicleOne = () => ({}), onChange = () => {} } = {}) {
  let catalog = services;
  const vehicles = new Map();
  const rowsHost = make("div", { className: "items-editor__rows" });
  const vehiclesHost = make("div", { className: "items-editor__vehicles" });
  const add = make("button", { type: "button", className: "btn secondary items-editor__add", textContent: "+ Add a service" });
  container.classList.add("items-editor");
  container.replaceChildren(rowsHost, vehiclesHost, add);

  const sizeOf = index => index === 0 && firstVehicle === "external" ? vehicleOne().vehicleType ?? "" : vehicles.get(index)?.size.value ?? "";
  const priceFor = (service, index) => {
    const prices = service?.vehiclePrices;
    if (!prices) return service?.cents ?? null;
    const size = sizeOf(index);
    if (size) return prices[size] ?? null;
    return new Set(Object.values(prices)).size === 1 ? prices.sedan : null;
  };

  function vehicleFields(index, saved = {}) {
    if (vehicles.has(index)) return vehicles.get(index);
    const size = make("select", { dataset_field: "vehicleSize" }, new Option("Size not set", ""), ...Object.entries(vehicleLabels).map(([value, label]) => new Option(label, value)));
    size.value = saved.vehicleType ?? "";
    const about = make("input", { dataset_field: "vehicleDetails", maxLength: 150, placeholder: "Year, make and model", value: saved.vehicle ?? "" });
    size.setAttribute("aria-label", `Vehicle ${index + 1} size`);
    about.setAttribute("aria-label", `Vehicle ${index + 1} details`);
    const box = make("fieldset", { className: "items-editor__vehicle" }, make("legend", { textContent: `Vehicle ${index + 1}` }), size, about);
    const entry = { box, size, about };
    size.addEventListener("change", () => { reprice(index); changed(); });
    about.addEventListener("input", changed);
    vehicles.set(index, entry);
    return entry;
  }

  function reprice(index) {
    for (const row of rowsHost.children) {
      if (Number(row.querySelector("[data-field=vehicleIndex]").value) !== index || row.dataset.autoPrice !== "true") continue;
      const service = catalog.find(item => item.id === row.dataset.serviceId);
      if (service) row.querySelector("[data-field=price]").value = dollars(priceFor(service, index));
    }
  }

  function vehicleOptions(select, selected) {
    select.replaceChildren(...Array.from({ length: MAX_VEHICLES }, (_, index) =>
      new Option(index === 0 && firstVehicle === "external" ? "Same vehicle" : `Vehicle ${index + 1}`, String(index))));
    select.value = String(selected);
  }

  function row(item = {}) {
    const service = make("select", { dataset_field: "service" });
    const names = catalog.map(entry => new Option(entry.name, entry.id));
    service.append(new Option("Choose a service", ""), ...names, new Option("Custom service", "custom"));
    const custom = make("input", { dataset_field: "customName", maxLength: 100, placeholder: "Service name", hidden: true });
    const vehicle = make("select", { dataset_field: "vehicleIndex" });
    vehicleOptions(vehicle, item.vehicleIndex ?? 0);
    const price = make("input", { dataset_field: "price", type: "number", min: 0, step: "0.01", inputMode: "decimal", placeholder: "Price", value: dollars(item.cents) });
    const minutes = make("input", { dataset_field: "minutes", type: "number", min: 0, max: 1440, step: 15, inputMode: "numeric", placeholder: "Minutes", value: item.minutes ?? "" });
    const remove = make("button", { type: "button", className: "items-editor__remove", textContent: "×" });
    for (const [node, label] of [[service, "Service"], [custom, "Custom service name"], [vehicle, "Vehicle"], [price, "Price in dollars"], [minutes, "Minutes"], [remove, "Remove service"]]) node.setAttribute("aria-label", label);
    const line = make("div", { className: "items-editor__row" },
      make("div", { className: "items-editor__what" }, service, custom),
      vehicle, make("label", { className: "items-editor__money" }, make("span", { textContent: "$" }), price),
      make("label", { className: "items-editor__time" }, minutes, make("span", { textContent: "min" })), remove);
    const known = catalog.find(entry => entry.id === item.serviceId) ?? (item.name ? catalog.find(entry => entry.name === item.name) : null);
    if (known) { service.value = known.id; line.dataset.serviceId = known.id; }
    else if (item.name) { service.value = "custom"; custom.hidden = false; custom.value = item.name; }
    line.dataset.autoPrice = item.cents == null ? "true" : "false";
    service.addEventListener("change", () => {
      const chosen = catalog.find(entry => entry.id === service.value);
      custom.hidden = service.value !== "custom";
      line.dataset.serviceId = chosen?.id ?? "";
      if (chosen) {
        price.value = dollars(priceFor(chosen, Number(vehicle.value)));
        minutes.value = chosen.duration;
        line.dataset.autoPrice = "true";
      } else if (service.value === "custom") custom.focus();
      changed();
    });
    vehicle.addEventListener("change", () => {
      if (line.dataset.autoPrice === "true") {
        const chosen = catalog.find(entry => entry.id === service.value);
        if (chosen) price.value = dollars(priceFor(chosen, Number(vehicle.value)));
      }
      changed();
    });
    price.addEventListener("input", () => { line.dataset.autoPrice = "false"; changed(); });
    custom.addEventListener("input", changed);
    minutes.addEventListener("input", changed);
    remove.addEventListener("click", () => { line.remove(); changed(); });
    rowsHost.append(line);
    return line;
  }

  // Show size and description fields for each vehicle in use, numbered in order.
  function syncVehicles() {
    const used = new Set([...rowsHost.children].map(line => Number(line.querySelector("[data-field=vehicleIndex]").value)));
    if (firstVehicle !== "external") used.add(0);
    for (const index of [...vehicles.keys()]) if (!used.has(index)) { vehicles.get(index).box.remove(); }
    vehiclesHost.replaceChildren(...[...used].sort((a, b) => a - b)
      .filter(index => !(index === 0 && firstVehicle === "external")).map(index => vehicleFields(index).box));
  }

  function read() {
    return [...rowsHost.children].map(line => {
      const service = line.querySelector("[data-field=service]").value;
      const known = catalog.find(entry => entry.id === service);
      const vehicleIndex = Number(line.querySelector("[data-field=vehicleIndex]").value);
      const name = known?.name ?? (service === "custom" ? line.querySelector("[data-field=customName]").value.trim() : "");
      const fromForm = vehicleIndex === 0 && firstVehicle === "external" ? vehicleOne() : null;
      const fields = vehicles.get(vehicleIndex);
      const vehicleType = fromForm ? fromForm.vehicleType ?? "" : fields?.size.value ?? "";
      return {
        ...(known ? { serviceId: known.id } : {}), name, vehicleIndex,
        ...(vehicleType ? { vehicleType } : {}),
        vehicle: fromForm ? fromForm.vehicle ?? "" : fields?.about.value.trim() ?? "",
        cents: toCents(line.querySelector("[data-field=price]").value),
        minutes: Number(line.querySelector("[data-field=minutes]").value) || 0,
      };
    });
  }

  function changed() {
    syncVehicles();
    onChange(read());
  }

  add.addEventListener("click", () => {
    const used = [...rowsHost.children].map(line => Number(line.querySelector("[data-field=vehicleIndex]").value));
    row({ vehicleIndex: used.length ? used[used.length - 1] : 0 }).querySelector("select").focus();
    changed();
  });

  for (const item of items) {
    if (item.vehicleIndex > 0 || firstVehicle !== "external") vehicleFields(item.vehicleIndex, item);
    row(item);
  }
  syncVehicles();

  return {
    read,
    // Throws a readable message when a row is incomplete or the vehicles skip a number.
    validate() {
      const rows = read();
      if (rows.some(item => !item.name)) throw new Error("Choose a service for each row, or remove it.");
      if (rows.some(item => item.cents != null && !(item.cents >= 0))) throw new Error("Check the prices.");
      const used = new Set(rows.map(item => item.vehicleIndex));
      if (firstVehicle === "external") used.add(0);
      for (let index = 0; index < used.size; index++) if (!used.has(index)) throw new Error(`Vehicle ${index + 1} has no services. Number the vehicles from 1 without gaps.`);
      return rows;
    },
    refresh() { reprice(0); changed(); },
    clear() { rowsHost.replaceChildren(); vehicles.clear(); syncVehicles(); },
    setServices(next) { catalog = next; },
    get size() { return rowsHost.childElementCount; },
  };
}

export const itemTotals = items => ({
  cents: items.some(item => item.cents != null) ? items.reduce((total, item) => total + (item.cents ?? 0), 0) : null,
  minutes: items.reduce((total, item) => total + (item.minutes || 0), 0),
});

// One readable line per service for detail screens.
export function itemLines(items) {
  const several = new Set(items.map(item => item.vehicleIndex)).size > 1;
  return items.map(item => {
    const vehicle = item.vehicle || vehicleLabels[item.vehicleType] || `Vehicle ${item.vehicleIndex + 1}`;
    return [several ? `${item.name} (${vehicle})` : item.name, item.cents != null ? appointmentMoney(item.cents) : "", item.minutes ? durationLabel(item.minutes) : ""]
      .filter(Boolean).join(" · ");
  });
}
