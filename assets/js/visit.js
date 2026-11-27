/* Visit notifications.
 *
 * Sends two kinds of ping to the visit-notify Cloudflare Worker, which turns each into a
 * push notification and saves the visit:
 *   "arrive"  once at the start of a visit;
 *   "update"  when the visitor leaves or switches away, listing what they did.
 * A visit ends after 30 minutes without activity. Nothing here identifies the visitor.
 *
 * Your own browsers: open https://minjookim-finance.github.io/?track=off once to stop counting them,
 * and ?track=on to count them again.
 */
(function () {
  'use strict';

  // The public site and its Cloudflare Worker.
  var RELAY = 'https://website-visit-relay.minjoo-kim-06b.workers.dev/';
  var SITE_HOSTS = ['minjookim-finance.github.io'];   // e.g. ['jdoe.github.io'] or ['www.janedoe.com', 'janedoe.com']
  var EMAIL_PATTERN = null;         // e.g. /jdoe@/i to report "Copied email address"
  // --------------------

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function forget(key) { try { localStorage.removeItem(key); } catch (e) {} }

  var choice = null;
  try { choice = new URLSearchParams(location.search).get('track'); } catch (e) {}
  if (choice === 'off') write('visit-optout', '1');
  if (choice === 'on') forget('visit-optout');
  if (choice === 'off' || read('visit-optout') === '1' || window.top !== window) return;
  if (SITE_HOSTS.indexOf(location.hostname) < 0) return;
  // A preloaded background tab should only register when first viewed.

  function startTracking() {
    var VISIT_GAP_MS = 30 * 60 * 1000;
    var KEY = 'visit-session';
    var MAX_ACTIONS = 25;

    function clean(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }
    function shorten(text, max) {
      text = clean(text);
      return text.length > max ? text.slice(0, max - 3) + '...' : text;
    }
    function randomId() {
      return Array.from(crypto.getRandomValues(new Uint8Array(12)), function (n) {
        return n.toString(16).padStart(2, '0');
      }).join('');
    }

    // ---- Visit state, kept in localStorage so a reload or a second page continues the visit ----

    function referringSite() {
      if (!document.referrer) return '';
      try { return new URL(document.referrer).origin; } catch (e) { return ''; }
    }

    var now = Date.now();
    var visit = null;
    try { visit = JSON.parse(read(KEY)); } catch (e) {}
    var seenBefore = !!visit;
    var isNewVisit = !visit || !visit.id || !(now - visit.last < VISIT_GAP_MS);
    if (isNewVisit) {
      visit = {
        id: randomId(), start: now, last: now, seconds: 0, scroll: -1, reached: '',
        actions: [], reported: false, returning: seenBefore,
        path: location.pathname, referrer: referringSite()
      };
    }
    if (!Array.isArray(visit.actions)) visit.actions = [];
    var dirty = false;

    function persist() { write(KEY, JSON.stringify(visit)); }

    // ---- Time the page was actually in the foreground ----

    var visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
    function settleTime() {
      if (!visibleSince) return;
      visit.seconds += (Date.now() - visibleSince) / 1000;
      visibleSince = Date.now();
    }

    // ---- Sending ----

    function send(kind) {
      settleTime();
      visit.last = Date.now();
      persist();
      var body = JSON.stringify({
        kind: kind, id: visit.id, path: visit.path, referrer: visit.referrer, returning: visit.returning,
        start: visit.start, seconds: Math.round(visit.seconds), scroll: visit.scroll,
        reached: visit.reached, actions: visit.actions
      });
      // The original Worker accepts arrivals at /visit. It ignores the new summary route until upgraded.
      var endpoint = kind === 'arrive' ? RELAY + 'visit' : RELAY;
      try {
        if (typeof fetch === 'function') {
          fetch(endpoint, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, body: body }).catch(function () {});
        } else if (navigator.sendBeacon) {
          navigator.sendBeacon(endpoint, body);
        }
      } catch (e) {}
    }

    // Send a summary when the visitor leaves or switches away: always once per visit, and
    // again later only if they did something new or spent at least another minute on the site.
    function onLeave() {
      settleTime();
      visibleSince = 0;
      noteScroll();
      var readMore = visit.seconds - (visit.reportedSeconds || 0) >= 60;
      if (visit.reported && !dirty && !readMore) { persist(); return; }
      dirty = false;
      visit.reported = true;
      visit.reportedSeconds = visit.seconds;
      send('update');
    }

    // ---- Recording actions ----

    function record(label) {
      label = clean(label).slice(0, 100);
      if (!label) return;
      for (var i = 0; i < visit.actions.length; i++) {
        if (visit.actions[i].t === label) {
          visit.actions[i].n = Math.min(99, (visit.actions[i].n || 1) + 1);
          dirty = true;
          persist();
          return;
        }
      }
      if (visit.actions.length >= MAX_ACTIONS) return;
      visit.actions.push({ t: label, n: 1 });
      dirty = true;
      persist();
    }

    function describeLink(link) {
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) === '#') return '';
      if (/^mailto:/i.test(href)) return 'Clicked email link';
      var url;
      try { url = new URL(link.href); } catch (e) { return ''; }
      var text = clean(link.textContent) || clean(link.getAttribute('aria-label'));
      var host = url.hostname.replace(/^www\./, '');
      if (/\.pdf$/i.test(url.pathname)) {
        return 'Opened PDF: ' + shorten(decodeURIComponent(url.pathname.split('/').pop()), 60);
      }
      if (url.hostname !== location.hostname) {
        return 'Opened link: ' + (text ? shorten(text, 50) + ' (' + host + ')' : host);
      }
      return ''; // pages on your own site are recorded as "Viewed <page>" when they load
    }

    function onClick(event) {
      if (event.type === 'auxclick' && event.button !== 1) return; // only middle-click opens a link
      var target = event.target;
      if (!target || !target.closest) return;
      var link = target.closest('a[href]');
      if (link) record(describeLink(link));
    }

    // Capture phase: the site's own handlers cannot swallow the event first.
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);

    if (EMAIL_PATTERN) {
      document.addEventListener('copy', function () {
        var selected = '';
        try { selected = String(window.getSelection()); } catch (e) {}
        if (EMAIL_PATTERN.test(selected)) record('Copied email address');
      });
    }

    // ---- How far down the page the visitor got ----

    function noteScroll() {
      var span = document.documentElement.scrollHeight - window.innerHeight;
      if (span < 50) return; // the page does not scroll
      var percent = Math.max(0, Math.min(100, Math.round(100 * window.scrollY / span)));
      if (percent > visit.scroll) visit.scroll = percent;
    }
    noteScroll();
    window.addEventListener('scroll', noteScroll, { passive: true });

    // The furthest section heading (h2) that crossed the middle of the screen.
    var headings = Array.prototype.slice.call(document.querySelectorAll('h2'));
    var furthest = -1;
    if (headings.length && 'IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var index = headings.indexOf(entry.target);
          if (index <= furthest) return;
          furthest = index;
          visit.reached = '"' + shorten(entry.target.textContent, 48) + '"';
        });
      }, { rootMargin: '-45% 0px -45% 0px' });
      headings.forEach(function (h) { observer.observe(h); });
    }

    // ---- Lifecycle ----

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') onLeave();
      else visibleSince = Date.now();
    });
    window.addEventListener('pagehide', onLeave);

    if (isNewVisit) {
      send('arrive');
    } else {
      if (location.pathname !== visit.path) record('Viewed ' + location.pathname);
      persist();
    }
  }

  function onFirstVisible() {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onFirstVisible);
    if (navigator.locks) {
      // Read and create the shared session once when tabs open concurrently.
      navigator.locks.request('visit-session-init', startTracking).catch(function () {});
    } else {
      startTracking();
    }
  }
  document.addEventListener('visibilitychange', onFirstVisible);
  onFirstVisible();
})();
