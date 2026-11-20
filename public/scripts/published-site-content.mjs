import { appointmentRequest } from "./appointment-utils.mjs";

const mounts = [...document.querySelectorAll("[data-site-copy]")];
if (mounts.length) {
  appointmentRequest("site-content").then(content => {
    for (const mount of mounts) {
      const key = mount.dataset.siteCopy;
      const value = content[key];
      if (!value || value === mount.dataset.originalCopy) continue;
      mount.textContent = value;
      mount.hidden = false;
      if (mount.classList.contains("site-copy-override")) mount.style.whiteSpace = "pre-line";
      for (const original of document.querySelectorAll('[data-original-section="' + key + '"]')) {
        original.hidden = true;
        original.style.display = "none";
      }
    }
  }).catch(() => {});
}
