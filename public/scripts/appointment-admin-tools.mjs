import { appointmentMoney, appointmentTime, easternStart } from "./appointment-utils.mjs";
import { jobPhotosSection } from "./appointment-photos.mjs";

export const statusLabels = {
  draft: "Draft / deposit required", awaiting_deposit: "Awaiting deposit", pending_approval: "Pending approval",
  confirmed: "Confirmed", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled", no_show: "No-show",
};
const elm = (tag, text, className = "") => Object.assign(document.createElement(tag), { textContent: text, className });
const cents = value => Math.round(Number(value) * 100);
const methodNames = { cash: "Cash", check: "Check", venmo: "Venmo", cash_app: "Cash App", other: "Other", stripe: "Stripe", reversal: "Reversal", check_cleared: "Check cleared", check_returned: "Check returned" };
const readDay = value => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "short" }).format(value);
const pendingNotes = new Map();
const noteSaves = new Map();
export const hasUnsavedJobNotes = () => pendingNotes.size > 0;
export const clearJobNotes = () => pendingNotes.clear();
window.addEventListener("beforeunload", event => {
  if (!pendingNotes.size) return;
  event.preventDefault();
  event.returnValue = "";
});

function inputField(form, name, label, attributes = {}, value = "") {
  const field = elm("label", "", attributes.type === "checkbox" ? "appointment-checkbox" : "field");
  const input = Object.assign(document.createElement(attributes.tag || "input"), { name }, attributes);
  input.value = value;
  field.append(elm("span", label), input);
  form.append(field);
  return input;
}

export function jobWorkspace(record, request, refresh, report) {
  const area = elm("details", "", "job-workspace");
  area.append(elm("summary", record.status === "completed" ? "View balance and payments" : "Open job workspace"));
  const directions = elm("a", "Directions");
  directions.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(record.address)}`;
  directions.target = "_blank";
  directions.rel = "noopener noreferrer";
  const contact = elm("div", "", "appointment-actions");
  contact.append(directions);
  if (record.phone) {
    for (const [label, scheme] of [["Call", "tel"], ["Text", "sms"]]) {
      const link = elm("a", label);
      link.href = `${scheme}:${record.phone}`;
      contact.append(link);
    }
  }
  area.append(contact, elm("p", `Service address: ${record.address}`));
  if (record.vehicle) area.append(elm("p", record.vehicle));

  const form = elm("form", "");
  const message = elm("p", "");
  message.setAttribute("role", "status");
  let busy = false;
  const action = (label, handler) => {
    const button = Object.assign(elm("button", label, "btn secondary"), { type: "button" });
    button.addEventListener("click", async () => {
      if (busy || !form.reportValidity()) return;
      busy = button.disabled = true;
      message.textContent = "Saving…";
      try { await handler(); }
      catch (error) { message.textContent = report(error); }
      finally { busy = button.disabled = false; }
    });
    return button;
  };

  if (record.status === "completed") {
    area.append(elm("p", `Final total ${appointmentMoney(record.finalCents)} · Deposit credit ${appointmentMoney(record.paidDeposit)} · Remaining ${appointmentMoney(record.balanceCents)}`));
    if (record.maintenanceInviteQueued) area.append(elm("p", "Maintenance invitation prepared for this customer."));
    for (const entry of record.payments) {
      const line = elm("div", "", "appointment-actions");
      line.append(elm("span", `${readDay(entry.at)} · ${methodNames[entry.method] || entry.method} · ${appointmentMoney(entry.amount)}${entry.clearance ? ` · ${entry.clearance}` : ""}`));
      const recordedManually = ["cash", "check", "venmo", "cash_app", "other"].includes(entry.method);
      const reversed = record.payments.some(other => other.method === "reversal" && other.reference === entry.id);
      if (entry.clearance === "pending") {
        for (const [label, cmd] of [["Mark cleared", "clear-check"], ["Mark returned", "return-check"]]) {
          line.append(action(label, async () => {
            await request(cmd, { id: record.id, paymentId: entry.id, requestId: crypto.randomUUID() });
            await refresh();
          }));
        }
      } else if (recordedManually && !reversed && entry.clearance !== "returned") {
        line.append(action("Reverse", async () => {
          if (!confirm("Reverse this manual payment in the ledger?")) return;
          await request("reverse-payment", { id: record.id, paymentId: entry.id, requestId: crypto.randomUUID() });
          await refresh();
        }));
      }
      area.append(line);
    }
    if (record.balanceCents > 0 && !record.payments.some(entry => entry.clearance === "pending")) {
      const method = inputField(form, "method", "Payment method", { tag: "select" });
      method.replaceChildren(...["cash", "check", "venmo", "cash_app", "other"].map(value => new Option(methodNames[value], value)));
      const amount = inputField(form, "amount", "Amount received ($)", { type: "number", min: .01, max: record.balanceCents / 100, step: .01, required: true }, (record.balanceCents / 100).toFixed(2));
      const reference = inputField(form, "reference", "Payment reference (optional)", { maxLength: 300 });
      const requestId = crypto.randomUUID();
      form.append(action("Record payment", async () => {
        await request("record-payment", { id: record.id, requestId, method: method.value, amountCents: cents(amount.value), reference: reference.value });
        await refresh();
      }));
    } else if (record.maintenanceEligible && !record.maintenanceInviteQueued) {
      form.append(action("Create monthly maintenance invitation", async () => {
        if (!confirm("I have the customer's permission to share a monthly maintenance invitation.")) return;
        const sendEmail = confirm("Queue this invitation for your staging email inbox? Cancel to create a share link only.");
        const { url } = await request("maintenance-invite", { id: record.id, permitted: true, sendEmail });
        const link = Object.assign(document.createElement("input"), { value: url, readOnly: true });
        link.setAttribute("aria-label", "Maintenance invitation link");
        const send = elm("a", "Open invitation email");
        send.href = `mailto:${encodeURIComponent(record.email).replace(/%40/g, "@")}?subject=${encodeURIComponent("Monthly detailing invitation")}&body=${encodeURIComponent(`Book ongoing maintenance after your full detail: ${url}`)}`;
        area.append(link, send);
        link.select();
        message.textContent = "Invitation link ready to share.";
      }));
    }
  } else {
    const pending = pendingNotes.get(record.id);
    const notes = inputField(form, "workNotes", "Private job notes", { tag: "textarea", rows: 3, maxLength: 5000 }, pending?.workNotes ?? record.workNotes);
    const changes = inputField(form, "scopeChanges", "Agreed scope changes", { tag: "textarea", rows: 2, maxLength: 1500 }, pending?.scopeChanges ?? record.scopeChanges);
    const final = inputField(form, "final", "Final total ($)", { type: "number", step: .01, min: record.paidDeposit / 100 },
      record.estimateCents == null ? "" : (record.estimateCents / 100).toFixed(2));
    const invoice = inputField(form, "invoice", "Itemized charges (optional)", { tag: "textarea", rows: 3, maxLength: 4200,
      placeholder: "Full detail | 300.00\nPet hair | 25.00\nDiscount | -10.00" });
    const accepted = inputField(form, "scopeAccepted", "Customer approved any price increase", { type: "checkbox" });
    const autoInvite = record.email && /\b(full detail|the works)\b/i.test(record.service)
      ? inputField(form, "maintenanceInviteAfterPayment", "Email a maintenance invitation after full payment (customer agreed)", { type: "checkbox" })
      : null;
    const work = () => ({ id: record.id, workNotes: notes.value, scopeChanges: changes.value });
    let autosave;
    async function saveNotes(draft) {
      const previous = noteSaves.get(record.id) ?? Promise.resolve();
      const save = previous.catch(() => {}).then(async () => {
        if (!form.isConnected) return;
        await request("save-job", draft);
        if (pendingNotes.get(record.id) === draft) pendingNotes.delete(record.id);
      });
      noteSaves.set(record.id, save);
      try { await save; }
      finally { if (noteSaves.get(record.id) === save) noteSaves.delete(record.id); }
    }
    function queueSave() {
      const draft = work();
      pendingNotes.set(record.id, draft);
      clearTimeout(autosave);
      message.textContent = "Changes pending.";
      autosave = setTimeout(async () => {
        if (!form.isConnected || pendingNotes.get(record.id) !== draft) return;
        try { await saveNotes(draft); message.textContent = "Notes saved."; }
        catch { message.textContent = "Notes aren't saved yet. Check your connection and try Save notes."; }
      }, 900);
    }
    notes.oninput = changes.oninput = queueSave;
    if (record.status === "confirmed") form.append(action("Start job", async () => {
      clearTimeout(autosave);
      if (pendingNotes.has(record.id)) await saveNotes(pendingNotes.get(record.id));
      await request("start-job", { id: record.id }); await refresh();
    }));
    form.append(action("Save notes", async () => {
      clearTimeout(autosave);
      await saveNotes(pendingNotes.get(record.id) ?? work());
      message.textContent = "Notes saved.";
    }), action("Complete job", async () => {
      if (!final.value) { final.focus(); message.textContent = "Enter the final total."; return; }
      clearTimeout(autosave);
      await noteSaves.get(record.id)?.catch(() => {});
      const invoiceLines = invoice.value.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const [description, price, extra] = line.split("|").map(value => value.trim());
        if (extra !== undefined || !description || !/^-?\d+(\.\d{1,2})?$/.test(price || "")) throw new Error("Enter each charge as Description | Amount.");
        return { description, cents: cents(price) };
      });
      await request("finish-job", {
        ...work(), finalCents: cents(final.value), scopeAccepted: accepted.checked,
        maintenanceInviteAfterPayment: autoInvite?.checked === true, ...(invoiceLines.length ? { invoiceLines } : {}),
      });
      pendingNotes.delete(record.id);
      await refresh();
    }));
  }
  area.append(form, message, jobPhotosSection(record.id));
  return area;
}

export function rescheduleWorkspace(record, request, refresh, report) {
  const area = elm("details", "");
  area.append(elm("summary", record.rescheduleRequest ? "Review customer’s request" : record.status === "pending_approval" ? "Offer a different time" : "Reschedule appointment"));
  const form = elm("form", "");
  const start = inputField(form, "start", "New time (Eastern)", { type: "datetime-local" });
  if (record.rescheduleRequest) {
    const requested = record.rescheduleRequest.start;
    form.prepend(elm("p", `Customer asked for ${appointmentTime({ start: requested, end: requested + record.end - record.start })}.`));
  }
  const message = elm("p", "");
  message.setAttribute("role", "status");
  const move = Object.assign(elm("button", record.status === "pending_approval" ? "Send or approve proposed time" : "Save appointment move", "btn secondary"), { type: "submit" });
  form.append(move, message);
  form.onsubmit = async event => {
    event.preventDefault();
    move.disabled = true;
    try {
      const proposed = start.value ? easternStart(start.value) : record.rescheduleRequest?.start;
      if (!proposed) { message.textContent = "Choose a proposed time."; return; }
      const action = record.status === "pending_approval" && record.rescheduleRequest?.start !== proposed ? "offer-alternate" : "reschedule";
      await request(action, { id: record.id, start: proposed });
      await refresh();
    } catch (error) { message.textContent = error.code ? report(error) : error.message; }
    finally { move.disabled = false; }
  };
  if (record.rescheduleRequest) {
    const reject = Object.assign(elm("button", "Decline requested move", "btn secondary"), { type: "button" });
    reject.onclick = async () => {
      reject.disabled = true;
      try { await request("reject-reschedule", { id: record.id }); await refresh(); }
      catch (error) { message.textContent = report(error); }
      finally { reject.disabled = false; }
    };
    form.append(reject);
  }
  area.append(form);
  return area;
}

export function setupBookingSettings(form, request, report) {
  if (form.dataset.bound) { form.dispatchEvent(new Event("reload-settings")); return; }
  form.dataset.bound = "1";
  const status = form.querySelector("[role=status]");
  const fields = form.elements;
  let revision;
  const rows = document.getElementById("service-rows");
  function addServiceRow(service = {}) {
    const row = document.createElement("div");
    row.className = "service-row";
    const definitions = [["name", "Service name", "text"], ["id", "Service code", "text"], ["duration", "Minutes", "number"], ["price", "Price ($)", "number"]];
    for (const [key, title, type] of definitions) {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.textContent = title;
      const input = document.createElement("input");
      Object.assign(input, {type, required: true, value: key === "price" ? (service.cents == null ? "" : (service.cents / 100).toFixed(2)) : service[key] ?? ""});
      input.dataset.key = key;
      if (key === "id") { input.pattern = "[a-z][a-z0-9_\\-]{0,30}"; input.placeholder = "full"; input.title = "Start with a lowercase letter. Use the quote service code to carry over estimates."; }
      if (key === "duration") { input.min = "30"; input.max = "720"; }
      if (key === "price") { input.min = "50"; input.max = "100000"; input.step = ".01"; }
      label.append(span, input); row.append(label);
    }
    const remove = Object.assign(document.createElement("button"), {type: "button", className: "quiet", textContent: "Remove service"});
    remove.onclick = () => row.remove();
    row.append(remove); rows.append(row);
    return row;
  }
  document.getElementById("add-service").onclick = () => addServiceRow().querySelector("input").focus();
  function load(settings) {
    for (const name of ["open", "close", "minimumHours", "horizonDays", "bufferMinutes"]) fields[name].value = settings[name];
    fields.enabled.checked = settings.enabled;
    for (const input of form.querySelectorAll('[name="weekday"]')) input.checked = settings.days.includes(Number(input.value));
    fields.blockedDates.value = settings.blockedDates.join(", ");
    fields.postalCodes.value = settings.postalCodes.join(", ");
    rows.replaceChildren();
    settings.services.forEach(addServiceRow);
    revision = settings.revision;
  }
  const button = form.querySelector("button[type=submit]");
  const refresh = async () => {
    button.disabled = true;
    try { load(await request("booking-settings")); button.disabled = false; }
    catch (error) { status.textContent = report(error); }
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    button.disabled = true;
    const parseList = value => value.split(/[,\s]+/).filter(Boolean);
    const input = Object.fromEntries(new FormData(form));
    const services = [...rows.children].map(row => {
      const values = Object.fromEntries([...row.querySelectorAll("input")].map(input => [input.dataset.key, input.value.trim()]));
      return { id: values.id, name: values.name, duration: Number(values.duration), cents: cents(values.price) };
    });
    try {
      const result = await request("save-booking-settings", {
        ...input, revision, enabled: fields.enabled.checked,
        days: [...form.querySelectorAll('[name="weekday"]:checked')].map(input => Number(input.value)),
        minimumHours: Number(input.minimumHours), horizonDays: Number(input.horizonDays), bufferMinutes: Number(input.bufferMinutes),
        blockedDates: parseList(input.blockedDates), postalCodes: parseList(input.postalCodes), services,
      });
      load(result);
      status.textContent = "Booking settings saved.";
    } catch (error) { status.textContent = report(error); }
    finally { button.disabled = false; }
  });
  form.addEventListener("reload-settings", refresh);
  void refresh();
}
