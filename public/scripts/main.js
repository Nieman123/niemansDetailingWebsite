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

// Initialize slideshow after DOM is ready
document.addEventListener('DOMContentLoaded', function () {
  if (window.makeBSS && !window.bssInitialized) {
    window.bssInitialized = true;
    makeBSS('.bss-slides');
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

