"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.vehicleName = exports.ItemError = exports.vehicleSizeLabels = exports.MAX_VEHICLES = exports.MAX_ITEMS = void 0;
exports.parseOwnerItems = parseOwnerItems;
exports.catalogItems = catalogItems;
exports.itemSummary = itemSummary;
exports.itemInvoiceLines = itemInvoiceLines;
exports.itemsOf = itemsOf;
// An appointment can cover several services, for one vehicle or several. Each item is one service on
// one vehicle. The appointment's service and vehicle strings stay as readable summaries of the items,
// so emails, the calendar event, search, client history and the maintenance check keep working unchanged.
const appointment_booking_1 = require("./appointment-booking");
exports.MAX_ITEMS = 12;
exports.MAX_VEHICLES = 4;
exports.vehicleSizeLabels = { sedan: "Sedan / coupe", suv_truck: "SUV / truck", van_3row: "Van / 3-row SUV" };
class ItemError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
exports.ItemError = ItemError;
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const whole = (value, min, max) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
// Every vehicle index from 0 up must be used, so "vehicle 2" never appears without a vehicle 1.
function checkVehicles(items) {
    const used = new Set(items.map(item => item.vehicleIndex));
    for (let index = 0; index < used.size; index++)
        if (!used.has(index))
            throw new ItemError("invalid_items");
}
// Owner-entered items: free names, prices and lengths, optionally tied to a catalog service.
function parseOwnerItems(input) {
    if (!Array.isArray(input) || !input.length || input.length > exports.MAX_ITEMS)
        throw new ItemError("invalid_items");
    const items = input.map(row => {
        if (!row || typeof row !== "object")
            throw new ItemError("invalid_items");
        const value = row;
        const name = text(value.name, 100);
        const cents = value.cents ?? null;
        const vehicleType = (0, appointment_booking_1.bookingVehicle)(value.vehicleType);
        if (!name || !whole(value.vehicleIndex ?? 0, 0, exports.MAX_VEHICLES - 1) || !whole(value.minutes, 0, 1440) ||
            (cents !== null && !whole(cents, 0, 10000000)) || (value.vehicleType && !vehicleType))
            throw new ItemError("invalid_items");
        const serviceId = text(value.serviceId, 31);
        return {
            ...(serviceId ? { serviceId } : {}), name, vehicleIndex: (value.vehicleIndex ?? 0),
            ...(vehicleType ? { vehicleType } : {}), vehicle: text(value.vehicle, 150), cents: cents, minutes: value.minutes,
        };
    });
    checkVehicles(items);
    return shareVehicleDetails(items);
}
// Customer-chosen items: only catalog services, priced and timed by the catalog.
function catalogItems(input, catalog) {
    if (!Array.isArray(input) || !input.length || input.length > 8)
        throw new ItemError("invalid_items");
    const seen = new Set();
    const services = [];
    const items = input.map(row => {
        const value = (row && typeof row === "object" ? row : {});
        const service = catalog.find(item => item.id === value.serviceId);
        const vehicleIndex = value.vehicleIndex ?? 0;
        if (!service || !whole(vehicleIndex, 0, exports.MAX_VEHICLES - 1))
            throw new ItemError("invalid_items");
        const key = `${vehicleIndex}:${service.id}`;
        if (seen.has(key))
            throw new ItemError("invalid_items");
        seen.add(key);
        const vehicleType = (0, appointment_booking_1.bookingVehicle)(value.vehicleType);
        const prices = (0, appointment_booking_1.bookingPrices)(service);
        if ((value.vehicleType && !vehicleType) || (!vehicleType && new Set(Object.values(prices)).size > 1))
            throw new ItemError("vehicle_required");
        services.push(service);
        return {
            serviceId: service.id, name: service.name, vehicleIndex, ...(vehicleType ? { vehicleType } : {}),
            vehicle: text(value.vehicle, 150), cents: prices[vehicleType ?? "sedan"], minutes: service.duration,
        };
    });
    checkVehicles(items);
    // One vehicle can't be two sizes.
    for (const index of new Set(items.map(item => item.vehicleIndex))) {
        const sizes = new Set(items.filter(item => item.vehicleIndex === index && item.vehicleType).map(item => item.vehicleType));
        if (sizes.size > 1)
            throw new ItemError("invalid_items");
    }
    return { items: shareVehicleDetails(items), services };
}
// The vehicle description and size are typed once per vehicle; copy them to every item on it.
function shareVehicleDetails(items) {
    return items.map(item => {
        const same = items.filter(other => other.vehicleIndex === item.vehicleIndex);
        const vehicle = item.vehicle || same.find(other => other.vehicle)?.vehicle || "";
        const vehicleType = item.vehicleType ?? same.find(other => other.vehicleType)?.vehicleType;
        return { ...item, vehicle, ...(vehicleType ? { vehicleType } : {}) };
    });
}
const vehicleName = (item) => item.vehicle || (item.vehicleType ? exports.vehicleSizeLabels[item.vehicleType] : "") || `Vehicle ${item.vehicleIndex + 1}`;
exports.vehicleName = vehicleName;
// Readable service and vehicle lines for everything that shows an appointment as one row.
function itemSummary(items) {
    const vehicles = [...new Set(items.map(item => item.vehicleIndex))].sort((a, b) => a - b);
    const services = vehicles.length > 1
        ? vehicles.map(index => {
            const on = items.filter(item => item.vehicleIndex === index);
            return `${on.map(item => item.name).join(" + ")} (${(0, exports.vehicleName)(on[0])})`;
        }).join("; ")
        : items.map(item => item.name).join(" + ");
    const vehicle = vehicles.map(index => {
        const first = items.find(item => item.vehicleIndex === index);
        return vehicles.length > 1 ? (0, exports.vehicleName)(first) : first.vehicle || (first.vehicleType ? exports.vehicleSizeLabels[first.vehicleType] : "");
    }).filter(Boolean).join(" + ");
    const priced = items.filter(item => item.cents !== null);
    return {
        service: services.slice(0, 400) || "Detailing appointment",
        vehicle: vehicle.slice(0, 300),
        estimateCents: priced.length ? priced.reduce((total, item) => total + (item.cents ?? 0), 0) : null,
        minutes: items.reduce((total, item) => total + item.minutes, 0),
    };
}
// One invoice line per item. With more than one vehicle, each line names its vehicle.
function itemInvoiceLines(items) {
    const several = new Set(items.map(item => item.vehicleIndex)).size > 1;
    return items.map(item => ({ description: (several ? `${item.name} (${(0, exports.vehicleName)(item)})` : item.name).slice(0, 140), cents: item.cents ?? 0 }));
}
// Older appointments have no items: read their single service and vehicle as one.
function itemsOf(appointment) {
    if (appointment.items?.length)
        return appointment.items;
    return [{ name: appointment.service, vehicleIndex: 0, vehicle: appointment.vehicle ?? "", cents: appointment.estimateCents,
            minutes: Math.round((appointment.end - appointment.start) / 60000) }];
}
