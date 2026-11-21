(() => {
  if (location.origin !== "https://minjookim-finance.github.io" || window.top !== window) return;

  const endpoint = "https://website-visit-relay.minjoo-kim-06b.workers.dev/visit";
  const storageKey = "website-visit-last-seen";
  const idleWindow = 30 * 60 * 1000;
  let lastSeenHere = 0;
  let pending = false;

  async function recordVisit() {
    const now = Date.now();
    let lastSeen = lastSeenHere;
    try {
      lastSeen = Math.max(lastSeen, Number(localStorage.getItem(storageKey)) || 0);
    } catch {
      // The in-memory timestamp still groups events when site storage is disabled.
    }

    const recent = lastSeen > 0 && now >= lastSeen && now - lastSeen < idleWindow;
    if (!recent) {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
      });
      if (!response.ok) return;
    }

    lastSeenHere = now;
    try {
      localStorage.setItem(storageKey, String(now));
    } catch {
      // Storage is optional.
    }
  }

  async function onVisible() {
    if (pending || document.visibilityState !== "visible") return;
    pending = true;
    try {
      if (navigator.locks) {
        await navigator.locks.request(storageKey, recordVisit);
      } else {
        await recordVisit();
      }
    } catch {
      // A failed notification can be retried on the next visit.
    } finally {
      pending = false;
    }
  }

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onVisible);
  onVisible();
})();
