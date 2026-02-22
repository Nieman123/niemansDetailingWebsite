import { auth, db } from "/scripts/firebase-client.js";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const DEFAULT_REPEAT_MONTHS = 6;
const DUE_SOON_DAYS = 7;
const GOOGLE_ADS_HEADERS = ["Email", "Phone", "First Name", "Last Name", "Country", "Zip"];

const params = new URLSearchParams(window.location.search);
const preselectedClientId = params.get("id");
const prefillFromLeadId = params.get("fromLead");

const els = {
  status: document.getElementById("admin-status"),
  authView: document.getElementById("auth-view"),
  unauthorizedView: document.getElementById("unauthorized-view"),
  adminView: document.getElementById("admin-view"),
  authHint: document.getElementById("auth-hint"),
  signInBtn: document.getElementById("sign-in-btn"),
  signOutBtn: document.getElementById("sign-out-btn"),
  unauthorizedSignOutBtn: document.getElementById("sign-out-unauthorized-btn"),
  userEmail: document.getElementById("admin-user-email"),
  userUid: document.getElementById("admin-uid"),
  refreshBtn: document.getElementById("refresh-clients-btn"),
  newClientBtn: document.getElementById("new-client-btn"),
  importMdBtn: document.getElementById("import-md-btn"),
  importMdInput: document.getElementById("import-md-input"),
  exportCsvBtn: document.getElementById("export-csv-btn"),
  searchInput: document.getElementById("client-search-input"),
  statusFilter: document.getElementById("client-status-filter"),
  followupFilter: document.getElementById("client-followup-filter"),
  sortFilter: document.getElementById("client-sort-filter"),
  clearFiltersBtn: document.getElementById("clear-client-filters-btn"),
  summaryTotal: document.getElementById("summary-total-clients"),
  summaryDue: document.getElementById("summary-due-clients"),
  summarySoon: document.getElementById("summary-soon-clients"),
  summaryUnscheduled: document.getElementById("summary-unscheduled-clients"),
  followupTodayCount: document.getElementById("followup-today-count"),
  followupSoonCount: document.getElementById("followup-soon-count"),
  followupList: document.getElementById("followup-list"),
  importSummary: document.getElementById("import-summary"),
  importSummaryHead: document.getElementById("import-summary-head"),
  importSummaryItems: document.getElementById("import-summary-items"),
  clientList: document.getElementById("client-list"),
  clientListEmpty: document.getElementById("client-list-empty"),
  detailPlaceholder: document.getElementById("client-detail-placeholder"),
  detailCard: document.getElementById("client-detail-card"),
  detailName: document.getElementById("client-detail-name"),
  detailUpdated: document.getElementById("client-last-updated"),
  detailIdPill: document.getElementById("client-id-pill"),
  actionSms: document.getElementById("client-action-sms"),
  actionCall: document.getElementById("client-action-call"),
  actionEmail: document.getElementById("client-action-email"),
  actionCopyLink: document.getElementById("client-action-copy-link"),
  actionOpenLead: document.getElementById("client-action-open-lead"),
  nameInput: document.getElementById("client-name-input"),
  phoneInput: document.getElementById("client-phone-input"),
  emailInput: document.getElementById("client-email-input"),
  preferredContactInput: document.getElementById("client-preferred-contact-input"),
  statusInput: document.getElementById("client-status-input"),
  sourceInput: document.getElementById("client-source-input"),
  neighborhoodInput: document.getElementById("client-neighborhood-input"),
  addressInput: document.getElementById("client-address-input"),
  cityInput: document.getElementById("client-city-input"),
  stateInput: document.getElementById("client-state-input"),
  zipInput: document.getElementById("client-zip-input"),
  countryInput: document.getElementById("client-country-input"),
  repeatMonthsInput: document.getElementById("client-repeat-months-input"),
  lastServiceInput: document.getElementById("client-last-service-input"),
  nextFollowupInput: document.getElementById("client-next-followup-input"),
  lastContactedInput: document.getElementById("client-last-contacted-input"),
  tagsInput: document.getElementById("client-tags-input"),
  followupNoteInput: document.getElementById("client-followup-note-input"),
  notesInput: document.getElementById("client-notes-input"),
  bookingDateInput: document.getElementById("client-booking-date-input"),
  bookingServiceInput: document.getElementById("client-booking-service-input"),
  bookingAmountInput: document.getElementById("client-booking-amount-input"),
  bookingNoteInput: document.getElementById("client-booking-note-input"),
  addBookingBtn: document.getElementById("add-booking-btn"),
  bookingsList: document.getElementById("client-bookings-list"),
  deleteClientBtn: document.getElementById("delete-client-btn"),
  saveClientBtn: document.getElementById("save-client-btn"),
};

const state = {
  user: null,
  isAdmin: false,
  clients: [],
  filteredClients: [],
  activeClientId: null,
  activeDraft: null,
  editingBookings: [],
  creatingNew: false,
  preferredClientId: preselectedClientId,
  fromLeadId: prefillFromLeadId,
  prefillLead: null,
  loading: false,
  saving: false,
  deleting: false,
  importing: false,
};

function setStatus(message, type = "info") {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.dataset.type = type;
}

function showView(view) {
  if (els.authView) els.authView.hidden = view !== "auth";
  if (els.unauthorizedView) els.unauthorizedView.hidden = view !== "unauthorized";
  if (els.adminView) els.adminView.hidden = view !== "admin";
}

function setControlsDisabled(disabled) {
  const controls = [
    els.refreshBtn,
    els.newClientBtn,
    els.importMdBtn,
    els.exportCsvBtn,
    els.searchInput,
    els.statusFilter,
    els.followupFilter,
    els.sortFilter,
    els.clearFiltersBtn,
    els.saveClientBtn,
    els.deleteClientBtn,
    els.addBookingBtn,
    els.actionCopyLink,
  ];
  controls.forEach((control) => {
    if (control) control.disabled = disabled;
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeText(value, maxLength = 1000) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date?.getTime?.()) ? null : date;
  }
  if (typeof value?.seconds === "number") {
    const ms = value.seconds * 1000;
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return "Unknown";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function parseIsoDateUtc(dateIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso || ""))) return null;
  const date = new Date(`${dateIso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabel(dateIso) {
  const date = parseIsoDateUtc(dateIso);
  if (!date) return "Not scheduled";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function daysFromToday(dateIso) {
  const date = parseIsoDateUtc(dateIso);
  if (!date) return null;
  const today = new Date();
  const todayUtcMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((date.getTime() - todayUtcMs) / dayMs);
}

function addMonthsIsoDate(dateIso, months) {
  const base = parseIsoDateUtc(dateIso);
  if (!base || !Number.isFinite(months) || months <= 0) return "";

  const year = base.getUTCFullYear();
  const month = base.getUTCMonth();
  const day = base.getUTCDate();

  const targetMonth = month + months;
  const lastDayTargetMonth = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDayTargetMonth);
  const result = new Date(Date.UTC(year, targetMonth, safeDay));
  return result.toISOString().slice(0, 10);
}

function normalizePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(0, 10);
}

function normalizePhoneE164(value) {
  const digits = normalizePhoneDigits(value);
  return digits.length === 10 ? `+1${digits}` : "";
}

function formatPhone(value) {
  const digits = normalizePhoneDigits(value);
  if (digits.length !== 10) return sanitizeText(value, 24);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
}

function normalizeZip(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 5);
  return digits;
}

function normalizeCountry(value) {
  const country = String(value || "US").trim().toUpperCase().slice(0, 2);
  return /^[A-Z]{2}$/.test(country) ? country : "US";
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((tag) => sanitizeText(tag, 50)).filter(Boolean))).slice(0, 20);
  }
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((tag) => sanitizeText(tag, 50))
        .filter(Boolean)
    )
  ).slice(0, 20);
}

function normalizeClientStatus(value) {
  const key = String(value || "").toLowerCase().trim();
  const map = {
    prospect: "prospect",
    new: "prospect",
    contacted: "prospect",
    active: "active",
    booked: "active",
    dormant: "dormant",
    "do_not_contact": "do_not_contact",
    "do-not-contact": "do_not_contact",
    dnc: "do_not_contact",
    archived: "archived",
    spam: "archived",
  };
  return map[key] || "prospect";
}

function normalizePreferredContact(value) {
  const key = String(value || "").toLowerCase().trim();
  if (key.includes("text") || key.includes("sms")) return "text";
  if (key.includes("call") || key.includes("phone")) return "call";
  if (key.includes("email")) return "email";
  return "";
}

function normalizeNumber(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function splitName(fullName) {
  const name = sanitizeText(fullName, 140);
  if (!name) return { first_name: "", last_name: "" };
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "" };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" "),
  };
}

function computeLookupKeys(client) {
  const keys = new Set();
  const nameSlug = String(client.full_name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (client.phone_e164) keys.add(`phone:${client.phone_e164}`);
  if (client.email) keys.add(`email:${client.email}`);
  if (nameSlug) keys.add(`name:${nameSlug}`);
  if (nameSlug && client.zip) keys.add(`namezip:${nameSlug}|${client.zip}`);

  return Array.from(keys).slice(0, 12);
}

function normalizeBooking(raw) {
  const date = normalizeDateInput(raw?.date);
  const service = sanitizeText(raw?.service, 120);
  const amountNumber = Number(raw?.amount);
  const amount = Number.isFinite(amountNumber) && amountNumber >= 0 ? Math.round(amountNumber * 100) / 100 : null;
  const notes = sanitizeText(raw?.notes, 280);
  const source = sanitizeText(raw?.source, 40) || "manual";
  const leadId = sanitizeText(raw?.lead_id, 120);
  const id = sanitizeText(raw?.id, 80) || (window.crypto?.randomUUID ? window.crypto.randomUUID() : `b_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);

  if (!date || !service) return null;
  return {
    id,
    date,
    service,
    amount,
    notes: notes || null,
    source,
    lead_id: leadId || null,
    created_at: sanitizeText(raw?.created_at, 40) || new Date().toISOString(),
  };
}

function sortBookings(bookings) {
  return [...bookings].sort((a, b) => {
    if (a.date === b.date) return String(a.service).localeCompare(String(b.service));
    return a.date < b.date ? 1 : -1;
  });
}

function bookingFingerprint(booking) {
  return [booking.date, booking.service.toLowerCase(), String(booking.amount ?? ""), String(booking.notes || "").toLowerCase()].join("|");
}

function mergeBookings(existingBookings, incomingBookings) {
  const map = new Map();
  [...existingBookings, ...incomingBookings].forEach((booking) => {
    const normalized = normalizeBooking(booking);
    if (!normalized) return;
    const key = bookingFingerprint(normalized);
    if (!map.has(key)) map.set(key, normalized);
  });
  return sortBookings(Array.from(map.values())).slice(0, 120);
}

function normalizeBookings(rawBookings) {
  if (!Array.isArray(rawBookings)) return [];
  const normalized = rawBookings
    .map((booking) => normalizeBooking(booking))
    .filter(Boolean);
  return sortBookings(normalized);
}

function effectiveFollowupDate(client) {
  const explicit = normalizeDateInput(client.next_followup_date);
  if (explicit) return explicit;

  const lastService = normalizeDateInput(client.last_service_date);
  const repeatMonths = normalizeNumber(client.repeat_interval_months, DEFAULT_REPEAT_MONTHS, 0, 36);
  if (!lastService || repeatMonths <= 0) return "";
  return addMonthsIsoDate(lastService, repeatMonths);
}

function followupBucket(client) {
  const status = normalizeClientStatus(client.status);
  if (status === "do_not_contact" || status === "archived") return "skip";

  const followupDate = effectiveFollowupDate(client);
  if (!followupDate) return "unscheduled";

  const days = daysFromToday(followupDate);
  if (days == null) return "unscheduled";
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= DUE_SOON_DAYS) return "soon";
  return "upcoming";
}

function followupLabel(client) {
  const bucket = followupBucket(client);
  const followupDate = effectiveFollowupDate(client);
  switch (bucket) {
    case "overdue":
      return `Overdue (${formatDateLabel(followupDate)})`;
    case "today":
      return "Due today";
    case "soon":
      return `Due ${formatDateLabel(followupDate)}`;
    case "upcoming":
      return `Next ${formatDateLabel(followupDate)}`;
    case "skip":
      return "Not in follow-up queue";
    default:
      return "No follow-up date";
  }
}

function clientUpdatedMs(client) {
  const updated = parseDate(client.updated_at);
  const created = parseDate(client.created_at);
  return updated?.getTime() || created?.getTime() || 0;
}

function clientMatchesSearch(client, search) {
  if (!search) return true;
  const haystack = [
    client.id,
    client.full_name,
    client.phone,
    client.phone_e164,
    client.email,
    client.source,
    client.neighborhood,
    client.address,
    client.city,
    client.state,
    client.zip,
    client.country,
    client.tags?.join(" "),
    client.notes,
    client.followup_note,
    client.source_lead_id,
    ...(Array.isArray(client.bookings) ? client.bookings.map((booking) => `${booking.date} ${booking.service} ${booking.notes || ""}`) : []),
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(search);
}

function sortClients(clients, sortKey) {
  const next = [...clients];

  switch (sortKey) {
    case "name":
      next.sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || "")));
      break;
    case "oldest":
      next.sort((a, b) => clientUpdatedMs(a) - clientUpdatedMs(b));
      break;
    case "newest":
      next.sort((a, b) => clientUpdatedMs(b) - clientUpdatedMs(a));
      break;
    case "followup":
    default:
      next.sort((a, b) => {
        const priority = {
          overdue: 0,
          today: 1,
          soon: 2,
          upcoming: 3,
          unscheduled: 4,
          skip: 5,
        };

        const aBucket = followupBucket(a);
        const bBucket = followupBucket(b);
        const aPriority = priority[aBucket] ?? 99;
        const bPriority = priority[bBucket] ?? 99;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aDate = effectiveFollowupDate(a) || "9999-12-31";
        const bDate = effectiveFollowupDate(b) || "9999-12-31";
        if (aDate !== bDate) return aDate < bDate ? -1 : 1;

        return String(a.full_name || "").localeCompare(String(b.full_name || ""));
      });
      break;
  }

  return next;
}

function normalizeClientRecord(record) {
  const fullName = sanitizeText(
    record.full_name
      || [sanitizeText(record.first_name, 70), sanitizeText(record.last_name, 100)].filter(Boolean).join(" "),
    140
  );
  const split = splitName(fullName);

  const phoneE164 = normalizePhoneE164(record.phone_e164 || record.phone);
  const phoneDisplay = phoneE164 ? formatPhone(phoneE164) : sanitizeText(record.phone, 24);
  const email = normalizeEmail(record.email);
  const repeatMonths = normalizeNumber(record.repeat_interval_months, DEFAULT_REPEAT_MONTHS, 0, 36);
  const bookings = normalizeBookings(record.bookings);
  const tags = normalizeTags(record.tags);

  return {
    ...record,
    id: sanitizeText(record.id, 160),
    full_name: fullName,
    first_name: split.first_name,
    last_name: split.last_name,
    phone: phoneDisplay,
    phone_e164: phoneE164,
    email,
    preferred_contact: normalizePreferredContact(record.preferred_contact),
    source: sanitizeText(record.source, 80),
    neighborhood: sanitizeText(record.neighborhood, 120),
    address: sanitizeText(record.address, 180),
    city: sanitizeText(record.city, 80),
    state: sanitizeText(record.state, 40).toUpperCase(),
    zip: normalizeZip(record.zip),
    country: normalizeCountry(record.country),
    status: normalizeClientStatus(record.status),
    repeat_interval_months: repeatMonths,
    last_service_date: normalizeDateInput(record.last_service_date),
    next_followup_date: normalizeDateInput(record.next_followup_date),
    last_contacted_date: normalizeDateInput(record.last_contacted_date),
    tags,
    notes: sanitizeText(record.notes, 4000),
    followup_note: sanitizeText(record.followup_note, 4000),
    bookings,
    source_lead_id: sanitizeText(record.source_lead_id, 120),
    import_source_file: sanitizeText(record.import_source_file, 220),
    external_created_date: normalizeDateInput(record.external_created_date),
    external_updated_date: normalizeDateInput(record.external_updated_date),
    lookup_keys: Array.isArray(record.lookup_keys) ? record.lookup_keys.map((key) => sanitizeText(key, 120)).filter(Boolean) : [],
  };
}

function blankClient(seed = {}) {
  return normalizeClientRecord({
    status: "prospect",
    country: "US",
    repeat_interval_months: DEFAULT_REPEAT_MONTHS,
    tags: [],
    bookings: [],
    ...seed,
  });
}

function statusPillClass(status) {
  return `pill-status-${escapeHtml(normalizeClientStatus(status))}`;
}

function followupPillClass(bucket) {
  return `pill-followup-${escapeHtml(bucket)}`;
}

function applyFilters() {
  const search = (els.searchInput?.value || "").trim().toLowerCase();
  const statusFilter = els.statusFilter?.value || "all";
  const followupFilter = els.followupFilter?.value || "all";
  const sortFilter = els.sortFilter?.value || "followup";

  let clients = [...state.clients];

  if (statusFilter !== "all") {
    clients = clients.filter((client) => normalizeClientStatus(client.status) === statusFilter);
  }

  if (followupFilter !== "all") {
    if (followupFilter === "due") {
      clients = clients.filter((client) => {
        const bucket = followupBucket(client);
        return bucket === "overdue" || bucket === "today" || bucket === "soon";
      });
    } else {
      clients = clients.filter((client) => followupBucket(client) === followupFilter);
    }
  }

  if (search) {
    clients = clients.filter((client) => clientMatchesSearch(client, search));
  }

  state.filteredClients = sortClients(clients, sortFilter);

  renderSummary();
  renderFollowupDashboard();
  renderClientList();

  if (state.activeClientId && !state.creatingNew) {
    const stillVisible = state.filteredClients.some((client) => client.id === state.activeClientId);
    if (!stillVisible) showClientDetails(null);
  }
}

function renderSummary() {
  const total = state.clients.length;
  const due = state.clients.filter((client) => {
    const bucket = followupBucket(client);
    return bucket === "overdue" || bucket === "today";
  }).length;
  const soon = state.clients.filter((client) => followupBucket(client) === "soon").length;
  const unscheduled = state.clients.filter((client) => followupBucket(client) === "unscheduled").length;

  if (els.summaryTotal) els.summaryTotal.textContent = String(total);
  if (els.summaryDue) els.summaryDue.textContent = String(due);
  if (els.summarySoon) els.summarySoon.textContent = String(soon);
  if (els.summaryUnscheduled) els.summaryUnscheduled.textContent = String(unscheduled);
}

function smsHref(client) {
  return client.phone_e164 ? `sms:${client.phone_e164}` : "#";
}

function callHref(client) {
  return client.phone_e164 ? `tel:${client.phone_e164}` : "#";
}

function emailHref(client) {
  return client.email ? `mailto:${client.email}` : "#";
}

function renderFollowupDashboard() {
  if (!els.followupList) return;

  const dueNow = state.clients.filter((client) => {
    const bucket = followupBucket(client);
    return bucket === "overdue" || bucket === "today";
  });
  const dueSoon = state.clients.filter((client) => followupBucket(client) === "soon");

  if (els.followupTodayCount) els.followupTodayCount.textContent = String(dueNow.length);
  if (els.followupSoonCount) els.followupSoonCount.textContent = String(dueSoon.length);

  const queue = sortClients(
    state.clients.filter((client) => {
      const bucket = followupBucket(client);
      return bucket === "overdue" || bucket === "today" || bucket === "soon";
    }),
    "followup"
  ).slice(0, 10);

  if (!queue.length) {
    els.followupList.innerHTML = `<li class="empty-state">No clients need follow-up in the current queue.</li>`;
    return;
  }

  els.followupList.innerHTML = queue.map((client) => {
    const bucket = followupBucket(client);
    const followupDate = effectiveFollowupDate(client);
    const contact = client.phone_e164 ? formatPhone(client.phone_e164) : (client.email || "No phone/email");

    return `
      <li class="followup-row">
        <div class="followup-row-top">
          <strong>${escapeHtml(client.full_name || "Unnamed client")}</strong>
          <span class="pill ${followupPillClass(bucket)}">${escapeHtml(followupLabel(client))}</span>
        </div>
        <div class="followup-row-sub">
          <span>${escapeHtml(contact)}</span>
          <span>${followupDate ? escapeHtml(formatDateLabel(followupDate)) : "No date"}</span>
        </div>
        <div class="followup-actions">
          <button type="button" class="btn followup-open-btn" data-client-id="${escapeHtml(client.id)}">Open</button>
          <a class="btn" href="${escapeHtml(smsHref(client))}" aria-disabled="${smsHref(client) === "#" ? "true" : "false"}">Text</a>
          <a class="btn" href="${escapeHtml(callHref(client))}" aria-disabled="${callHref(client) === "#" ? "true" : "false"}">Call</a>
        </div>
      </li>
    `;
  }).join("");

  els.followupList.querySelectorAll(".followup-open-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const clientId = button.getAttribute("data-client-id");
      if (clientId) selectClient(clientId);
    });
  });
}

function renderClientList() {
  if (!els.clientList || !els.clientListEmpty) return;

  if (!state.filteredClients.length) {
    els.clientList.innerHTML = "";
    els.clientListEmpty.hidden = false;
    return;
  }

  els.clientListEmpty.hidden = true;

  els.clientList.innerHTML = state.filteredClients.map((client) => {
    const activeClass = !state.creatingNew && client.id === state.activeClientId ? " client-item-active" : "";
    const followup = followupLabel(client);
    const bucket = followupBucket(client);
    const subline = [client.phone || client.email || "No phone/email", client.neighborhood || client.city || ""].filter(Boolean).join(" | ");

    return `
      <li>
        <button type="button" class="client-item${activeClass}" data-client-id="${escapeHtml(client.id)}">
          <span class="client-item-top">
            <span class="client-item-name">${escapeHtml(client.full_name || "Unnamed client")}</span>
            <span class="pill ${statusPillClass(client.status)}">${escapeHtml(normalizeClientStatus(client.status))}</span>
          </span>
          <span class="client-item-sub">${escapeHtml(subline || "No contact details")}</span>
          <span class="client-item-bottom">
            <span class="pill ${followupPillClass(bucket)}">${escapeHtml(followup)}</span>
            <span class="muted">${escapeHtml(formatDateTime(client.updated_at || client.created_at))}</span>
          </span>
        </button>
      </li>
    `;
  }).join("");

  els.clientList.querySelectorAll(".client-item").forEach((button) => {
    button.addEventListener("click", () => {
      const clientId = button.getAttribute("data-client-id");
      if (clientId) selectClient(clientId);
    });
  });
}

function setQueryParams({ clientId = null, fromLeadId = null }) {
  const nextUrl = new URL(window.location.href);
  if (clientId) {
    nextUrl.searchParams.set("id", clientId);
  } else {
    nextUrl.searchParams.delete("id");
  }

  if (fromLeadId) {
    nextUrl.searchParams.set("fromLead", fromLeadId);
  } else {
    nextUrl.searchParams.delete("fromLead");
  }

  history.replaceState(null, "", nextUrl.toString());
}

function showClientDetails(client) {
  if (!client) {
    state.activeClientId = null;
    state.activeDraft = null;
    state.editingBookings = [];
    state.creatingNew = false;

    if (els.detailPlaceholder) els.detailPlaceholder.hidden = false;
    if (els.detailCard) els.detailCard.hidden = true;

    if (els.clientList) {
      els.clientList.querySelectorAll(".client-item-active").forEach((node) => node.classList.remove("client-item-active"));
    }

    setQueryParams({ clientId: null, fromLeadId: state.fromLeadId });
    return;
  }

  const normalized = blankClient(client);
  state.activeDraft = normalized;
  state.activeClientId = normalized.id || null;
  state.editingBookings = normalizeBookings(normalized.bookings);
  state.creatingNew = !normalized.id;

  if (els.detailPlaceholder) els.detailPlaceholder.hidden = true;
  if (els.detailCard) els.detailCard.hidden = false;

  if (els.detailName) els.detailName.textContent = normalized.full_name || "New Client";
  if (els.detailUpdated) {
    const updatedLabel = normalized.updated_at || normalized.created_at
      ? `Updated ${formatDateTime(normalized.updated_at || normalized.created_at)}`
      : "Unsaved draft";
    els.detailUpdated.textContent = updatedLabel;
  }
  if (els.detailIdPill) {
    els.detailIdPill.textContent = normalized.id ? `ID: ${normalized.id}` : "New";
  }

  if (els.nameInput) els.nameInput.value = normalized.full_name || "";
  if (els.phoneInput) els.phoneInput.value = normalized.phone || "";
  if (els.emailInput) els.emailInput.value = normalized.email || "";
  if (els.preferredContactInput) els.preferredContactInput.value = normalized.preferred_contact || "";
  if (els.statusInput) els.statusInput.value = normalizeClientStatus(normalized.status);
  if (els.sourceInput) els.sourceInput.value = normalized.source || "";
  if (els.neighborhoodInput) els.neighborhoodInput.value = normalized.neighborhood || "";
  if (els.addressInput) els.addressInput.value = normalized.address || "";
  if (els.cityInput) els.cityInput.value = normalized.city || "";
  if (els.stateInput) els.stateInput.value = normalized.state || "";
  if (els.zipInput) els.zipInput.value = normalized.zip || "";
  if (els.countryInput) els.countryInput.value = normalizeCountry(normalized.country || "US");
  if (els.repeatMonthsInput) els.repeatMonthsInput.value = String(normalized.repeat_interval_months ?? DEFAULT_REPEAT_MONTHS);
  if (els.lastServiceInput) els.lastServiceInput.value = normalized.last_service_date || "";
  if (els.nextFollowupInput) els.nextFollowupInput.value = normalizeDateInput(normalized.next_followup_date) || effectiveFollowupDate(normalized);
  if (els.lastContactedInput) els.lastContactedInput.value = normalized.last_contacted_date || "";
  if (els.tagsInput) els.tagsInput.value = Array.isArray(normalized.tags) ? normalized.tags.join(", ") : "";
  if (els.followupNoteInput) els.followupNoteInput.value = normalized.followup_note || "";
  if (els.notesInput) els.notesInput.value = normalized.notes || "";

  setClientActionLinks(normalized);
  renderBookingsList();

  if (normalized.id) {
    setQueryParams({ clientId: normalized.id, fromLeadId: null });
  } else {
    setQueryParams({ clientId: null, fromLeadId: state.fromLeadId });
  }
}

function setClientActionLinks(client) {
  if (els.actionSms) {
    const href = smsHref(client);
    els.actionSms.href = href;
    els.actionSms.setAttribute("aria-disabled", href === "#" ? "true" : "false");
  }

  if (els.actionCall) {
    const href = callHref(client);
    els.actionCall.href = href;
    els.actionCall.setAttribute("aria-disabled", href === "#" ? "true" : "false");
  }

  if (els.actionEmail) {
    const href = emailHref(client);
    els.actionEmail.href = href;
    els.actionEmail.setAttribute("aria-disabled", href === "#" ? "true" : "false");
  }

  if (els.actionOpenLead) {
    if (client.source_lead_id) {
      els.actionOpenLead.hidden = false;
      els.actionOpenLead.href = `/admin/index.html?id=${encodeURIComponent(client.source_lead_id)}`;
    } else {
      els.actionOpenLead.hidden = true;
      els.actionOpenLead.href = "/admin/index.html";
    }
  }
}

function renderBookingsList() {
  if (!els.bookingsList) return;

  if (!state.editingBookings.length) {
    els.bookingsList.innerHTML = `<li class="empty-state">No bookings recorded yet.</li>`;
    return;
  }

  els.bookingsList.innerHTML = state.editingBookings.map((booking) => {
    const amountLabel = booking.amount == null ? "Amount N/A" : `$${Number(booking.amount).toFixed(2)}`;

    return `
      <li class="booking-row">
        <div class="booking-row-top">
          <strong>${escapeHtml(booking.service)}</strong>
          <button type="button" class="btn booking-remove-btn" data-booking-id="${escapeHtml(booking.id)}">Remove</button>
        </div>
        <div class="booking-row-sub">
          <span>${escapeHtml(formatDateLabel(booking.date))}</span>
          <span>${escapeHtml(amountLabel)}</span>
        </div>
        ${booking.notes ? `<div class="booking-row-sub"><span>${escapeHtml(booking.notes)}</span></div>` : ""}
      </li>
    `;
  }).join("");

  els.bookingsList.querySelectorAll(".booking-remove-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const bookingId = button.getAttribute("data-booking-id");
      if (!bookingId) return;
      state.editingBookings = state.editingBookings.filter((booking) => booking.id !== bookingId);
      renderBookingsList();
    });
  });
}

function selectClient(clientId) {
  const client = state.clients.find((item) => item.id === clientId);
  if (!client) {
    showClientDetails(null);
    return;
  }
  showClientDetails(client);
  renderClientList();
}

function openNewClientForm(seed = {}) {
  state.creatingNew = true;
  state.activeClientId = null;
  showClientDetails(blankClient(seed));
  renderClientList();
  setStatus("New client draft ready.");
}

function autoFillNextFollowup() {
  const lastServiceDate = normalizeDateInput(els.lastServiceInput?.value || "");
  const repeatMonths = normalizeNumber(els.repeatMonthsInput?.value, DEFAULT_REPEAT_MONTHS, 0, 36);
  const currentNext = normalizeDateInput(els.nextFollowupInput?.value || "");
  if (!lastServiceDate || repeatMonths <= 0 || currentNext) return;

  const computed = addMonthsIsoDate(lastServiceDate, repeatMonths);
  if (computed && els.nextFollowupInput) {
    els.nextFollowupInput.value = computed;
  }
}

function addBookingFromInputs() {
  if (!els.bookingDateInput || !els.bookingServiceInput) return;

  const bookingDate = normalizeDateInput(els.bookingDateInput.value);
  const bookingService = sanitizeText(els.bookingServiceInput.value, 120);
  const bookingAmountRaw = Number(els.bookingAmountInput?.value);
  const bookingAmount = Number.isFinite(bookingAmountRaw) && bookingAmountRaw >= 0
    ? Math.round(bookingAmountRaw * 100) / 100
    : null;
  const bookingNote = sanitizeText(els.bookingNoteInput?.value, 280);

  if (!bookingDate || !bookingService) {
    setStatus("Booking date and service are required.", "error");
    return;
  }

  const booking = normalizeBooking({
    date: bookingDate,
    service: bookingService,
    amount: bookingAmount,
    notes: bookingNote,
    source: "manual",
  });

  if (!booking) {
    setStatus("Could not add booking entry.", "error");
    return;
  }

  state.editingBookings = mergeBookings(state.editingBookings, [booking]);
  renderBookingsList();

  if (els.lastServiceInput) {
    const currentLastService = normalizeDateInput(els.lastServiceInput.value);
    if (!currentLastService || booking.date > currentLastService) {
      els.lastServiceInput.value = booking.date;
      if (els.nextFollowupInput) {
        els.nextFollowupInput.value = "";
        autoFillNextFollowup();
      }
    }
  }

  if (els.bookingDateInput) els.bookingDateInput.value = "";
  if (els.bookingServiceInput) els.bookingServiceInput.value = "";
  if (els.bookingAmountInput) els.bookingAmountInput.value = "";
  if (els.bookingNoteInput) els.bookingNoteInput.value = "";

  setStatus("Booking entry added to draft.");
}

function collectDraftFromForm() {
  const fullName = sanitizeText(els.nameInput?.value, 140);
  const split = splitName(fullName);
  const phoneE164 = normalizePhoneE164(els.phoneInput?.value || "");
  const phoneDisplay = phoneE164 ? formatPhone(phoneE164) : sanitizeText(els.phoneInput?.value, 24);
  const email = normalizeEmail(els.emailInput?.value || "");

  const repeatInterval = normalizeNumber(els.repeatMonthsInput?.value, DEFAULT_REPEAT_MONTHS, 0, 36);
  const lastServiceDate = normalizeDateInput(els.lastServiceInput?.value || "");
  let nextFollowupDate = normalizeDateInput(els.nextFollowupInput?.value || "");
  if (!nextFollowupDate && lastServiceDate && repeatInterval > 0) {
    nextFollowupDate = addMonthsIsoDate(lastServiceDate, repeatInterval);
  }

  const draft = blankClient({
    id: state.activeClientId,
    full_name: fullName,
    first_name: split.first_name,
    last_name: split.last_name,
    phone: phoneDisplay,
    phone_e164: phoneE164,
    email,
    preferred_contact: normalizePreferredContact(els.preferredContactInput?.value || ""),
    status: normalizeClientStatus(els.statusInput?.value || "prospect"),
    source: sanitizeText(els.sourceInput?.value, 80),
    neighborhood: sanitizeText(els.neighborhoodInput?.value, 120),
    address: sanitizeText(els.addressInput?.value, 180),
    city: sanitizeText(els.cityInput?.value, 80),
    state: sanitizeText(els.stateInput?.value, 40).toUpperCase(),
    zip: normalizeZip(els.zipInput?.value),
    country: normalizeCountry(els.countryInput?.value || "US"),
    repeat_interval_months: repeatInterval,
    last_service_date: lastServiceDate,
    next_followup_date: nextFollowupDate,
    last_contacted_date: normalizeDateInput(els.lastContactedInput?.value || ""),
    tags: normalizeTags(els.tagsInput?.value || ""),
    followup_note: sanitizeText(els.followupNoteInput?.value, 4000),
    notes: sanitizeText(els.notesInput?.value, 4000),
    bookings: mergeBookings([], state.editingBookings),
    source_lead_id: sanitizeText(state.prefillLead?.id || state.activeDraft?.source_lead_id || "", 120),
    import_source_file: sanitizeText(state.activeDraft?.import_source_file || "", 220),
    external_created_date: normalizeDateInput(state.activeDraft?.external_created_date),
    external_updated_date: normalizeDateInput(state.activeDraft?.external_updated_date),
  });

  draft.lookup_keys = computeLookupKeys(draft);
  return draft;
}

function validateDraft(draft) {
  const errors = [];

  if (!draft.full_name) errors.push("Client name is required.");
  if (!draft.phone_e164 && !draft.email) errors.push("At least one contact method (phone or email) is required.");
  if (draft.zip && !/^\d{5}$/.test(draft.zip)) errors.push("ZIP code must be 5 digits.");

  return errors;
}

function collectDocPayload(draft) {
  const normalized = blankClient(draft);
  const bookings = mergeBookings([], normalized.bookings);

  return {
    full_name: normalized.full_name || null,
    first_name: normalized.first_name || null,
    last_name: normalized.last_name || null,
    phone: normalized.phone || null,
    phone_e164: normalized.phone_e164 || null,
    email: normalized.email || null,
    preferred_contact: normalized.preferred_contact || null,
    status: normalizeClientStatus(normalized.status),
    source: normalized.source || null,
    neighborhood: normalized.neighborhood || null,
    address: normalized.address || null,
    city: normalized.city || null,
    state: normalized.state || null,
    zip: normalized.zip || null,
    country: normalizeCountry(normalized.country || "US"),
    repeat_interval_months: normalizeNumber(normalized.repeat_interval_months, DEFAULT_REPEAT_MONTHS, 0, 36),
    last_service_date: normalizeDateInput(normalized.last_service_date) || null,
    next_followup_date: normalizeDateInput(normalized.next_followup_date) || null,
    last_contacted_date: normalizeDateInput(normalized.last_contacted_date) || null,
    tags: normalizeTags(normalized.tags),
    followup_note: normalized.followup_note || null,
    notes: normalized.notes || null,
    bookings,
    source_lead_id: normalized.source_lead_id || null,
    import_source_file: normalized.import_source_file || null,
    external_created_date: normalizeDateInput(normalized.external_created_date) || null,
    external_updated_date: normalizeDateInput(normalized.external_updated_date) || null,
    lookup_keys: computeLookupKeys(normalized),
  };
}

function updateClientInState(clientId, patch) {
  const index = state.clients.findIndex((client) => client.id === clientId);
  if (index < 0) return;
  state.clients[index] = normalizeClientRecord({ ...state.clients[index], ...patch, id: clientId });
}

async function maybeSyncLeadLink(clientId, draft) {
  const leadId = sanitizeText(draft.source_lead_id || "", 120);
  if (!leadId) return;

  const updates = {
    client_id: clientId,
    client_synced_at: serverTimestamp(),
    admin_updated_by: state.user.uid,
    admin_updated_at: serverTimestamp(),
  };

  if (state.prefillLead?.status === "booked" || normalizeClientStatus(draft.status) === "active") {
    updates.status = "booked";
  }

  try {
    await updateDoc(doc(db, "leads", leadId), updates);
  } catch (error) {
    console.error("Failed to sync lead link", error);
    setStatus("Client saved, but lead link sync failed.", "error");
  }
}

async function saveClient() {
  if (!state.user || !state.isAdmin || state.saving || state.deleting || state.importing) return;

  const draft = collectDraftFromForm();
  const validationErrors = validateDraft(draft);
  if (validationErrors.length) {
    setStatus(validationErrors[0], "error");
    return;
  }

  const payload = collectDocPayload(draft);

  state.saving = true;
  setControlsDisabled(true);
  setStatus("Saving client...");

  try {
    if (state.creatingNew || !state.activeClientId) {
      const ref = await addDoc(collection(db, "clients"), {
        ...payload,
        created_at: serverTimestamp(),
        created_by: state.user.uid,
        updated_at: serverTimestamp(),
        updated_by: state.user.uid,
      });

      const localRecord = normalizeClientRecord({
        id: ref.id,
        ...payload,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: state.user.uid,
        updated_by: state.user.uid,
      });

      state.clients.unshift(localRecord);
      state.activeClientId = ref.id;
      state.creatingNew = false;

      await maybeSyncLeadLink(ref.id, draft);
      applyFilters();
      selectClient(ref.id);
      setStatus("Client created.", "success");
    } else {
      await updateDoc(doc(db, "clients", state.activeClientId), {
        ...payload,
        updated_at: serverTimestamp(),
        updated_by: state.user.uid,
      });

      updateClientInState(state.activeClientId, {
        ...payload,
        updated_at: new Date().toISOString(),
        updated_by: state.user.uid,
      });

      await maybeSyncLeadLink(state.activeClientId, draft);
      applyFilters();
      selectClient(state.activeClientId);
      setStatus("Client updated.", "success");
    }

    state.prefillLead = null;
    state.fromLeadId = null;
  } catch (error) {
    console.error("Failed to save client", error);
    setStatus("Could not save client.", "error");
  } finally {
    state.saving = false;
    setControlsDisabled(false);
  }
}

async function deleteActiveClient() {
  if (!state.user || !state.isAdmin || state.deleting || state.saving || state.importing) return;

  if (state.creatingNew || !state.activeClientId) {
    showClientDetails(null);
    renderClientList();
    setStatus("Draft discarded.");
    return;
  }

  const client = state.clients.find((item) => item.id === state.activeClientId);
  if (!client) return;

  const confirmed = window.confirm(`Delete client \"${client.full_name || client.id}\"? This cannot be undone.`);
  if (!confirmed) return;

  const currentFilteredIds = state.filteredClients.map((item) => item.id);
  const currentIndex = currentFilteredIds.indexOf(state.activeClientId);

  state.deleting = true;
  setControlsDisabled(true);
  setStatus("Deleting client...");

  try {
    await deleteDoc(doc(db, "clients", state.activeClientId));

    state.clients = state.clients.filter((item) => item.id !== state.activeClientId);
    const deletedId = state.activeClientId;
    state.activeClientId = null;
    state.creatingNew = false;

    applyFilters();

    const nextClientId =
      state.filteredClients[currentIndex]?.id
      || state.filteredClients[currentIndex - 1]?.id
      || null;

    if (nextClientId) {
      selectClient(nextClientId);
    } else {
      showClientDetails(null);
      setQueryParams({ clientId: null, fromLeadId: null });
    }

    setStatus(`Client ${deletedId} deleted.`);
  } catch (error) {
    console.error("Failed to delete client", error);
    setStatus("Could not delete client.", "error");
  } finally {
    state.deleting = false;
    setControlsDisabled(false);
  }
}

async function copyClientLink() {
  if (state.creatingNew || !state.activeClientId) {
    setStatus("Save this client first to get a sharable link.", "error");
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("id", state.activeClientId);
  url.searchParams.delete("fromLead");

  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("Client link copied to clipboard.", "success");
  } catch {
    setStatus("Could not copy client link.", "error");
  }
}

async function checkAdmin(uid) {
  const snap = await getDoc(doc(db, "adminUsers", uid));
  return snap.exists();
}

async function ensureClientPresent(clientId) {
  if (!clientId) return;
  if (state.clients.some((client) => client.id === clientId)) return;

  const snap = await getDoc(doc(db, "clients", clientId));
  if (!snap.exists()) return;
  state.clients.unshift(normalizeClientRecord({ id: snap.id, ...snap.data() }));
}

async function loadClients() {
  if (state.loading) return;

  state.loading = true;
  setControlsDisabled(true);
  setStatus("Loading clients...");

  try {
    const preferredClientId = state.activeClientId || state.preferredClientId;
    const clientsQuery = query(collection(db, "clients"), limit(2000));
    const result = await getDocs(clientsQuery);

    state.clients = result.docs.map((docSnap) => normalizeClientRecord({ id: docSnap.id, ...docSnap.data() }));

    if (preferredClientId) {
      await ensureClientPresent(preferredClientId);
    }

    applyFilters();

    if (preferredClientId) {
      selectClient(preferredClientId);
    } else if (state.filteredClients.length && !state.creatingNew) {
      selectClient(state.filteredClients[0].id);
    } else if (!state.filteredClients.length && !state.creatingNew) {
      showClientDetails(null);
    }

    state.preferredClientId = null;
    setStatus(`Loaded ${state.clients.length} clients.`);
  } catch (error) {
    console.error("Failed to load clients", error);
    setStatus("Could not load clients. Check Firestore rules/indexes.", "error");
  } finally {
    state.loading = false;
    setControlsDisabled(false);
  }
}

function buildLookupIndex(clients) {
  const map = new Map();
  clients.forEach((client) => {
    const keys = computeLookupKeys(client);
    keys.forEach((key) => {
      if (!map.has(key)) map.set(key, client);
    });
  });
  return map;
}

function coerceFrontmatterScalar(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const unquoted = raw.replace(/^['"]|['"]$/g, "");
  if (/^(null|~)$/i.test(unquoted)) return "";
  if (/^(true|false)$/i.test(unquoted)) return unquoted.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseFrontmatter(markdown) {
  const match = String(markdown || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { attributes: {}, body: String(markdown || "") };

  const lines = match[1].split(/\r?\n/);
  const attributes = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const value = keyMatch[2];

    if (value.trim()) {
      attributes[key] = coerceFrontmatterScalar(value);
      continue;
    }

    const block = [];
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      if (/^[A-Za-z0-9_-]+\s*:/.test(nextLine)) break;
      if (!nextLine.trim() || nextLine.startsWith("  ") || nextLine.startsWith("\t")) {
        block.push(nextLine.replace(/^\s{2}/, ""));
        j += 1;
        continue;
      }
      break;
    }

    const trimmedBlock = block.map((entry) => entry.trim()).filter(Boolean);
    const listItems = trimmedBlock.filter((entry) => entry.startsWith("- "));
    if (listItems.length && listItems.length === trimmedBlock.length) {
      attributes[key] = listItems.map((entry) => coerceFrontmatterScalar(entry.slice(2)));
    } else {
      const nestedObject = {};
      trimmedBlock.forEach((entry) => {
        const nestedMatch = entry.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!nestedMatch) return;
        nestedObject[nestedMatch[1]] = coerceFrontmatterScalar(nestedMatch[2]);
      });
      attributes[key] = Object.keys(nestedObject).length ? nestedObject : "";
    }

    i = j - 1;
  }

  return {
    attributes,
    body: String(markdown || "").slice(match[0].length),
  };
}

function extractHeadingName(body) {
  const heading = String(body || "").match(/^#\s+(.+)$/m);
  if (!heading) return "";
  return sanitizeText(heading[1], 140);
}

function extractMarkdownSummary(body) {
  const summaryMatch = String(body || "").match(/##\s+Summary\s*([\s\S]*?)(?:\n##\s+|$)/i);
  if (!summaryMatch) return "";

  const lines = summaryMatch[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);

  return sanitizeText(lines.join(" | "), 1200);
}

function extractMarkdownServiceBookings(body, fallbackService) {
  const matches = String(body || "").matchAll(/^-\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*:\s*(.+)$/gim);
  const bookings = [];

  for (const match of matches) {
    const date = normalizeDateInput(match[1]);
    const notes = sanitizeText(match[2], 280);
    const booking = normalizeBooking({
      date,
      service: sanitizeText(fallbackService || "Imported service", 120),
      amount: null,
      notes,
      source: "markdown_import",
    });
    if (booking) bookings.push(booking);
  }

  return sortBookings(bookings);
}

async function parseMarkdownClient(file) {
  const markdown = await file.text();
  const { attributes, body } = parseFrontmatter(markdown);

  const fileStem = String(file.name || "")
    .replace(/\.md$/i, "")
    .replace(/^client\s*[\-\u2013\u2014]\s*/i, "")
    .trim();

  const headingName = extractHeadingName(body);
  const fullName = sanitizeText(attributes.client || headingName || fileStem, 140);
  const split = splitName(fullName);

  const phoneRaw = sanitizeText(attributes.phone, 24);
  const phoneE164 = normalizePhoneE164(phoneRaw);
  const phoneDisplay = phoneE164 ? formatPhone(phoneE164) : phoneRaw;

  const email = normalizeEmail(attributes.email);
  const status = normalizeClientStatus(attributes.status || "prospect");
  const repeatInterval = normalizeNumber(attributes.repeat_interval_months, DEFAULT_REPEAT_MONTHS, 0, 36);

  let lastServiceDate = normalizeDateInput(attributes.last_service);
  let nextFollowupDate = normalizeDateInput(attributes.next_due || attributes.next_due_date);

  const source = sanitizeText(attributes.source, 80);
  const neighborhood = sanitizeText(attributes.neighborhood, 120);
  const address = sanitizeText(attributes.address, 180);
  const city = sanitizeText(attributes.city, 80);
  const stateText = sanitizeText(attributes.state, 40).toUpperCase();
  const zip = normalizeZip(attributes.zip);
  const country = normalizeCountry(attributes.country || "US");

  const preferredContact = normalizePreferredContact(attributes.preferred_contact);
  const tags = normalizeTags(attributes.tags);
  const summary = extractMarkdownSummary(body);

  const quoteServiceMatch = String(body || "").match(/-\s*Package\s*:\s*(.+)$/im);
  const fallbackService = sanitizeText(quoteServiceMatch?.[1], 120) || "Imported service";
  const bookings = extractMarkdownServiceBookings(body, fallbackService);

  if (!lastServiceDate && bookings.length) {
    lastServiceDate = bookings[0].date;
  }

  if (!nextFollowupDate && lastServiceDate && repeatInterval > 0) {
    nextFollowupDate = addMonthsIsoDate(lastServiceDate, repeatInterval);
  }

  const notes = sanitizeText(summary || String(body || "").replace(/\s+/g, " "), 4000);

  const client = blankClient({
    full_name: fullName,
    first_name: split.first_name,
    last_name: split.last_name,
    phone: phoneDisplay,
    phone_e164: phoneE164,
    email,
    preferred_contact: preferredContact,
    status,
    source,
    neighborhood,
    address,
    city,
    state: stateText,
    zip,
    country,
    repeat_interval_months: repeatInterval,
    last_service_date: lastServiceDate,
    next_followup_date: nextFollowupDate,
    tags,
    notes,
    bookings,
    import_source_file: sanitizeText(file.name, 220),
    external_created_date: normalizeDateInput(attributes.created),
    external_updated_date: normalizeDateInput(attributes.updated),
  });

  client.lookup_keys = computeLookupKeys(client);

  return {
    client,
    filename: file.name,
  };
}

function mergeClientForImport(existingRaw, incomingRaw) {
  const existing = blankClient(existingRaw);
  const incoming = blankClient(incomingRaw);

  const merged = blankClient({
    id: existing.id,
    full_name: incoming.full_name || existing.full_name,
    first_name: incoming.first_name || existing.first_name,
    last_name: incoming.last_name || existing.last_name,
    phone: incoming.phone_e164 ? incoming.phone : existing.phone,
    phone_e164: incoming.phone_e164 || existing.phone_e164,
    email: incoming.email || existing.email,
    preferred_contact: incoming.preferred_contact || existing.preferred_contact,
    status: incoming.status || existing.status,
    source: incoming.source || existing.source,
    neighborhood: incoming.neighborhood || existing.neighborhood,
    address: incoming.address || existing.address,
    city: incoming.city || existing.city,
    state: incoming.state || existing.state,
    zip: incoming.zip || existing.zip,
    country: incoming.country || existing.country,
    repeat_interval_months: incoming.repeat_interval_months || existing.repeat_interval_months,
    last_service_date: incoming.last_service_date || existing.last_service_date,
    next_followup_date: incoming.next_followup_date || existing.next_followup_date,
    last_contacted_date: existing.last_contacted_date,
    tags: normalizeTags([...(existing.tags || []), ...(incoming.tags || [])]),
    followup_note: existing.followup_note,
    notes: existing.notes || incoming.notes,
    bookings: mergeBookings(existing.bookings || [], incoming.bookings || []),
    source_lead_id: existing.source_lead_id || incoming.source_lead_id,
    import_source_file: incoming.import_source_file || existing.import_source_file,
    external_created_date: incoming.external_created_date || existing.external_created_date,
    external_updated_date: incoming.external_updated_date || existing.external_updated_date,
  });

  merged.lookup_keys = computeLookupKeys(merged);
  return merged;
}

function renderImportSummary(summaryHead, lines) {
  if (!els.importSummary || !els.importSummaryHead || !els.importSummaryItems) return;

  els.importSummary.hidden = false;
  els.importSummaryHead.textContent = summaryHead;
  els.importSummaryItems.innerHTML = (lines || []).slice(0, 120).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
}

async function importMarkdownFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || !state.user || !state.isAdmin || state.importing || state.saving || state.deleting) return;

  state.importing = true;
  setControlsDisabled(true);
  setStatus(`Parsing ${files.length} markdown file(s)...`);

  const parsed = [];
  const parseIssues = [];

  for (const file of files) {
    try {
      const record = await parseMarkdownClient(file);
      if (!record.client.full_name) {
        parseIssues.push(`Skipped ${file.name}: no client name found.`);
        continue;
      }
      parsed.push(record);
    } catch (error) {
      console.error("Failed to parse markdown file", file.name, error);
      parseIssues.push(`Skipped ${file.name}: could not parse file.`);
    }
  }

  if (!parsed.length) {
    renderImportSummary("No valid markdown files were found.", parseIssues.length ? parseIssues : ["No import actions were performed."]);
    setStatus("No valid markdown files to import.", "error");
    state.importing = false;
    setControlsDisabled(false);
    if (els.importMdInput) els.importMdInput.value = "";
    return;
  }

  const lookupIndex = buildLookupIndex(state.clients);
  let possibleUpdates = 0;
  parsed.forEach((record) => {
    const match = (record.client.lookup_keys || []).map((key) => lookupIndex.get(key)).find(Boolean);
    if (match) possibleUpdates += 1;
  });

  const confirmed = window.confirm(
    `Import ${parsed.length} file(s)? ${possibleUpdates} look like updates and ${parsed.length - possibleUpdates} look like new clients.`
  );

  if (!confirmed) {
    setStatus("Markdown import canceled.");
    state.importing = false;
    setControlsDisabled(false);
    if (els.importMdInput) els.importMdInput.value = "";
    return;
  }

  let createdCount = 0;
  let updatedCount = 0;
  const details = [...parseIssues];

  for (const record of parsed) {
    try {
      const incoming = record.client;
      const existingMatch = (incoming.lookup_keys || []).map((key) => lookupIndex.get(key)).find(Boolean);

      if (existingMatch?.id) {
        const merged = mergeClientForImport(existingMatch, incoming);
        const payload = collectDocPayload(merged);

        await updateDoc(doc(db, "clients", existingMatch.id), {
          ...payload,
          import_source_file: incoming.import_source_file || payload.import_source_file || null,
          external_created_date: payload.external_created_date,
          external_updated_date: payload.external_updated_date,
          imported_at: serverTimestamp(),
          imported_by: state.user.uid,
          updated_at: serverTimestamp(),
          updated_by: state.user.uid,
        });

        const mergedLocal = normalizeClientRecord({
          ...merged,
          id: existingMatch.id,
          updated_at: new Date().toISOString(),
          updated_by: state.user.uid,
        });

        updateClientInState(existingMatch.id, mergedLocal);
        mergedLocal.lookup_keys.forEach((key) => lookupIndex.set(key, mergedLocal));

        updatedCount += 1;
        details.push(`Updated ${merged.full_name} from ${record.filename}.`);
      } else {
        const payload = collectDocPayload(incoming);
        const ref = await addDoc(collection(db, "clients"), {
          ...payload,
          import_source_file: incoming.import_source_file || payload.import_source_file || null,
          external_created_date: payload.external_created_date,
          external_updated_date: payload.external_updated_date,
          imported_at: serverTimestamp(),
          imported_by: state.user.uid,
          created_at: serverTimestamp(),
          created_by: state.user.uid,
          updated_at: serverTimestamp(),
          updated_by: state.user.uid,
        });

        const localRecord = normalizeClientRecord({
          id: ref.id,
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: state.user.uid,
          updated_by: state.user.uid,
        });

        state.clients.unshift(localRecord);
        localRecord.lookup_keys.forEach((key) => lookupIndex.set(key, localRecord));

        createdCount += 1;
        details.push(`Created ${incoming.full_name} from ${record.filename}.`);
      }
    } catch (error) {
      console.error("Markdown import failure", record.filename, error);
      details.push(`Failed ${record.filename}: ${error?.message || "unknown error"}.`);
    }
  }

  applyFilters();

  if (!state.activeClientId && state.filteredClients.length) {
    selectClient(state.filteredClients[0].id);
  }

  renderImportSummary(
    `Markdown import complete. Created ${createdCount}, updated ${updatedCount}, total parsed ${parsed.length}.`,
    details
  );

  setStatus(`Import finished: ${createdCount} created, ${updatedCount} updated.`, "success");

  state.importing = false;
  setControlsDisabled(false);
  if (els.importMdInput) els.importMdInput.value = "";
}

function csvEscapeCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildGoogleAdsRow(client) {
  const normalized = blankClient(client);
  const split = splitName(normalized.full_name);

  return {
    Email: normalized.email || "",
    Phone: normalized.phone_e164 || "",
    "First Name": normalized.first_name || split.first_name || "",
    "Last Name": normalized.last_name || split.last_name || "",
    Country: normalizeCountry(normalized.country || "US"),
    Zip: normalized.zip || "",
  };
}

function exportGoogleAdsCsv() {
  const candidates = state.filteredClients.length ? state.filteredClients : state.clients;
  if (!candidates.length) {
    setStatus("No clients available to export.", "error");
    return;
  }

  const rows = candidates
    .map((client) => buildGoogleAdsRow(client))
    .filter((row) => {
      const hasNameAddress = row["First Name"] && row["Last Name"] && row.Country && row.Zip;
      return Boolean(row.Email || row.Phone || hasNameAddress);
    });

  if (!rows.length) {
    setStatus("No exportable records. Add email, phone, or full name + country + ZIP.", "error");
    return;
  }

  const csvLines = [
    GOOGLE_ADS_HEADERS.join(","),
    ...rows.map((row) => GOOGLE_ADS_HEADERS.map((header) => csvEscapeCell(row[header])).join(",")),
  ];

  const csv = `\uFEFF${csvLines.join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const today = new Date().toISOString().slice(0, 10);

  link.href = URL.createObjectURL(blob);
  link.download = `google-ads-client-export-${today}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);

  setStatus(`Exported ${rows.length} contacts to Google Ads CSV format.`, "success");
}

function leadCreatedDate(lead) {
  return parseDate(lead.created_at) || parseDate(lead.ts) || new Date();
}

function serviceLabelFromLead(lead) {
  const map = {
    quick: "Quick Once Over",
    full: "Full Detail",
    interior: "Interior Refresh",
    other: "Other",
  };
  return map[String(lead.service || "").toLowerCase()] || sanitizeText(lead.service, 120) || "Quote lead";
}

function buildClientDraftFromLead(lead) {
  const leadDate = leadCreatedDate(lead);
  const leadDateIso = leadDate.toISOString().slice(0, 10);
  const leadStatus = String(lead.status || "new").toLowerCase();
  const mappedStatus = leadStatus === "booked" ? "active" : "prospect";

  const booking = normalizeBooking({
    id: `lead_${sanitizeText(lead.id, 80)}`,
    date: leadDateIso,
    service: serviceLabelFromLead(lead),
    amount: Number.isFinite(Number(lead.quoted_total)) ? Number(lead.quoted_total) : null,
    notes: sanitizeText(lead.notes, 280),
    source: "lead_quote",
    lead_id: sanitizeText(lead.id, 120),
    created_at: new Date().toISOString(),
  });

  const clientSeed = blankClient({
    full_name: sanitizeText(lead.name, 140),
    phone: formatPhone(lead.phone_normalized || lead.phone),
    phone_e164: normalizePhoneE164(lead.phone_normalized || lead.phone),
    email: "",
    status: mappedStatus,
    source: "quote_page",
    zip: normalizeZip(lead.zip),
    country: "US",
    repeat_interval_months: DEFAULT_REPEAT_MONTHS,
    last_service_date: leadStatus === "booked" ? leadDateIso : "",
    next_followup_date: leadStatus === "booked" ? addMonthsIsoDate(leadDateIso, DEFAULT_REPEAT_MONTHS) : "",
    tags: ["quote/lead"],
    notes: sanitizeText(lead.notes, 4000),
    bookings: booking && leadStatus === "booked" ? [booking] : [],
    source_lead_id: sanitizeText(lead.id, 120),
  });

  clientSeed.lookup_keys = computeLookupKeys(clientSeed);
  return clientSeed;
}

async function prefillFromLeadIfNeeded() {
  if (!state.fromLeadId || !state.user || !state.isAdmin) return;

  try {
    setStatus(`Loading lead ${state.fromLeadId} for client prefill...`);
    const leadSnap = await getDoc(doc(db, "leads", state.fromLeadId));
    if (!leadSnap.exists()) {
      setStatus(`Lead ${state.fromLeadId} was not found.`, "error");
      state.fromLeadId = null;
      setQueryParams({ clientId: state.activeClientId, fromLeadId: null });
      return;
    }

    const lead = { id: leadSnap.id, ...leadSnap.data() };
    state.prefillLead = lead;

    const seed = buildClientDraftFromLead(lead);
    const lookupIndex = buildLookupIndex(state.clients);
    const existingMatch = (seed.lookup_keys || []).map((key) => lookupIndex.get(key)).find(Boolean);

    if (existingMatch?.id) {
      const merged = mergeClientForImport(existingMatch, seed);
      showClientDetails({ ...merged, id: existingMatch.id });
      state.creatingNew = false;
      state.activeClientId = existingMatch.id;
      setStatus(`Loaded lead ${lead.id}. Review and save to update ${merged.full_name}.`);
    } else {
      openNewClientForm(seed);
      setStatus(`Loaded lead ${lead.id}. Review and save to create a client.`);
    }

    state.fromLeadId = null;
    setQueryParams({ clientId: state.activeClientId, fromLeadId: null });
  } catch (error) {
    console.error("Failed to prefill from lead", error);
    setStatus("Could not prefill from lead.", "error");
  }
}

function bindEvents() {
  if (els.signInBtn) {
    els.signInBtn.addEventListener("click", async () => {
      try {
        setStatus("Signing in...");
        await signInWithPopup(auth, new GoogleAuthProvider());
      } catch (error) {
        console.error("Sign in failed", error);
        setStatus("Sign in failed. Check Google Auth settings.", "error");
      }
    });
  }

  if (els.signOutBtn) {
    els.signOutBtn.addEventListener("click", async () => {
      await signOut(auth);
    });
  }

  if (els.unauthorizedSignOutBtn) {
    els.unauthorizedSignOutBtn.addEventListener("click", async () => {
      await signOut(auth);
    });
  }

  if (els.refreshBtn) {
    els.refreshBtn.addEventListener("click", async () => {
      await loadClients();
      await prefillFromLeadIfNeeded();
    });
  }

  if (els.newClientBtn) {
    els.newClientBtn.addEventListener("click", () => {
      state.prefillLead = null;
      openNewClientForm();
    });
  }

  if (els.importMdBtn && els.importMdInput) {
    els.importMdBtn.addEventListener("click", () => {
      els.importMdInput.click();
    });

    els.importMdInput.addEventListener("change", async (event) => {
      const files = event.target?.files;
      if (!files?.length) return;
      await importMarkdownFiles(files);
    });
  }

  if (els.exportCsvBtn) {
    els.exportCsvBtn.addEventListener("click", exportGoogleAdsCsv);
  }

  const filterControls = [els.searchInput, els.statusFilter, els.followupFilter, els.sortFilter];
  filterControls.forEach((control) => {
    if (!control) return;
    const eventName = control === els.searchInput ? "input" : "change";
    control.addEventListener(eventName, applyFilters);
  });

  if (els.clearFiltersBtn) {
    els.clearFiltersBtn.addEventListener("click", () => {
      if (els.searchInput) els.searchInput.value = "";
      if (els.statusFilter) els.statusFilter.value = "all";
      if (els.followupFilter) els.followupFilter.value = "all";
      if (els.sortFilter) els.sortFilter.value = "followup";
      applyFilters();
    });
  }

  if (els.phoneInput) {
    els.phoneInput.addEventListener("blur", () => {
      const e164 = normalizePhoneE164(els.phoneInput.value);
      if (e164) els.phoneInput.value = formatPhone(e164);
    });
  }

  if (els.zipInput) {
    els.zipInput.addEventListener("input", () => {
      els.zipInput.value = normalizeZip(els.zipInput.value);
    });
  }

  if (els.countryInput) {
    els.countryInput.addEventListener("blur", () => {
      els.countryInput.value = normalizeCountry(els.countryInput.value);
    });
  }

  if (els.repeatMonthsInput) {
    els.repeatMonthsInput.addEventListener("change", autoFillNextFollowup);
  }

  if (els.lastServiceInput) {
    els.lastServiceInput.addEventListener("change", autoFillNextFollowup);
  }

  if (els.addBookingBtn) {
    els.addBookingBtn.addEventListener("click", addBookingFromInputs);
  }

  if (els.deleteClientBtn) {
    els.deleteClientBtn.addEventListener("click", deleteActiveClient);
  }

  if (els.saveClientBtn) {
    els.saveClientBtn.addEventListener("click", saveClient);
  }

  if (els.actionCopyLink) {
    els.actionCopyLink.addEventListener("click", copyClientLink);
  }
}

async function handleAuth(user) {
  state.user = user;

  if (!user) {
    state.isAdmin = false;
    state.clients = [];
    state.filteredClients = [];
    if (els.authHint) {
      els.authHint.textContent = "You must be listed in adminUsers/<uid> to access admin tools.";
    }
    if (els.userEmail) els.userEmail.textContent = "-";
    if (els.userUid) els.userUid.textContent = "-";
    showView("auth");
    setStatus("Sign in to access client manager.");
    return;
  }

  if (els.userEmail) els.userEmail.textContent = user.email || "(no email)";
  if (els.userUid) els.userUid.textContent = user.uid;
  if (els.authHint) {
    els.authHint.textContent = `Signed in as ${user.email || user.uid}`;
  }

  try {
    setStatus("Checking admin access...");
    state.isAdmin = await checkAdmin(user.uid);
    if (!state.isAdmin) {
      showView("unauthorized");
      setStatus("You are signed in but not listed in adminUsers.", "error");
      return;
    }

    showView("admin");
    await loadClients();
    await prefillFromLeadIfNeeded();
    setStatus("Client manager ready.", "success");
  } catch (error) {
    console.error("Admin check failed", error);
    showView("unauthorized");
    setStatus("Could not verify admin access.", "error");
  }
}

bindEvents();
onAuthStateChanged(auth, (user) => {
  handleAuth(user).catch((error) => {
    console.error("Unexpected auth handler error", error);
    setStatus("Unexpected authentication error.", "error");
  });
});
