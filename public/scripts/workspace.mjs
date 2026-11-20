import { appointmentsPreview } from "./firebase-config.mjs";
const nav = document.querySelector(".work-nav");
nav.innerHTML = "<a href=\"/admin/appointments\" data-stage-nav ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"3\" y=\"5\" width=\"18\" height=\"16\" rx=\"3\"/><path d=\"M7 3v5m10-5v5M3 11h18\"/></svg>Appointments</a><a href=\"/admin\" ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 13l3-8h12l3 8v6H3z\"/><path d=\"M3 13h5l2 3h4l2-3h5\"/></svg>Leads</a><a href=\"/admin/clients\" ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"9\" cy=\"8\" r=\"3\"/><path d=\"M3 20v-2a6 6 0 0 1 12 0v2m4-1v-1a6 6 0 0 0-3-5m0-9a3 3 0 0 1 0 6\"/></svg>Clients</a><a href=\"/admin/content\" data-stage-nav ><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 4h16v16H4zM8 8h8m-8 4h8m-8 4h4\"/></svg>Publishing</a>";
const destinations = {appointments:"/admin/appointments",index:"/admin",clients:"/admin/clients",content:"/admin/content",blog:"/admin/content"};
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
  const back = Object.assign(document.createElement("button"), {type:"button", className:"mobile-list-back", textContent:"Back to list"});
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
    const button = event.target.closest(".lead-item, .client-item, .followup-open-btn, #post-list li, #new-post-btn");
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
