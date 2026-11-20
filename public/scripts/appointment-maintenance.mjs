import { appointmentRequest } from "./appointment-utils.mjs";

const status = document.getElementById("maintenance-status");
const form = document.getElementById("maintenance-form");
let fragment = location.hash;
try {
  if (fragment) sessionStorage.setItem("maintenanceInvite",fragment);
  else fragment = sessionStorage.getItem("maintenanceInvite") || "";
} catch {}
const link = /^#([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(fragment);
if (location.hash) history.replaceState(null, "", location.pathname);
if (!link) status.textContent = "Open the invitation Nieman sent you.";
else {
  const [, id, token] = link;
  const payload = { id, token };
  const show = offer => {
    form.hidden = offer.enrolled;
    status.textContent = offer.enrolled ? "Request received. Nieman will follow up to schedule your first visit." : `Request enrollment by ${offer.eligibleThrough}.`;
  };
  appointmentRequest("maintenance-offer", payload).then(show).catch(() => { status.textContent = "This invitation is unavailable or has expired."; });
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try { show(await appointmentRequest("maintenance-enroll", { ...payload, accepted: form.elements.accepted.checked })); }
    catch { status.textContent = "Couldn't submit your request. Try again or contact Nieman."; }
    finally { button.disabled = false; }
  };
}
