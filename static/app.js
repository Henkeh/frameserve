(() => {
  const auraA = document.getElementById("auraA");
  const auraB = document.getElementById("auraB");
  const imgA = document.getElementById("imgA");
  const imgB = document.getElementById("imgB");
  const vidA = document.getElementById("vidA");
  const vidB = document.getElementById("vidB");
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
  //  - video=fit|seconds (default: fit)
  // Supported media types in /photos: images and videos
  const params = new URLSearchParams(location.search);

  const seconds = clampInt(params.get("seconds"), 10, 1, 3600);
  const shuffle = truthy(params.get("shuffle"), true);
  const fit = (params.get("fit") || "contain").toLowerCase();
  const showHud = truthy(params.get("hud"), false);
  const order = (params.get("order") || "mtime_desc");
  const refreshSeconds = clampInt(params.get("refresh"), 60, 5, 3600);
  const keepAwake = truthy(params.get("awake"), true);
  const transition = validTransition(params.get("transition"));
  const videoMode = validVideoMode(params.get("video"));

  imgA.style.objectFit = (fit === "cover") ? "cover" : "contain";
  imgB.style.objectFit = (fit === "cover") ? "cover" : "contain";
  vidA.style.objectFit = (fit === "cover") ? "cover" : "contain";
  vidB.style.objectFit = (fit === "cover") ? "cover" : "contain";

  const stage = document.getElementById("stage");
  stage.classList.add("trans-" + transition);

  if (!showHud) hud.classList.add("hidden");
  else hud.classList.remove("hidden");

  let photos = [];
  let idx = 0;
  let paused = false;
  let active = "A";
  let timer = null;
  let videoEndedHandler = null;
  let videoErrorHandler = null;
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

  function validVideoMode(v) {
    const allowed = ["fit", "seconds"];
    const s = (v || "").toLowerCase().trim();
    return allowed.includes(s) ? s : "fit";
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
  function currentVideo() {
    return active === "A" ? vidA : vidB;
  }
  function nextVideo() {
    return active === "A" ? vidB : vidA;
  }
  function currentAura() {
    return active === "A" ? auraA : auraB;
  }
  function nextAura() {
    return active === "A" ? auraB : auraA;
  }

  function mediaForSlot(slot) {
    const img = slot === "A" ? imgA : imgB;
    const vid = slot === "A" ? vidA : vidB;
    return vid.style.display !== "none" ? vid : img;
  }

  function currentMediaEl() {
    return mediaForSlot(active);
  }

  function extFromName(name) {
    const i = name.lastIndexOf(".");
    if (i < 0) return "";
    return name.slice(i).toLowerCase();
  }

  function mediaType(item) {
    const t = item && item.type ? String(item.type).toLowerCase() : "";
    if (t === "video" || t === "image") return t;

    const e = extFromName(item && item.name ? item.name : "");
    if (e === ".mp4" || e === ".webm" || e === ".ogg" || e === ".ogv" || e === ".mov" || e === ".m4v") return "video";
    return "image";
  }

  function hideMediaEl(el) {
    el.classList.remove("visible", "exiting");
    el.style.display = "none";
  }

  function showMediaEl(el) {
    el.style.display = "block";
    el.classList.add("visible");
  }

  function stopVideo(el) {
    if (!el) return;
    if (videoEndedHandler) el.removeEventListener("ended", videoEndedHandler);
    if (videoErrorHandler) el.removeEventListener("error", videoErrorHandler);
    videoEndedHandler = null;
    videoErrorHandler = null;
    try {
      el.pause();
      el.currentTime = 0;
    } catch (err) {
      // ignore
    }
  }

  function clearNonVisibleMedia() {
    const activeMedia = currentMediaEl();

    [imgA, imgB, vidA, vidB].forEach((el) => {
      if (el !== activeMedia) {
        if (el === vidA || el === vidB) {
          stopVideo(el);
        }
        hideMediaEl(el);
      }
    });
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

  function swapLayers(currentEl, nextEl, showAura) {
    const curAura = currentAura();
    const nxtAura = nextAura();

    if (showAura) {
      curAura.classList.remove("visible");
      nxtAura.classList.add("visible");
    } else {
      curAura.classList.remove("visible");
      nxtAura.classList.remove("visible");
    }

    if (transition === "slide") {
      currentEl.classList.add("exiting");
      currentEl.classList.remove("visible");
      nextEl.classList.add("visible");
      // Remove exiting class after the CSS transition finishes
      setTimeout(() => currentEl.classList.remove("exiting"), 950);
    } else {
      currentEl.classList.remove("visible");
      nextEl.classList.add("visible");
    }
    active = (active === "A") ? "B" : "A";

    setTimeout(() => {
      clearNonVisibleMedia();
    }, transition === "slide" ? 960 : 0);
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

  function updateStatus() {
    const item = photos[idx];
    const kind = mediaType(item);
    const cadence = paused
      ? "paused"
      : (kind === "video" ? (videoMode === "seconds" ? `video<=${seconds}s` : "video") : seconds + "s");
    setStatus(`${idx + 1}/${photos.length} • ${cadence} • ${shuffle ? "shuffle" : "ordered"} • fit=${fit}`);
  }

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleImageAdvance() {
    stopTimer();
    timer = setTimeout(() => {
      if (paused) return;
      showAt(nextIndex());
    }, seconds * 1000);
  }

  function bindVideoAdvance(videoEl) {
    if (!videoEl) return;

    videoEndedHandler = () => {
      if (paused) return;
      showAt(nextIndex());
    };
    videoErrorHandler = () => {
      if (paused) return;
      showAt(nextIndex());
    };

    videoEl.addEventListener("ended", videoEndedHandler, { once: true });
    videoEl.addEventListener("error", videoErrorHandler, { once: true });
  }

  async function startCurrentVideo() {
    const videoEl = currentVideo();
    if (!videoEl || videoEl.style.display === "none") return;

    bindVideoAdvance(videoEl);

    try {
      const p = videoEl.play();
      if (p && typeof p.then === "function") {
        await p;
      }
    } catch (err) {
      logWarn("Video autoplay failed:", err);
      scheduleImageAdvance();
    }
  }

  async function scheduleAdvanceForCurrent() {
    stopTimer();
    const item = photos[idx];
    if (!item || paused) return;

    if (mediaType(item) === "video") {
      await startCurrentVideo();
      if (videoMode === "seconds") {
        scheduleImageAdvance();
      }
      return;
    }

    scheduleImageAdvance();
  }

  async function showAt(i, immediate = false) {
    if (!photos.length) return;

    stopTimer();
    stopVideo(currentVideo());
    stopVideo(nextVideo());

    idx = i;
    const item = photos[idx] || {};
    const url = item.url || item;
    const kind = mediaType(item);

    updateStatus();

    const nxtAura = nextAura();
    const curImg = currentImg();
    const curVid = currentVideo();
    const currentEl = currentMediaEl();

    let nextEl;

    if (kind === "video") {
      const nxtVid = nextVideo();
      hideMediaEl(nextImg());
      nxtVid.classList.remove("exiting");
      nxtVid.style.display = "block";
      nxtVid.src = url;
      nxtVid.load();
      nextEl = nxtVid;

      nxtAura.removeAttribute("src");
      nxtAura.style.opacity = "0";
    } else {
      const nxtImg = nextImg();
      hideMediaEl(nextVideo());
      // preload first to minimize blank flashes
      await preload(url);
      nxtImg.src = url;
      nxtImg.classList.remove("exiting");
      nxtImg.style.display = "block";
      nextEl = nxtImg;

      nxtAura.src = url;
      nxtAura.style.opacity = "";
    }

    if (immediate) {
      stopVideo(curVid);
      hideMediaEl(curImg);
      hideMediaEl(curVid);

      auraA.classList.remove("visible");
      auraB.classList.remove("visible");
      if (kind === "video") {
        nxtAura.classList.remove("visible");
      } else {
        nxtAura.classList.add("visible");
      }

      // Make next visible instantly without animation
      showMediaEl(nextEl);
      active = (active === "A") ? "B" : "A";

      clearNonVisibleMedia();
      if (!paused) await scheduleAdvanceForCurrent();
      return;
    }

    // Crossfade
    requestAnimationFrame(async () => {
      swapLayers(currentEl, nextEl, kind !== "video");
      if (!paused) {
        await scheduleAdvanceForCurrent();
      }
    });
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
        if (photos.length) {
          if (paused) {
            if (mediaType(photos[idx]) === "video") {
              currentVideo().pause();
            }
            stopTimer();
          } else {
            scheduleAdvanceForCurrent();
          }
        }
        updateStatus();
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
      setStatus("Loading media…");
      await fetchPhotos();

      if (!photos.length) {
        setStatus("No media found in /photos (mount your directory).");
        // Keep HUD visible so user sees message
        hud.classList.remove("hidden");
        return;
      }

      idx = pickStartIndex();
      await showAt(idx, true);
      refreshListPeriodically();
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      hud.classList.remove("hidden");
    }
  }

  boot();
})();
