// Sales tax on detailing invoices. NC taxes motor vehicle detailing as a repair or maintenance service, so a
// single fixed combined rate (state + county) applies to the invoice subtotal. Off until the owner turns it on.
//
// Model: the deposit is a prepayment applied to the service price and carries no tax of its own. Tax is
// computed once on the final invoice subtotal when the job is completed and frozen on the appointment, so the
// customer owes subtotal + tax, and the balance due is that total minus the deposit and other payments.
export type TaxSettings = {
  enabled: boolean;
  // Hundredths of a percent: 700 is 7.00%, 675 is 6.75%.
  rateBasisPoints: number;
  // NCDOR sales and use tax account number shown on receipts. Optional.
  taxId: string;
  revision: string;
};

export const DEFAULT_TAX_RATE = 700;
export const defaultTaxSettings: TaxSettings = { enabled: false, rateBasisPoints: DEFAULT_TAX_RATE, taxId: "", revision: "" };

export function parseTaxSettings(input: Record<string, unknown>): Omit<TaxSettings, "revision"> | null {
  const { enabled, rateBasisPoints, taxId } = input;
  if (typeof enabled !== "boolean" || typeof rateBasisPoints !== "number" || !Number.isInteger(rateBasisPoints) ||
    rateBasisPoints < 1 || rateBasisPoints > 2000) return null;
  const id = typeof taxId === "string" ? taxId.trim() : "";
  if (taxId !== undefined && typeof taxId !== "string" || id.length > 40 || (id && !/^[A-Za-z0-9][A-Za-z0-9 .\-]*$/.test(id))) return null;
  return { enabled, rateBasisPoints, taxId: id };
}

export const taxOn = (cents: number, rateBasisPoints: number) => Math.max(0, Math.round(cents * rateBasisPoints / 10_000));

export const taxRateLabel = (rateBasisPoints: number) => `${(rateBasisPoints / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

export const taxLineLabel = (rateBasisPoints: number) => `Sales tax (${taxRateLabel(rateBasisPoints)})`;

// How much of a payment covers tax. Payments settle the service price first, then the tax, so a payment
// only counts toward tax once the subtotal is covered.
export function taxPortion(finalCents: number, taxCents: number, paidBefore: number, amount: number) {
  const serviceOpen = Math.max(0, finalCents - paidBefore);
  return Math.min(taxCents, Math.max(0, amount - serviceOpen));
}
