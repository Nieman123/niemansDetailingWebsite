(() => {
  const $ = selector => document.querySelector(selector);
  let receipt;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('id') && hash.has('token')) {
    receipt = { id: hash.get('id'), token: hash.get('token') };
    try {
      sessionStorage.setItem('quoteLeadReceipt', JSON.stringify(receipt));
      history.replaceState(null, '', location.pathname);
    } catch {} // Preserve the fragment for reload when storage is unavailable.
  } else {
    try { receipt = JSON.parse(sessionStorage.getItem('quoteLeadReceipt') || 'null'); } catch {}
  }
  let lead;
  let selected = [];
  let saved = [];
  let saving = false;
  const labels = { quick: 'Quick Once Over', full: 'Full Detail', interior_only: 'Interior Only', other: 'Custom detail' };
  const money = value => `$${value}`;
  const same = () => [...selected].sort().join() === [...saved].sort().join();
  const api = async (action, addons) => {
    const response = await fetch('/api/leadOptions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...receipt, action, addons }), signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(response.status === 403 ? 'expired' : 'unavailable');
    return data;
  };
  const render = () => {
    const base = lead.quoted_total === null ? null : lead.quoted_total - saved.reduce((sum, key) => sum + (lead.addon_prices[key] || 0), 0);
    const total = base === null ? null : base + selected.reduce((sum, key) => sum + lead.addon_prices[key], 0);
    $('#saved-quote').textContent = total === null ? 'Custom detail: pricing confirmed by text' : `${labels[lead.service]} estimate: ${money(total)}${same() ? '' : ' (unsaved)'}`;
    document.querySelectorAll('[data-addon]').forEach(button => {
      const key = button.dataset.addon;
      button.hidden = !(key in lead.addon_prices);
      button.disabled = saving;
      button.setAttribute('aria-pressed', String(selected.includes(key)));
      button.querySelector('.delta').textContent = `+ ${money(lead.addon_prices[key])}`;
    });
    $('#save-addons').disabled = saving || same();
    $('#save-addons').textContent = saving ? 'Saving…' : 'Save my add-ons';
  };
  document.querySelectorAll('[data-addon]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.addon;
    selected = selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key];
    $('#addon-status').textContent = same() ? 'Your saved request is up to date.' : 'Changes are not saved yet. Tap “Save my add-ons” below.';
    render();
  }));
  $('#save-addons').addEventListener('click', async () => {
    if (saving || same()) return;
    saving = true;
    render();
    try {
      lead = await api('save', selected);
      saved = [...lead.addons];
      selected = [...saved];
      $('#addon-status').textContent = 'Saved to your quote request. I’ll confirm everything by text.';
    } catch (error) {
      $('#addon-status').textContent = error.message === 'expired'
        ? 'This edit link has expired. Your original request is saved. Text Nieman to add extras.'
        : 'Your extras didn’t save. Please try again. Your original quote request is still saved.';
    } finally { saving = false; render(); }
  });
  window.addEventListener('beforeunload', event => {
    if (lead && !same()) { event.preventDefault(); event.returnValue = ''; }
  });
  (async () => {
    if (!receipt) {
      $('#thanks-message').textContent = 'To request a quote, choose your vehicle and package first.';
      $('#receipt-error').hidden = false;
      $('#receipt-error').innerHTML = '<a href="/quote">Get a quick quote →</a>';
      return;
    }
    try {
      lead = await api('read');
      saved = [...lead.addons];
      selected = [...saved];
      $('#thanks-kicker').textContent = 'Request received ✓';
      $('#thanks-title').textContent = 'You’re all set.';
      $('#thanks-message').textContent = 'I’ll personally text you to confirm pricing and find a time that works. Nieman';
      $('#addon-section').hidden = false;
      render();
    } catch {
      $('#thanks-title').textContent = 'Need to update your quote?';
      $('#thanks-message').textContent = 'This edit link is unavailable or has expired. If you already submitted, your request is still saved. Text me to confirm or add extras.';
    }
  })();
})();
