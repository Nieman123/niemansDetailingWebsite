(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Local dev helper: prefer emulator when on Hosting emulator (port 5000)
  const HOSTING_ORIGIN = 'https://niemansdetailing.com';
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const isHostingEmulator = isLocalHost && (location.port === '5000' || location.port === '5010');
  const shouldTrackFunnelSteps = !isLocalHost;
  // If using Hosting emulator, keep relative path so rewrites hit local function.
  // If using generic file server (e.g., 5500), post to production.
  const API_BASE = isHostingEmulator ? '' : (isLocalHost ? HOSTING_ORIGIN : '');
  const buildApiUrl = (path) => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (!API_BASE) return normalizedPath;
    const base = API_BASE.replace(/\/+$/, '');
    // Avoid "/api/api/*" when the base already includes the function name.
    if (base.endsWith('/api') && normalizedPath.startsWith('/api/')) {
      return `${base}${normalizedPath.slice(4)}`;
    }
    return `${base}${normalizedPath}`;
  };

  // Canonical keys
  const VEHICLES = { sedan: 'Sedan/Coupe', suv: 'SUV/Crossover', truck: 'Truck/Van' };
  const SERVICES = { quick: 'Quick Once Over', full: 'Full Detail', interior: 'Interior Refresh', other: 'Other' };
  const HERO_SERVICE_LABELS = { quick: 'Quick Detail', full: 'Full Detail', interior: 'Interior Refresh' };
  const ADDON_LABELS = { wax: 'Wax/Sealant', pethair: 'Pet Hair', soiled: 'Heavily Soiled', headlights: 'Headlight Restoration' };

  // Pricing model
  const PRICES = {
    base: {
      sedan: { quick: 200, full: 300, interior: 150 },
      suv: { quick: 250, full: 350, interior: 200 },
      truck: { quick: 300, full: 500, interior: 250 }
    },
    addons: {
      wax: { sedan: 25, suv: 30, truck: 35 },
      pethair: { sedan: 30, suv: 40, truck: 50 },
      soiled: { sedan: 40, suv: 60, truck: 80 },
      headlights: { sedan: 75, suv: 85, truck: 95 }
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
    try { return { ...initial, ...(JSON.parse(localStorage.getItem('quoteState') || '{}')) }; }
    catch { return { ...initial }; }
  };
  const saveState = (s) => localStorage.setItem('quoteState', JSON.stringify(s));

  let state = loadState();

  const FUNNEL_SESSION_KEY = 'quoteFunnelSessionId';
  const FUNNEL_TRACKED_STEPS_KEY = 'quoteFunnelTrackedSteps';
  const FUNNEL_SUBMITTED_KEY = 'quoteFunnelSubmitted';
  const FUNNEL_STARTED_AT_KEY = 'quoteFunnelStartedAt';
  const FUNNEL_LAST_EVENT_AT_KEY = 'quoteFunnelLastEventAt';
  const FUNNEL_STATE_VERSION_KEY = 'quoteFunnelStateVersion';
  const FUNNEL_STATE_VERSION = '3';
  const FUNNEL_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

  const getSessionStorage = () => {
    try { return window.sessionStorage; }
    catch { return null; }
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

  const priceDelta = (addon, vehicle) => (vehicle ? (PRICES.addons[addon]?.[vehicle] || 0) : 0);

  const computeQuote = (s) => {
    if (!s.vehicle || !s.service) return { total: null, consult: false };
    if (CONSULT_SERVICES.has(s.service)) return { total: null, consult: true };
    const base = PRICES.base[s.vehicle]?.[s.service];
    if (typeof base !== 'number') return { total: null, consult: false };
    let total = base;
    for (const a of s.addons) total += priceDelta(a, s.vehicle);
    return { total, consult: false };
  };

  const formatUSD = (n) => `$${n.toFixed(0)}`;
  const reduceMotion = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  })();
  let hasRenderedStep = false;

  const placeQuotePeek = (n) => {
    const peek = $('#quote-peek');
    if (!peek) return;
    if (n === 2 || n === 3) {
      const parent = $(`#step-${n}`);
      const h2 = parent?.querySelector('h2');
      if (parent && h2) {
        // Ensure it sits right after the h2
        if (h2.nextElementSibling !== peek) h2.insertAdjacentElement('afterend', peek);
        peek.hidden = false;
      }
    } else {
      peek.hidden = true;
    }
  };

  const setStep = (n) => {
    const prevStep = state.step;
    state.step = n;
    trackStepView(n);
    const nextScreen = $(`#step-${n}`);
    $$('.screen').forEach(sec => {
      sec.hidden = true;
      sec.classList.remove('step-enter');
    });
    nextScreen?.removeAttribute('hidden');
    if (nextScreen && hasRenderedStep && n !== prevStep && !reduceMotion) {
      nextScreen.classList.add('step-enter');
      nextScreen.addEventListener('animationend', () => {
        nextScreen.classList.remove('step-enter');
      }, { once: true });
    }
    hasRenderedStep = true;
    const pct = ((n - 1) / 3) * 100;
    const bar = $('#progress'); if (bar) bar.style.width = pct + '%';
    const stepCount = $('#step-count'); if (stepCount) stepCount.textContent = `Step ${n} of 4`;
    placeQuotePeek(n);
    if (n >= 3) updateAddonDeltas();
    recalculate();
    // Move focus to step heading for accessibility
    const heading = $(`#step-${n} h2`);
    if (heading) requestAnimationFrame(() => heading.focus());
  };

  const toggleAddon = (key, el) => {
    const idx = state.addons.indexOf(key);
    if (idx >= 0) state.addons.splice(idx, 1); else state.addons.push(key);
    el.setAttribute('aria-pressed', String(idx < 0));
    saveState(state);
    recalculate();
  };

  function updateAddonDeltas() {
    const v = state.vehicle;
    const map = {
      wax: PRICES.addons.wax[v],
      pethair: PRICES.addons.pethair[v],
      soiled: PRICES.addons.soiled[v],
      headlights: PRICES.addons.headlights[v]
    };
    for (const [k, val] of Object.entries(map)) {
      const el = document.querySelector(`.delta[data-delta="${k}"]`);
      if (el) el.textContent = v ? `+ $${val}` : '+ $25–95';
    }
  }

  const recalculate = () => {
    state.consult = (state.service === 'other' || state.service === 'paint');
    const { total, consult } = computeQuote(state);
    state.quote = total;

    // Update teaser on steps 2/3
    const peek = $('#quote-peek');
    if (peek) {
      if (consult) {
        peek.textContent = 'I’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        peek.textContent = `Your quote: ${formatUSD(total)}`;
      } else {
        peek.textContent = 'Select options to see your quote.';
      }
    }

    // Update main quote line on step 4
    const line = $('#quote-line');
    if (line) {
      if (consult) {
        line.textContent = 'I’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        line.textContent = `Your quote: ${formatUSD(total)}`;
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
        heroPeek.textContent = 'Quick Detail from $150 (select options to see your quote)';
      }
    }

    // CTA swap
    const submitBtn = $('#submit');
    if (submitBtn) {
      if (state.consult) {
        submitBtn.textContent = 'Request consult';
        submitBtn.dataset.mode = 'consult';
      } else {
        submitBtn.textContent = 'Text me my quote';
        submitBtn.dataset.mode = 'quote';
      }
    }
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

  const trackLeadSubmitted = () => {
    if (!shouldTrackFunnelSteps) return;
    if (funnel.submitted || pendingLeadSubmissionEvent) return;
    pendingLeadSubmissionEvent = true;
    trackFunnelEvent('lead_submitted', { step: 4 }).then((ok) => {
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
    $$('#step-3 .toggle').forEach(btn => {
      const k = btn.getAttribute('data-addon');
      const on = state.addons.includes(k);
      btn.setAttribute('aria-pressed', String(on));
    });
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
        updateAddonDeltas();
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

    // Step 3 toggles
    $$('#step-3 .toggle').forEach(btn => {
      btn.addEventListener('click', () => toggleAddon(btn.getAttribute('data-addon'), btn));
    });

    // Nav buttons
    $$('#step-3 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(2)));
    $$('#step-3 .nav .primary').forEach(b => b.addEventListener('click', () => goNext(4)));
    $$('#step-2 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(1)));
    $$('#step-4 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(3)));

    // Inputs
    $('#notes').addEventListener('input', (e) => { state.notes = e.target.value.slice(0, 1000); saveState(state); });
    $('#name').addEventListener('input', (e) => { state.name = e.target.value.slice(0, 120); saveState(state); });
    $('#phone').addEventListener('input', (e) => {
      const formatted = formatPhone(e.target.value);
      e.target.value = formatted;
      state.phone = formatted; saveState(state);
      showPhoneError('');
    });

    // Submit
    $('#submit').addEventListener('click', submit);
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
    if (!state.vehicle) errors.push('Select a vehicle type');
    if (!state.service) errors.push('Select a service');
    if (!sanitize(state.name)) errors.push('Enter your name');
    const phoneDigits = getUsPhoneDigits(state.phone);
    if (phoneDigits.length !== 10) {
      showPhoneError('Enter a valid US phone');
      errors.push('Enter a valid US phone');
    }
    return errors;
  };

  function showPhoneError(msg) {
    const el = document.getElementById('phone-error');
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  const submit = async () => {
    const errs = validate();
    if (errs.length) {
      // Only inline error for phone; others may alert for now
      if (errs.length === 1 && errs[0] === 'Enter a valid US phone') return;
      alert(errs[0]);
      return;
    }

    // Honeypot: silently succeed if filled
    const hp = (document.getElementById('company') || {}).value || '';
    if (hp.trim()) {
      const fake = { id: 'ok' };
      const { total, consult } = computeQuote(state);
      const payload = {
        vehicle: state.vehicle,
        service: state.service,
        addons: state.addons,
        zip: state.zip || null,
        notes: sanitize(state.notes),
        name: sanitize(state.name),
        phone: state.phone,
        quote: consult ? null : total,
        consult: !!consult,
        quoted_total: consult ? null : total,
        utm: readUTMs(),
        ts: new Date().toISOString(),
        status: 'spam',
        referrer: document.referrer || null,
        user_agent: navigator.userAgent,
        honeypot: true,
      };
      // Try to record spam server-side without triggering Telegram
      try {
        const res = await fetch(buildApiUrl('/api/createLead'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.ok && data.id) {
            showConfirm(payload, data.id);
            clearStoredPii();
            return;
          }
        }
      } catch { }
      showConfirm(payload, fake.id);
      return;
    }

    const { total, consult } = computeQuote(state);
    const payload = {
      vehicle: state.vehicle,
      service: state.service,
      addons: state.addons,
      zip: state.zip || null,
      notes: sanitize(state.notes),
      name: sanitize(state.name),
      phone: state.phone,
      quote: consult ? null : total,
      consult: !!consult,
      quoted_total: consult ? null : total,
      utm: readUTMs(),
      ts: new Date().toISOString(),
      status: 'new',
      referrer: document.referrer || null,
      user_agent: navigator.userAgent,
      honeypot: false,
    };

    const submitBtn = $('#submit');
    const prevText = submitBtn ? submitBtn.textContent : null;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Confirming…'; }
    try {
      const res = await fetch(buildApiUrl('/api/createLead'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`);
      }
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        const txt = await res.text();
        throw new Error(`Non-JSON response (${ct}): ${txt.slice(0, 200)}`);
      }
      if (!data.ok) throw new Error(data.error || 'Failed to submit');
      showConfirm(payload, data.id);
      trackLeadSubmitted();
      clearStoredPii();
      if (window.gtag) {
        gtag('event', 'lead_submit', {
          method: 'quick_quote',
          value: state.quote || 0,
          service: state.service,
          vehicle: state.vehicle
        });
      }
      const conversionValue = typeof state.quote === 'number' ? state.quote : 1.0;
      const conversionCurrency = 'USD';
      fireAdsConversion(conversionValue, conversionCurrency);
    } catch (err) {
      console.error(err);
      alert('Submission failed. If testing locally, use Firebase emulators or set API_BASE to your domain.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevText || 'Text me my quote'; }
    }
  };

  const showConfirm = (payload, id) => {
    $$('.screen').forEach(s => s.hidden = true);
    const recap = $('#recap');
    const { total, consult } = computeQuote(state);
    const priceText = consult ? 'Consult' : `$${total}`;
    recap.innerHTML = `
      <div class="pill">${VEHICLES[payload.vehicle] || payload.vehicle}</div>
      <div class="pill">${SERVICES[payload.service] || payload.service}</div>
      <div class="pill">Add-ons: ${(payload.addons || []).map(a => ADDON_LABELS[a] || a).join(', ') || 'None'}</div>
      <div class="pill">Price: ${priceText}</div>
      <div class="pill">Ref: ${id}</div>
    `;
    $('#confirm').hidden = false;
  };

  // Boot
  captureUTMs();
  hydrateSelections();
  wire();
  wireCallFab();
  setStep(state.vehicle ? (state.service ? (state.zip || state.notes || state.name || state.phone ? 4 : 3) : 2) : 1);
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
