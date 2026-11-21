// Sends JavaScript errors from the site's own pages to the admin Health page.
// Anonymous: only the message, the script and line, and the page path (no query string, no #token).
(function () {
  'use strict';
  if (window.__ndErrorReport) return;
  window.__ndErrorReport = true;
  var sent = 0;
  var seen = {};

  function ours(source) {
    if (!source) return true;
    try { return new URL(source, location.href).origin === location.origin; } catch (e) { return false; }
  }

  function report(message, source, line) {
    message = String(message || '').slice(0, 300);
    // "Script error." is a cross-origin error with no details, and extensions inject their own noise.
    if (!message || message === 'Script error.' || /extension:\/\//.test(source || '') || !ours(source)) return;
    if (sent >= 3 || seen[message]) return;
    seen[message] = true;
    sent += 1;
    var body = JSON.stringify({
      message: message,
      source: source ? String(source).replace(location.origin, '').split(/[?#]/)[0].slice(0, 160) : '',
      line: typeof line === 'number' ? line : undefined,
      page: location.pathname.slice(0, 120),
    });
    try {
      fetch('/api/clientError', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  window.addEventListener('error', function (event) {
    if (!event || !event.message) return; // Failed image or stylesheet loads carry no message.
    report(event.message, event.filename, event.lineno);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    var message = reason && reason.message ? reason.message : String(reason || '');
    // Network hiccups on a visitor's phone are not site bugs.
    if (/failed to fetch|load failed|networkerror|aborted/i.test(message)) return;
    report('Unhandled promise rejection: ' + message, reason && reason.stack ? (String(reason.stack).match(/https?:\/\/[^\s)]+/) || [''])[0].replace(/:\d+:\d+$/, '') : '', undefined);
  });
})();
