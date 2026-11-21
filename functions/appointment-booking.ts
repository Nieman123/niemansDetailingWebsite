const DAY = 86_400_000;
const MINUTE = 60_000;
const zone = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export const bookingVehicles = ["sedan", "suv_truck", "van_3row"] as const;
export type BookingVehicle = typeof bookingVehicles[number];
export type BookingService = {
  id: string; name: string; duration: number; cents: number;
  vehiclePrices?: Record<BookingVehicle, number>;
  // Featured services lead the booking picker; the description is a short customer-facing line.
  featured?: boolean;
  description?: string;
};

// Quotes already use these rates. Recognize the original Full Detail booking price until it is edited.
export function bookingPrices(service: BookingService): Record<BookingVehicle, number> {
  if (service.vehiclePrices) return service.vehiclePrices;
  const sedan = service.cents;
  if (service.id === "full" && sedan === 30_000) return { sedan, suv_truck: 35_000, van_3row: 40_000 };
  return { sedan, suv_truck: sedan, van_3row: sedan };
}

export function bookingVehicle(value: unknown): BookingVehicle | undefined {
  return bookingVehicles.find(vehicle => vehicle === value);
}
export type DayHours = { open: string; close: string };
export type BookingSettings = {
  enabled: boolean;
  days: number[];
  open: string;
  close: string;
  // Per-weekday overrides keyed "0" (Sunday) through "6"; other open days use open/close.
  hours?: Record<string, DayHours>;
  minimumHours: number;
  horizonDays: number;
  bufferMinutes: number;
  blockedDates: string[];
  postalCodes: string[];
  services: BookingService[];
  revision: string;
};

export const emptyBookingSettings: BookingSettings = {
  enabled: false, days: [], open: "09:00", close: "17:00", minimumHours: 24, horizonDays: 45,
  bufferMinutes: 30, blockedDates: [], postalCodes: [], services: [], revision: "",
};

function integer(input: unknown, min: number, max: number): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= min && input <= max;
}

function stringList(input: unknown, pattern: RegExp, max: number): input is string[] {
  return Array.isArray(input) && input.length <= max && input.every(item => typeof item === "string" && pattern.test(item));
}

export function parseBookingSettings(input: Record<string, unknown>): Omit<BookingSettings, "revision"> | null {
  const { enabled, days, open, close, hours, minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services } = input;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  let dayHours: Record<string, DayHours> | undefined;
  if (hours !== undefined) {
    if (!hours || typeof hours !== "object" || Array.isArray(hours)) return null;
    dayHours = {};
    for (const [day, value] of Object.entries(hours as Record<string, unknown>)) {
      const row = value as Partial<DayHours> | null;
      if (!/^[0-6]$/.test(day) || !row || typeof row.open !== "string" || typeof row.close !== "string" ||
        !clock.test(row.open) || !clock.test(row.close) || row.open >= row.close) return null;
      dayHours[day] = { open: row.open, close: row.close };
    }
  }
  if (typeof enabled !== "boolean" || !Array.isArray(days) || days.length > 7 || !days.every(value => integer(value, 0, 6)) ||
    typeof open !== "string" || typeof close !== "string" || !clock.test(open) || !clock.test(close) || open >= close ||
    !integer(minimumHours, 1, 168) || !integer(horizonDays, 1, 90) || !integer(bufferMinutes, 0, 120) ||
    !stringList(blockedDates, /^\d{4}-\d{2}-\d{2}$/, 150) || !stringList(postalCodes, /^\d{5}$/, 150) ||
    !Array.isArray(services) || services.length > 25 || (enabled && (!days.length || !services.length || !postalCodes.length))) return null;
  const ids = new Set<string>();
  const catalog: BookingService[] = [];
  for (const row of services) {
    if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9_-]{0,30}$/.test(row.id) || ids.has(row.id) ||
      typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 || !integer(row.duration, 30, 720) || !integer(row.cents, 5000, 10_000_000)) return null;
    ids.add(row.id);
    let vehiclePrices: BookingService["vehiclePrices"];
    if (row.vehiclePrices !== undefined) {
      const prices = row.vehiclePrices;
      if (!prices || typeof prices !== "object" || Array.isArray(prices) ||
          !bookingVehicles.every(vehicle => integer(prices[vehicle], 5000, 10_000_000))) return null;
      vehiclePrices = { sedan: prices.sedan, suv_truck: prices.suv_truck, van_3row: prices.van_3row };
    }
    if (row.featured !== undefined && typeof row.featured !== "boolean") return null;
    if (row.description !== undefined && (typeof row.description !== "string" || row.description.length > 140)) return null;
    const description = typeof row.description === "string" ? row.description.trim() : "";
    catalog.push({ id: row.id, name: row.name.trim(), duration: row.duration, cents: vehiclePrices?.sedan ?? row.cents,
      ...(vehiclePrices ? { vehiclePrices } : {}), ...(row.featured ? { featured: true } : {}), ...(description ? { description } : {}) });
  }
  return { enabled, days, open, close, ...(dayHours ? { hours: dayHours } : {}), minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services: catalog };
}

export function easternDate(timestamp: number) {
  const date = easternParts(timestamp);
  return `${date.year}-${date.month}-${date.day}`;
}

function easternParts(timestamp: number) {
  return Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
}

function eastDateTime(day: string, time: string) {
  const wall = Date.parse(`${day}T${time}:00Z`);
  if (!Number.isFinite(wall)) return null;
  const valid = [4, 5].map(offset => wall + offset * 60 * MINUTE).filter(value => {
    const part = easternParts(value);
    return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}` === `${day}T${time}`;
  });
  return valid.length === 1 ? valid[0] : null;
}

// The bookable window for one Eastern date, ignoring notice and horizon: null when the day is closed or blocked.
export function businessHours(settings: BookingSettings, date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || settings.blockedDates.includes(date)) return null;
  const day = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(day) || !settings.days.includes(new Date(day).getUTCDay())) return null;
  const hours = settings.hours?.[String(new Date(day).getUTCDay())] ?? { open: settings.open, close: settings.close };
  const start = eastDateTime(date, hours.open);
  const end = eastDateTime(date, hours.close);
  return start === null || end === null ? null : { start, end };
}

export function bookingSlots(settings: BookingSettings, date: string, service: BookingService, now: number) {
  if (!settings.enabled || date < easternDate(now) || date > easternDate(now + settings.horizonDays * DAY)) return [];
  const window = businessHours(settings, date);
  if (!window) return [];
  const { start, end } = window;
  const result: number[] = [];
  for (let candidate = start; candidate + service.duration * MINUTE <= end; candidate += 30 * MINUTE) {
    if (candidate >= now + settings.minimumHours * 60 * MINUTE) result.push(candidate);
  }
  return result;
}
