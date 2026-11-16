"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyBookingSettings = void 0;
exports.parseBookingSettings = parseBookingSettings;
exports.easternDate = easternDate;
exports.bookingSlots = bookingSlots;
const DAY = 86400000;
const MINUTE = 60000;
const zone = "America/New_York";
const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
exports.emptyBookingSettings = {
    enabled: false, days: [], open: "09:00", close: "17:00", minimumHours: 24, horizonDays: 45,
    bufferMinutes: 30, blockedDates: [], postalCodes: [], services: [], revision: "",
};
function integer(input, min, max) {
    return typeof input === "number" && Number.isInteger(input) && input >= min && input <= max;
}
function stringList(input, pattern, max) {
    return Array.isArray(input) && input.length <= max && input.every(item => typeof item === "string" && pattern.test(item));
}
function parseBookingSettings(input) {
    const { enabled, days, open, close, minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services } = input;
    const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof enabled !== "boolean" || !Array.isArray(days) || days.length > 7 || !days.every(value => integer(value, 0, 6)) ||
        typeof open !== "string" || typeof close !== "string" || !clock.test(open) || !clock.test(close) || open >= close ||
        !integer(minimumHours, 1, 168) || !integer(horizonDays, 1, 90) || !integer(bufferMinutes, 0, 120) ||
        !stringList(blockedDates, /^\d{4}-\d{2}-\d{2}$/, 150) || !stringList(postalCodes, /^\d{5}$/, 150) ||
        !Array.isArray(services) || services.length > 25 || (enabled && (!days.length || !services.length || !postalCodes.length)))
        return null;
    const ids = new Set();
    const catalog = [];
    for (const row of services) {
        if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9_-]{0,30}$/.test(row.id) || ids.has(row.id) ||
            typeof row.name !== "string" || !row.name.trim() || row.name.length > 100 || !integer(row.duration, 30, 720) || !integer(row.cents, 5000, 10000000))
            return null;
        ids.add(row.id);
        catalog.push({ id: row.id, name: row.name.trim(), duration: row.duration, cents: row.cents });
    }
    return { enabled, days, open, close, minimumHours, horizonDays, bufferMinutes, blockedDates, postalCodes, services: catalog };
}
function easternDate(timestamp) {
    const date = easternParts(timestamp);
    return `${date.year}-${date.month}-${date.day}`;
}
function easternParts(timestamp) {
    return Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
}
function eastDateTime(day, time) {
    const wall = Date.parse(`${day}T${time}:00Z`);
    if (!Number.isFinite(wall))
        return null;
    const valid = [4, 5].map(offset => wall + offset * 60 * MINUTE).filter(value => {
        const part = easternParts(value);
        return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}` === `${day}T${time}`;
    });
    return valid.length === 1 ? valid[0] : null;
}
function bookingSlots(settings, date, service, now) {
    if (!settings.enabled || !/^\d{4}-\d{2}-\d{2}$/.test(date) || settings.blockedDates.includes(date))
        return [];
    const day = Date.parse(`${date}T12:00:00Z`);
    if (!Number.isFinite(day) || date < easternDate(now) || date > easternDate(now + settings.horizonDays * DAY) ||
        !settings.days.includes(new Date(day).getUTCDay()))
        return [];
    const start = eastDateTime(date, settings.open);
    const end = eastDateTime(date, settings.close);
    if (start === null || end === null)
        return [];
    const result = [];
    for (let candidate = start; candidate + service.duration * MINUTE <= end; candidate += 30 * MINUTE) {
        if (candidate >= now + settings.minimumHours * 60 * MINUTE)
            result.push(candidate);
    }
    return result;
}
