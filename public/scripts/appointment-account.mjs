import { appointmentsEnabled, auth } from "./firebase-client.js";
import {
  GoogleAuthProvider, isSignInWithEmailLink, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail,
  sendSignInLinkToEmail, signInWithEmailAndPassword, signInWithEmailLink, signInWithPopup, signOut, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { appointmentRequest, appointmentTime } from "./appointment-utils.mjs";

const id = name => document.getElementById(name);
const status = id("account-status");
const signInForm = id("email-link");
const passForm = id("password-sign-in");
const dashboard = id("account-dashboard");
const signInPanel = id("account-sign-in");
const list = id("my-appointments");
const landing = `${location.origin}/account`;
let sequence = 0;

function run(message, callback) {
  return async event => {
    event.preventDefault();
    const button = event.submitter || (event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (button) button.disabled = true;
    try { await callback(); }
    catch (error) {
      status.textContent = error.code === "auth/requires-recent-login" ? "Sign in again before setting a password." :
        error.code === "appointment_email_mismatch" ? "Sign in with the email used for this appointment to save it." : message;
    } finally { if (button) button.disabled = false; }
  };
}

async function renderUser(user) {
  const version = ++sequence;
  list.replaceChildren();
  dashboard.hidden = !user;
  signInPanel.hidden = !!user;
  if (!user) {
    status.textContent = sessionStorage.getItem("appointmentAccountClaim") ? "Sign in with your email to save this appointment." :
      "Sign in with the email used for your appointment.";
    return;
  }
  if (!user.emailVerified) {
    status.textContent = "Verify your email and sign in again to see your appointments.";
    const verify = Object.assign(document.createElement("button"), { type: "button", className: "btn secondary", textContent: "Send verification email" });
    verify.onclick = run("Couldn't send the verification email.", async () => {
      await sendEmailVerification(user, { url: landing });
      status.textContent = "Check your email to verify your account.";
    });
    list.append(verify);
    return;
  }
  const token = await user.getIdToken();
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem("appointmentAccountClaim") || "null"); } catch {}
  if (pending) {
    try {
      await appointmentRequest("claim-appointment", pending, token);
      sessionStorage.removeItem("appointmentAccountClaim");
    } catch (error) {
      if (version === sequence) status.textContent = error.code === "appointment_email_mismatch" ? "Use the appointment's email address to save it." : "Couldn't save that appointment link.";
    }
  }
  const records = await appointmentRequest("my-appointments", {}, token);
  if (version !== sequence) return;
  if (!pending || !sessionStorage.getItem("appointmentAccountClaim")) status.textContent = records.length ? user.email : "Your saved appointments will appear here.";
  for (const record of records) {
    const card = Object.assign(document.createElement("article"), { className: "appointment-record" });
    const title = Object.assign(document.createElement("h2"), { textContent: record.service });
    const when = Object.assign(document.createElement("p"), { textContent: `${appointmentTime(record)} · ${record.status.replaceAll("_", " ")}` });
    const open = Object.assign(document.createElement("button"), { type: "button", className: "btn secondary", textContent: "View appointment" });
    open.onclick = run("Couldn't open this appointment.", async () => {
      const link = await appointmentRequest("my-link", { id: record.id }, await user.getIdToken());
      location.assign(`/appointment#${record.id}.${link.token}`);
    });
    card.append(title, when, open);
    list.append(card);
  }
}

async function init() {
  if (!appointmentsEnabled) { status.textContent = "Customer accounts aren't available yet."; return; }
  if (isSignInWithEmailLink(auth, location.href)) {
    const complete = async email => {
      await signInWithEmailLink(auth, email, location.href);
      localStorage.removeItem("appointmentSignInEmail");
      history.replaceState(null, "", "/account");
    };
    const known = localStorage.getItem("appointmentSignInEmail");
    if (known) await complete(known);
    else {
      signInPanel.hidden = false;
      status.textContent = "Enter your appointment email to complete sign-in.";
      signInForm.querySelector("button[type=submit]").textContent = "Complete sign-in";
      signInForm.onsubmit = run("This email doesn't match the sign-in link, or the link has expired.", async () => {
        await complete(signInForm.elements.email.value.trim());
        location.assign(landing);
      });
      return;
    }
  }
  signInForm.onsubmit = run("Couldn't send a sign-in link. Check the email and try again.", async () => {
    const email = signInForm.elements.email.value.trim();
    await sendSignInLinkToEmail(auth, email, { url: landing, handleCodeInApp: true });
    localStorage.setItem("appointmentSignInEmail", email);
    status.textContent = "Check your email for the sign-in link.";
  });
  id("google-sign-in").onclick = run("Google sign-in couldn't finish.", () => signInWithPopup(auth, new GoogleAuthProvider()));
  passForm.onsubmit = run("Check your email and password, or request a sign-in link.", () =>
    signInWithEmailAndPassword(auth, passForm.elements.email.value, passForm.elements.password.value));
  id("reset-password").onclick = run("Couldn't send the reset email.", async () => {
    if (!passForm.elements.email.reportValidity()) return;
    await sendPasswordResetEmail(auth, passForm.elements.email.value);
    status.textContent = "Check your email for password reset instructions.";
  });
  id("set-password").onsubmit = run("Couldn't update the password.", async () => {
    if (!auth.currentUser?.emailVerified) throw new Error("Email not verified");
    await updatePassword(auth.currentUser, id("set-password").elements.password.value);
    id("set-password").reset();
    status.textContent = "Password saved.";
  });
  id("account-sign-out").onclick = run("Couldn't sign out.", async () => {
    sessionStorage.removeItem("appointmentAccountClaim");
    sessionStorage.removeItem("appointmentCheckoutReturn");
    await signOut(auth);
  });
  onAuthStateChanged(auth, user => renderUser(user).catch(() => { status.textContent = "Couldn't load your appointments. Try signing in again."; }));
}

init().catch(() => { status.textContent = "This sign-in link could not be used. Reopen My appointments to request a new link."; });
