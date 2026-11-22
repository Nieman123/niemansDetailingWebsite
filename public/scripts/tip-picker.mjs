// Optional tip chooser for card payments: No tip, 15%, 20%, 25% of the service total, or a custom amount.
// Renders into `host` and calls onChange(tipCents) whenever the choice changes.
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = cents => dollars.format(cents / 100);
const PERCENTS = [15, 20, 25];

export function tipPicker(host, { baseCents, maxCents, onChange = () => {} }) {
  let tipCents = 0;
  let choice = "none";
  const chips = document.createElement("div");
  chips.className = "tip-picker__chips";
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", "Tip amount");
  const custom = document.createElement("label");
  custom.className = "field tip-picker__custom";
  custom.hidden = true;
  custom.innerHTML = '<span>Tip amount ($)</span><input type="number" min="0" step="0.01" inputmode="decimal" autocomplete="off">';
  const input = custom.querySelector("input");
  input.max = String(maxCents / 100);
  const options = [
    { id: "none", label: "No tip", cents: () => 0 },
    ...PERCENTS.map(percent => ({ id: `p${percent}`, label: `${percent}%`, sub: money(Math.round(baseCents * percent / 100)), cents: () => Math.round(baseCents * percent / 100) })),
    { id: "custom", label: "Custom", cents: () => Math.round(Math.max(0, Number(input.value) || 0) * 100) },
  ].filter(option => option.cents() <= maxCents || option.id === "custom" || option.id === "none");
  const buttons = options.map(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tip-picker__chip";
    button.dataset.choice = option.id;
    button.append(Object.assign(document.createElement("strong"), { textContent: option.label }));
    if (option.sub) button.append(Object.assign(document.createElement("span"), { textContent: option.sub }));
    button.onclick = () => select(option.id);
    return button;
  });
  chips.append(...buttons);
  function select(id) {
    choice = id;
    for (const button of buttons) button.setAttribute("aria-pressed", String(button.dataset.choice === id));
    custom.hidden = id !== "custom";
    if (id === "custom") input.focus();
    update();
  }
  function update() {
    const option = options.find(entry => entry.id === choice);
    tipCents = Math.min(maxCents, option ? option.cents() : 0);
    onChange(tipCents);
  }
  input.addEventListener("input", update);
  host.replaceChildren(chips, custom);
  select("none");
  return { get tipCents() { return tipCents; }, get overMax() { return choice === "custom" && Math.round((Number(input.value) || 0) * 100) > maxCents; } };
}
