import { appointmentRequest } from "./appointment-utils.mjs";

const status = document.getElementById("maintenance-status");
const form = document.getElementById("maintenance-form");
// Short invitation links look like /m/Xk3p9QmT2w. The server swaps the code for the long link's id and token.
const shortCode = /^\/m\/([A-Za-z0-9]{10})\/?$/.exec(location.pathname)?.[1];
let fragment = location.hash;
if (shortCode) {
  fragment = await appointmentRequest("resolve-short-link", { code: shortCode, kind: "maintenance" })
    .then(({ id, token }) => `#${id}.${token}`, () => "#unavailable");
}
try {
  if (/^#[a-f0-9]{64}\.[a-f0-9]{64}$/.test(fragment)) sessionStorage.setItem("maintenanceInvite",fragment);
  else if (!shortCode) fragment = sessionStorage.getItem("maintenanceInvite") || "";
} catch {}
const link = /^#([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(fragment);
if (location.hash) history.replaceState(null, "", location.pathname);
if (fragment === "#unavailable") status.textContent = "This invitation is unavailable or has expired.";
else if (!link) status.textContent = "Open the invitation Nieman sent you.";
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
