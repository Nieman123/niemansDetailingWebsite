// Register service worker for offline support
(function () {
  'use strict';
  const isLocalhost = Boolean(
    window.location.hostname === 'localhost' ||
    window.location.hostname === '[::1]' ||
    window.location.hostname.match(/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/)
  );
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || isLocalhost)) {
    navigator.serviceWorker.register('service-worker.js').catch(function (e) {
      console.error('Error during service worker registration:', e);
    });
  }
})();

// Lightweight GA wrapper
function trackEvent(category, action, label) {
  if (window.ga) {
    ga('send', 'event', category, action, label);
  }
}

// Helper: run work during idle time to avoid blocking paint
function onIdle(cb) {
  if ('requestIdleCallback' in window) {
    return requestIdleCallback(cb, { timeout: 2000 });
  }
  return setTimeout(cb, 0);
}

const TAB_HASHES = new Set(['#overview', '#services', '#about', '#contact']);

// Initialize slideshow after DOM is ready but defer to idle
document.addEventListener('DOMContentLoaded', function () {
  // Lazy import minimal slider after idle; zero JS on first paint
  onIdle(() => {
    if (window.sliderHydrated) return;
    import('/scripts/slider.js').then(m => {
      try { m.hydrateSlider && m.hydrateSlider('.slideshow'); window.sliderHydrated = true; } catch (_) {}
    }).catch(() => {});
  });

  const igSection = document.getElementById('instagram-section');
  if (igSection) {
    const igObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadInstagram();
          observer.disconnect();
        }
      });
    });
    igObserver.observe(igSection);
  }

  const serviceSection = document.getElementById('service-area');
  if (serviceSection) {
    const mapObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadMap();
          observer.disconnect();
        }
      });
    });
    mapObserver.observe(serviceSection);
  }

  initHashDrivenTabs();
});

// Google Maps callback
function initMap() {
  if (!(window.google && google.maps)) return;
  const map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 35.6, lng: -82.55 },
    zoom: 10
  });
  highlightServiceArea(map);
}

// Highlight service area polygon on the map
function highlightServiceArea(map) {
  const serviceCoords = [
    { lat: 35.79722, lng: -82.68167 }, // Marshall
    { lat: 35.82833, lng: -82.54861 }, // Mars Hill
    { lat: 35.61417, lng: -82.3275 },  // Black Mountain
    { lat: 35.43167, lng: -82.50389 }, // Fletcher
    { lat: 35.53639, lng: -82.83861 }  // Canton
  ];
  const serviceArea = new google.maps.Polygon({
    paths: serviceCoords,
    strokeColor: '#673AB7',
    strokeOpacity: 0.8,
    strokeWeight: 2,
    fillColor: '#673AB7',
    fillOpacity: 0.2
  });
  serviceArea.setMap(map);
}

// Lazy-load Instagram and Pixlee widgets
function loadInstagram() {
  if (window.instagramLoaded) return;
  window.instagramLoaded = true;

  window.PixleeAsyncInit = function() {
    if (window.Pixlee) {
      Pixlee.init({apiKey:'gJFLksbWhYk1jWdGalcu'});
      Pixlee.addSimpleWidget({widgetId:'14925'});
    }
  };

  const pixlee = document.createElement('script');
  pixlee.src = '//instafeed.assets.pixlee.com/assets/pixlee_widget_1_0_0.js';
  pixlee.defer = true;
  document.body.appendChild(pixlee);

  const ig = document.createElement('script');
  ig.src = '//www.instagram.com/embed.js';
  ig.async = true;
  document.body.appendChild(ig);
}

// Lazy-load Google Maps API
function loadMap() {
  if (window.mapLoaded) return;
  window.mapLoaded = true;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  const apiKey = mapEl.dataset.apiKey;
  if (!apiKey) return;
  const script = document.createElement('script');
  // Use Google’s recommended async loading param and weekly channel
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&loading=async&v=weekly`;
  script.async = true;
  script.defer = true;
  script.onerror = () => {
    console.error('Google Maps script failed to load');
    try {
      mapEl.textContent = 'Map failed to load.';
    } catch (_) {}
  };
  document.head.appendChild(script);
}

// Sync tabs with URL hash for deep linking
function initHashDrivenTabs() {
  const tabLinks = Array.from(document.querySelectorAll('.mdl-layout__tab[href^="#"]'))
    .map((tab) => ({ tab, hash: tab.getAttribute('href') }))
    .filter(({ hash }) => TAB_HASHES.has(hash));

  if (!tabLinks.length) return;

  tabLinks.forEach(({ tab, hash }) => {
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      if (window.location.hash !== hash) {
        history.pushState(null, '', hash);
      }
      activateTabFromHash(hash);
    });
  });

  requestAnimationFrame(function () {
    if (TAB_HASHES.has(window.location.hash)) {
      activateTabFromHash(window.location.hash);
      return;
    }
    activateTabFromHash('#overview');
  });

  const sync = () => activateTabFromHash(window.location.hash);
  window.addEventListener('hashchange', sync);
}

function activateTabFromHash(hash) {
  if (!hash) return;
  const normalized = hash.startsWith('#') ? hash : `#${hash}`;
  if (!TAB_HASHES.has(normalized)) return;

  document.querySelectorAll('.mdl-layout__tab[href^="#"]').forEach((tab) => {
    const isActive = tab.getAttribute('href') === normalized;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('.mdl-layout__tab-panel').forEach((panel) => {
    const isActive = `#${panel.id}` === normalized;
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  });
}

// Programmatically open Services tab and jump to a specific service block.
function navigateToService(serviceId) {
  const targetId = (serviceId || '').trim();
  if (!targetId) return false;

  if (window.location.hash !== '#services') {
    history.pushState(null, '', '#services');
  }
  activateTabFromHash('#services');

  requestAnimationFrame(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  return false;
}

// Scheduler auto-hydration without user interaction
(function(){
  var mounted = false;
  function mountScheduler(){
    if (mounted) return; // idempotent
    try {
      var host = document.getElementById('scheduler');
      if (!host) return;
      var src = host.getAttribute('data-src');
      if (!src) return;
      var mount = document.getElementById('scheduler-mount');
      if (!mount) return;
      var frame = document.createElement('iframe');
      frame.className = 'scheduler-frame';
      frame.src = src;
      frame.title = 'Appointment Scheduler';
      frame.loading = 'eager'; // injected after paint
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'clipboard-write; fullscreen';
      frame.setAttribute('aria-label', 'Appointment Scheduler');
      mount.appendChild(frame);
      var fb = document.getElementById('scheduler-fallback-link');
      if (fb) fb.href = src;
      // when the iframe loads, hide placeholder skeleton/text
      frame.addEventListener('load', function(){
        try { host.classList.add('ready'); } catch(_) {}
      });
      mounted = true;
    } catch (e) {
      // No-op: never block paint
    }
  }
  function scheduleMount() {
    // Try ASAP after first paint, but ensure it runs even if idle never fires
    onIdle(mountScheduler);
    setTimeout(mountScheduler, 1500);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scheduleMount();
  } else {
    window.addEventListener('DOMContentLoaded', scheduleMount, { once: true });
  }
  // Absolute fallback if DOMContentLoaded timing is quirky
  window.addEventListener('load', scheduleMount, { once: true });
})();
