(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const shouldTrackFunnelSteps = !isLocalHost;
  const buildApiUrl = path => path; // Same-origin API; previews never submit to production.

  // Canonical keys
  const VEHICLES = { sedan: 'Sedan/Coupe', suv_truck: 'SUV/Truck', van_3row: 'Van/3-Row SUV' };
  const SERVICES = { quick: 'Quick Once Over', full: 'Full Detail', interior_only: 'Interior Only', other: 'Other' };
  const HERO_SERVICE_LABELS = { quick: 'Quick Detail', full: 'Full Detail', interior_only: 'Interior Only' };
  // Pricing model
  const PRICES = {
    base: {
      sedan: { quick: 200, full: 300, interior_only: 200 },
      suv_truck: { quick: 250, full: 350, interior_only: 250 },
      van_3row: { quick: 300, full: 400, interior_only: 300 }
    }

  };

  const CONSULT_SERVICES = new Set(['other', 'paint']);

  const initial = {
    vehicle: null,
    service: null,
    addons: [],
    zip: '',
    notes: '',
    name: '',
    phone: '',
    quote: null,
    consult: false,
    step: 1,
  };

  const loadState = () => {
    try {
      const restored = { ...initial, ...(JSON.parse(localStorage.getItem('quoteState') || '{}')) };
      let migrated = false;

      if (restored.vehicle === 'suv') {
        restored.vehicle = 'suv_truck';
        migrated = true;
      } else if (restored.vehicle === 'truck') {
        // The former Truck/Van choice is now split across two categories.
        restored.vehicle = null;
        migrated = true;
      } else if (restored.vehicle && !Object.prototype.hasOwnProperty.call(VEHICLES, restored.vehicle)) {
        restored.vehicle = null;
        migrated = true;
      }

      if (restored.service === 'interior' || restored.service === 'paint') {
        restored.service = 'interior_only';
        migrated = true;
      } else if (restored.service && !Object.prototype.hasOwnProperty.call(SERVICES, restored.service)) {
        restored.service = null;
        migrated = true;
      }

      restored.addons = [];
      restored.name = '';
      restored.phone = '';
      restored.notes = '';

      if (migrated) localStorage.setItem('quoteState', JSON.stringify(restored));
      return restored;
    } catch {
      return { ...initial };
    }
  };
  const saveState = (s) => { try { localStorage.setItem('quoteState', JSON.stringify({ ...s, name: '', phone: '', notes: '' })); } catch {} };

  let state = loadState();
  state.addons = []; // Add-ons are offered only after the lead is saved.
  saveState(state);
  let submitting = false;
  let completed = false;
  let updateToken = null;
  try {
    const pending = sessionStorage.getItem('quotePendingToken');
    if (/^[a-f0-9]{64}$/.test(pending || '')) updateToken = pending;
  } catch {}

  const FUNNEL_SESSION_KEY = 'quoteFunnelSessionId';
  const FUNNEL_TRACKED_STEPS_KEY = 'quoteFunnelTrackedSteps';
  const FUNNEL_SUBMITTED_KEY = 'quoteFunnelSubmitted';
  const FUNNEL_STARTED_AT_KEY = 'quoteFunnelStartedAt';
  const FUNNEL_LAST_EVENT_AT_KEY = 'quoteFunnelLastEventAt';
  const FUNNEL_STATE_VERSION_KEY = 'quoteFunnelStateVersion';
  const FUNNEL_STATE_VERSION = '5';
  const FUNNEL_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  const getSessionStorage = () => {
    try {
      const storage = window.sessionStorage;
      return {
        getItem: key => { try { return storage.getItem(key); } catch { return null; } },
        setItem: (key, value) => { try { storage.setItem(key, value); } catch {} },
        removeItem: key => { try { storage.removeItem(key); } catch {} },
      };
    } catch { return null; }
  };

  const makeSessionId = () => {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `q_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  };

  const loadTrackedSteps = (storage) => {
    if (!storage) return new Set();
    try {
      const parsed = JSON.parse(storage.getItem(FUNNEL_TRACKED_STEPS_KEY) || '[]');
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map((v) => String(v)).filter((v) => /^[1-4]$/.test(v)));
    } catch {
      return new Set();
    }
  };

  const persistTrackedSteps = (storage, trackedSteps) => {
    if (!storage) return;
    storage.setItem(FUNNEL_TRACKED_STEPS_KEY, JSON.stringify(Array.from(trackedSteps)));
  };

  const initFunnel = () => {
    const storage = getSessionStorage();
    const now = Date.now();
    if (!storage) {
      return {
        storage: null,
        sessionId: makeSessionId(),
        startedAt: new Date(now).toISOString(),
        trackedSteps: new Set(),
        submitted: false,
      };
    }

    const storedVersion = storage.getItem(FUNNEL_STATE_VERSION_KEY) || '';
    if (storedVersion !== FUNNEL_STATE_VERSION) {
      storage.setItem(FUNNEL_STATE_VERSION_KEY, FUNNEL_STATE_VERSION);
      storage.setItem(FUNNEL_SESSION_KEY, makeSessionId());
      storage.setItem(FUNNEL_STARTED_AT_KEY, new Date(now).toISOString());
      storage.removeItem(FUNNEL_TRACKED_STEPS_KEY);
      storage.removeItem(FUNNEL_SUBMITTED_KEY);
      storage.removeItem(FUNNEL_LAST_EVENT_AT_KEY);
    }

    const existingSessionId = storage.getItem(FUNNEL_SESSION_KEY);
    const lastEventAt = Number(storage.getItem(FUNNEL_LAST_EVENT_AT_KEY) || 0);
    const expired = !existingSessionId || !Number.isFinite(lastEventAt) || (now - lastEventAt > FUNNEL_SESSION_TIMEOUT_MS);

    if (expired) {
      storage.setItem(FUNNEL_SESSION_KEY, makeSessionId());
      storage.setItem(FUNNEL_STARTED_AT_KEY, new Date(now).toISOString());
      storage.removeItem(FUNNEL_TRACKED_STEPS_KEY);
      storage.removeItem(FUNNEL_SUBMITTED_KEY);
    }

    storage.setItem(FUNNEL_LAST_EVENT_AT_KEY, String(now));

    return {
      storage,
      sessionId: storage.getItem(FUNNEL_SESSION_KEY) || makeSessionId(),
      startedAt: storage.getItem(FUNNEL_STARTED_AT_KEY) || new Date(now).toISOString(),
      trackedSteps: loadTrackedSteps(storage),
      submitted: storage.getItem(FUNNEL_SUBMITTED_KEY) === '1',
    };
  };

  const funnel = initFunnel();
  const pendingStepEvents = new Set();
  let pendingLeadSubmissionEvent = false;

  const markFunnelActivity = () => {
    if (!funnel.storage) return;
    funnel.storage.setItem(FUNNEL_LAST_EVENT_AT_KEY, String(Date.now()));
  };

  const fireAdsConversion = (value, currency = 'USD', options = {}) => {
    const amount = typeof value === 'number' && isFinite(value) ? value : 1.0;
    const extraParams = options && typeof options.params === 'object' ? options.params : null;
    const eventCallback = options && typeof options.eventCallback === 'function' ? options.eventCallback : null;
    const payload = {
      send_to: 'AW-17602789326/DjI6CICLnaIbEM7_1MlB',
      value: amount,
      currency,
      ...(extraParams || {}),
    };
    if (eventCallback) payload.event_callback = eventCallback;
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', payload);
    } else {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'conversion', ...payload });
      if (eventCallback) setTimeout(eventCallback, 0);
    }
    if (typeof window.console !== 'undefined' && typeof window.console.log === 'function') {
      window.console.log('[Ads] conversion fired', payload);
    }
    const lastPayload = { ...payload };
    if (eventCallback) delete lastPayload.event_callback;
    window.__lastQuoteConversion = lastPayload;
  };

  window.reportQuoteConversion = fireAdsConversion;

  const computeQuote = (s) => {
    if (!s.vehicle || !s.service) return { total: null, consult: false };
    if (CONSULT_SERVICES.has(s.service)) return { total: null, consult: true };
    const base = PRICES.base[s.vehicle]?.[s.service];
    if (typeof base !== 'number') return { total: null, consult: false };
    return { total: base, consult: false };
  };

  const formatUSD = (n) => `$${n.toFixed(0)}`;

  const updateServicePrices = () => {
    $$('[data-service-price]').forEach((el) => {
      const service = el.getAttribute('data-service-price');
      if (CONSULT_SERVICES.has(service)) {
        el.textContent = 'Custom quote';
        return;
      }
      const price = state.vehicle ? PRICES.base[state.vehicle]?.[service] : null;
      el.textContent = typeof price === 'number' ? `Starting at ${formatUSD(price)}` : 'Select vehicle';
    });
  };

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let hasRenderedStep = false;

  const STEP_TITLES = {
    1: 'Choose your vehicle',
    2: 'Choose your package',
    3: 'Get your quote',
  };

  const updateProgress = (n) => {
    const pct = n / 3;
    const bar = $('#progress');
    if (bar) { bar.style.transform = `scaleX(${pct})`; bar.classList.toggle('is-complete', n === 3); }

    const stepCount = $('#step-count');
    if (stepCount) stepCount.textContent = `Step ${n} of 3`;

    const stepTitle = $('#step-title');
    if (stepTitle) stepTitle.textContent = STEP_TITLES[n] || '';

    const track = $('#progress-track');
    if (track) track.setAttribute('aria-valuenow', String(n));

    $$('[data-progress-step]').forEach((item) => {
      const step = Number(item.getAttribute('data-progress-step'));
      item.classList.toggle('is-current', step === n);
      item.classList.toggle('is-complete', step < n);
      if (step === n) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  };

  const updateStickyAction = () => {
    const actionBar = $('#quote-action-bar');
    const primary = $('#quote-action-primary');
    const label = $('#quote-action-label');
    const back = $('#quote-action-back');
    if (!actionBar || !primary || !label || !back) return;

    actionBar.hidden = completed;
    back.hidden = state.step <= 1;

    let nextLabel = 'Continue';
    let disabled = false;

    if (state.step === 1) {
      nextLabel = state.vehicle ? 'Next: Choose Package' : 'Select a vehicle above';
      disabled = !state.vehicle;
    } else if (state.step === 2) {
      nextLabel = state.service ? 'Next: Your Quote' : 'Select a package above';
      disabled = !state.service;
    } else if (state.step === 3) {
      nextLabel = state.consult ? 'Request My Consultation' : 'Text Me My Quote';
    }

    label.textContent = nextLabel;
    primary.disabled = disabled || submitting;
    primary.setAttribute('aria-label', nextLabel);
  };

  let skeletonTimer;
  const setStep = (n) => {
    if (submitting || completed) return;
    const prevStep = state.step;
    state.step = n;
    document.body.dataset.quoteStep = String(n);
    document.body.classList.remove('quote-flow-complete');
    trackStepView(n);
    const nextScreen = $(`#step-${n}`);
    $$('.screen').forEach(sec => {
      sec.hidden = true;
      sec.classList.remove('step-enter');
    });
    nextScreen?.removeAttribute('hidden');
    if (nextScreen && hasRenderedStep && n !== prevStep && !reduceMotion) {
      nextScreen.classList.add('step-enter');
      const skeleton = $('#step-skeleton');
      skeleton.hidden = false;
      clearTimeout(skeletonTimer);
      skeletonTimer = setTimeout(() => { skeleton.hidden = true; }, 160);
      nextScreen.addEventListener('animationend', () => {
        nextScreen.classList.remove('step-enter');
      }, { once: true });
    }
    hasRenderedStep = true;
    updateProgress(n);
    recalculate();
    // Move focus to step heading for accessibility
    const heading = $(`#step-${n} h2`);
    if (heading) requestAnimationFrame(() => heading.focus());
  };

  const recalculate = () => {
    updateServicePrices();
    state.consult = CONSULT_SERVICES.has(state.service);
    const { total, consult } = computeQuote(state);
    state.quote = total;

    // Update the estimate before contact submission
    const line = $('#quote-line');
    if (line) {
      if (consult) {
        line.textContent = 'I’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        line.textContent = `Your estimate: ${formatUSD(total)}`;
      } else {
        line.textContent = 'Select options to see your quote.';
      }
    }

    const heroPeek = $('#hero-quote-peek');
    if (heroPeek) {
      if (consult) {
        heroPeek.textContent = 'I’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        const serviceLabel = HERO_SERVICE_LABELS[state.service] || SERVICES[state.service] || 'Detail';
        heroPeek.textContent = `${serviceLabel} estimate: ${formatUSD(total)}`;
      } else {
        heroPeek.textContent = 'Quick Detail from $200 (select options to see your quote)';
      }
    }

    // CTA swap
    const submitBtn = $('#submit');
    if (submitBtn) {
      if (state.consult) {
        submitBtn.textContent = 'Request My Consultation';
        submitBtn.dataset.mode = 'consult';
      } else {
        submitBtn.textContent = 'Text Me My Quote';
        submitBtn.dataset.mode = 'quote';
      }
    }
    updateStickyAction();
  };

  const sanitize = (s) => (s || '').replace(/<[^>]*>/g, '').trim();

  const getUsPhoneDigits = (value) => {
    const rawDigits = (value || '').replace(/\D/g, '');
    const digits = rawDigits.length > 10 && rawDigits.startsWith('1')
      ? rawDigits.slice(1)
      : rawDigits;
    return digits.slice(0, 10);
  };

  const formatPhone = (value) => {
    const digits = getUsPhoneDigits(value);
    const p1 = digits.slice(0, 3), p2 = digits.slice(3, 6), p3 = digits.slice(6, 10);
    if (digits.length > 6) return `(${p1}) ${p2}-${p3}`;
    if (digits.length > 3) return `(${p1}) ${p2}`;
    if (digits.length > 0) return `(${p1}`;
    return '';
  };

  const clearStoredPii = () => {
    state.zip = '';
    state.notes = '';
    state.name = '';
    state.phone = '';
    saveState(state);
  };

  const getQueryParams = () => {
    const params = new URLSearchParams(location.search);
    const map = {};
    for (const [k, v] of params.entries()) map[k] = v;
    return map;
  };

  // UTM capture into hidden inputs
  const captureUTMs = () => {
    const qp = new URLSearchParams(location.search);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    set('utm-source', qp.get('utm_source'));
    set('utm-medium', qp.get('utm_medium'));
    set('utm-campaign', qp.get('utm_campaign'));
    set('utm-content', qp.get('utm_content'));
    set('utm-term', qp.get('utm_term'));
  };

  const readUTMs = () => ({
    utm_source: (document.getElementById('utm-source') || {}).value || '',
    utm_medium: (document.getElementById('utm-medium') || {}).value || '',
    utm_campaign: (document.getElementById('utm-campaign') || {}).value || '',
    utm_content: (document.getElementById('utm-content') || {}).value || '',
    utm_term: (document.getElementById('utm-term') || {}).value || '',
  });

  const trackFunnelEvent = (event, extra = {}) => {
    if (!shouldTrackFunnelSteps) return Promise.resolve(false);
    if (!funnel.sessionId) return Promise.resolve(false);
    const payload = {
      session_id: funnel.sessionId,
      session_started_at: funnel.startedAt,
      event,
      page: 'quote',
      flow_version: '5',
      referrer: document.referrer || null,
      utm: readUTMs(),
      ts_client: new Date().toISOString(),
      ...extra,
    };
    return fetch(buildApiUrl('/api/quoteProgress'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    }).then((res) => {
      if (!res.ok) return false;
      markFunnelActivity();
      return true;
    }).catch(() => false);
  };

  const trackStepView = (stepNumber) => {
    if (!shouldTrackFunnelSteps) return;
    const key = String(stepNumber);
    if (funnel.trackedSteps.has(key) || pendingStepEvents.has(key)) return;
    pendingStepEvents.add(key);
    trackFunnelEvent('step_view', { step: stepNumber }).then((ok) => {
      if (!ok) return;
      funnel.trackedSteps.add(key);
      persistTrackedSteps(funnel.storage, funnel.trackedSteps);
    }).finally(() => {
      pendingStepEvents.delete(key);
    });
  };

  const trackLeadSubmitted = (method) => {
    if (!shouldTrackFunnelSteps) return;
    if (funnel.submitted || pendingLeadSubmissionEvent) return;
    pendingLeadSubmissionEvent = true;
    trackFunnelEvent('lead_submitted', { step: 3, capture_method: method }).then((ok) => {
      if (!ok) return;
      funnel.submitted = true;
      if (funnel.storage) funnel.storage.setItem(FUNNEL_SUBMITTED_KEY, '1');
    }).finally(() => {
      pendingLeadSubmissionEvent = false;
    });
  };

  const goNext = (n) => setStep(n);
  const goPrev = (n) => setStep(n);

  const hydrateSelections = () => {
    if (state.vehicle) {
      const el = $(`#step-1 .option[data-value="${state.vehicle}"]`);
      if (el) el.setAttribute('aria-checked', 'true');
    }
    if (state.service) {
      const el = $(`#step-2 .option[data-value="${state.service}"]`);
      if (el) el.setAttribute('aria-checked', 'true');
      $('#consult-note').hidden = !CONSULT_SERVICES.has(state.service);
    }
    $('#notes').value = state.notes || '';
    $('#name').value = state.name || '';
    $('#phone').value = state.phone || '';
  };

  // Event wiring
  const wire = () => {
    // Step 1 selections
    $$('#step-1 .option').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-value');
        state.vehicle = val;
        $$('#step-1 .option').forEach(b => b.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        saveState(state);
        recalculate();
        goNext(2);
      });
    });

    // Step 2 selections
    $$('#step-2 .option').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-value');
        state.service = val;
        $$('#step-2 .option').forEach(b => b.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        state.consult = CONSULT_SERVICES.has(val);
        $('#consult-note').hidden = !state.consult;
        saveState(state);
        recalculate();
        goNext(3);
      });
    });

    // Navigation
    $$('#step-2 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(1)));
    $$('#step-3 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(2)));

    // Inputs
    $('#notes').addEventListener('input', (e) => { state.notes = e.target.value.slice(0, 1000); saveState(state); });
    $('#name').addEventListener('input', (e) => {
      state.name = e.target.value.slice(0, 120);
      saveState(state);
      showFieldError('name', '');
    });
    $('#phone').addEventListener('input', (e) => {
      const formatted = formatPhone(e.target.value);
      e.target.value = formatted;
      state.phone = formatted; saveState(state);
      showFieldError('phone', '');
    });

    const stickyPrimary = $('#quote-action-primary');
    if (stickyPrimary) {
      stickyPrimary.addEventListener('click', () => {
        if (state.step === 1 && state.vehicle) goNext(2);
        else if (state.step === 2 && state.service) goNext(3);
        else if (state.step === 3) submit();
      });
    }

    const stickyBack = $('#quote-action-back');
    if (stickyBack) {
      stickyBack.addEventListener('click', () => {
        if (state.step > 1) goPrev(state.step - 1);
      });
    }

    // Submit
    $('#contact-form').addEventListener('submit', event => { event.preventDefault(); submit(); });
  };

  const wireCallFab = () => {
    const fab = document.querySelector('.call-fab');
    if (!fab) return;
    fab.addEventListener('click', (event) => {
      const href = fab.getAttribute('href') || '';
      const shouldIntercept = /^tel:/i.test(href);
      if (!shouldIntercept) return;
      let navigationHandled = false;
      const resumeNavigation = () => {
        if (navigationHandled) return;
        navigationHandled = true;
        if (shouldIntercept && href) {
          window.location.href = href;
        }
      };

      if (shouldIntercept) event.preventDefault();

      const callClickValue = typeof state.quote === 'number' ? state.quote : 1;
      const analyticsPayload = {
        method: 'quote_call_fab',
        page: 'quote',
      flow_version: '5',
        service: state.service || 'unset',
        vehicle: state.vehicle || 'unset',
        value: callClickValue,
      };

      if (typeof window.gtag === 'function') {
        const payload = shouldIntercept
          ? { ...analyticsPayload, event_callback: resumeNavigation, event_timeout: 1200 }
          : analyticsPayload;
        window.gtag('event', 'call_click', payload);
      } else {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: 'call_click', ...analyticsPayload });
        if (shouldIntercept) setTimeout(resumeNavigation, 0);
      }

      if (shouldIntercept) {
        setTimeout(resumeNavigation, 1200);
      }
    });
  };

  const validate = () => {
    const errors = [];
    showFieldError('name', '');
    showFieldError('phone', '');

    if (!state.vehicle) {
      setStep(1);
      return [{ field: null, message: 'Select a vehicle type.' }];
    }
    if (!state.service) {
      setStep(2);
      return [{ field: null, message: 'Select a package.' }];
    }
    if (!sanitize(state.name)) {
      showFieldError('name', 'Enter your name.');
      errors.push({ field: 'name', message: 'Enter your name.' });
    }
    const phoneDigits = getUsPhoneDigits(state.phone);
    if (phoneDigits.length !== 10) {
      showFieldError('phone', 'Enter a 10-digit US phone number.');
      errors.push({ field: 'phone', message: 'Enter a 10-digit US phone number.' });
    }
    return errors;
  };

  function showFieldError(fieldId, msg) {
    const field = document.getElementById(fieldId);
    const el = document.getElementById(`${fieldId}-error`);
    if (!field || !el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
      field.setAttribute('aria-invalid', 'true');
    } else {
      el.textContent = '';
      el.hidden = true;
      field.removeAttribute('aria-invalid');
    }
  }

  const submit = async (method = 'quiz') => {
    if (submitting || completed) return;
    const recovery = method === 'exit_intent';
    const errorEl = $(recovery ? '#exit-error' : '#submit-error');
    errorEl.hidden = true;
    if (recovery) {
      const digits = getUsPhoneDigits($('#exit-phone').value);
      if (digits.length !== 10) {
        errorEl.textContent = 'Enter a 10-digit US phone number.';
        errorEl.hidden = false;
        $('#exit-phone').setAttribute('aria-invalid', 'true');
        $('#exit-phone').focus();
        return;
      }
      if (!state.vehicle || !state.service) return;
    } else {
      const errs = validate();
      if (errs.length) {
        const field = errs.find(e => e.field)?.field;
        if (field) document.getElementById(field)?.focus();
        return;
      }
    }
    if (!updateToken) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      updateToken = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      try { sessionStorage.setItem('quotePendingToken', updateToken); } catch {}
    }
    const payload = {
      vehicle: state.vehicle, service: state.service, addons: [],
      name: sanitize(state.name), phone: recovery ? formatPhone($('#exit-phone').value) : state.phone,
      notes: sanitize(state.notes), utm: readUTMs(), referrer: document.referrer || null,
      honeypot: Boolean($('#company').value.trim()), capture_method: method,
      flow_version: '5', update_token: updateToken, session_id: funnel.sessionId, session_started_at: funnel.startedAt,
    };
    submitting = true;
    $('#submit').disabled = true;
    $('#submit').textContent = 'Sending…';
    $('#exit-submit').disabled = true;
    $('#exit-submit').textContent = 'Sending…';
    updateStickyAction();
    $('#quote-action-label').textContent = 'Sending…';
    try {
      const res = await fetch(buildApiUrl('/api/createLead'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.id || !data.update_token) throw new Error('Lead submission failed');
      completed = true;
      try { sessionStorage.removeItem('quotePendingToken'); } catch {}
      try { sessionStorage.setItem('quoteLeadReceipt', JSON.stringify({ id: data.id, token: data.update_token })); } catch {}
      clearStoredPii();
      if (!payload.honeypot) {
        trackLeadSubmitted(method);
        window.gtag?.('event', 'lead_submit', { method, value: state.quote || 0, service: state.service, vehicle: state.vehicle });
      }
      let navigating = false;
      const navigate = () => {
        if (navigating) return;
        navigating = true;
        location.assign(`/thank-you#id=${encodeURIComponent(data.id)}&token=${encodeURIComponent(data.update_token)}`);
      };
      if (!payload.honeypot) fireAdsConversion(state.quote || 1, 'USD', { params: { transaction_id: data.id }, eventCallback: navigate });
      setTimeout(navigate, 800);
    } catch (err) {
      errorEl.textContent = 'That didn’t go through. Please try again, or text (828) 273-3894.';
      errorEl.hidden = false;
      errorEl.scrollIntoView({ block: 'center', behavior: 'instant' });
      submitting = false;
      $('#submit').disabled = false;
      $('#exit-submit').disabled = false;
      $('#exit-submit').textContent = 'Text my quote';
      recalculate();
    }
  };

  const wireExitIntent = () => {
    const sheet = $('#exit-sheet');
    const storage = getSessionStorage();
    let shown = false;
    try { shown = storage?.getItem('quoteExitShown') === '1'; } catch {}
    let lastActivity = Date.now();
    let scrollAnchor = { y: window.scrollY, time: performance.now() };
    let lastScroll = window.scrollY;
    let ignoreScrollUntil = 0;
    const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    const show = trigger => {
      if (shown || submitting || completed || document.hidden || typing() || !state.vehicle || !state.service || !matchMedia('(max-width: 767px)').matches) return;
      shown = true;
      try { storage?.setItem('quoteExitShown', '1'); } catch {}
      $('#exit-phone').value = state.phone || '';
      sheet.showModal();
      // Focus the close control so opening the prompt doesn't summon the keyboard.
      $('#exit-close').focus({ preventScroll: true });
      window.gtag?.('event', 'quote_exit_prompt', { trigger, step: state.step });
    };
    ['pointerdown', 'keydown', 'input'].forEach(type => document.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true }));
    document.addEventListener('focusin', () => { ignoreScrollUntil = Date.now() + 1200; });
    document.addEventListener('visibilitychange', () => { lastActivity = Date.now(); });
    window.addEventListener('scroll', () => {
      lastActivity = Date.now();
      const y = Math.max(0, window.scrollY), now = performance.now();
      if (y >= lastScroll || now - scrollAnchor.time > 600) scrollAnchor = { y, time: now };
      if (Date.now() > ignoreScrollUntil && scrollAnchor.y - y > 180 && now - scrollAnchor.time < 600) show('rapid_scroll_up');
      lastScroll = y;
    }, { passive: true });
    setInterval(() => { if (Date.now() - lastActivity >= 30000) show('idle'); }, 1000);
    $('#exit-close').addEventListener('click', () => sheet.close());
    $('#exit-phone').addEventListener('input', e => {
      e.target.value = formatPhone(e.target.value);
      e.target.removeAttribute('aria-invalid');
      $('#exit-error').hidden = true;
    });
    $('#exit-form').addEventListener('submit', e => { e.preventDefault(); submit('exit_intent'); });
  };

  // Boot
  captureUTMs();
  hydrateSelections();
  wire();
  wireCallFab();
  wireExitIntent();
  setStep(state.vehicle ? (state.service ? 3 : 2) : 1);
  recalculate();
})();

// Before/After slider wiring (square frame, no visible range)
(function () {
  const frame = document.querySelector('.ba-frame');
  if (!frame) return;
  const after = frame.querySelector('.ba-after');
  const bar = frame.querySelector('.ba-bar');
  const grip = frame.querySelector('.ba-grip');
  const range = document.getElementById('ba-range');

  if (!after || !bar || !grip) return;

  function setSplit(pct) {
    pct = Math.max(0, Math.min(100, pct));
    const right = 100 - pct;
    after.style.clipPath = `inset(0 ${right}% 0 0)`;
    bar.style.left = pct + '%';
    grip.style.left = `calc(${pct}% - 18px)`;
    if (range) {
      range.value = String(pct);
      range.setAttribute('aria-valuenow', String(Math.round(pct)));
    }
  }

  // init at 50%
  setSplit(50);

  // Keyboard accessibility via hidden range (optional but supported)
  if (range) {
    range.addEventListener('input', e => setSplit(parseFloat(e.target.value) || 50));
  }

  // Pointer/touch drag directly on the image area
  let dragging = false;
  function pctFromEvent(ev) {
    const rect = frame.getBoundingClientRect();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const x = clientX - rect.left;
    return (x / rect.width) * 100;
  }
  frame.addEventListener('pointerdown', e => { dragging = true; setSplit(pctFromEvent(e)); });
  window.addEventListener('pointermove', e => { if (dragging) setSplit(pctFromEvent(e)); });
  window.addEventListener('pointerup', () => { dragging = false; });

  frame.addEventListener('touchstart', e => { setSplit(pctFromEvent(e)); }, { passive: true });
  frame.addEventListener('touchmove', e => { setSplit(pctFromEvent(e)); }, { passive: true });
})();
