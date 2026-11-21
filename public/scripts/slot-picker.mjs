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

// The month calendar and time list used on /schedule, built for pages that add it on demand.
// Returns the root to pass to slotPicker plus its status line and retry button.
export function slotCalendar(prefix, title = "Available dates") {
  const make = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };
  const arrow = (label, extra) => {
    const button = make("button", { type: "button", disabled: true }, make("span", { className: "chevron" + extra }));
    button.setAttribute("aria-label", label);
    button.firstChild.setAttribute("aria-hidden", "true");
    return button;
  };
  const status = make("p", { id: prefix + "-calendar-status", textContent: "Checking availability." });
  status.setAttribute("role", "status");
  const retry = make("button", { type: "button", className: "btn secondary", textContent: "Try again", hidden: true });
  const weekdays = make("div", { className: "weekdays" }, ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => make("span", { textContent: day })));
  weekdays.setAttribute("aria-hidden", "true");
  const grid = make("div", { className: "month-grid" });
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-labelledby", prefix + "-month-title");
  const note = make("p", { className: "slot-note" });
  note.setAttribute("role", "status");
  const times = make("div", { className: "time-grid" });
  times.setAttribute("role", "group");
  times.setAttribute("aria-labelledby", prefix + "-slot-heading");
  const root = make("div", { className: "owner-slot-calendar" },
    make("div", { className: "month-nav" }, make("h2", { id: prefix + "-month-title", textContent: title }),
      make("div", {}, arrow("Previous month", " previous"), arrow("Next month", ""))),
    status, retry, weekdays, grid,
    make("section", { className: "time-section" }, make("h3", { id: prefix + "-slot-heading", textContent: "Available times" }), note, times));
  return { root, status, retry };
}

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
  // keepStart: a previously chosen start time to restore if it is still open after reloading.
  async function load(preferred = day, keepStart = null) {
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
      // A lookup can carry the booking horizon, for pages that don't load booking options first.
      if (result.horizonDays) {
        maxMonth = easternDay.format(Date.now() + result.horizonDays * 86_400_000).slice(0, 7);
        next.disabled = month >= maxMonth;
      }
      for (const value of result.slots) {
        const key = easternDay.format(value);
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(value);
      }
      const keptDay = keepStart ? easternDay.format(keepStart) : null;
      const keep = keptDay && slots.get(keptDay)?.includes(keepStart);
      day = keep ? keptDay : slots.has(preferred) ? preferred : slots.keys().next().value;
      if (keep) selected = keepStart;
      drawDays();
      drawTimes();
      status.textContent = slots.size ? "" : empty;
      if (keep) onSelect(keepStart);
      else if (keepStart) status.textContent = "That time isn't open with these settings. Choose another time.";
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
    // Open the month holding a start time and select it if it's still offered.
    show(start) {
      const target = easternDay.format(start).slice(0, 7);
      month = target < minMonth ? minMonth : target;
      if (month > maxMonth) maxMonth = month;
      return load(easternDay.format(start), start);
    },
    clearSelection() {
      selected = null;
      times.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
    },
    focusTime() { times.querySelector('[aria-pressed="true"]')?.focus(); },
  };
}
