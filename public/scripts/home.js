// Homepage behavior: retire the old service worker and lazy-load the service area map.
(function () {
  'use strict';
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || isLocalhost)) {
    navigator.serviceWorker.register('/service-worker.js').catch(function (e) {
      console.error('Error during service worker registration:', e);
    });
  }
})();

const CENSUS_ZCTA_QUERY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';
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

const DARK_MAP_STYLES = [
  { elementType: 'geometry', stylers: [{ color: '#14121f' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#a59fba' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0912' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#3a3456' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#262138' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3157' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#07060d' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#171427' }] }
];

document.addEventListener('DOMContentLoaded', function () {
  const serviceSection = document.getElementById('service-area');
  if (!serviceSection || !('IntersectionObserver' in window)) return;
  const mapObserver = new IntersectionObserver((entries, observer) => {
    if (entries.some(entry => entry.isIntersecting)) {
      loadMap();
      observer.disconnect();
    }
  }, { rootMargin: '300px 0px' });
  mapObserver.observe(serviceSection);
});

function ensurePreconnect(url) {
  const origin = new URL(url, window.location.origin).origin;
  if (preconnectedOrigins.has(origin)) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  if (origin !== window.location.origin) link.crossOrigin = '';
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
        color: '#17120a',
        fontSize: '10px',
        fontWeight: '700'
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 18,
        fillColor: '#e4bb5c',
        fillOpacity: 0.95,
        strokeColor: '#7b52e6',
        strokeWeight: 2
      }
    });

    new google.maps.Circle({
      map,
      center: location,
      radius: 5500,
      strokeColor: '#7b52e6',
      strokeOpacity: 0.45,
      strokeWeight: 1.5,
      fillColor: '#7b52e6',
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
      mapEl.querySelector('.area__map-fallback span').textContent = 'The map could not load. Call or text to confirm your address.';
    } catch (_) {}
  };
  document.head.appendChild(script);
}
