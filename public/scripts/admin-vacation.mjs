import { db } from "./firebase-client.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const form = document.getElementById("vacation-form");
const feedback = document.getElementById("vacation-status");
const button = form.querySelector("button[type=submit]");
const preview = document.getElementById("vacation-preview");
const noticeRef = doc(db, "publicSettings", "vacationMode");
const defaults = {
  enabled: true,
  startDate: "2026-06-18",
  endDate: "2026-07-01",
  headline: "Vacation notice",
  message: "I'll be away June 18 through July 1. I'll be scheduling details again starting July 2. You can still request a quote or text me, and I'll follow up when I'm back.",
};
const fields = form.elements;
let owner;

function values() {
  return {
    enabled: fields.enabled.checked,
    startDate: fields.startDate.value,
    endDate: fields.endDate.value,
    headline: fields.headline.value.trim(),
    message: fields.message.value.trim(),
  };
}
function showPreview() {
  const notice = values();
  document.getElementById("vacation-preview-heading").textContent = notice.headline;
  document.getElementById("vacation-preview-message").textContent = notice.message;
  preview.hidden = !notice.enabled;
}
form.addEventListener("input", showPreview);

export async function loadVacation(user) {
  owner = null;
  form.hidden = true;
  form.reset();
  if (!user) return;
  const profile = await getDoc(doc(db, "adminUsers", user.uid));
  if (!profile.exists() || profile.data().role === "editor") return;
  owner = user.uid;
  form.hidden = false;
  button.disabled = true;
  feedback.textContent = "Loading vacation notice…";
  try {
    const snapshot = await getDoc(noticeRef);
    if (owner !== user.uid) return;
    const notice = { ...defaults, ...snapshot.data() };
    fields.enabled.checked = notice.enabled;
    for (const key of ["startDate", "endDate", "headline", "message"]) fields[key].value = notice[key];
    showPreview();
    feedback.textContent = "";
    button.disabled = false;
  } catch {
    if (owner === user.uid) feedback.textContent = "Could not load the current notice. Reload to try again.";
  }
}

form.onsubmit = async event => {
  event.preventDefault();
  if (!owner) return;
  const notice = values();
  if (notice.startDate > notice.endDate) {
    feedback.textContent = "The end date must be on or after the start date.";
    fields.endDate.focus();
    return;
  }
  button.disabled = true;
  const uid = owner;
  try {
    await setDoc(noticeRef, { ...notice, updatedBy: uid, updatedAt: serverTimestamp() }, { merge: true });
    if (owner === uid) feedback.textContent = "Vacation notice saved.";
  } catch {
    if (owner === uid) feedback.textContent = "Could not save the vacation notice. Try again.";
  } finally {
    if (owner === uid) button.disabled = false;
  }
};
