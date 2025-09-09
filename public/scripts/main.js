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

// Initialize slideshow after DOM is ready but defer to idle
document.addEventListener('DOMContentLoaded', function () {
  onIdle(() => {
    if (window.makeBSS && !window.bssInitialized) {
      window.bssInitialized = true;
      // small timeout to yield to main thread
      setTimeout(() => { window.makeBSS('.bss-slides', { auto: false, swipe: true }); }, 0);
    }
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
