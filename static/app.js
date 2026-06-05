(() => {
  const auraA = document.getElementById("auraA");
  const auraB = document.getElementById("auraB");
  const imgA = document.getElementById("imgA");
  const imgB = document.getElementById("imgB");
  const hud = document.getElementById("hud");
  const statusEl = document.getElementById("status");

  // Query params (client-side only):
  //  - seconds=10
  //  - shuffle=1
  //  - fit=contain|cover
  //  - hud=1
  //  - order=mtime_desc|mtime_asc|name_asc|name_desc
  //  - refresh=60 (seconds to re-fetch list)
  //  - awake=1 (request Screen Wake Lock; default on)
  //  - transition=fade|none|slide (default: fade)
  const params = new URLSearchParams(location.search);

  const seconds = clampInt(params.get("seconds"), 10, 1, 3600);
  const shuffle = truthy(params.get("shuffle"), true);
  const fit = (params.get("fit") || "contain").toLowerCase();
  const showHud = truthy(params.get("hud"), false);
  const order = (params.get("order") || "mtime_desc");
  const refreshSeconds = clampInt(params.get("refresh"), 60, 5, 3600);
  const keepAwake = truthy(params.get("awake"), true);
  const transition = validTransition(params.get("transition"));

  imgA.style.objectFit = (fit === "cover") ? "cover" : "contain";
  imgB.style.objectFit = (fit === "cover") ? "cover" : "contain";

  const stage = document.getElementById("stage");
  stage.classList.add("trans-" + transition);

  if (!showHud) hud.classList.add("hidden");
  else hud.classList.remove("hidden");

  let photos = [];
  let idx = 0;
  let paused = false;
  let active = "A";
  let timer = null;
  let lastListHash = "";

  function logDebug() {
    if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug.apply(console, arguments);
    }
  }

  function logWarn() {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn.apply(console, arguments);
    }
  }

  // ---- Wake Lock (best-effort; OS/browser may still dim/sleep) ----
  let wakeLock = null;

  async function requestWakeLock() {
    if (!keepAwake) return;
    if (!("wakeLock" in navigator)) {
      logDebug("Wake Lock API not supported");
      return;
    }

    // If we already have one, don't spam requests
    if (wakeLock) return;

    try {
      wakeLock = await navigator.wakeLock.request("screen");
      logDebug("Wake lock acquired");

      wakeLock.addEventListener("release", () => {
        logDebug("Wake lock released");
        wakeLock = null;
      });
    } catch (err) {
      logWarn("Wake lock request failed:", err);
      wakeLock = null;
    }
  }

  // Browsers commonly release wake locks when the tab loses visibility.
  document.addEventListener("visibilitychange", () => {
    if (!keepAwake) return;

    if (document.visibilityState === "visible") {
      requestWakeLock();
    } else {
      // We don't need to do anything here; release events will fire if it releases.
      // But we clear our reference to avoid thinking it's still held.
      wakeLock = null;
    }
  });
  // ---------------------------------------------------------------

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function clampInt(v, def, min, max) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function truthy(v, def) {
    if (v === null || v === undefined) return def;
    const s = String(v).toLowerCase().trim();
    return (s === "1" || s === "true" || s === "yes" || s === "on");
  }

  function validTransition(v) {
    const allowed = ["fade", "none", "slide"];
    const s = (v || "").toLowerCase().trim();
    return allowed.includes(s) ? s : "fade";
  }

  function pickStartIndex() {
    if (!photos.length) return 0;
    return shuffle ? Math.floor(Math.random() * photos.length) : 0;
  }

  function nextIndex() {
    if (!photos.length) return 0;
    if (shuffle) return Math.floor(Math.random() * photos.length);
    return (idx + 1) % photos.length;
  }

  function prevIndex() {
    if (!photos.length) return 0;
    if (shuffle) return Math.floor(Math.random() * photos.length);
    return (idx - 1 + photos.length) % photos.length;
  }

  function currentImg() {
    return active === "A" ? imgA : imgB;
  }
  function nextImg() {
    return active === "A" ? imgB : imgA;
  }
  function currentAura() {
    return active === "A" ? auraA : auraB;
  }
  function nextAura() {
    return active === "A" ? auraB : auraA;
  }

  function isFullscreenActive() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement
    );
  }

  function requestAnyFullscreen(el) {
    const fn =
      el.requestFullscreen ||
      el.webkitRequestFullscreen ||
      el.mozRequestFullScreen ||
      el.msRequestFullscreen;
    if (fn) fn.call(el);
  }

  function exitAnyFullscreen() {
    const fn =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen;
    if (fn) fn.call(document);
  }

  function swapLayers() {
    const cur = currentImg();
    const nxt = nextImg();
    const curAura = currentAura();
    const nxtAura = nextAura();

    curAura.classList.remove("visible");
    nxtAura.classList.add("visible");

    if (transition === "slide") {
      cur.classList.add("exiting");
      cur.classList.remove("visible");
      nxt.classList.add("visible");
      // Remove exiting class after the CSS transition finishes
      setTimeout(() => cur.classList.remove("exiting"), 950);
    } else {
      cur.classList.remove("visible");
      nxt.classList.add("visible");
    }
    active = (active === "A") ? "B" : "A";
  }

  function preload(url) {
    return new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(true);
      i.onerror = () => resolve(false);
      i.src = url;
    });
  }

  function getKey(e) {
    if (typeof e.key === "string" && e.key.length > 0) {
      // Legacy Safari may report Spacebar instead of a single space.
      return e.key === "Spacebar" ? " " : e.key;
    }

    const code = e.which || e.keyCode;
    switch (code) {
      case 32: return " ";
      case 37: return "ArrowLeft";
      case 39: return "ArrowRight";
      case 70: return "f";
      case 72: return "h";
      default: return "";
    }
  }

  async function showAt(i, immediate = false) {
    if (!photos.length) return;

    idx = i;
    const url = photos[idx].url || photos[idx];

    setStatus(`${idx + 1}/${photos.length} • ${paused ? "paused" : seconds + "s"} • ${shuffle ? "shuffle" : "ordered"} • fit=${fit}`);

    const nxt = nextImg();
    // preload first to minimize blank flashes
    await preload(url);

    nxt.src = url;
    const nxtAura = nextAura();
    nxtAura.src = url;

    if (immediate) {
      auraA.classList.remove("visible");
      auraB.classList.remove("visible");
      nxtAura.classList.add("visible");

      // Make next visible instantly without animation
      imgA.classList.remove("visible");
      imgB.classList.remove("visible");
      nxt.classList.add("visible");
      active = (nxt === imgA) ? "A" : "B";
      return;
    }

    // Crossfade
    requestAnimationFrame(() => {
      swapLayers();
    });
  }

  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (paused) return;
      showAt(nextIndex());
    }, seconds * 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function fetchPhotos() {
    const url = new URL("/api/photos", location.origin);
    url.searchParams.set("order", order);

    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) throw new Error(`api returned ${res.status}`);
    const data = await res.json();
    const list = data.photos || [];

    // Create a simple hash signature to detect changes
    const signature = JSON.stringify(list.map(p => [p.name, p.mtime]));

    photos = list;
    lastListHash = signature;
  }

  async function refreshListPeriodically() {
    setInterval(async () => {
      try {
        const url = new URL("/api/photos", location.origin);
        url.searchParams.set("order", order);
        const res = await fetch(url.toString(), { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const list = data.photos || [];
        const signature = JSON.stringify(list.map(p => [p.name, p.mtime]));

        if (signature !== lastListHash) {
          photos = list;
          lastListHash = signature;

          // If current index is out of range after deletions, clamp.
          if (idx >= photos.length) idx = 0;
          // Continue slideshow seamlessly; show current immediately.
          await showAt(idx, true);
        }
      } catch (err) {
        // ignore
      }
    }, refreshSeconds * 1000);
  }

  function bindKeys() {
    window.addEventListener("keydown", async (e) => {
      const key = getKey(e);
      const lowerKey = key.toLowerCase ? key.toLowerCase() : "";

      if (key === " " || key === "Space") {
        e.preventDefault();
        paused = !paused;
        setStatus(`${idx + 1}/${photos.length} • ${paused ? "paused" : seconds + "s"} • ${shuffle ? "shuffle" : "ordered"} • fit=${fit}`);
        return;
      }
      if (key === "ArrowRight") {
        e.preventDefault();
        await showAt(nextIndex());
        return;
      }
      if (key === "ArrowLeft") {
        e.preventDefault();
        await showAt(prevIndex());
        return;
      }
      if (lowerKey === "f") {
        e.preventDefault();
        if (!isFullscreenActive()) {
          requestAnyFullscreen(document.documentElement);
        } else {
          exitAnyFullscreen();
        }
        return;
      }
      if (lowerKey === "h") {
        e.preventDefault();
        hud.classList.toggle("hidden");
        return;
      }
    });
  }

  async function boot() {
    bindKeys();

    // Best-effort attempt to keep screen awake while visible.
    // Note: Some platforms require user interaction or may ignore due to power settings.
    requestWakeLock();

    try {
      setStatus("Loading photos…");
      await fetchPhotos();

      if (!photos.length) {
        setStatus("No photos found in /photos (mount your directory).");
        // Keep HUD visible so user sees message
        hud.classList.remove("hidden");
        return;
      }

      idx = pickStartIndex();
      await showAt(idx, true);

      startTimer();
      refreshListPeriodically();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      hud.classList.remove("hidden");
    }
  }

  boot();
})();
