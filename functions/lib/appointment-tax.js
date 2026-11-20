"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.taxLineLabel = exports.taxRateLabel = exports.taxOn = exports.defaultTaxSettings = exports.DEFAULT_TAX_RATE = void 0;
exports.parseTaxSettings = parseTaxSettings;
exports.taxPortion = taxPortion;
exports.DEFAULT_TAX_RATE = 700;
exports.defaultTaxSettings = { enabled: false, rateBasisPoints: exports.DEFAULT_TAX_RATE, taxId: "", revision: "" };
function parseTaxSettings(input) {
    const { enabled, rateBasisPoints, taxId } = input;
    if (typeof enabled !== "boolean" || typeof rateBasisPoints !== "number" || !Number.isInteger(rateBasisPoints) ||
        rateBasisPoints < 1 || rateBasisPoints > 2000)
        return null;
    const id = typeof taxId === "string" ? taxId.trim() : "";
    if (taxId !== undefined && typeof taxId !== "string" || id.length > 40 || (id && !/^[A-Za-z0-9][A-Za-z0-9 .\-]*$/.test(id)))
        return null;
    return { enabled, rateBasisPoints, taxId: id };
}
const taxOn = (cents, rateBasisPoints) => Math.max(0, Math.round(cents * rateBasisPoints / 10000));
exports.taxOn = taxOn;
const taxRateLabel = (rateBasisPoints) => `${(rateBasisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
exports.taxRateLabel = taxRateLabel;
const taxLineLabel = (rateBasisPoints) => `Sales tax (${(0, exports.taxRateLabel)(rateBasisPoints)})`;
exports.taxLineLabel = taxLineLabel;
// How much of a payment covers tax. Payments settle the service price first, then the tax, so a payment
// only counts toward tax once the subtotal is covered.
function taxPortion(finalCents, taxCents, paidBefore, amount) {
    const serviceOpen = Math.max(0, finalCents - paidBefore);
    return Math.min(taxCents, Math.max(0, amount - serviceOpen));
}
