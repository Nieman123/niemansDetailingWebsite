const eastern = "America/New_York";
const machineDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: eastern, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const friendlyDate = new Intl.DateTimeFormat("en-US", {
  timeZone: eastern, weekday: "short", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit",
});
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

// Resolve both Eastern offsets and round-trip the wall-clock time through Intl.
export function easternStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a start date and time.");
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) throw new Error("Enter a valid start date and time.");
  const candidates = [4, 5].map(offset => wall + offset * 3_600_000).filter(candidate => {
    const parts = Object.fromEntries(machineDate.formatToParts(candidate).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === value;
  });
  if (candidates.length !== 1) throw new Error("That Eastern time is skipped or repeated by daylight saving. Choose another time.");
  return candidates[0];
}

export const appointmentTime = ({ start, end }) => `${friendlyDate.formatRange(start, end)} Eastern`;
export const appointmentMoney = cents => dollars.format(cents / 100);

export async function appointmentRequest(action, body = {}, bearer) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`/api/appointments/${action}`, {
    method: "POST", headers, body: JSON.stringify(body), cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    const error = new Error(data?.error || "appointment_operation_failed");
    error.code = data?.error;
    throw error;
  }
  return data.result;
}

const icsUtc = timestamp => new Date(timestamp).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = value => value.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/([;,])/g, "\\$1");

export function googleCalendarUrl(appointment) {
  const { service, start, end, address } = appointment;
  const query = new URLSearchParams({
    action: "TEMPLATE", text: `${service} | Nieman’s Detailing`,
    dates: `${icsUtc(start)}/${icsUtc(end)}`, location: address, ctz: eastern,
  });
  return `https://calendar.google.com/calendar/render?${query}`;
}

function foldIcs(line) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) { result += "\r\n "; bytes = 1; }
    result += character;
    bytes += size;
  }
  return result;
}

export function calendarFile(id, appointment, now = Date.now()) {
  const { service, start, end, address } = appointment;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nieman's Detailing//Appointments//EN",
    "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${id}@niemansdetailing.com`,
    `DTSTAMP:${icsUtc(now)}`, `DTSTART:${icsUtc(start)}`, `DTEND:${icsUtc(end)}`,
    `SUMMARY:${icsText(`${service} | Nieman’s Detailing`)}`, `LOCATION:${icsText(address)}`,
    "STATUS:CONFIRMED", `SEQUENCE:${Number.isSafeInteger(appointment.calendarSequence) ? appointment.calendarSequence : 0}`, "END:VEVENT", "END:VCALENDAR", "",
  ].map(foldIcs).join("\r\n");
}
