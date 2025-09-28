(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Local dev helper: prefer emulator when on Hosting emulator (port 5000)
  const HOSTING_ORIGIN = 'https://niemansdetailing.com';
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const isHostingEmulator = isLocalHost && (location.port === '5000' || location.port === '5010');
  // If using Hosting emulator, keep relative path so rewrites hit local function.
  // If using generic file server (e.g., 5500), post to production.
  const API_BASE = isHostingEmulator ? '' : (isLocalHost ? HOSTING_ORIGIN : '');

  // Canonical keys
  const VEHICLES = { sedan: 'Sedan/Coupe', suv: 'SUV/Crossover', truck: 'Truck/Van' };
  const SERVICES = { quick: 'Quick Once Over', full: 'Full Detail', interior: 'Interior Refresh', other: 'Other' };
  const ADDON_LABELS = { wax: 'Wax/Sealant', pethair: 'Pet Hair', soiled: 'Heavily Soiled', headlights: 'Headlight Restoration' };

  // Pricing model
  const PRICES = {
    base: {
      sedan: { quick: 150, full: 300, interior: 99 },
      suv:   { quick: 170, full: 350, interior: 99 },
      truck: { quick: 180, full: 380, interior: 99 }
    },
    addons: {
      wax:        { sedan: 25, suv: 30, truck: 35 },
      pethair:    { sedan: 30, suv: 40, truck: 50 },
      soiled:     { sedan: 40, suv: 60, truck: 80 },
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

  const fireAdsConversion = (value, currency = 'USD') => {
    const amount = typeof value === 'number' && isFinite(value) ? value : 1.0;
    const payload = {
      send_to: 'AW-17602789326/DjI6CICLnaIbEM7_1MlB',
      value: amount,
      currency,
    };
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', payload);
    } else {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'conversion', ...payload });
    }
    if (typeof window.console !== 'undefined' && typeof window.console.log === 'function') {
      window.console.log('[Ads] conversion fired', payload);
    }
    window.__lastQuoteConversion = payload;
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
    state.step = n;
    $$('.screen').forEach(sec => { sec.hidden = true; });
    $(`#step-${n}`)?.removeAttribute('hidden');
    const pct = ((n - 1) / 4) * 100;
    const bar = $('#progress'); if (bar) bar.style.width = pct + '%';
    const stepCount = $('#step-count'); if (stepCount) stepCount.textContent = `Step ${n} of 5`;
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
        peek.textContent = 'We’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        peek.textContent = `Your quote: ${formatUSD(total)}`;
      } else {
        peek.textContent = 'Select options to see your quote.';
      }
    }

    // Update main quote line on step 5
    const line = $('#quote-line');
    if (line) {
      if (consult) {
        line.textContent = 'We’ll confirm pricing by text.';
      } else if (typeof total === 'number') {
        line.textContent = `Your quote: ${formatUSD(total)}`;
      } else {
        line.textContent = 'Select options to see your quote.';
      }
    }

    // CTA swap
    const submitBtn = $('#submit');
    if (submitBtn) {
      if (state.consult) {
        submitBtn.textContent = 'Request consult';
        submitBtn.dataset.mode = 'consult';
      } else {
        submitBtn.textContent = 'Confirm my quote';
        submitBtn.dataset.mode = 'quote';
      }
    }
  };

  const sanitize = (s) => (s || '').replace(/<[^>]*>/g, '').trim();

  const formatPhone = (value) => {
    const digits = (value || '').replace(/\D/g, '').slice(0, 10);
    const p1 = digits.slice(0,3), p2 = digits.slice(3,6), p3 = digits.slice(6,10);
    if (digits.length > 6) return `(${p1}) ${p2}-${p3}`;
    if (digits.length > 3) return `(${p1}) ${p2}`;
    if (digits.length > 0) return `(${p1}`;
    return '';
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
    set('utm-source',   qp.get('utm_source'));
    set('utm-medium',   qp.get('utm_medium'));
    set('utm-campaign', qp.get('utm_campaign'));
    set('utm-content',  qp.get('utm_content'));
    set('utm-term',     qp.get('utm_term'));
  };

  const readUTMs = () => ({
    utm_source:   (document.getElementById('utm-source')||{}).value || '',
    utm_medium:   (document.getElementById('utm-medium')||{}).value || '',
    utm_campaign: (document.getElementById('utm-campaign')||{}).value || '',
    utm_content:  (document.getElementById('utm-content')||{}).value || '',
    utm_term:     (document.getElementById('utm-term')||{}).value || '',
  });

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
    $('#zip').value = state.zip || '';
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
    $$('#step-4 .nav .primary').forEach(b => b.addEventListener('click', () => goNext(5)));
    $$('#step-5 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(4)));

    // Inputs
    $('#zip').addEventListener('input', (e) => {
      const v = e.target.value.replace(/\D/g, '').slice(0,5);
      e.target.value = v;
      state.zip = v; saveState(state); recalculate();
    });
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

  const validate = () => {
    const errors = [];
    if (!state.vehicle) errors.push('Select a vehicle type');
    if (!state.service) errors.push('Select a service');
    if (!sanitize(state.name)) errors.push('Enter your name');
    const phoneDigits = (state.phone || '').replace(/\D/g, '');
    if (phoneDigits.length !== 10) {
      showPhoneError('Enter a valid US phone');
      errors.push('Enter a valid US phone');
    }
    if (state.zip && !/^\d{5}$/.test(state.zip)) errors.push('ZIP must be 5 digits');
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
        const res = await fetch(`${API_BASE}/api/createLead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.ok && data.id) {
            showConfirm(payload, data.id);
            return;
          }
        }
      } catch {}
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
      const res = await fetch(`${API_BASE}/api/createLead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt.slice(0,200)}`);
      }
      const ct = res.headers.get('content-type') || '';
      let data;
      if (ct.includes('application/json')) {
        data = await res.json();
      } else {
        const txt = await res.text();
        throw new Error(`Non-JSON response (${ct}): ${txt.slice(0,200)}`);
      }
      if (!data.ok) throw new Error(data.error || 'Failed to submit');
      showConfirm(payload, data.id);
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
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = prevText || 'Confirm my quote'; }
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
      <div class="pill">Add-ons: ${(payload.addons||[]).map(a => ADDON_LABELS[a]||a).join(', ') || 'None'}</div>
      <div class="pill">ZIP: ${payload.zip || '—'}</div>
      <div class="pill">Price: ${priceText}</div>
      <div class="pill">Ref: ${id}</div>
    `;
    $('#confirm').hidden = false;
  };

  // Boot
  captureUTMs();
  hydrateSelections();
  wire();
  setStep(state.vehicle ? (state.service ? (state.zip || state.name || state.phone ? 5 : 3) : 2) : 1);
  recalculate();
})();
