import { appointmentRequest } from "./appointment-utils.mjs";

const mounts = [...document.querySelectorAll("[data-site-content]")];
if (mounts.length) {
  appointmentRequest("site-content").then(content => {
    for (const mount of mounts) {
      const keys = mount.dataset.siteContent.split(/\s+/);
      for (const key of keys) {
        if (!content[key]) continue;
        const row = document.createElement(key === "headline" ? "h2" : "p");
        row.textContent = content[key];
        mount.append(row);
      }
      mount.hidden = mount.childElementCount === 0;
    }
  }).catch(() => {});
}
