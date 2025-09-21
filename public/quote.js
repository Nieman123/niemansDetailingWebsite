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
  const ADDON_LABELS = { wax: 'Wax/Sealant', pethair: 'Pet Hair', odor: 'Odor/Ozone', engine: 'Engine Bay', soiled: 'Heavily Soiled', ceramic: 'Ceramic Consult' };

  // Pricing tables
  const BASE = {
    sedan: { quick: 150, full: 300, interior: 99 },
    suv: { quick: 170, full: 350, interior: 99 },
    truck: { quick: 180, full: 380, interior: 99 },
  };
  const ADDONS = {
    wax:   { sedan: 25, suv: 30, truck: 35 },
    pethair:{ sedan: 30, suv: 40, truck: 50 },
    odor:  { sedan: 35, suv: 45, truck: 55 },
    engine:{ sedan: 25, suv: 25, truck: 30 },
    soiled:{ sedan: 40, suv: 60, truck: 80 },
    ceramic:{ sedan: 0, suv: 0, truck: 0 },
  };

  const CONSULT_SERVICES = new Set(['other']);

  const initial = {
    vehicle: null,
    service: null,
    addons: [],
    zip: '',
    notes: '',
    name: '',
    phone: '',
  };

  const loadState = () => {
    try { return { ...initial, ...(JSON.parse(localStorage.getItem('quoteState') || '{}')) }; }
    catch { return { ...initial }; }
  };
  const saveState = (s) => localStorage.setItem('quoteState', JSON.stringify(s));

  let state = loadState();

  const priceDelta = (addon, vehicle) => (vehicle ? (ADDONS[addon]?.[vehicle] || 0) : 0);

  const computeQuote = (s) => {
    if (!s.vehicle || !s.service) return { total: null, consult: true };
    if (CONSULT_SERVICES.has(s.service)) return { total: null, consult: true };
    let total = BASE[s.vehicle]?.[s.service] || 0;
    for (const a of s.addons) total += priceDelta(a, s.vehicle);
    return { total, consult: false };
  };

  const formatUSD = (n) => `$${n.toFixed(0)}`;

  const setStep = (n) => {
    $$('.screen').forEach(sec => { sec.hidden = true; });
    $(`#step-${n}`)?.removeAttribute('hidden');
    // Delta labels depend on vehicle selection
    if (n >= 3) updateAddonDeltas();
    updateQuoteLine();
  };

  const toggleAddon = (key, el) => {
    const idx = state.addons.indexOf(key);
    if (idx >= 0) state.addons.splice(idx, 1); else state.addons.push(key);
    el.setAttribute('aria-pressed', String(idx < 0));
    saveState(state);
    updateQuoteLine();
  };

  const updateAddonDeltas = () => {
    $$('.delta').forEach(span => {
      const k = span.getAttribute('data-delta');
      span.textContent = `+ $${priceDelta(k, state.vehicle || 'sedan')}`;
    });
  };

  const updateQuoteLine = () => {
    const q = computeQuote(state);
    const line = $('#quote-line');
    const consult = CONSULT_SERVICES.has(state.service);
    if (!line) return;
    if (consult || q.total == null) {
      line.textContent = 'We’ll confirm pricing by text.';
    } else {
      line.textContent = `Instant quote: ${formatUSD(q.total)}`;
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
        $('#consult-note').hidden = !CONSULT_SERVICES.has(val);
        saveState(state);
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
    $$('#step-4 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(3)));
    $$('#step-4 .nav .primary').forEach(b => b.addEventListener('click', () => goNext(5)));
    $$('#step-5 .nav .secondary').forEach(b => b.addEventListener('click', () => goPrev(4)));

    // Inputs
    $('#zip').addEventListener('input', (e) => {
      const v = e.target.value.replace(/\D/g, '').slice(0,5);
      e.target.value = v;
      state.zip = v; saveState(state); updateQuoteLine();
    });
    $('#notes').addEventListener('input', (e) => { state.notes = e.target.value.slice(0, 1000); saveState(state); });
    $('#name').addEventListener('input', (e) => { state.name = e.target.value.slice(0, 120); saveState(state); });
    $('#phone').addEventListener('input', (e) => { e.target.value = formatPhone(e.target.value); state.phone = e.target.value; saveState(state); });

    // Submit
    $('#submit').addEventListener('click', submit);
  };

  const validate = () => {
    const errors = [];
    if (!state.vehicle) errors.push('Select a vehicle type');
    if (!state.service) errors.push('Select a service');
    if (!sanitize(state.name)) errors.push('Enter your name');
    const phoneDigits = (state.phone || '').replace(/\D/g, '');
    if (!(phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith('1')))) errors.push('Enter a valid US phone');
    if (state.zip && !/^\d{5}$/.test(state.zip)) errors.push('ZIP must be 5 digits');
    return errors;
  };

  const submit = async () => {
    const errs = validate();
    if (errs.length) { alert(errs[0]); return; }

    const { total, consult } = computeQuote(state);
    const payload = {
      vehicle: state.vehicle,
      service: state.service,
      addons: state.addons,
      zip: state.zip || null,
      notes: sanitize(state.notes),
      name: sanitize(state.name),
      phone: state.phone,
      quoted_total: consult ? null : total,
      utm: getQueryParams(),
      ts: new Date().toISOString(),
      status: 'new',
      referrer: document.referrer || null,
      user_agent: navigator.userAgent,
    };

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
    } catch (err) {
      console.error(err);
      alert('Submission failed. If testing locally, use Firebase emulators or set API_BASE to your domain.');
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
  hydrateSelections();
  wire();
  setStep(state.vehicle ? (state.service ? (state.zip || state.name || state.phone ? 5 : 3) : 2) : 1);
  updateQuoteLine();
})();
