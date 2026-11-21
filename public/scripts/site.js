// Shared behavior for public pages: analytics helper, mobile menu, footer year.
(function () {
  'use strict';

  // JavaScript errors on public pages show up on the admin Health page.
  if (!window.__ndErrorReport) {
    var errorReport = document.createElement('script');
    errorReport.src = '/scripts/error-report.js';
    errorReport.defer = true;
    document.head.appendChild(errorReport);
  }

  if (typeof window.trackEvent !== 'function') {
    window.trackEvent = function (category, action, label) {
      var clean = function (value) {
        return String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 32);
      };
      var eventName = [clean(category), clean(action)].filter(Boolean).join('_') || 'site_event';
      var params = {};
      if (category) params.event_category = category;
      if (action) params.event_action = action;
      if (label) params.event_label = label;
      if (typeof window.gtag === 'function') {
        window.gtag('event', eventName, params);
      } else if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push(Object.assign({ event: eventName }, params));
      }
    };
  }

  // Phone links count as Google Ads phone conversions.
  window.trackPhoneConversion = function () {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', { send_to: 'AW-17602789326/QubCCJ7smf0bEM7_1MlB' });
    }
  };

  function initMenu() {
    var toggle = document.querySelector('.nav-toggle');
    var menu = document.getElementById('mobile-menu');
    if (!toggle || !menu) return;

    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      menu.hidden = !open;
      document.body.classList.toggle('menu-open', open);
    };

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    menu.addEventListener('click', function (event) {
      if (event.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
    window.matchMedia('(min-width: 961px)').addEventListener('change', function (query) {
      if (query.matches) setOpen(false);
    });
  }

  function initTracking() {
    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (href.indexOf('tel:') === 0) {
        window.trackEvent('Contact', 'click', link.dataset.track || 'Phone');
        window.trackPhoneConversion();
      } else if (href.indexOf('sms:') === 0) {
        window.trackEvent('Contact', 'click', link.dataset.track || 'Text');
      } else if (link.dataset.track) {
        window.trackEvent('CTA', 'click', link.dataset.track);
      }
    });
  }

  function initYear() {
    document.querySelectorAll('[data-year]').forEach(function (node) {
      node.textContent = String(new Date().getFullYear());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initMenu(); initTracking(); initYear(); });
  } else {
    initMenu(); initTracking(); initYear();
  }
})();
