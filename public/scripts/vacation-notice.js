(function () {
  "use strict";

  const PROJECT_ID = "niemansdetailing";
  const API_KEY = "AIzaSyBgUntKRCQsi_SyJmNOgJLBI8Yj8gEsmA4";
  const SETTINGS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/publicSettings/vacationMode?key=${API_KEY}`;

  const DEFAULT_NOTICE = {
    enabled: true,
    startDate: "2026-06-18",
    endDate: "2026-07-01",
    headline: "Vacation notice",
    message:
      "I'll be away June 18 through July 1. I'll be scheduling details again starting July 2. You can still request a quote or text me, and I'll follow up when I'm back.",
  };

  function dateOnlyString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function isDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  }

  function dateFromDateOnly(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDateOnly(value, includeYear = false) {
    if (!isDateOnly(value)) return "";
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    }).format(dateFromDateOnly(value));
  }

  function formatDateRange(startDate, endDate) {
    if (!isDateOnly(startDate) || !isDateOnly(endDate)) return "";
    const startYear = startDate.slice(0, 4);
    const endYear = endDate.slice(0, 4);
    const includeStartYear = startYear !== endYear;
    return `${formatDateOnly(startDate, includeStartYear)} through ${formatDateOnly(endDate, true)}`;
  }

  function isActiveNotice(notice) {
    if (!notice?.enabled || !isDateOnly(notice.startDate) || !isDateOnly(notice.endDate)) return false;
    if (notice.startDate > notice.endDate) return false;
    const today = dateOnlyString();
    return today >= notice.startDate && today <= notice.endDate;
  }

  function firestoreValue(value) {
    if (!value || typeof value !== "object") return undefined;
    if ("stringValue" in value) return value.stringValue;
    if ("booleanValue" in value) return Boolean(value.booleanValue);
    if ("nullValue" in value) return null;
    return undefined;
  }

  function noticeFromFirestore(fields) {
    const data = {};
    Object.entries(fields || {}).forEach(([key, value]) => {
      data[key] = firestoreValue(value);
    });
    return data;
  }

  function normalizeNotice(raw) {
    const startDate = String(raw.startDate || DEFAULT_NOTICE.startDate).trim();
    const endDate = String(raw.endDate || DEFAULT_NOTICE.endDate).trim();
    return {
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_NOTICE.enabled,
      startDate,
      endDate,
      headline: String(raw.headline || DEFAULT_NOTICE.headline).trim().slice(0, 90),
      message: String(raw.message || DEFAULT_NOTICE.message).trim().slice(0, 420),
    };
  }

  async function loadNotice() {
    const response = await fetch(SETTINGS_URL, { cache: "no-store" });
    if (response.status === 403 || response.status === 404) return DEFAULT_NOTICE;
    if (!response.ok) throw new Error(`Vacation settings request failed: ${response.status}`);
    const payload = await response.json();
    return normalizeNotice(noticeFromFirestore(payload.fields));
  }

  function vacationIcon() {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 48 48");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `
      <path d="M16 18.5h16a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4v-13a4 4 0 0 1 4-4Z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/>
      <path d="M19 18.5v-3.2a5 5 0 0 1 10 0v3.2M18 24.5v9M30 24.5v9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M34.5 10.5 37 8l2.5 2.5L37 13l-2.5-2.5ZM9 13.5 11.5 11l2.5 2.5-2.5 2.5L9 13.5ZM35 29.5h5M8 29.5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    `;
    return icon;
  }

  function pageAction() {
    const path = window.location.pathname.replace(/\/$/, "");
    if (path === "/quote" || path === "/quote.html") {
      return { href: "sms:+18282733894", label: "Text questions" };
    }
    return { href: "/quote", label: "Request a quote" };
  }

  function createNotice(notice) {
    const article = document.createElement("article");
    article.className = "nd-vacation-notice";
    article.setAttribute("role", "status");
    article.setAttribute("aria-label", "Vacation scheduling notice");

    const iconWrap = document.createElement("div");
    iconWrap.className = "nd-vacation-icon";
    iconWrap.appendChild(vacationIcon());

    const copy = document.createElement("div");
    copy.className = "nd-vacation-copy";

    const eyebrow = document.createElement("p");
    eyebrow.className = "nd-vacation-eyebrow";
    eyebrow.textContent = "Scheduling update";

    const title = document.createElement("h2");
    title.className = "nd-vacation-title";
    title.textContent = notice.headline || DEFAULT_NOTICE.headline;

    const message = document.createElement("p");
    message.className = "nd-vacation-message";
    message.textContent = notice.message || DEFAULT_NOTICE.message;

    const windowText = document.createElement("p");
    windowText.className = "nd-vacation-window";
    windowText.textContent = formatDateRange(notice.startDate, notice.endDate);

    copy.append(eyebrow, title, message, windowText);

    const action = pageAction();
    const link = document.createElement("a");
    link.className = "nd-vacation-action";
    link.href = action.href;
    link.textContent = action.label;

    article.append(iconWrap, copy, link);
    return article;
  }

  function render(notice) {
    const roots = document.querySelectorAll("[data-vacation-notice-root]");
    if (!roots.length) return;

    roots.forEach((root) => {
      root.textContent = "";
      if (isActiveNotice(notice)) {
        root.appendChild(createNotice(notice));
      }
    });
  }

  async function init() {
    if (!document.querySelector("[data-vacation-notice-root]")) return;
    try {
      render(await loadNotice());
    } catch (error) {
      console.warn("Vacation notice unavailable", error);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
