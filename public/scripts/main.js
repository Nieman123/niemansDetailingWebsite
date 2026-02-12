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
const CENSUS_ZCTA_QUERY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';
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
  initMobileMenu();
});

// Google Maps callback
function initMap() {
  if (!(window.google && google.maps)) return;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
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
