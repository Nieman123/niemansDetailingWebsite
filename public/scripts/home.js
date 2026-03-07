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

// GA4 event helper
function trackEvent(category, action, label) {
  const clean = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);

  const eventName = [clean(category), clean(action)].filter(Boolean).join('_') || 'site_event';
  const params = {};
  if (category) params.event_category = category;
  if (action) params.event_action = action;
  if (label) params.event_label = label;

  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
    return;
  }

  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.push({
      event: eventName,
      ...params
    });
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
const CENSUS_ZCTA_QUERY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';
const panelHydrationCache = new Map();
const preconnectedOrigins = new Set();
const SERVICE_ZIP_COORDS = {
  '28801': { lat: 35.5951, lng: -82.5515 }, // Asheville (Downtown)
  '28803': { lat: 35.5402, lng: -82.5190 }, // South Asheville
  '28804': { lat: 35.6510, lng: -82.5666 }, // North Asheville
  '28805': { lat: 35.6008, lng: -82.4766 }, // East Asheville
  '28806': { lat: 35.5798, lng: -82.6189 }, // West Asheville
  '28787': { lat: 35.6971, lng: -82.5607 }, // Weaverville
  '28711': { lat: 35.6179, lng: -82.3212 }, // Black Mountain
  '28732': { lat: 35.4308, lng: -82.5012 }, // Fletcher
  '28704': { lat: 35.4701, lng: -82.5190 }, // Arden
  '28715': { lat: 35.5357, lng: -82.6804 }, // Candler
  '28701': { lat: 35.7185, lng: -82.6371 }, // Alexander
  '28748': { lat: 35.6509, lng: -82.7009 }, // Leicester
  '28753': { lat: 35.7973, lng: -82.6846 }, // Marshall
  '28754': { lat: 35.8273, lng: -82.5482 }, // Mars Hill
  '28759': { lat: 35.9139, lng: -82.1948 }, // Micaville
  '28716': { lat: 35.5326, lng: -82.8374 }, // Canton
  '28730': { lat: 35.5223, lng: -82.4020 }, // Fairview
  '28778': { lat: 35.5976, lng: -82.3990 }  // Swannanoa
};

// Initialize slideshow after DOM is ready but defer to idle
document.addEventListener('DOMContentLoaded', function () {
  // Lazy import minimal slider after idle; zero JS on first paint
  onIdle(() => {
    if (window.sliderHydrated) return;
    import('/scripts/home-slider.js').then(m => {
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
  initDesktopHeaderCollapse();
  initMobileMenu();
  initOverviewActionReveal();
  initDelayedCallFab();
});

function ensurePreconnect(url) {
  const origin = new URL(url, window.location.origin).origin;
  if (preconnectedOrigins.has(origin)) return;

  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  if (origin !== window.location.origin) {
    link.crossOrigin = '';
  }

  document.head.appendChild(link);
  preconnectedOrigins.add(origin);
}

// Google Maps callback
function initMap() {
  if (!(window.google && google.maps)) return;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  mapEl.replaceChildren();
  const zipCodes = (mapEl.dataset.zipCodes || '')
    .split(',')
    .map((zip) => zip.trim())
    .filter(Boolean);

  const map = new google.maps.Map(mapEl, {
    center: { lat: 35.6, lng: -82.55 },
    zoom: 10
  });
  highlightServiceAreaByZip(map, zipCodes);
}

// Highlight service area ZIP codes directly on the map
function highlightServiceAreaByZip(map, zipCodes) {
  if (!zipCodes.length) return;
  const validZips = zipCodes.filter((zip) => /^\d{5}$/.test(zip));
  if (!validZips.length) return;

  loadZipBoundaryGeoJson(validZips)
    .then((geojson) => {
      if (!geojson || !Array.isArray(geojson.features) || geojson.features.length === 0) {
        throw new Error('No ZIP boundary features returned');
      }
      drawZipBoundaryGeoJson(map, geojson);
    })
    .catch((error) => {
      console.warn('ZIP boundary fetch failed, using fallback ZIP circles.', error);
      drawZipCenterFallback(map, validZips);
    });
}

function loadZipBoundaryGeoJson(zipCodes) {
  const where = `ZCTA5 IN ('${zipCodes.join("','")}')`;
  const params = new URLSearchParams({
    where,
    outFields: 'ZCTA5,NAME,BASENAME',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson'
  });
  const url = `${CENSUS_ZCTA_QUERY_URL}?${params.toString()}`;

  return fetch(url)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Boundary request failed with status ${response.status}`);
      }
      return response.json();
    });
}

function drawZipBoundaryGeoJson(map, geojson) {
  const existingFeatures = [];
  map.data.forEach((feature) => existingFeatures.push(feature));
  existingFeatures.forEach((feature) => map.data.remove(feature));
  map.data.addGeoJson(geojson);

  map.data.setStyle({
    fillColor: '#7c5ce4',
    fillOpacity: 0.18,
    strokeColor: '#c7b9ff',
    strokeOpacity: 0.95,
    strokeWeight: 2
  });

  if (!map.__zipInfoWindow) {
    map.__zipInfoWindow = new google.maps.InfoWindow();
  }
  if (!map.__zipClickBound) {
    map.__zipClickBound = true;
    map.data.addListener('click', (event) => {
      const zip = event.feature.getProperty('ZCTA5') || event.feature.getProperty('NAME');
      map.__zipInfoWindow.setPosition(event.latLng);
      map.__zipInfoWindow.setContent(`Service ZIP: <strong>${zip || 'Area'}</strong>`);
      map.__zipInfoWindow.open({ map });
    });
  }

  const bounds = new google.maps.LatLngBounds();
  map.data.forEach((feature) => {
    extendBoundsByGeometry(bounds, feature.getGeometry());
  });
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds);
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > 10) map.setZoom(10);
    });
  }
}

function extendBoundsByGeometry(bounds, geometry) {
  if (!geometry) return;

  if (typeof geometry.lat === 'function' && typeof geometry.lng === 'function') {
    bounds.extend(geometry);
    return;
  }

  if (typeof geometry.get === 'function') {
    const point = geometry.get();
    if (point && typeof point.lat === 'function' && typeof point.lng === 'function') {
      bounds.extend(point);
      return;
    }
  }

  if (typeof geometry.getArray === 'function') {
    geometry.getArray().forEach((part) => extendBoundsByGeometry(bounds, part));
  }
}

function drawZipCenterFallback(map, zipCodes) {
  const infoWindow = new google.maps.InfoWindow();
  const bounds = new google.maps.LatLngBounds();
  let successCount = 0;

  zipCodes.forEach((zip) => {
    const location = SERVICE_ZIP_COORDS[zip];
    if (!location) return;
    successCount += 1;
    bounds.extend(location);

    const marker = new google.maps.Marker({
      map,
      position: location,
      title: `ZIP ${zip}`,
      label: {
        text: zip,
        color: '#1f1744',
        fontSize: '10px',
        fontWeight: '700'
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 18,
        fillColor: '#e9defc',
        fillOpacity: 0.95,
        strokeColor: '#673AB7',
        strokeWeight: 2
      }
    });

    new google.maps.Circle({
      map,
      center: location,
      radius: 5500,
      strokeColor: '#673AB7',
      strokeOpacity: 0.45,
      strokeWeight: 1.5,
      fillColor: '#673AB7',
      fillOpacity: 0.1
    });

    marker.addListener('click', () => {
      infoWindow.setContent(`Service ZIP: <strong>${zip}</strong>`);
      infoWindow.open({ anchor: marker, map });
    });
  });

  if (successCount > 0) {
    map.fitBounds(bounds);
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if (map.getZoom() > 10) map.setZoom(10);
    });
  }
}

// Lazy-load Instagram and Pixlee widgets
function loadInstagram() {
  if (window.instagramLoaded) return;
  window.instagramLoaded = true;
  ensurePreconnect('https://instafeed.assets.pixlee.com');
  ensurePreconnect('https://www.instagram.com');

  window.PixleeAsyncInit = function() {
    if (window.Pixlee) {
      const container = document.getElementById('pixlee_container');
      if (container) {
        container.innerHTML = '';
      }
      Pixlee.init({apiKey:'gJFLksbWhYk1jWdGalcu'});
      Pixlee.addSimpleWidget({widgetId:'14925'});
    }
  };

  const pixlee = document.createElement('script');
  pixlee.src = 'https://instafeed.assets.pixlee.com/assets/pixlee_widget_1_0_0.js';
  pixlee.defer = true;
  document.body.appendChild(pixlee);

  const ig = document.createElement('script');
  ig.src = 'https://www.instagram.com/embed.js';
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
  ensurePreconnect('https://maps.googleapis.com');
  ensurePreconnect('https://maps.gstatic.com');
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
      void activateTabFromHash(hash);
    });
  });

  requestAnimationFrame(function () {
    if (TAB_HASHES.has(window.location.hash)) {
      void activateTabFromHash(window.location.hash);
      return;
    }
    void activateTabFromHash('#overview');
  });

  const sync = () => { void activateTabFromHash(window.location.hash); };
  window.addEventListener('hashchange', sync);
}

function hydrateTabPanel(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return Promise.resolve(null);

  const fragmentUrl = panel.dataset.fragment;
  if (!fragmentUrl || panel.dataset.hydrated === 'true') {
    return Promise.resolve(panel);
  }

  if (panelHydrationCache.has(panelId)) {
    return panelHydrationCache.get(panelId);
  }

  panel.dataset.hydrated = 'loading';

  const request = fetch(fragmentUrl, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Panel request failed with status ${response.status}`);
      }
      return response.text();
    })
    .then((html) => {
      panel.innerHTML = html;
      panel.dataset.hydrated = 'true';
      return panel;
    })
    .catch((error) => {
      console.error(`Failed to hydrate ${panelId} panel`, error);
      panel.dataset.hydrated = 'error';
      panel.innerHTML = `
        <section class="section--center">
          <div class="panel-shell">
            <p>That section failed to load.</p>
            <button class="mdl-button service-more-btn panel-shell__retry" type="button" onclick="retryLazyPanel('${panelId}')">Try Again</button>
          </div>
        </section>
      `;
      return panel;
    });

  panelHydrationCache.set(panelId, request);
  return request;
}

function retryLazyPanel(panelId) {
  panelHydrationCache.delete(panelId);
  const panel = document.getElementById(panelId);
  if (panel) {
    delete panel.dataset.hydrated;
  }
  return hydrateTabPanel(panelId).then(() => activateTabFromHash(`#${panelId}`));
}

window.retryLazyPanel = retryLazyPanel;

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

  return hydrateTabPanel(normalized.slice(1));
}

function initMobileMenu() {
  const toggle = document.querySelector('.mobile-nav-toggle');
  const panel = document.getElementById('mobileNav');
  const backdrop = document.querySelector('.mobile-nav-backdrop');
  if (!toggle || !panel || !backdrop) return;

  const closeMenu = () => {
    document.body.classList.remove('mobile-menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  const openMenu = () => {
    document.body.classList.add('mobile-menu-open');
    toggle.setAttribute('aria-expanded', 'true');
  };

  toggle.addEventListener('click', function () {
    if (document.body.classList.contains('mobile-menu-open')) {
      closeMenu();
      return;
    }
    openMenu();
  });

  backdrop.addEventListener('click', closeMenu);
  panel.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeMenu);
  });

  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 768) closeMenu();
  });
}

function initDesktopHeaderCollapse() {
  const brandRow = document.querySelector('.desktop-header-brand-row');
  const stackedLogo = document.querySelector('.desktop-header-logo-stack');
  const horizontalLogo = document.querySelector('.desktop-header-logo-horizontal');
  if (!brandRow || !window.matchMedia) return;

  const desktopQuery = window.matchMedia('(min-width: 769px)');
  let ticking = false;

  const getThreshold = () => Math.max(24, Math.round((brandRow.offsetHeight || 0) * 0.35));

  const syncLogoVisibility = (shouldCompact) => {
    if (!stackedLogo || !horizontalLogo) return;
    stackedLogo.hidden = shouldCompact;
    horizontalLogo.hidden = !shouldCompact;
  };

  const syncState = () => {
    ticking = false;
    const shouldCompact = desktopQuery.matches && window.scrollY > getThreshold();
    document.body.classList.toggle('desktop-header-compact', shouldCompact);
    syncLogoVisibility(shouldCompact);
  };

  const requestSync = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(syncState);
  };

  syncState();
  window.addEventListener('scroll', requestSync, { passive: true });
  window.addEventListener('resize', requestSync);
  window.addEventListener('load', requestSync, { once: true });

  if (typeof desktopQuery.addEventListener === 'function') {
    desktopQuery.addEventListener('change', syncState);
  } else if (typeof desktopQuery.addListener === 'function') {
    desktopQuery.addListener(syncState);
  }
}

function initOverviewActionReveal() {
  const actionRows = Array.from(document.querySelectorAll('#overview .overview-service-actions'));
  if (!actionRows.length) return;

  actionRows.forEach((row) => {
    row.classList.add('overview-reveal');
  });

  if (!('IntersectionObserver' in window)) {
    actionRows.forEach((row) => row.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      obs.unobserve(entry.target);
    });
  }, {
    threshold: 0.2,
    rootMargin: '0px 0px -10% 0px'
  });

  actionRows.forEach((row) => observer.observe(row));
}

function initDelayedCallFab() {
  const callFab = document.querySelector('.mdl-chip-float-contact');
  if (!callFab) return;
  if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return;

  const SHOW_DELAY_MS = 7000;
  const BLURB_DURATION_MS = 4000;

  window.setTimeout(() => {
    callFab.classList.add('is-visible', 'show-blurb');
    window.setTimeout(() => {
      callFab.classList.remove('show-blurb');
    }, BLURB_DURATION_MS);
  }, SHOW_DELAY_MS);
}

// Programmatically open Services tab and jump to a specific service block.
function navigateToService(serviceId) {
  const targetId = (serviceId || '').trim();
  if (!targetId) return false;

  if (window.location.hash !== '#services') {
    history.pushState(null, '', '#services');
  }
  void activateTabFromHash('#services').then(() => {
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  return false;
}
