// The readout under an owner-chosen start time: what the booking rules and calendars say about it.
// Shared by New booking and Reschedule, which both let the owner book over a conflict on purpose.
const rangeTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const issueText = {
  past: "That time has already passed.",
  too_soon_for_deposit: "That’s too soon for a deposit link. Choose “No deposit required” or a time at least 36 minutes away.",
  blocked_date: "That date is blocked off in Settings.",
  closed_day: "You don’t normally take bookings that day.",
  outside_hours: "It runs outside your business hours for that day.",
};

function conflictLine(item, bufferMinutes) {
  const when = rangeTime.formatRange(item.start, item.end);
  const who = item.kind === "appointment" ? [item.name, item.service].filter(Boolean).join(" · ") || "Another appointment" : "Busy on your calendar";
  return item.overlaps ? `Overlaps ${who}, ${when}.` : `Inside your ${bufferMinutes}-minute travel buffer: ${who}, ${when}.`;
}

// Fills the .time-check box from an admin-check-time result. Returns true when the time overlaps something.
export function showTimeCheck(box, result) {
  const conflict = result.issues.includes("overlap");
  box.dataset.state = result.open ? "open" : conflict ? "conflict" : "warn";
  const lines = [
    ...result.issues.filter(issue => issueText[issue]).map(issue => issueText[issue]),
    ...result.conflicts.map(item => conflictLine(item, result.bufferMinutes)),
  ];
  const heading = document.createElement("p");
  heading.textContent = result.open ? "Open. Nothing else is booked around this time."
    : conflict ? "This time isn’t free." : "This time is free, but note:";
  box.replaceChildren(heading);
  if (lines.length) {
    const list = document.createElement("ul");
    list.append(...lines.map(line => Object.assign(document.createElement("li"), { textContent: line })));
    box.append(list);
  }
  box.hidden = false;
  return conflict;
}

export function showTimeCheckMessage(box, state, text) {
  box.dataset.state = state;
  box.replaceChildren(Object.assign(document.createElement("p"), { textContent: text }));
  box.hidden = false;
}
