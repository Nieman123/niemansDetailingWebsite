import { appointmentMoney } from "./appointment-utils.mjs";

// Customer add-ons on /schedule: more services for the first vehicle, and more vehicles with their own
// services. The main service and first vehicle stay in the existing pickers; this adds everything after them.
const MAX_EXTRA_VEHICLES = 3;
const sizes = [["sedan", "Sedan or coupe"], ["suv_truck", "SUV or truck"], ["van_3row", "Van or 3-row"]];
const make = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const pricesOf = service => service.vehiclePrices ?? { sedan: service.cents, suv_truck: service.cents, van_3row: service.cents };
export const priceRange = (service, size) => {
  const prices = pricesOf(service);
  if (size && prices[size] != null) return { min: prices[size], max: prices[size] };
  const values = Object.values(prices);
  return { min: Math.min(...values), max: Math.max(...values) };
};
const priceText = (service, size) => {
  const { min, max } = priceRange(service, size);
  return min === max ? appointmentMoney(min) : "from " + appointmentMoney(min);
};

export function bookingExtras(container, { services, mainService, mainSize, onChange }) {
  const group = Math.random().toString(36).slice(2, 8);
  const firstChips = make("div", { className: "booking-extras__chips" });
  const first = make("fieldset", { className: "booking-extras__vehicle" },
    make("legend", { textContent: "Add to this vehicle" }), firstChips);
  const extraHost = make("div", { className: "booking-extras" });
  const addVehicle = make("button", { type: "button", className: "quiet booking-extras__add", textContent: "+ Add another vehicle" });
  container.classList.add("booking-extras");
  container.replaceChildren(first, extraHost, addVehicle);
  let counter = 0;

  function chip(service, size, checked) {
    const input = make("input", { type: "checkbox", className: "sr-only", value: service.id, checked });
    const price = make("small", { textContent: priceText(service, size) });
    input.addEventListener("change", onChange);
    return make("label", { className: "booking-extras__chip" }, input, make("span", { textContent: service.name }), price);
  }
  const checkedIn = host => new Set([...host.querySelectorAll("input[type=checkbox]:checked")].map(input => input.value));

  // Add-ons for the first vehicle: every service except the main one, priced for its size.
  function renderFirst() {
    const keep = checkedIn(firstChips);
    const main = mainService()?.id;
    firstChips.replaceChildren(...services.filter(service => service.id !== main).map(service => chip(service, mainSize(), keep.has(service.id))));
  }

  function vehicleBlock() {
    const name = `extra-size-${group}-${counter++}`;
    const legend = make("legend", { textContent: "Another vehicle" });
    const sizeRow = make("div", { className: "booking-extras__sizes vehicle-picker" }, ...sizes.map(([value, label]) =>
      make("label", { className: "vehicle-choice" }, make("input", { type: "radio", className: "sr-only", name, value }), make("span", { textContent: label }))));
    const chips = make("div", { className: "booking-extras__chips" });
    const about = make("input", { type: "text", maxLength: 150, placeholder: "Year, make and model (optional)" });
    about.setAttribute("aria-label", "Vehicle year, make and model");
    const remove = make("button", { type: "button", className: "quiet booking-extras__remove", textContent: "Remove this vehicle" });
    const block = make("fieldset", { className: "booking-extras__vehicle" }, legend, sizeRow, chips, about, remove);
    const size = () => block.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
    const renderChips = () => {
      const keep = checkedIn(chips);
      chips.replaceChildren(...services.map(service => chip(service, size(), keep.has(service.id))));
    };
    sizeRow.addEventListener("change", () => { renderChips(); onChange(); });
    about.addEventListener("input", onChange);
    remove.addEventListener("click", () => { block.remove(); renumber(); onChange(); });
    block.read = () => ({ size: size(), vehicle: about.value.trim(), serviceIds: [...checkedIn(chips)] });
    block.flag = () => sizeRow.querySelector("input");
    renderChips();
    return block;
  }
  function renumber() {
    [...extraHost.children].forEach((block, index) => { block.querySelector("legend").textContent = `Vehicle ${index + 2}`; });
    addVehicle.hidden = extraHost.childElementCount >= MAX_EXTRA_VEHICLES;
  }
  addVehicle.addEventListener("click", () => {
    const block = vehicleBlock();
    extraHost.append(block);
    renumber();
    block.querySelector("input").focus();
    onChange();
  });
  renderFirst();

  return {
    // Main service changed or first vehicle size changed.
    refresh: renderFirst,
    // Extra rows in booking order, after the main service.
    read() {
      const rows = [...checkedIn(firstChips)].map(serviceId => ({ serviceId, vehicleIndex: 0 }));
      [...extraHost.children].forEach((block, index) => {
        const { size, vehicle, serviceIds } = block.read();
        for (const serviceId of serviceIds) rows.push({ serviceId, vehicleIndex: index + 1, ...(size ? { vehicleType: size } : {}), vehicle });
      });
      return rows;
    },
    // A vehicle with nothing chosen, or a size missing where the price depends on it. Returns the field to show.
    problem() {
      for (const block of extraHost.children) {
        const { size, serviceIds } = block.read();
        if (!serviceIds.length) return { node: block, focus: block.querySelector(".booking-extras__chips input"), message: "Pick a service for each added vehicle, or remove it." };
        const varies = serviceIds.some(id => { const range = priceRange(services.find(service => service.id === id)); return range.min !== range.max; });
        if (varies && !size) return { node: block, focus: block.flag(), message: "Pick a size for each added vehicle." };
      }
      return null;
    },
  };
}
