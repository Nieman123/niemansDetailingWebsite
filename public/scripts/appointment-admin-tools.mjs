import { appointmentMoney, appointmentTime, easternStart, fillDurationSelect, taxOn, taxRateLabel, vehicleLabels } from "./appointment-utils.mjs";
import { jobPhotoBoard, jobPhotosSection } from "./appointment-photos.mjs";
import { standardServices } from "./service-picker.mjs";

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
// Current sales tax setting, loaded with the settings view and rechecked before a job is completed.
let salesTax = { enabled: false, rateBasisPoints: 0 };
const currentRate = () => salesTax.enabled ? salesTax.rateBasisPoints : 0;
async function freshTaxRate(request) {
  try { salesTax = await request("tax-settings"); } catch {}
  return currentRate();
}
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
  const action = (label, handler, className = "btn secondary") => {
    const button = Object.assign(elm("button", label, className), { type: "button" });
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
    const taxText = record.taxCents ? ` · Sales tax (${taxRateLabel(record.taxRateBasisPoints)}) ${appointmentMoney(record.taxCents)} · Total ${appointmentMoney(record.totalCents)}` : "";
    area.append(elm("p", `${record.taxCents ? "Subtotal" : "Final total"} ${appointmentMoney(record.finalCents)}${taxText} · Deposit credit ${appointmentMoney(record.paidDeposit)} · Remaining ${appointmentMoney(record.balanceCents)}`));
    if (record.maintenanceInviteQueued) area.append(elm("p", "Maintenance invitation prepared for this customer."));
    for (const entry of record.payments) {
      const line = elm("div", "", "appointment-actions");
      line.append(elm("span", `${readDay(entry.at)} · ${methodNames[entry.method] || entry.method} · ${appointmentMoney(entry.amount)}${entry.taxCents ? ` (incl. ${appointmentMoney(entry.taxCents)} tax)` : ""}${entry.clearance ? ` · ${entry.clearance}` : ""}`));
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
        const sendEmail = confirm("Email this invitation to the customer too? Cancel to create a share link only.");
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
      record.workNotes = draft.workNotes;
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
    }, "btn primary"));
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
      const rate = await freshTaxRate(request);
      if (rate && !confirm(`Add ${taxRateLabel(rate)} sales tax (${appointmentMoney(taxOn(cents(final.value), rate))}) to this invoice?`)) { message.textContent = ""; return; }
      await request("finish-job", {
        ...work(), finalCents: cents(final.value), scopeAccepted: accepted.checked, taxRateBasisPoints: rate,
        maintenanceInviteAfterPayment: autoInvite?.checked === true, ...(invoiceLines.length ? { invoiceLines } : {}),
      });
      pendingNotes.delete(record.id);
      await refresh();
    }, record.status === "in_progress" ? "btn primary" : "btn secondary"));
  }
  area.append(form, message, jobPhotosSection(record.id));
  return area;
}

// The owner's private notes on any appointment, at the top of the appointment detail. They are the same
// notes as the job screen's, autosave as you type, and never reach the customer.
export function privateNotesCard(record, request) {
  const card = elm("section", "", "job-card private-notes");
  const heading = elm("h4", "Private notes");
  const saveState = elm("span", "Saved", "job-save-state");
  heading.append(saveState);
  const notes = Object.assign(document.createElement("textarea"), {
    rows: 3, maxLength: 5000, placeholder: "Anything to remember about this appointment or customer.",
  });
  notes.setAttribute("aria-label", "Private notes");
  const current = () => pendingNotes.get(record.id)?.workNotes ?? record.workNotes ?? "";
  notes.value = current();
  card.append(heading, notes, elm("p", "Only you see these. They never go to the customer.", "private-notes__hint"));

  async function save(draft) {
    // A job screen draft also carries scope changes; save those with it while the job is open.
    const job = "scopeChanges" in draft && ["confirmed", "in_progress"].includes(record.status);
    const previous = noteSaves.get(record.id) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      await request(job ? "save-job" : "save-notes", job ? draft : { id: record.id, workNotes: draft.workNotes });
      if (pendingNotes.get(record.id) === draft) pendingNotes.delete(record.id);
    });
    noteSaves.set(record.id, run);
    try { await run; }
    finally { if (noteSaves.get(record.id) === run) noteSaves.delete(record.id); }
  }
  let autosave;
  function queueSave() {
    const draft = { ...pendingNotes.get(record.id), id: record.id, workNotes: notes.value };
    pendingNotes.set(record.id, draft);
    record.workNotes = draft.workNotes;
    clearTimeout(autosave);
    saveState.textContent = "Saving…";
    saveState.dataset.state = "pending";
    autosave = setTimeout(async () => {
      if (!notes.isConnected || pendingNotes.get(record.id) !== draft) return;
      try { await save(draft); saveState.textContent = "Saved"; delete saveState.dataset.state; }
      catch { saveState.textContent = "Not saved, retrying"; saveState.dataset.state = "error"; setTimeout(() => { if (notes.isConnected) queueSave(); }, 5000); }
    }, 900);
  }
  notes.oninput = queueSave;
  // Called when coming back from the job screen, where the same notes may have changed.
  card.sync = () => {
    notes.value = current();
    if (!pendingNotes.has(record.id)) { clearTimeout(autosave); saveState.textContent = "Saved"; delete saveState.dataset.state; }
  };
  return card;
}

// Quote add-on prices by vehicle size, in dollars, matching the quote form.
const addOnPrices = {
  "Pet hair": { sedan: 30, suv_truck: 40, van_3row: 50 },
  "Heavy soil": { sedan: 40, suv_truck: 60, van_3row: 80 },
  "Wax / sealant": { sedan: 25, suv_truck: 30, van_3row: 35 },
  "Odor / ozone": { sedan: 35, suv_truck: 45, van_3row: 55 },
  "Engine bay": { sedan: 25, suv_truck: 25, van_3row: 30 },
  "Headlights": { sedan: 75, suv_truck: 85, van_3row: 95 },
};
const noteChips = ["Pet hair", "Heavy soil", "Stains noted", "Paint damage noted", "Customer not home", "Keys with customer", "No water access", "No power access"];
const vehicleSize = text => /van|3-row|three-row|minivan|full-size/i.test(text) ? "van_3row" : /suv|truck|crossover|4runner|tahoe|pickup/i.test(text) ? "suv_truck" : "sedan";
const elapsed = ms => {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${String(minutes % 60).padStart(2, "0")} min`;
};

// The on-site job screen for confirmed and in-progress appointments: big targets, autosaving notes,
// one-tap photos, and a closeout builder that adds up line items instead of free-typed text.
export function jobScreen(record, request, refresh, report) {
  const screen = elm("div", "", "job-screen");
  const started = record.status === "in_progress";
  const size = vehicleSize(record.vehicle || "");

  const hero = elm("div", "", "job-hero");
  const clock = elm("p", "", "job-clock");
  const tick = () => {
    clock.textContent = started && record.startedAt ? `On the clock · ${elapsed(Date.now() - record.startedAt)}` : `Scheduled · ${appointmentTime(record)}`;
  };
  tick();
  if (started && record.startedAt) {
    const timer = setInterval(() => { if (!clock.isConnected) clearInterval(timer); else tick(); }, 30000);
  }
  hero.append(clock, elm("p", [record.vehicle, record.service].filter(Boolean).join(" · "), "job-vehicle"));
  if (record.preparation) hero.append(elm("p", record.preparation, "job-prep"));
  const contact = elm("div", "", "job-contact");
  const link = (label, href, external) => {
    const anchor = elm("a", label, "job-contact__link");
    anchor.href = href;
    if (external) Object.assign(anchor, { target: "_blank", rel: "noopener noreferrer" });
    contact.append(anchor);
  };
  if (record.address) link("Directions", "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(record.address), true);
  if (record.phone) { link("Call", "tel:" + record.phone); link("Text", "sms:" + record.phone); }
  if (contact.childElementCount) hero.append(contact);
  screen.append(hero);

  const message = elm("p", "", "job-status-line");
  message.setAttribute("role", "status");
  let busy = false;
  const run = async (button, handler) => {
    if (busy) return;
    busy = button.disabled = true;
    message.textContent = "Saving…";
    try { await handler(); }
    catch (error) { message.textContent = error.code ? report(error) : error.message; }
    finally { busy = button.disabled = false; }
  };

  // Notes autosave while you type, and survive moving between views.
  const pending = pendingNotes.get(record.id);
  const notesCard = elm("section", "", "job-card");
  notesCard.append(elm("h4", "Private notes"));
  const saveState = elm("span", "Saved", "job-save-state");
  notesCard.querySelector("h4").append(saveState);
  const notes = Object.assign(document.createElement("textarea"), { rows: 4, maxLength: 5000, value: pending?.workNotes ?? record.workNotes ?? "", placeholder: "What you noticed, what you did, anything for next time." });
  notes.setAttribute("aria-label", "Private job notes");
  const chips = elm("div", "", "job-chips");
  for (const label of noteChips) {
    const chip = Object.assign(elm("button", "+ " + label, "job-chip"), { type: "button" });
    chip.onclick = () => {
      notes.value = (notes.value.trim() ? notes.value.trimEnd() + "\n" : "") + "• " + label;
      notes.dispatchEvent(new Event("input"));
    };
    chips.append(chip);
  }
  const changes = Object.assign(document.createElement("textarea"), { rows: 2, maxLength: 1500, value: pending?.scopeChanges ?? record.scopeChanges ?? "", placeholder: "Anything added or changed with the customer's OK." });
  changes.setAttribute("aria-label", "Agreed scope changes");
  notesCard.append(notes, chips, elm("label", "Agreed scope changes", "job-label"), changes);
  screen.append(notesCard);

  const work = () => ({ id: record.id, workNotes: notes.value, scopeChanges: changes.value });
  let autosave;
  async function saveNotes(draft) {
    const previous = noteSaves.get(record.id) ?? Promise.resolve();
    const save = previous.catch(() => {}).then(async () => {
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
    record.workNotes = draft.workNotes;
    clearTimeout(autosave);
    saveState.textContent = "Saving…";
    saveState.dataset.state = "pending";
    autosave = setTimeout(async () => {
      if (!notes.isConnected || pendingNotes.get(record.id) !== draft) return;
      try { await saveNotes(draft); saveState.textContent = "Saved"; delete saveState.dataset.state; }
      catch { saveState.textContent = "Not saved, retrying"; saveState.dataset.state = "error"; setTimeout(queueSave, 5000); }
    }, 900);
  }
  notes.oninput = changes.oninput = queueSave;
  const flushNotes = async () => {
    clearTimeout(autosave);
    if (pendingNotes.has(record.id)) await saveNotes(pendingNotes.get(record.id));
    await noteSaves.get(record.id)?.catch(() => {});
  };

  screen.append(jobPhotoBoard(record.id));

  if (!started) {
    const startButton = Object.assign(elm("button", "Start job", "btn primary job-start"), { type: "button" });
    startButton.onclick = () => run(startButton, async () => {
      await flushNotes();
      await request("start-job", { id: record.id });
      await refresh();
    });
    screen.prepend(startButton);
    screen.append(message);
    return screen;
  }

  // Closeout: line items with one-tap add-ons, running total, and the amount still due.
  const closeout = elm("section", "", "job-card job-closeout");
  closeout.append(elm("h4", "Finish and charge"));
  const lines = elm("div", "", "job-lines");
  const totalLine = elm("p", "", "job-total");
  const taxLine = elm("p", "", "job-due job-tax");
  const dueLine = elm("p", "", "job-due");
  const approval = elm("label", "", "appointment-checkbox job-approval");
  const approved = Object.assign(document.createElement("input"), { type: "checkbox" });
  approval.append(approved, elm("span", "Customer approved the higher total"));
  const invite = record.email && /\b(full detail|the works)\b/i.test(record.service) ? elm("label", "", "appointment-checkbox") : null;
  const inviteBox = Object.assign(document.createElement("input"), { type: "checkbox" });
  if (invite) invite.append(inviteBox, elm("span", "Email a monthly maintenance invite after full payment (customer agreed)"));

  function lineRow(description = "", dollars = "") {
    const row = elm("div", "", "job-line");
    const what = Object.assign(document.createElement("input"), { value: description, maxLength: 140, placeholder: "Description" });
    what.setAttribute("aria-label", "Line description");
    const amount = Object.assign(document.createElement("input"), { type: "number", step: "0.01", inputMode: "decimal", value: dollars, placeholder: "0.00" });
    amount.setAttribute("aria-label", "Line amount in dollars");
    const remove = Object.assign(elm("button", "×", "job-line__remove"), { type: "button" });
    remove.setAttribute("aria-label", "Remove line");
    remove.onclick = () => { row.remove(); update(); };
    what.oninput = amount.oninput = update;
    row.append(what, amount, remove);
    lines.append(row);
    return row;
  }
  const readLines = () => [...lines.children].map(row => {
    const [what, amount] = row.querySelectorAll("input");
    return { description: what.value.trim(), dollars: amount.value };
  }).filter(line => line.description || line.dollars);
  function update() {
    const total = readLines().reduce((sum, line) => sum + cents(line.dollars || 0), 0);
    const rate = currentRate();
    const tax = rate ? taxOn(total, rate) : 0;
    taxLine.hidden = !rate;
    taxLine.textContent = rate ? `Subtotal ${appointmentMoney(total)} · Sales tax (${taxRateLabel(rate)}) ${appointmentMoney(tax)}` : "";
    totalLine.textContent = "Total " + appointmentMoney(total + tax);
    const due = total + tax - (record.paidDeposit ?? 0);
    dueLine.textContent = (record.paidDeposit ? `Deposit ${appointmentMoney(record.paidDeposit)} applied · ` : "") + "Due now " + appointmentMoney(Math.max(0, due));
    approval.hidden = !(record.estimateCents != null && total > record.estimateCents);
    finish.textContent = "Complete job · collect " + appointmentMoney(Math.max(0, due));
    return total;
  }

  const saved = record.invoiceLines?.length ? record.invoiceLines : [{ description: record.service, cents: record.estimateCents ?? 0 }];
  saved.forEach(line => lineRow(line.description, line.cents ? (line.cents / 100).toFixed(2) : ""));
  const addOns = elm("div", "", "job-chips");
  for (const [label, prices] of Object.entries(addOnPrices)) {
    const chip = Object.assign(elm("button", `+ ${label} $${prices[size]}`, "job-chip job-chip--gold"), { type: "button" });
    chip.onclick = () => { lineRow(label, prices[size].toFixed(2)); update(); };
    addOns.append(chip);
  }
  const custom = Object.assign(elm("button", "+ Custom line", "job-chip"), { type: "button" });
  custom.onclick = () => { lineRow().querySelector("input").focus(); };
  addOns.append(custom);

  const finish = Object.assign(elm("button", "", "btn job-finish"), { type: "button" });
  finish.onclick = () => run(finish, async () => {
    const items = readLines();
    if (!items.length) throw new Error("Add at least one line.");
    const invoiceLines = items.map(line => {
      if (!line.description || line.dollars === "" || !Number.isFinite(Number(line.dollars))) throw new Error("Each line needs a description and an amount.");
      return { description: line.description, cents: cents(line.dollars) };
    });
    const total = invoiceLines.reduce((sum, line) => sum + line.cents, 0);
    if (total < (record.paidDeposit ?? 0)) throw new Error("The total can't be less than the deposit already paid.");
    const raised = record.estimateCents != null && total > record.estimateCents;
    if (raised && !approved.checked) { approval.querySelector("input").focus(); throw new Error("Confirm the customer approved the higher total."); }
    if (raised && !changes.value.trim()) {
      changes.value = "Added: " + invoiceLines.slice(1).map(line => `${line.description} ${appointmentMoney(line.cents)}`).join(", ");
    }
    // Recheck the tax setting so the amount confirmed here is the amount the server charges.
    const rate = await freshTaxRate(request);
    update();
    const tax = rate ? taxOn(total, rate) : 0;
    const summary = rate ? `${appointmentMoney(total)} plus ${appointmentMoney(tax)} sales tax (${appointmentMoney(total + tax)} total)` : appointmentMoney(total);
    if (!confirm(`Complete this job with a total of ${summary}?`)) { message.textContent = ""; return; }
    await flushNotes();
    await request("finish-job", {
      ...work(), finalCents: total, scopeAccepted: approved.checked, invoiceLines, taxRateBasisPoints: rate,
      maintenanceInviteAfterPayment: invite ? inviteBox.checked : false,
    });
    pendingNotes.delete(record.id);
    await refresh();
  });

  closeout.append(lines, addOns, taxLine, totalLine, dueLine, approval);
  if (invite) closeout.append(invite);
  screen.append(closeout);
  const bar = elm("div", "", "job-finish-bar");
  bar.append(message, finish);
  screen.append(bar);
  update();
  return screen;
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

const weekdayNames = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];

// Sales tax: off until turned on. The rate applies to invoices completed after saving.
export function setupTaxSettings(form, request, report) {
  if (form.dataset.bound) { form.dispatchEvent(new Event("reload-settings")); return; }
  form.dataset.bound = "1";
  const status = form.querySelector("[role=status]");
  const fields = form.elements;
  const button = form.querySelector("button[type=submit]");
  let revision = "";
  function load(settings) {
    salesTax = settings;
    revision = settings.revision ?? "";
    fields.enabled.checked = settings.enabled;
    fields.rate.value = (settings.rateBasisPoints / 100).toFixed(2).replace(/\.?0+$/, "");
    fields.taxId.value = settings.taxId ?? "";
    status.textContent = settings.enabled ? `Charging ${taxRateLabel(settings.rateBasisPoints)} sales tax on completed invoices.` : "Sales tax is off.";
  }
  const refresh = async () => {
    button.disabled = true;
    try { load(await request("tax-settings")); button.disabled = false; }
    catch (error) { status.textContent = report(error); }
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const rateBasisPoints = Math.round(Number(fields.rate.value) * 100);
    if (fields.enabled.checked && !salesTax.enabled && !confirm(`Charge ${taxRateLabel(rateBasisPoints)} sales tax on every invoice completed from now on?`)) return;
    button.disabled = true;
    try {
      load(await request("save-tax-settings", { revision, enabled: fields.enabled.checked, rateBasisPoints, taxId: fields.taxId.value.trim() }));
      status.textContent = "Saved. " + status.textContent;
    } catch (error) { status.textContent = report(error); }
    finally { button.disabled = false; }
  });
  form.addEventListener("reload-settings", refresh);
  void refresh();
}

// Day-before reminders and review requests, sent by the 5-minute maintenance job.
export function setupFollowUpSettings(form, request, report) {
  if (!form) return;
  if (form.dataset.bound) { form.dispatchEvent(new Event("reload-settings")); return; }
  form.dataset.bound = "1";
  const status = form.querySelector("[role=status]");
  const fields = form.elements;
  const button = form.querySelector("button[type=submit]");
  let revision = "";
  const sync = () => { fields.reviewUrl.required = fields.reviewRequests.checked; };
  fields.reviewRequests.addEventListener("change", sync);
  function load(settings) {
    revision = settings.revision ?? "";
    fields.reminders.checked = settings.reminders;
    fields.reviewRequests.checked = settings.reviewRequests;
    fields.reviewUrl.value = settings.reviewUrl ?? "";
    sync();
    status.textContent = [settings.reminders ? "Reminders on." : "Reminders off.",
      settings.reviewRequests ? "Review requests on." : "Review requests off."].join(" ");
  }
  const refresh = async () => {
    button.disabled = true;
    try { load(await request("follow-up-settings")); button.disabled = false; }
    catch (error) { status.textContent = report(error); }
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    button.disabled = true;
    try {
      load(await request("save-follow-up-settings", { revision, reminders: fields.reminders.checked,
        reviewRequests: fields.reviewRequests.checked, reviewUrl: fields.reviewUrl.value.trim() }));
      status.textContent = "Saved. " + status.textContent;
    } catch (error) { status.textContent = report(error); }
    finally { button.disabled = false; }
  });
  form.addEventListener("reload-settings", refresh);
  void refresh();
}

export function setupBookingSettings(form, request, report) {
  if (form.dataset.bound) { form.dispatchEvent(new Event("reload-settings")); return; }
  form.dataset.bound = "1";
  const status = form.querySelector("[role=status]");
  const fields = form.elements;
  let revision;
  const rows = document.getElementById("service-rows");
  const week = document.getElementById("weekly-hours");

  // One row per weekday: open toggle plus start and end times.
  const dayRows = new Map(weekdayNames.map(([day, label]) => {
    const row = elm("div", "", "weekly-hours__row");
    const toggle = elm("label", "", "appointment-checkbox weekly-hours__day");
    const open = Object.assign(document.createElement("input"), { type: "checkbox" });
    toggle.append(open, elm("span", label));
    const time = (title) => {
      const field = elm("label", "", "field");
      const input = Object.assign(document.createElement("input"), { type: "time", step: 900 });
      field.append(elm("span", title, "sr-only"), input);
      input.setAttribute("aria-label", `${label} ${title.toLowerCase()}`);
      return [field, input];
    };
    const [startField, start] = time("Start");
    const [endField, end] = time("End");
    const sync = () => { row.classList.toggle("is-closed", !open.checked); start.disabled = end.disabled = !open.checked; start.required = end.required = open.checked; };
    open.addEventListener("change", sync);
    row.append(toggle, startField, elm("span", "to", "weekly-hours__to"), endField);
    week.append(row);
    return [day, { open, start, end, sync }];
  }));
  document.getElementById("copy-weekday-hours").onclick = () => {
    const monday = dayRows.get(1);
    for (const day of [2, 3, 4, 5]) {
      const row = dayRows.get(day);
      row.open.checked = monday.open.checked;
      row.start.value = monday.start.value;
      row.end.value = monday.end.value;
      row.sync();
    }
  };

  function addServiceRow(service = {}) {
    const row = document.createElement("div");
    row.className = "service-row";
    const info = document.createElement("div");
    const pricing = document.createElement("div");
    info.className = "service-fields";
    pricing.className = "service-prices";
    function control(parent, key, title, input, required = true) {
      const label = document.createElement("label");
      label.className = "field";
      input.dataset.key = key;
      input.required = required;
      label.append(elm("span", title), input);
      parent.append(label);
      return input;
    }
    const name = control(info, "name", "Service name", document.createElement("input"));
    name.value = service.name || "";
    name.maxLength = 100;
    const code = control(info, "id", "Service code", document.createElement("input"));
    code.value = service.id || "";
    code.pattern = "[a-z][a-z0-9_\\-]{0,30}";
    code.placeholder = "full";
    code.title = "Use the same service code as the quote form to carry its estimate into booking.";
    const length = control(info, "duration", "Appointment length", document.createElement("select"));
    fillDurationSelect(length, service.duration || 60, 30, 720);
    for (const [key, label] of Object.entries(vehicleLabels)) {
      const price = control(pricing, key, label + " ($)", document.createElement("input"));
      Object.assign(price, { type: "number", min: "50", max: "100000", step: ".01", inputMode: "decimal" });
      const amount = service.vehiclePrices?.[key] ?? service.cents;
      price.value = amount == null ? "" : (amount / 100).toFixed(2);
    }
    const extra = elm("div", "", "service-extra");
    const description = control(extra, "description", "Short description (optional)", document.createElement("input"), false);
    description.maxLength = 140;
    description.value = service.description || "";
    const featureLabel = elm("label", "", "appointment-checkbox");
    const featured = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!service.featured });
    featured.dataset.key = "featured";
    featureLabel.append(featured, elm("span", "Featured on the booking page"));
    extra.append(featureLabel);
    row.append(info, pricing, extra);
    const remove = Object.assign(document.createElement("button"), { type: "button", className: "btn secondary btn-remove", textContent: "Remove service" });
    remove.onclick = () => row.remove();
    row.append(remove); rows.append(row);
    return row;
  }
  document.getElementById("add-service").onclick = () => addServiceRow().querySelector("input").focus();
  document.getElementById("add-standard-services").onclick = () => {
    const codes = new Set([...rows.querySelectorAll('[data-key="id"]')].map(input => input.value.trim()));
    const added = standardServices.filter(service => !codes.has(service.id));
    added.forEach(service => addServiceRow(service));
    status.textContent = added.length
      ? `Added ${added.length} service${added.length === 1 ? "" : "s"}. Check the lengths and prices, then save.`
      : "Your standard services are already listed.";
  };

  function load(settings) {
    for (const name of ["minimumHours", "horizonDays", "bufferMinutes"]) fields[name].value = settings[name];
    fields.enabled.checked = settings.enabled;
    for (const [day, row] of dayRows) {
      const hours = settings.hours?.[String(day)] ?? { open: settings.open, close: settings.close };
      row.open.checked = settings.days.includes(day);
      row.start.value = hours.open;
      row.end.value = hours.close;
      row.sync();
    }
    fields.blockedDates.value = settings.blockedDates.join(", ");
    fields.postalCodes.value = settings.postalCodes.join(", ");
    rows.replaceChildren();
    settings.services.forEach(addServiceRow);
    revision = settings.revision;
    form.dispatchEvent(new CustomEvent("booking-settings-loaded", { bubbles: true, detail: settings }));
  }
  const button = form.querySelector("button[type=submit]");
  const refresh = async () => {
    button.disabled = true;
    try { load(await request("booking-settings")); button.disabled = false; }
    catch (error) { status.textContent = report(error); }
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const parseList = value => value.split(/[,\s]+/).filter(Boolean);
    const input = Object.fromEntries(new FormData(form));
    const openDays = [...dayRows].filter(([, row]) => row.open.checked);
    const badDay = openDays.find(([, row]) => !row.start.value || !row.end.value || row.start.value >= row.end.value);
    if (badDay) {
      status.textContent = "Each open day needs an end time after its start time.";
      badDay[1].start.focus();
      return;
    }
    const hours = Object.fromEntries(openDays.map(([day, row]) => [String(day), { open: row.start.value, close: row.end.value }]));
    const fallback = openDays[0]?.[1] ?? dayRows.get(1);
    const services = [...rows.children].map(row => {
      const values = Object.fromEntries([...row.querySelectorAll("[data-key]")].map(input => [input.dataset.key, input.type === "checkbox" ? input.checked : input.value.trim()]));
      const vehiclePrices = Object.fromEntries(Object.keys(vehicleLabels).map(key => [key, cents(values[key])]));
      return {
        id: values.id, name: values.name, duration: Number(values.duration), cents: vehiclePrices.sedan, vehiclePrices,
        ...(values.featured ? { featured: true } : {}), ...(values.description ? { description: values.description } : {}),
      };
    });
    button.disabled = true;
    try {
      const result = await request("save-booking-settings", {
        revision, enabled: fields.enabled.checked,
        days: openDays.map(([day]) => day), open: fallback.start.value || "09:00", close: fallback.end.value || "17:00", hours,
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
