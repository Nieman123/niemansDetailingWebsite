import { appointmentsPreview } from "./firebase-config.mjs";
const nav = document.querySelector(".work-nav");
nav.innerHTML = "<a href=\"/admin/appointments\" data-stage-nav ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M7 3v5m10-5v5M3 11h18\"/></svg>Appointments</a><a href=\"/admin\" ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 13l3-8h12l3 8v6H3z\"/><path d=\"M3 13h5l2 3h4l2-3h5\"/></svg>Leads</a><a href=\"/admin/clients\" ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 20v-2a6 6 0 0 1 12 0v2m4-1v-1a6 6 0 0 0-3-5m0-9a3 3 0 0 1 0 6\"/></svg>Clients</a><a href=\"/admin/invoices\" ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M6 2h9l5 5v15H6z\"/><path d=\"M14 2v6h6M9 13h8M9 17h5\"/></svg>Invoices</a><a href=\"/admin/content\" data-stage-nav ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 4h16v16H4zM8 8h8m-8 4h8m-8 4h4\"/></svg>Publishing</a><a href=\"/admin/health\" data-stage-nav ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 12h4l3-7 4 14 3-7h4\"/></svg>Health</a>";
const destinations = {appointments:"/admin/appointments",index:"/admin",clients:"/admin/clients",invoices:"/admin/invoices",content:"/admin/content",blog:"/admin/content",health:"/admin/health"};
nav.querySelector('a[href="' + destinations[nav.dataset.section] + '"]')?.setAttribute("aria-current", "page");
for (const link of document.querySelectorAll("[data-stage-nav]")) {
  if (!appointmentsPreview) {
    if (link.closest(".work-nav") && link.textContent === "Publishing") link.href = "/admin/blog";
    else link.hidden = true;
  }
}
if (!appointmentsPreview) document.querySelector("[data-work-home]").href = "/admin";

const directory = document.querySelector("#admin-view .sidebar");
const detail = document.querySelector("#admin-view .main");
if (directory && detail) {
  const mobile = window.matchMedia("(max-width: 800px)");
  const back = Object.assign(document.createElement("button"), {type:"button", className:"mobile-list-back", textContent:"‹ " + (document.body.dataset.records || "Back to list")});
  detail.prepend(back);
  let selected;
  function openRecord(button) {
    if (!mobile.matches) return;
    selected = button;
    document.body.dataset.recordOpen = "true";
    back.focus();
    window.scrollTo(0,0);
  }
  document.addEventListener("click", event => {
    const button = event.target.closest(".lead-item, .client-item, .followup-open-btn, #post-list li, #new-post-btn, #new-client-btn");
    if (button) openRecord(button);
  });
  back.onclick = () => {
    delete document.body.dataset.recordOpen;
    (selected?.isConnected ? selected : directory.querySelector("input, button"))?.focus();
  };
  if (new URLSearchParams(location.search).has("id") || new URLSearchParams(location.search).has("fromLead")) {
    if (mobile.matches) document.body.dataset.recordOpen = "true";
  }
}

// Quick filter chips mirror a native <select>, so the existing filter code keeps working.
for (const row of document.querySelectorAll(".chip-filter[data-for]")) {
  const select = document.getElementById(row.dataset.for);
  if (!select) continue;
  const values = (row.dataset.values || "").split(",").filter(Boolean);
  const labels = (row.dataset.labels || "").split(",");
  const options = [...select.options].filter(option => !values.length || values.includes(option.value));
  const chips = options.map((option, index) => {
    const chip = Object.assign(document.createElement("button"), {type:"button", className:"chip-filter__chip", textContent: labels[index] || (option.value === "all" ? "All" : option.textContent)});
    chip.dataset.value = option.value;
    chip.onclick = () => { select.value = option.value; select.dispatchEvent(new Event("change", {bubbles:true})); };
    return chip;
  });
  row.setAttribute("role", "group");
  row.append(...chips);
  const sync = () => chips.forEach(chip => chip.setAttribute("aria-pressed", String(chip.dataset.value === select.value)));
  select.addEventListener("change", sync);
  // Clear filters sets the value without an event, so re-check after clicks too.
  document.addEventListener("click", () => setTimeout(sync));
  sync();
}

// Rarely used record sections start folded on phones.
if (window.matchMedia("(max-width: 800px)").matches) {
  for (const section of document.querySelectorAll("details[data-mobile-collapsed]")) section.open = false;
}
