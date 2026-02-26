import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { connectAuthEmulator, getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { connectFirestoreEmulator, getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

const DEFAULT_FIREBASE_API_KEY = "AIzaSyBgUntKRCQsi_SyJmNOgJLBI8Yj8gEsmA4";

const pageApiKey =
  document.querySelector('meta[name="firebase-api-key"]')?.getAttribute("content")?.trim() || "";

const firebaseConfig = {
  apiKey: pageApiKey || DEFAULT_FIREBASE_API_KEY,
  authDomain: "niemansdetailing.firebaseapp.com",
  projectId: "niemansdetailing",
  storageBucket: "niemansdetailing.firebasestorage.app", // standard bucket name
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
const isHostingEmulator = isLocalHost && (window.location.port === "5000" || window.location.port === "5010");

if (isHostingEmulator) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

export { app, auth, db, storage, firebaseConfig };
