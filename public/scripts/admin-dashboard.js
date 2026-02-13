import { auth, db } from "/scripts/firebase-client.js";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const params = new URLSearchParams(window.location.search);
const preselectedLeadId = params.get("id");

const els = {
  status: document.getElementById("admin-status"),
  authView: document.getElementById("auth-view"),
  unauthorizedView: document.getElementById("unauthorized-view"),
  adminView: document.getElementById("admin-view"),
  userEmail: document.getElementById("admin-user-email"),
  userUid: document.getElementById("admin-uid"),
  authHint: document.getElementById("auth-hint"),
  signInBtn: document.getElementById("sign-in-btn"),
  signOutBtn: document.getElementById("sign-out-btn"),
  unauthorizedSignOutBtn: document.getElementById("sign-out-unauthorized-btn"),
  refreshBtn: document.getElementById("refresh-leads-btn"),
  searchInput: document.getElementById("lead-search-input"),
  statusFilter: document.getElementById("lead-status-filter"),
  serviceFilter: document.getElementById("lead-service-filter"),
  rangeFilter: document.getElementById("lead-range-filter"),
  sortFilter: document.getElementById("lead-sort-filter"),
  clearFiltersBtn: document.getElementById("clear-filters-btn"),
  totalCount: document.getElementById("summary-total-count"),
  shownCount: document.getElementById("summary-shown-count"),
  newCount: document.getElementById("summary-new-count"),
  followupCount: document.getElementById("summary-followup-count"),
  leadList: document.getElementById("lead-list"),
  leadListEmpty: document.getElementById("lead-list-empty"),
  leadDetailPlaceholder: document.getElementById("lead-detail-placeholder"),
  leadDetailCard: document.getElementById("lead-detail-card"),
  detailHeaderName: document.getElementById("detail-name"),
  detailHeaderCreated: document.getElementById("detail-created"),
  detailPricePill: document.getElementById("detail-price-pill"),
  detailBody: document.getElementById("lead-detail-body"),
  detailUtm: document.getElementById("lead-detail-utm"),
  detailMeta: document.getElementById("lead-detail-meta"),
  detailSmsBtn: document.getElementById("lead-action-sms"),
  detailCallBtn: document.getElementById("lead-action-call"),
  detailCopyLinkBtn: document.getElementById("lead-action-copy-link"),
  detailStatusInput: document.getElementById("lead-status-input"),
  detailAdminNoteInput: document.getElementById("lead-admin-note-input"),
  saveLeadBtn: document.getElementById("save-lead-btn"),
};

const state = {
  user: null,
  isAdmin: false,
  leads: [],
  filteredLeads: [],
  activeLeadId: null,
  preferredLeadId: preselectedLeadId,
  loadingLeads: false,
  savingLead: false,
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
    els.searchInput,
    els.statusFilter,
    els.serviceFilter,
    els.rangeFilter,
    els.sortFilter,
    els.clearFiltersBtn,
    els.saveLeadBtn,
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDate(value) {
  if (!value) return null;
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

function leadCreatedDate(lead) {
  return parseDate(lead.created_at) || parseDate(lead.ts);
}

function leadCreatedMs(lead) {
  return leadCreatedDate(lead)?.getTime() || 0;
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return "Unknown date";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizePhoneDigits(input) {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(0, 10);
}

function formatPhone(input) {
  const digits = normalizePhoneDigits(input);
  if (digits.length !== 10) return input || "N/A";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function smsHrefForLead(lead) {
  const digits = normalizePhoneDigits(lead.phone_normalized || lead.phone);
  return digits.length === 10 ? `sms:+1${digits}` : "#";
}

function callHrefForLead(lead) {
  const digits = normalizePhoneDigits(lead.phone_normalized || lead.phone);
  return digits.length === 10 ? `tel:+1${digits}` : "#";
}

function priceLabel(lead) {
  return lead.quoted_total == null ? "Consult" : `$${lead.quoted_total}`;
}

function leadStatus(lead) {
  return String(lead.status || "new").toLowerCase();
}

function serviceLabel(lead) {
  const map = {
    quick: "Quick Once Over",
    full: "Full Detail",
    interior: "Interior Refresh",
    other: "Other",
  };
  return map[String(lead.service || "").toLowerCase()] || lead.service || "N/A";
}

function vehicleLabel(lead) {
  const map = {
    sedan: "Sedan/Coupe",
    suv: "SUV/Crossover",
    truck: "Truck/Van",
  };
  return map[String(lead.vehicle || "").toLowerCase()] || lead.vehicle || "N/A";
}

function daysAgoToMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function sortLeads(leads, sortKey) {
  const next = [...leads];
  switch (sortKey) {
    case "oldest":
      next.sort((a, b) => leadCreatedMs(a) - leadCreatedMs(b));
      break;
    case "price-high":
      next.sort((a, b) => (Number(b.quoted_total) || -1) - (Number(a.quoted_total) || -1));
      break;
    case "price-low":
      next.sort((a, b) => (Number(a.quoted_total) || 999999) - (Number(b.quoted_total) || 999999));
      break;
    default:
      next.sort((a, b) => leadCreatedMs(b) - leadCreatedMs(a));
      break;
  }
  return next;
}

function leadMatchesSearch(lead, search) {
  if (!search) return true;
  const haystack = [
    lead.id,
    lead.name,
    lead.phone,
    lead.phone_normalized,
    lead.zip,
    lead.notes,
    lead.service,
    lead.vehicle,
    lead.status,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

function applyFilters() {
  const search = (els.searchInput?.value || "").trim().toLowerCase();
  const statusFilter = els.statusFilter?.value || "all";
  const serviceFilter = els.serviceFilter?.value || "all";
  const rangeFilter = els.rangeFilter?.value || "all";
  const sortFilter = els.sortFilter?.value || "newest";

  let leads = [...state.leads];

  if (statusFilter !== "all") {
    leads = leads.filter((lead) => leadStatus(lead) === statusFilter);
  }
  if (serviceFilter !== "all") {
    leads = leads.filter((lead) => String(lead.service || "").toLowerCase() === serviceFilter);
  }
  if (rangeFilter !== "all") {
    const cutoff =
      rangeFilter === "1d" ? daysAgoToMs(1)
      : rangeFilter === "7d" ? daysAgoToMs(7)
      : rangeFilter === "30d" ? daysAgoToMs(30)
      : daysAgoToMs(90);
    leads = leads.filter((lead) => leadCreatedMs(lead) >= cutoff);
  }
  if (search) {
    leads = leads.filter((lead) => leadMatchesSearch(lead, search));
  }

  leads = sortLeads(leads, sortFilter);
  state.filteredLeads = leads;

  renderSummary();
  renderLeadList();

  if (state.activeLeadId) {
    const stillVisible = leads.some((lead) => lead.id === state.activeLeadId);
    if (!stillVisible) {
      showLeadDetails(null);
    }
  }
}

function renderSummary() {
  const total = state.leads.length;
  const shown = state.filteredLeads.length;
  const newCount = state.leads.filter((lead) => leadStatus(lead) === "new").length;
  const followupCount = state.leads.filter((lead) => {
    const status = leadStatus(lead);
    return status === "new" || status === "contacted";
  }).length;

  if (els.totalCount) els.totalCount.textContent = String(total);
  if (els.shownCount) els.shownCount.textContent = String(shown);
  if (els.newCount) els.newCount.textContent = String(newCount);
  if (els.followupCount) els.followupCount.textContent = String(followupCount);
}

function renderLeadList() {
  if (!els.leadList || !els.leadListEmpty) return;

  if (!state.filteredLeads.length) {
    els.leadList.innerHTML = "";
    els.leadListEmpty.hidden = false;
    return;
  }

  els.leadListEmpty.hidden = true;

  els.leadList.innerHTML = state.filteredLeads
    .map((lead) => {
      const status = leadStatus(lead);
      const activeClass = lead.id === state.activeLeadId ? " lead-item-active" : "";
      return `
        <li>
          <button type="button" class="lead-item${activeClass}" data-lead-id="${escapeHtml(lead.id)}">
            <span class="lead-item-top">
              <span class="lead-item-name">${escapeHtml(lead.name || "Unnamed lead")}</span>
              <span class="pill pill-status pill-${escapeHtml(status)}">${escapeHtml(status)}</span>
            </span>
            <span class="lead-item-mid">${escapeHtml(serviceLabel(lead))} • ${escapeHtml(vehicleLabel(lead))}</span>
            <span class="lead-item-bottom">
              <span>${escapeHtml(priceLabel(lead))}</span>
              <span>${escapeHtml(formatDateTime(leadCreatedDate(lead)))}</span>
            </span>
          </button>
        </li>
      `;
    })
    .join("");

  els.leadList.querySelectorAll(".lead-item").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-lead-id");
      if (id) selectLead(id);
    });
  });
}

function detailRowsHtml(rows) {
  return rows
    .map(
      (row) => `
      <div class="row">
        <div class="k">${escapeHtml(row.label)}</div>
        <div class="v">${escapeHtml(row.value)}</div>
      </div>
    `
    )
    .join("");
}

function showLeadDetails(lead) {
  state.activeLeadId = lead?.id || null;

  if (!lead) {
    if (els.leadDetailPlaceholder) els.leadDetailPlaceholder.hidden = false;
    if (els.leadDetailCard) els.leadDetailCard.hidden = true;
    if (els.leadList) {
      els.leadList.querySelectorAll(".lead-item-active").forEach((node) => {
        node.classList.remove("lead-item-active");
      });
    }
    return;
  }

  if (els.leadDetailPlaceholder) els.leadDetailPlaceholder.hidden = true;
  if (els.leadDetailCard) els.leadDetailCard.hidden = false;

  if (els.detailHeaderName) {
    els.detailHeaderName.textContent = lead.name || "Unnamed lead";
  }
  if (els.detailHeaderCreated) {
    els.detailHeaderCreated.textContent = `Created ${formatDateTime(leadCreatedDate(lead))}`;
  }
  if (els.detailPricePill) {
    els.detailPricePill.textContent = priceLabel(lead);
  }

  if (els.detailBody) {
    const addonText = Array.isArray(lead.addons) && lead.addons.length ? lead.addons.join(", ") : "None";
    els.detailBody.innerHTML = detailRowsHtml([
      { label: "Lead ID", value: lead.id || "N/A" },
      { label: "Status", value: leadStatus(lead) },
      { label: "Vehicle", value: vehicleLabel(lead) },
      { label: "Service", value: serviceLabel(lead) },
      { label: "Add-ons", value: addonText },
      { label: "ZIP", value: lead.zip || "N/A" },
      { label: "Phone", value: formatPhone(lead.phone_normalized || lead.phone || "N/A") },
      { label: "Quote", value: priceLabel(lead) },
      { label: "Notes", value: lead.notes || "None" },
    ]);
  }

  if (els.detailUtm) {
    els.detailUtm.textContent = JSON.stringify(lead.utm || {}, null, 2);
  }
  if (els.detailMeta) {
    els.detailMeta.innerHTML = detailRowsHtml([
      { label: "Submitted", value: lead.ts || "N/A" },
      { label: "Referrer", value: lead.referrer || "N/A" },
      { label: "User Agent", value: lead.user_agent || "N/A" },
      { label: "IP", value: lead.ip || "N/A" },
      { label: "Internal Note", value: lead.admin_note || "None" },
    ]);
  }

  const smsHref = smsHrefForLead(lead);
  const callHref = callHrefForLead(lead);
  if (els.detailSmsBtn) {
    els.detailSmsBtn.href = smsHref;
    els.detailSmsBtn.setAttribute("aria-disabled", smsHref === "#" ? "true" : "false");
  }
  if (els.detailCallBtn) {
    els.detailCallBtn.href = callHref;
    els.detailCallBtn.setAttribute("aria-disabled", callHref === "#" ? "true" : "false");
  }

  if (els.detailStatusInput) {
    els.detailStatusInput.value = leadStatus(lead);
  }
  if (els.detailAdminNoteInput) {
    els.detailAdminNoteInput.value = lead.admin_note || "";
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("id", lead.id);
  history.replaceState(null, "", nextUrl.toString());
}

function selectLead(leadId) {
  const lead = state.leads.find((item) => item.id === leadId);
  if (!lead) {
    showLeadDetails(null);
    return;
  }
  showLeadDetails(lead);
  renderLeadList();
}

async function checkAdmin(uid) {
  const snap = await getDoc(doc(db, "adminUsers", uid));
  return snap.exists();
}

async function ensureLeadPresent(leadId) {
  if (!leadId) return;
  const exists = state.leads.some((lead) => lead.id === leadId);
  if (exists) return;

  const snap = await getDoc(doc(db, "leads", leadId));
  if (!snap.exists()) return;
  state.leads.unshift({ id: snap.id, ...snap.data() });
}

async function loadLeads() {
  if (state.loadingLeads) return;
  state.loadingLeads = true;
  setControlsDisabled(true);
  setStatus("Loading leads...");

  try {
    const preferredLeadId = state.activeLeadId || state.preferredLeadId;
    const leadsQuery = query(collection(db, "leads"), orderBy("ts", "desc"), limit(300));
    const snapshot = await getDocs(leadsQuery);
    state.leads = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

    if (preferredLeadId) {
      await ensureLeadPresent(preferredLeadId);
    }

    applyFilters();

    if (preferredLeadId) {
      selectLead(preferredLeadId);
    } else if (!state.activeLeadId && state.filteredLeads.length) {
      selectLead(state.filteredLeads[0].id);
    } else if (state.activeLeadId) {
      selectLead(state.activeLeadId);
    }
    state.preferredLeadId = null;

    setStatus(`Loaded ${state.leads.length} leads.`);
  } catch (error) {
    console.error("Failed to load leads", error);
    setStatus("Could not load leads. Check Firestore rules/indexes.", "error");
  } finally {
    state.loadingLeads = false;
    setControlsDisabled(false);
  }
}

async function saveLeadEdits() {
  if (!state.user || !state.isAdmin || !state.activeLeadId || state.savingLead) return;
  const lead = state.leads.find((item) => item.id === state.activeLeadId);
  if (!lead) return;

  const nextStatus = String(els.detailStatusInput?.value || "new").toLowerCase();
  const adminNote = (els.detailAdminNoteInput?.value || "").trim().slice(0, 2000);

  state.savingLead = true;
  setControlsDisabled(true);
  setStatus("Saving lead updates...");

  try {
    await updateDoc(doc(db, "leads", state.activeLeadId), {
      status: nextStatus,
      admin_note: adminNote || null,
      admin_updated_by: state.user.uid,
      admin_updated_at: serverTimestamp(),
    });

    const idx = state.leads.findIndex((item) => item.id === state.activeLeadId);
    if (idx >= 0) {
      state.leads[idx] = {
        ...state.leads[idx],
        status: nextStatus,
        admin_note: adminNote || null,
        admin_updated_by: state.user.uid,
      };
    }
    applyFilters();
    selectLead(state.activeLeadId);
    setStatus("Lead updated.");
  } catch (error) {
    console.error("Failed to save lead updates", error);
    setStatus("Could not save lead updates.", "error");
  } finally {
    state.savingLead = false;
    setControlsDisabled(false);
  }
}

async function copyCurrentLeadLink() {
  if (!state.activeLeadId) return;
  const url = new URL(window.location.href);
  url.searchParams.set("id", state.activeLeadId);
  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("Lead link copied to clipboard.");
  } catch {
    setStatus("Could not copy link.", "error");
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
    els.refreshBtn.addEventListener("click", loadLeads);
  }

  const filterControls = [
    els.searchInput,
    els.statusFilter,
    els.serviceFilter,
    els.rangeFilter,
    els.sortFilter,
  ];
  filterControls.forEach((control) => {
    if (!control) return;
    const eventName = control === els.searchInput ? "input" : "change";
    control.addEventListener(eventName, applyFilters);
  });

  if (els.clearFiltersBtn) {
    els.clearFiltersBtn.addEventListener("click", () => {
      if (els.searchInput) els.searchInput.value = "";
      if (els.statusFilter) els.statusFilter.value = "all";
      if (els.serviceFilter) els.serviceFilter.value = "all";
      if (els.rangeFilter) els.rangeFilter.value = "all";
      if (els.sortFilter) els.sortFilter.value = "newest";
      applyFilters();
    });
  }

  if (els.saveLeadBtn) {
    els.saveLeadBtn.addEventListener("click", saveLeadEdits);
  }

  if (els.detailCopyLinkBtn) {
    els.detailCopyLinkBtn.addEventListener("click", copyCurrentLeadLink);
  }
}

async function handleAuth(user) {
  state.user = user;

  if (!user) {
    state.isAdmin = false;
    if (els.authHint) {
      els.authHint.textContent = "You must be listed in adminUsers/<uid> to access admin tools.";
    }
    if (els.userEmail) els.userEmail.textContent = "-";
    if (els.userUid) els.userUid.textContent = "-";
    showView("auth");
    setStatus("Sign in to access admin dashboard.");
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
    await loadLeads();
    setStatus("Admin dashboard ready.");
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
