const eastern = "America/New_York";
export const easternDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: eastern, year: "numeric", month: "2-digit", day: "2-digit",
});
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: eastern, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const time = new Intl.DateTimeFormat("en-US", { timeZone: eastern, hour: "numeric", minute: "2-digit" });
const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
const noon = date => new Date(date + "T12:00:00Z");

export const easternInput = value => easternDay.format(value) + "T" + clock.format(value);

export function slotPicker(root, { getSlots, onSelect, onClear, status, retry, empty, unavailable }) {
  const grid = root.querySelector(".month-grid");
  const heading = root.querySelector(".month-nav h2");
  const [previous, next] = root.querySelectorAll(".month-nav button");
  const times = root.querySelector(".time-grid");
  const slotHeading = root.querySelector(".time-section h3");
  const slotNote = root.querySelector(".slot-note");
  const today = easternDay.format(Date.now());
  const minMonth = today.slice(0, 7);
  let month = minMonth;
  let maxMonth = minMonth;
  let slots = new Map();
  let day, selected, revision = 0;

  function drawDays() {
    const first = noon(month + "-01");
    grid.replaceChildren();
    for (let i = 0; i < first.getUTCDay(); i++) grid.append(document.createElement("span"));
    for (let n = 1; n <= 31; n++) {
      const key = month + "-" + String(n).padStart(2, "0");
      const date = noon(key);
      if (date.getUTCMonth() !== first.getUTCMonth()) break;
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: n, disabled: !slots.has(key) });
      button.dataset.day = key;
      button.setAttribute("aria-label", dayName.format(date) + (button.disabled ? ", unavailable" : ", available"));
      button.setAttribute("aria-pressed", String(day === key));
      if (today === key) button.setAttribute("aria-current", "date");
      grid.append(button);
    }
  }
  function drawTimes() {
    slotHeading.textContent = day ? dayName.format(noon(day)) : "Available times";
    slotNote.textContent = day ? "Choose a start time in Eastern time." : "";
    times.replaceChildren();
    for (const value of slots.get(day) || []) {
      const button = Object.assign(document.createElement("button"), { type: "button", textContent: time.format(value) });
      button.dataset.start = value;
      button.setAttribute("aria-pressed", String(value === selected));
      times.append(button);
    }
  }
  async function load(preferred = day) {
    const version = ++revision;
    slots = new Map();
    day = selected = null;
    onClear();
    heading.textContent = monthName.format(noon(month + "-01"));
    previous.disabled = month <= minMonth;
    next.disabled = month >= maxMonth;
    retry.hidden = true;
    grid.setAttribute("aria-busy", "true");
    status.textContent = "Checking openings for " + heading.textContent + ".";
    drawDays();
    drawTimes();
    try {
      const result = await getSlots(month);
      if (version !== revision) return;
      for (const value of result.slots) {
        const key = easternDay.format(value);
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(value);
      }
      day = slots.has(preferred) ? preferred : slots.keys().next().value;
      drawDays();
      drawTimes();
      status.textContent = slots.size ? "" : empty;
    } catch (error) {
      if (version !== revision) return;
      status.textContent = unavailable(error);
      retry.hidden = false;
    } finally {
      if (version === revision) grid.removeAttribute("aria-busy");
    }
  }
  function shiftMonth(offset) {
    const first = noon(month + "-01");
    first.setUTCMonth(first.getUTCMonth() + offset);
    month = first.toISOString().slice(0, 7);
    load();
  }
  previous.onclick = () => shiftMonth(-1);
  next.onclick = () => shiftMonth(1);
  retry.onclick = () => load();
  grid.onclick = event => {
    const key = event.target.closest("button")?.dataset.day;
    if (!slots.has(key)) return;
    day = key;
    selected = null;
    onClear();
    drawDays();
    drawTimes();
    grid.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  };
  times.onclick = event => {
    const value = Number(event.target.closest("button")?.dataset.start);
    if (!slots.get(day)?.includes(value)) return;
    times.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
    event.target.closest("button").setAttribute("aria-pressed", "true");
    selected = value;
    onSelect(value);
  };
  return {
    load,
    setHorizon(days) {
      maxMonth = easternDay.format(Date.now() + days * 86_400_000).slice(0, 7);
      if (month > maxMonth) month = maxMonth;
    },
    clearSelection() {
      selected = null;
      times.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
    },
    focusTime() { times.querySelector('[aria-pressed="true"]')?.focus(); },
  };
}
