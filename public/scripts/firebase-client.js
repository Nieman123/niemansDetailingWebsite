import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
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

export { app, auth, db, storage, firebaseConfig };
