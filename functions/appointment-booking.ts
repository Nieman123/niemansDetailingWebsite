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
export type BookingSettings = {
  enabled: boolean;
  days: number[];
  open: string;
  close: string;
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
  const { enabled, days, open, close, minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services } = input;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
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
    catalog.push({ id: row.id, name: row.name.trim(), duration: row.duration, cents: vehiclePrices?.sedan ?? row.cents,
      ...(vehiclePrices ? { vehiclePrices } : {}) });
  }
  return { enabled, days, open, close, minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services: catalog };
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

export function bookingSlots(settings: BookingSettings, date: string, service: BookingService, now: number) {
  if (!settings.enabled || !/^\d{4}-\d{2}-\d{2}$/.test(date) || settings.blockedDates.includes(date)) return [];
  const day = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(day) || date < easternDate(now) || date > easternDate(now + settings.horizonDays * DAY) ||
    !settings.days.includes(new Date(day).getUTCDay())) return [];
  const start = eastDateTime(date, settings.open);
  const end = eastDateTime(date, settings.close);
  if (start === null || end === null) return [];
  const result: number[] = [];
  for (let candidate = start; candidate + service.duration * MINUTE <= end; candidate += 30 * MINUTE) {
    if (candidate >= now + settings.minimumHours * 60 * MINUTE) result.push(candidate);
  }
  return result;
}
