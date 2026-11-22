// Money and jobs report on the admin Dashboard: revenue, jobs, average ticket, sales tax and top services.
import { appointmentsEnabled, auth } from "./firebase-client.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { appointmentRequest } from "./appointment-utils.mjs";

const byId = id => document.getElementById(id);
const section = byId("reports");
const chart = byId("revenue-chart");
const periodButtons = [...document.querySelectorAll("#report-period [data-period]")];
let report = null;
let period = "month";
let scope = 0;
let scrolledToTax = false;

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const exact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const money = cents => dollars.format(Math.round(cents / 100));
const monthDate = month => new Date(`${month}-15T12:00:00Z`);
const monthName = (month, style = "long") => new Intl.DateTimeFormat("en-US", { month: style, year: "numeric", timeZone: "UTC" }).format(monthDate(month));
const shortMonth = month => new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(monthDate(month));
const element = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null && child !== ""));
  return node;
};

function total(months) {
  const sum = { revenueCents: 0, taxCents: 0, jobs: 0, services: new Map() };
  for (const month of months) {
    sum.revenueCents += month.revenueCents;
    sum.taxCents += month.taxCents;
    sum.jobs += month.jobs;
    for (const service of month.services) {
      const key = service.name.toLowerCase();
      const row = sum.services.get(key) ?? { name: service.name, jobs: 0, revenueCents: 0 };
      row.jobs += service.jobs;
      row.revenueCents += service.revenueCents;
      sum.services.set(key, row);
    }
  }
  return { ...sum, ticketCents: sum.jobs ? sum.revenueCents / sum.jobs : 0, services: [...sum.services.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.jobs - a.jobs) };
}

// The months in the chosen period, the months it is compared with, and how to describe both.
function periods() {
  const months = report.months;
  const last = months.length - 1;
  const year = report.currentMonth.slice(0, 4);
  if (period === "last") return { now: months.slice(last - 1, last), before: months.slice(last - 2, last - 1), label: monthName(months[last - 1].month), versus: "the month before" };
  if (period === "year") {
    const now = months.filter(month => month.month.startsWith(year));
    const before = months.filter(month => month.month.startsWith(String(Number(year) - 1)) && month.month.slice(5) <= report.currentMonth.slice(5));
    return { now, before, label: `${year} so far`, versus: `the same months of ${Number(year) - 1}` };
  }
  if (period === "12") return { now: months.slice(-12), before: months.slice(-24, -12), label: `${monthName(months[last - 11].month, "short")} to ${monthName(report.currentMonth, "short")}`, versus: "the 12 months before" };
  return { now: months.slice(last), before: months.slice(last - 1, last), label: `${monthName(report.currentMonth)} so far`, versus: "last month" };
}

function setTile(id, value, note) {
  const node = byId(id);
  node.querySelector("strong").textContent = value;
  node.querySelector("small").textContent = note;
}

function compare(now, before, format) {
  if (!before) return now ? "Nothing to compare with yet" : "";
  const change = Math.round((now - before) / before * 100);
  return `${change === 0 ? "Same as" : change > 0 ? `Up ${change}% from` : `Down ${-change}% from`} ${format(before)}`;
}

function renderTiles() {
  const { now, before, label, versus } = periods();
  const current = total(now);
  const previous = total(before);
  byId("report-range").textContent = `${label}, compared with ${versus}.`;
  setTile("tile-revenue", money(current.revenueCents), compare(current.revenueCents, previous.revenueCents, money));
  setTile("tile-jobs", String(current.jobs), compare(current.jobs, previous.jobs, String));
  setTile("tile-ticket", current.jobs ? money(current.ticketCents) : "None yet", compare(current.ticketCents, previous.ticketCents, money));
  setTile("tile-tax", exact.format(current.taxCents / 100), current.taxCents ? "Owed to the state for this period" : "No taxed work in this period");

  const list = byId("top-services");
  const top = current.services.slice(0, 6);
  const largest = Math.max(1, ...top.map(service => service.revenueCents));
  list.replaceChildren(...top.map(service => {
    const meter = element("div", { className: "meter" }, element("i"));
    meter.firstChild.style.width = `${Math.max(2, service.revenueCents / largest * 100)}%`;
    return element("li", {}, element("strong", { textContent: service.name }),
      element("span", { textContent: `${money(service.revenueCents)} · ${service.jobs} job${service.jobs === 1 ? "" : "s"}` }), meter);
  }));
  if (!top.length) list.append(element("li", { className: "health-empty", textContent: "No finished jobs in this period." }));
}

function renderChart() {
  const months = report.months.slice(-12);
  const largest = Math.max(1, ...months.map(month => month.revenueCents));
  const best = months.reduce((top, month) => month.revenueCents > top.revenueCents ? month : top, months[0]);
  const tip = element("div", { className: "revenue-tip", hidden: true });
  const bars = months.map(month => {
    const height = month.revenueCents / largest * 100;
    const bar = element("button", { type: "button", className: "revenue-bar" }, element("i"));
    bar.firstChild.style.height = `${height}%`;
    bar.dataset.current = String(month.month === report.currentMonth);
    bar.setAttribute("aria-label", `${monthName(month.month)}: ${money(month.revenueCents)}, ${month.jobs} job${month.jobs === 1 ? "" : "s"}`);
    // Label only the best month and this month, so the chart stays readable.
    if (month.revenueCents && (month === best || month.month === report.currentMonth)) {
      const label = element("b", { textContent: compact.format(month.revenueCents / 100) });
      label.style.bottom = `calc(${height}% + 4px)`;
      bar.append(label);
    }
    const show = () => {
      tip.replaceChildren(element("strong", { textContent: monthName(month.month) }),
        element("span", { textContent: `${exact.format(month.revenueCents / 100)} revenue` }),
        element("span", { textContent: `${month.jobs} job${month.jobs === 1 ? "" : "s"}${month.jobs ? `, ${money(month.revenueCents / month.jobs)} average` : ""}` }));
      const box = chart.getBoundingClientRect();
      const rect = bar.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2 - box.left, 72), box.width - 72);
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(0, box.height - (box.height - 24) * height / 100 - 8)}px`;
      tip.hidden = false;
    };
    bar.addEventListener("pointerenter", show);
    bar.addEventListener("focus", show);
    bar.addEventListener("pointerleave", () => { tip.hidden = true; });
    bar.addEventListener("blur", () => { tip.hidden = true; });
    return bar;
  });
  chart.replaceChildren(...bars, tip);
  const labels = element("div", { className: "revenue-labels", ariaHidden: "true" }, ...months.map(month => element("span", { textContent: shortMonth(month.month) })));
  chart.nextElementSibling?.classList.contains("revenue-labels") ? chart.nextElementSibling.replaceWith(labels) : chart.after(labels);

  byId("report-rows").replaceChildren(...[...months].reverse().map(month => element("tr", {},
    element("th", { scope: "row", textContent: monthName(month.month, "short") }),
    element("td", { textContent: exact.format(month.revenueCents / 100) }),
    element("td", { textContent: String(month.jobs) }),
    element("td", { textContent: month.jobs ? exact.format(month.revenueCents / month.jobs / 100) : "–" }),
    element("td", { textContent: exact.format(month.taxCents / 100) }))));
}

function render() {
  renderTiles();
  renderChart();
  renderTax();
}

// ---------- Sales tax filing ----------
const tax = {
  frequency: byId("tax-frequency"), period: byId("tax-period"), callout: byId("tax-callout"), summary: byId("tax-summary"),
  copy: byId("tax-copy"), csv: byId("tax-csv"), filed: byId("tax-filed"), status: byId("tax-status"), note: byId("tax-note"),
};
const dayLabel = date => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const cents = value => exact.format(value / 100);
let selectedPeriod = null;

function chosenPeriod() {
  const periods = report.salesTax.periods;
  return periods.find(period => period.key === selectedPeriod) ?? null;
}

function renderTax() {
  const { salesTax } = report;
  tax.frequency.value = salesTax.frequency;
  const periods = salesTax.periods;
  const toFile = periods.filter(period => period.needsFiling).sort((a, b) => a.due.localeCompare(b.due));
  const open = periods.find(period => !period.ended);
  // Default to the oldest return still to file, otherwise the most recent finished period.
  if (!periods.some(period => period.key === selectedPeriod)) selectedPeriod = (toFile[0] ?? periods.find(period => period.ended) ?? periods[0])?.key ?? null;
  tax.period.replaceChildren(...periods.map(period => element("option", { value: period.key,
    textContent: `${period.label}${!period.ended ? " (in progress)" : period.filedAt ? " · filed" : period.overdue ? " · overdue" : period.needsFiling ? " · to file" : ""}` })));
  tax.period.value = selectedPeriod ?? "";

  const callout = tax.callout;
  const next = toFile[0];
  if (!salesTax.frequencyChosen) {
    callout.dataset.tone = "warning";
    callout.querySelector("strong").textContent = "Choose how often you file";
    callout.querySelector("span").textContent = "Pick monthly, quarterly or yearly above to match your NCDOR filing schedule. You'll get a Telegram reminder a week before each return is due.";
  } else if (next) {
    callout.dataset.tone = next.overdue ? "error" : "warning";
    callout.querySelector("strong").textContent = `${next.label} return ${next.overdue ? "was due" : "is due"} ${dayLabel(next.due)}`;
    callout.querySelector("span").textContent = `${cents(next.taxCents)} in sales tax on ${cents(next.taxableCents)} of taxable sales.${toFile.length > 1 ? ` ${toFile.length - 1} more period${toFile.length === 2 ? "" : "s"} not marked filed.` : ""} Mark it filed once you've sent it to NCDOR.`;
  } else {
    callout.dataset.tone = "ok";
    callout.querySelector("strong").textContent = "You're caught up";
    callout.querySelector("span").textContent = open ? `Next return: ${open.label}, due ${dayLabel(open.due)}. ${cents(open.taxCents)} collected so far.` : "Every finished period is marked filed.";
  }
  tax.note.textContent = [
    salesTax.enabled ? "" : "Sales tax is turned off in Settings, so new jobs aren't charging tax.",
    "Due dates follow NCDOR: monthly returns by the 20th of the next month, quarterly by the last day of the month after the quarter, yearly by January 31. If a due date lands on a weekend or holiday, it moves to the next business day.",
    "Amounts are what you billed, by the month the job was finished or the invoice issued, including anything not paid yet.",
  ].filter(Boolean).join(" ");
  renderTaxPeriod();
}

function renderTaxPeriod() {
  const period = chosenPeriod();
  tax.status.textContent = "";
  [tax.copy, tax.csv, tax.filed].forEach(button => { button.disabled = !period; });
  if (!period) { tax.summary.replaceChildren(); return; }
  const item = (label, value, key = false) => {
    const node = element("div", {}, element("dt", { textContent: label }), element("dd", { textContent: value }));
    if (key) node.className = "tax-key";
    return node;
  };
  tax.summary.replaceChildren(
    item("Gross sales", cents(period.grossCents)),
    item("Taxable sales", cents(period.taxableCents)),
    item("Exempt or untaxed", cents(period.exemptCents)),
    item("Sales tax collected", cents(period.taxCents), true),
    item("Jobs", String(period.jobs)),
    item(period.filedAt ? "Filed" : "Due", period.filedAt ? when.format(period.filedAt) : dayLabel(period.due)),
  );
  tax.filed.hidden = !period.ended;
  tax.filed.textContent = period.filedAt ? "Mark as not filed" : "Mark as filed";
}
const when = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });

function summaryText(period) {
  const { salesTax } = report;
  return [
    `Sales tax summary: ${period.label}`,
    `Period: ${period.months[0]} to ${period.months[period.months.length - 1]}`,
    `Gross sales: ${cents(period.grossCents)}`,
    `Taxable sales: ${cents(period.taxableCents)}`,
    `Exempt or untaxed sales: ${cents(period.exemptCents)}`,
    `Sales tax collected: ${cents(period.taxCents)}${salesTax.rateBasisPoints ? ` (rate ${(salesTax.rateBasisPoints / 100).toFixed(2)}%)` : ""}`,
    `Jobs: ${period.jobs}`,
    `Due: ${dayLabel(period.due)}`,
    salesTax.taxId ? `NC account ID: ${salesTax.taxId}` : null,
    ...(period.byMonth.length > 1 ? ["", "By month:", ...period.byMonth.map(row => `${monthName(row.month)}: gross ${cents(row.grossCents)}, taxable ${cents(row.taxableCents)}, tax ${cents(row.taxCents)}`)] : []),
  ].filter(line => line !== null).join("\n").replace(/\n{3,}/g, "\n\n");
}

tax.period.addEventListener("change", () => { selectedPeriod = tax.period.value; renderTaxPeriod(); });
tax.copy.addEventListener("click", async () => {
  const period = chosenPeriod();
  if (!period) return;
  try { await navigator.clipboard.writeText(summaryText(period)); tax.status.textContent = "Summary copied."; }
  catch { tax.status.textContent = "Couldn't copy. Try Download CSV instead."; }
});
tax.csv.addEventListener("click", () => {
  const period = chosenPeriod();
  if (!period) return;
  const amount = value => (value / 100).toFixed(2);
  const rows = [["month", "gross_sales", "taxable_sales", "exempt_sales", "sales_tax", "jobs"],
    ...period.byMonth.map(row => [row.month, amount(row.grossCents), amount(row.taxableCents), amount(row.grossCents - row.taxableCents), amount(row.taxCents), row.jobs]),
    ["total", amount(period.grossCents), amount(period.taxableCents), amount(period.exemptCents), amount(period.taxCents), period.jobs]];
  const link = element("a", { href: URL.createObjectURL(new Blob([rows.map(row => row.join(",")).join("\r\n")], { type: "text/csv" })),
    download: `sales-tax-${period.key}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

async function saveFiling(change, done) {
  const session = scope;
  tax.frequency.disabled = tax.filed.disabled = true;
  try {
    const result = await appointmentRequest("save-tax-filing", change, await auth.currentUser?.getIdToken());
    if (session !== scope) return;
    report = result;
    render();
    tax.status.textContent = done;
  } catch {
    tax.status.textContent = "Couldn't save. Try again.";
    if (report) tax.frequency.value = report.salesTax.frequency;
  } finally { tax.frequency.disabled = false; tax.filed.disabled = !chosenPeriod(); }
}
tax.frequency.addEventListener("change", () => { selectedPeriod = null; saveFiling({ frequency: tax.frequency.value }, "Filing schedule saved."); });
tax.filed.addEventListener("click", () => {
  const period = chosenPeriod();
  if (period) saveFiling({ period: period.key, filed: !period.filedAt }, period.filedAt ? `${period.label} marked not filed.` : `${period.label} marked filed.`);
});

for (const button of periodButtons) {
  button.addEventListener("click", () => {
    period = button.dataset.period;
    periodButtons.forEach(other => other.setAttribute("aria-pressed", String(other === button)));
    if (report) renderTiles();
  });
}

async function load() {
  const session = scope;
  try {
    const result = await appointmentRequest("business-report", {}, await auth.currentUser?.getIdToken());
    if (session !== scope) return;
    report = result;
    render();
    section.hidden = false;
    if (location.hash === "#sales-tax" && !scrolledToTax) { scrolledToTax = true; byId("sales-tax").scrollIntoView(); }
  } catch {
    // The health section below explains sign-in and access problems, so the report just stays hidden.
    if (session === scope && !report) section.hidden = true;
  }
}

byId("refresh-health")?.addEventListener("click", () => { if (auth.currentUser) load(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && report) load(); });

if (appointmentsEnabled) {
  onAuthStateChanged(auth, user => {
    ++scope;
    report = null;
    section.hidden = true;
    if (user) load();
  });
}
