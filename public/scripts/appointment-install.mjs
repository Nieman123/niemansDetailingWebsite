import { appointmentsEnabled } from "./firebase-client.js";

if (appointmentsEnabled && "serviceWorker" in navigator) {
  const button = document.getElementById("install-appointments");
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    button.hidden = false;
    button.onclick = async () => {
      button.hidden = true;
      await event.prompt();
    };
  });
  navigator.serviceWorker.register("/admin/appointment-sw.js", { scope: "/admin/" }).catch(() => {});
}
