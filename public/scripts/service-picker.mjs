import { appointmentMoney, durationLabel } from "./appointment-utils.mjs";

// Renders a service catalog as radio cards (featured) and chips (everything else),
// and keeps a native <select> in sync so existing form code keeps reading select.value.
export function servicePicker(container, select, services, { valueFor = service => service.id, vehicle = () => "", none } = {}) {
  const group = `service-${Math.random().toString(36).slice(2, 8)}`;
  const featured = services.filter(service => service.featured);
  const lead = featured.length ? featured : services.slice(0, 1);
  const rest = services.filter(service => !lead.includes(service));
  container.replaceChildren();
  container.classList.add("service-picker");
  select.hidden = true;
  select.tabIndex = -1;

  function priceText(service) {
    const prices = service.vehiclePrices ?? { sedan: service.cents };
    const chosen = vehicle();
    if (chosen && prices[chosen] != null) return appointmentMoney(prices[chosen]);
    const values = Object.values(prices);
    const min = Math.min(...values), max = Math.max(...values);
    return min === max ? appointmentMoney(min) : "From " + appointmentMoney(min);
  }

  function option(service, size) {
    const label = document.createElement("label");
    label.className = "service-choice service-choice--" + size;
    const input = Object.assign(document.createElement("input"), { type: "radio", name: group, value: service ? valueFor(service) : "" });
    input.className = "sr-only";
    const name = Object.assign(document.createElement("span"), { className: "service-choice__name", textContent: service ? service.name : none });
    label.append(input, name);
    if (service && size === "lead") {
      if (service.description) label.append(Object.assign(document.createElement("span"), { className: "service-choice__desc", textContent: service.description }));
      label.append(Object.assign(document.createElement("span"), { className: "service-choice__meta", textContent: durationLabel(service.duration) }));
    }
    if (service) {
      const price = Object.assign(document.createElement("span"), { className: "service-choice__price", textContent: priceText(service) });
      price.dataset.serviceValue = valueFor(service);
      label.append(price);
    }
    input.addEventListener("change", () => {
      select.value = input.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return label;
  }

  const leadGroup = Object.assign(document.createElement("div"), { className: "service-picker__lead" });
  leadGroup.append(...lead.map(service => option(service, "lead")));
  container.append(leadGroup);
  if (rest.length || none) {
    const more = Object.assign(document.createElement("div"), { className: "service-picker__more" });
    more.append(...rest.map(service => option(service, "chip")));
    if (none) more.append(option(null, "chip"));
    container.append(Object.assign(document.createElement("p"), { className: "service-picker__label", textContent: lead.length ? "Other services" : "Services" }), more);
  }

  const sync = () => {
    for (const input of container.querySelectorAll("input")) input.checked = input.value === select.value;
  };
  sync();
  return {
    sync,
    refreshPrices() {
      for (const service of services) {
        const node = container.querySelector(`[data-service-value="${CSS.escape(valueFor(service))}"]`);
        if (node) node.textContent = priceText(service);
      }
    },
  };
}

// Nieman's current bookable services. Durations are starting points to adjust in Settings.
export const standardServices = [
  { id: "full", name: "The Works (Full Detail)", featured: true, description: "Interior and exterior, wheels, engine bay, steam cleaning, and wax.", duration: 240, vehiclePrices: { sedan: 30000, suv_truck: 35000, van_3row: 40000 } },
  { id: "quick", name: "Quick Once Over", description: "Lighter upkeep detail with an SiO₂ spray sealant.", duration: 150, vehiclePrices: { sedan: 20000, suv_truck: 25000, van_3row: 30000 } },
  { id: "interior_only", name: "Interior Only", description: "Full interior clean without exterior service.", duration: 180, vehiclePrices: { sedan: 20000, suv_truck: 25000, van_3row: 30000 } },
  { id: "headlights", name: "Headlight Restoration", duration: 90, vehiclePrices: { sedan: 7500, suv_truck: 8500, van_3row: 9500 } },
  { id: "trim", name: "Trim Restoration", duration: 120, vehiclePrices: { sedan: 12000, suv_truck: 12000, van_3row: 12000 } },
  { id: "new_car", name: "New Car Decontamination", duration: 180, vehiclePrices: { sedan: 12500, suv_truck: 12500, van_3row: 12500 } },
  { id: "hard_water", name: "Hard Water Spot Removal", duration: 90, vehiclePrices: { sedan: 8000, suv_truck: 8000, van_3row: 8000 } },
  { id: "monthly_mini", name: "Monthly Mini", description: "Maintenance visit for existing clients.", duration: 75, vehiclePrices: { sedan: 8500, suv_truck: 10000, van_3row: 10000 } },
];
