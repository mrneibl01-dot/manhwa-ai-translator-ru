// Manhwa AI Translator RU v5.0.0 (Batch Engine) - Smart Full-Chapter Preloader
(() => {
  if (window.__MAT_LOADED__) return;
  window.__MAT_LOADED__ = true;

  const DOMAIN = location.hostname;
  let settings = {
    apiKey: "",
    model: "gemini-3.5-flash-lite",
    preloadChapter: true,
    turboMode: true,
    skipSfx: true,
    fontScale: 1.0,
    softEdges: true,
    showBadge: true,
    showSideButton: true,
    enabledDomains: {}
  };

  let isEnabled = false;
  let isPaused = false;
  let overlaysHidden = false;
  let isSnipping = false;

  let rootLayer = null;
  let cropLayer = null;
  let badgeEl = null;
  let sideDockEl = null;
  let mutationObserver = null;
  let resizeObserver = null;
  let syncRaf = null;
  let scrollTimer = null;
  let keepaliveTimer = null;
  let retryTimer = null;
  let imgSeq = 1;
  let reqSeq = 1;

  let port = null;
  const pendingReqs = new Map();

  // Map<HTMLImageElement, { id, overlay, blocks, status, src, forceFresh, retries }>
  const trackedImages = new Map();
  const idToImage = new Map();

  // Allow up to 8 images in-flight so the background Batch Engine ALWAYS has 3-4 pages ready to pack into 1 API call!
  const MAX_INFLIGHT_IMAGES = 8;
  let inflightImages = 0;
  let stats = { done: 0, total: 0, working: 0, lastSec: null, notice: "", error: "" };

  init();

  async function init() {
    const stored = await chrome.storage.local.get(null);
    settings = { ...settings, ...stored };
    isEnabled = Boolean(settings.enabledDomains && settings.enabledDomains[DOMAIN]);

    if (isEnabled) {
      startTranslator();
    }

    chrome.storage.onChanged.addListener((changes) => {
      let needRestart = false;
      let needRefit = false;
      let needReschedule = false;
      for (const [k, { newValue }] of Object.entries(changes)) {
        settings[k] = newValue;
        if (k === "fontScale" || k === "softEdges") needRefit = true;
        if (k === "apiKey" || k === "model" || k === "turboMode" || k === "preloadChapter") needReschedule = true;
        if (k === "showBadge") updateBadge();
        if (k === "showSideButton") updateSideDockVisibility();
        if (k === "enabledDomains") {
          const nowEnabled = Boolean(newValue && newValue[DOMAIN]);
          if (nowEnabled !== isEnabled) {
            isEnabled = nowEnabled;
            needRestart = true;
          }
        }
      }
      if (needRestart) {
        if (isEnabled) startTranslator();
        else stopTranslator();
      } else if (isEnabled) {
        if (needRefit) rerenderAllOverlays();
        if (needReschedule) {
          stats.error = "";
          for (const [, info] of trackedImages.entries()) {
            if (info.status === "error" || info.status === "partial") info.status = "idle";
          }
          scanForImages();
          scheduleWork();
          updateBadge();
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "GET_STATUS") {
        sendResponse({ domain: DOMAIN, isEnabled, isPaused, overlaysHidden, stats });
        return false;
      }
      if (msg.type === "RETRANSLATE_PAGE") {
        if (isEnabled) {
          stopTranslator();
          startTranslator();
        }
        sendResponse({ ok: true });
        return false;
      }
      if (msg.type === "START_SNIP") {
        startSnipMode();
        sendResponse({ ok: true });
        return false;
      }
    });

    window.addEventListener("keydown", async (e) => {
      if (isTypingTarget(e.target)) return;
      if (e.altKey && e.code === "KeyS") {
        e.preventDefault();
        startSnipMode();
      } else if (e.altKey && e.code === "KeyT") {
        e.preventDefault();
        const next = !isEnabled;
        const domains = { ...(settings.enabledDomains || {}) };
        if (next) domains[DOMAIN] = true;
        else delete domains[DOMAIN];
        await chrome.storage.local.set({ enabledDomains: domains });
      } else if (e.altKey && e.code === "KeyH" && (isEnabled || cropLayer)) {
        e.preventDefault();
        toggleOverlaysHidden();
      }
    });
  }

  function ensurePort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: "mat-stream" });
    } catch (_) {
      return null;
    }

    port.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "PONG") return;

      if (msg.type === "ENGINE_NOTICE") {
        stats.notice = msg.notice || "";
        updateBadge();
        return;
      }

      if (msg.type === "TILE_BLOCKS" && isEnabled) {
        const img = idToImage.get(msg.imgId);
        if (img && trackedImages.has(img)) {
          const info = trackedImages.get(img);
          if (info.status === "working" && Array.isArray(msg.blocks)) {
            info.blocks = info.blocks.concat(msg.blocks);
            if (msg.elapsedMs && msg.elapsedMs < 60000) {
              stats.lastSec = (msg.elapsedMs / 1000).toFixed(1);
            }
            if (img.complete && isLargeEnough(img)) {
              ensureOverlay(img, info);
              renderOverlayBlocks(img, info, true);
            }
            updateBadge();
          }
        }
        return;
      }

      if (msg.type === "IMAGE_RESULT") {
        const req = pendingReqs.get(msg.reqId);
        if (!req) return;
        pendingReqs.delete(msg.reqId);
        handleImageResult(req, msg);
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      for (const [, req] of pendingReqs.entries()) {
        if (req.info && req.info.status === "working") {
          req.info.status = "idle";
        }
      }
      pendingReqs.clear();
      inflightImages = 0;
      stats.working = 0;

      if (isEnabled && !isPaused) {
        setTimeout(() => {
          if (isEnabled && !isPaused) scheduleWork();
        }, 450);
      }
    });

    return port;
  }

  function startKeepalive() {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(() => {
      if (inflightImages > 0 && port) {
        try { port.postMessage({ type: "PING" }); } catch (_) {}
      }
    }, 16000);
  }

  function stopKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function ensureCropLayer() {
    if (!cropLayer) {
      cropLayer = document.createElement("div");
      cropLayer.id = "mat-crop-layer";
      if (overlaysHidden) cropLayer.classList.add("mat-hidden");
      document.body.appendChild(cropLayer);
    }
    return cropLayer;
  }

  // =========================================================================
  // RIGHT-SIDE FLOATING MINI-DOCK
  // =========================================================================
  function createSideDock() {
    if (sideDockEl) return;
    sideDockEl = document.createElement("div");
    sideDockEl.id = "mat-side-dock";
    sideDockEl.innerHTML = `
      <button type="button" id="mat-side-trigger" title="Инструменты перевода (✂ Область)">✂</button>
      <div id="mat-side-menu">
        <button type="button" class="mat-side-btn mat-primary-snip" data-act="snip">
          <span>✂ Обрезать и перевести</span>
          <span class="mat-side-kbd">Alt+S</span>
        </button>
        <button type="button" class="mat-side-btn" data-act="rescan">
          <span>↻ Доперевести экран</span>
        </button>
        <button type="button" class="mat-side-btn" data-act="toggle-eye">
          <span class="mat-eye-label">👁 Скрыть перевод</span>
          <span class="mat-side-kbd">Alt+H</span>
        </button>
        <button type="button" class="mat-side-btn" data-act="clear-crops">
          <span>🗑 Убрать вырезки</span>
        </button>
      </div>
    `;
    document.body.appendChild(sideDockEl);

    sideDockEl.querySelector("#mat-side-trigger").addEventListener("click", (e) => {
      e.stopPropagation();
      sideDockEl.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
      if (sideDockEl && !sideDockEl.contains(e.target)) {
        sideDockEl.classList.remove("open");
      }
    });

    sideDockEl.querySelector('[data-act="snip"]').addEventListener("click", () => {
      sideDockEl.classList.remove("open");
      startSnipMode();
    });

    sideDockEl.querySelector('[data-act="rescan"]').addEventListener("click", () => {
      sideDockEl.classList.remove("open");
      retranslateVisibleScreen();
    });

    sideDockEl.querySelector('[data-act="toggle-eye"]').addEventListener("click", () => {
      sideDockEl.classList.remove("open");
      toggleOverlaysHidden();
    });

    sideDockEl.querySelector('[data-act="clear-crops"]').addEventListener("click", () => {
      sideDockEl.classList.remove("open");
      if (cropLayer) cropLayer.innerHTML = "";
    });

    updateSideDockVisibility();
  }

  function updateSideDockVisibility() {
    if (!sideDockEl) return;
    sideDockEl.style.display = settings.showSideButton === false ? "none" : "flex";
    const eyeLabel = sideDockEl.querySelector(".mat-eye-label");
    if (eyeLabel) {
      eyeLabel.textContent = overlaysHidden ? "👁 Показать перевод" : "👁 Скрыть перевод";
    }
  }

  function retranslateVisibleScreen() {
    const vh = window.innerHeight || 900;
    let queued = 0;
    for (const [img, info] of trackedImages.entries()) {
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh && isLargeEnough(img)) {
        info.status = "idle";
        info.blocks = [];
        info.forceFresh = true;
        info.retries = 0;
        if (info.overlay) info.overlay.innerHTML = "";
        queued++;
      }
    }
    if (queued > 0) {
      stats.error = "";
      recountTotals();
      scheduleWork();
      updateBadge();
    }
  }

  // =========================================================================
  // INSTANT AREA SNIP / CROP OVERLAY TRANSLATOR
  // =========================================================================
  function startSnipMode() {
    if (isSnipping) return;
    isSnipping = true;

    const screen = document.createElement("div");
    screen.id = "mat-snip-screen";

    const hint = document.createElement("div");
    hint.id = "mat-snip-hint";
    hint.textContent = "✂ Выделите мышкой нужный текст для мгновенного перевода (ESC — отмена)";

    const box = document.createElement("div");
    box.id = "mat-snip-box";

    screen.appendChild(hint);
    screen.appendChild(box);
    document.body.appendChild(screen);

    let startX = 0, startY = 0, dragging = false, selRect = null;

    const cleanup = () => {
      isSnipping = false;
      screen.remove();
      window.removeEventListener("keydown", onKeyDown, true);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    screen.addEventListener("mousedown", (e) => {
      if (e.button !== 0) { cleanup(); return; }
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = "block";
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = "0px";
      box.style.height = "0px";
      hint.style.display = "none";
    });

    screen.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x1 = Math.min(startX, e.clientX);
      const y1 = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = `${x1}px`;
      box.style.top = `${y1}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      selRect = { left: x1, top: y1, width: w, height: h };
    });

    screen.addEventListener("mouseup", async () => {
      if (!dragging) return;
      dragging = false;
      const finalRect = selRect;
      cleanup();

      if (!finalRect || finalRect.width < 18 || finalRect.height < 14) return;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      runCropTranslation(finalRect);
    });
  }

  async function runCropTranslation(vpRect) {
    const layer = ensureCropLayer();
    const docLeft = vpRect.left + window.scrollX;
    const docTop = vpRect.top + window.scrollY;

    const card = document.createElement("div");
    card.className = "mat-crop-card";
    card.style.left = `${docLeft}px`;
    card.style.top = `${docTop}px`;
    card.style.width = `${vpRect.width}px`;
    card.style.height = `${vpRect.height}px`;

    const tReq = chrome.runtime.sendMessage({
      type: "TRANSLATE_CROP_REGION",
      rect: vpRect,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight
    });

    let finished = false;
    setTimeout(() => {
      if (finished) return;
      const loader = document.createElement("div");
      loader.className = "mat-crop-loading";
      loader.textContent = "Перевод…";
      card.appendChild(loader);
      layer.appendChild(card);
    }, 65);

    try {
      const res = await tReq;
      finished = true;
      if (!card.parentElement) layer.appendChild(card);
      card.innerHTML = "";

      if (res && res.ok && Array.isArray(res.blocks) && res.blocks.length > 0) {
        if (res.elapsedMs && res.elapsedMs < 60000) {
          stats.lastSec = (res.elapsedMs / 1000).toFixed(1);
          updateBadge();
        }
        renderCropBlocks(card, vpRect.width, vpRect.height, res.blocks, res.cropColors);
      } else {
        const errBox = document.createElement("div");
        errBox.className = "mat-crop-error";
        errBox.textContent = (res && res.error) || "Не удалось перевести область";
        errBox.addEventListener("click", () => card.remove());
        card.appendChild(errBox);
        setTimeout(() => card.remove(), 4500);
      }
    } catch (err) {
      finished = true;
      if (!card.parentElement) layer.appendChild(card);
      card.innerHTML = "";
      const errBox = document.createElement("div");
      errBox.className = "mat-crop-error";
      errBox.textContent = err.message || "Ошибка перевода";
      errBox.addEventListener("click", () => card.remove());
      card.appendChild(errBox);
      setTimeout(() => card.remove(), 4500);
    }
  }

  function renderCropBlocks(card, cardW, cardH, blocks, cropColors) {
    const fontScale = Number(settings.fontScale || 1.0);
    const softEdges = settings.softEdges !== false;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mat-crop-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Убрать перевод области";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      card.remove();
    });
    card.appendChild(closeBtn);

    const singleCompact = blocks.length === 1;

    for (const block of blocks) {
      const el = document.createElement("div");
      el.className = `mat-bubble mat-style-${block.style || "white_bubble"}`;

      if (singleCompact) {
        el.style.left = "0%";
        el.style.top = "0%";
        el.style.width = "100%";
        el.style.height = "100%";
      } else {
        el.style.left = `${block.leftPct}%`;
        el.style.top = `${block.topPct}%`;
        el.style.width = `${block.widthPct}%`;
        el.style.height = `${block.heightPct}%`;
      }

      const bg = block.bgColor || cropColors?.bgColor || "rgb(248, 248, 250)";
      const fg = block.fgColor || cropColors?.fgColor || "#111318";
      const sh = block.shadowColor || cropColors?.shadowColor || "rgba(248, 248, 250, 0.95)";

      el.style.backgroundColor = bg;
      el.style.color = fg;
      if (softEdges && block.style !== "system_box") {
        el.style.boxShadow = `0 0 10px 5px ${sh}`;
      }

      const span = document.createElement("span");
      span.textContent = block.ru;
      el.appendChild(span);

      el.title = "Клик — оригинал • Наведите и нажмите × чтобы убрать";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("mat-peek");
      });

      card.appendChild(el);

      const boxW = singleCompact ? cardW : (block.widthPct / 100) * cardW;
      const boxH = singleCompact ? cardH : (block.heightPct / 100) * cardH;
      fitTextToBox(el, boxW, boxH, fontScale);
    }
  }

  // =========================================================================
  // TRUE FULL-CHAPTER LAZY-BYPASS SCANNER & BATCH PRELOADER
  // =========================================================================
  function startTranslator() {
    if (rootLayer) return;

    rootLayer = document.createElement("div");
    rootLayer.id = "mat-root-layer";
    document.body.appendChild(rootLayer);

    createBadge();
    createSideDock();
    ensurePort();
    startKeepalive();

    resizeObserver = new ResizeObserver(() => scheduleSync());
    resizeObserver.observe(document.body);

    mutationObserver = new MutationObserver(() => {
      scanForImages();
      scheduleSync();
      scheduleWork();
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-src", "data-lazy-src", "data-original"]
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleSync, { passive: true });

    scanForImages();
    scheduleWork();
    updateBadge();
  }

  function stopTranslator() {
    stopKeepalive();
    if (port) {
      try { port.disconnect(); } catch (_) {}
      port = null;
    }
    pendingReqs.clear();

    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", scheduleSync);
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }

    trackedImages.clear();
    idToImage.clear();
    inflightImages = 0;
    stats = { done: 0, total: 0, working: 0, lastSec: null, notice: "", error: "" };

    if (rootLayer) { rootLayer.remove(); rootLayer = null; }
    if (badgeEl) { badgeEl.remove(); badgeEl = null; }
    if (sideDockEl) { sideDockEl.remove(); sideDockEl = null; }
  }

  function onScroll() {
    scheduleSync();
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scanForImages();
      // If any pre-translated image just entered viewport and loaded, ensure its overlay is rendered immediately!
      for (const [img, info] of trackedImages.entries()) {
        if (info.status === "done" && info.blocks.length > 0 && !info.overlay && img.complete && isLargeEnough(img)) {
          ensureOverlay(img, info);
          renderOverlayBlocks(img, info, false);
        }
      }
      scheduleWork();
    }, 80);
  }

  function isPlaceholderUrl(url) {
    if (!url) return true;
    const u = url.toLowerCase();
    return (
      u.startsWith("data:image/gif") ||
      u.startsWith("data:image/svg") ||
      /(blank|spacer|placeholder|loading|loader|spinner|transparent|1x1)\.(gif|png|jpg|webp|svg)/i.test(u)
    );
  }

  // Always prefer the real manga URL hidden in lazy-load attributes before placeholder src!
  function getRealMangaUrl(img) {
    const lazyAttrs = [
      img.getAttribute("data-src"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-url"),
      img.getAttribute("data-cfsrc"),
      img.getAttribute("data-img")
    ];
    for (const raw of lazyAttrs) {
      const val = (raw || "").trim();
      if (val && /^https?:\/\//i.test(val) && !isPlaceholderUrl(val)) {
        return val;
      }
    }
    const cur = (img.currentSrc || img.src || "").trim();
    if (cur && !isPlaceholderUrl(cur)) return cur;
    return "";
  }

  function hasLazyAttr(img) {
    return Boolean(
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-url") ||
      img.getAttribute("data-cfsrc")
    );
  }

  function scanForImages() {
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      if (!couldBeMangaImage(img)) continue;

      const realUrl = getRealMangaUrl(img);

      // Force eager loading on manga pages when preloading is ON so browser paints them smoothly too
      if (settings.preloadChapter !== false && img.loading === "lazy") {
        img.loading = "eager";
      }

      if (trackedImages.has(img)) {
        const info = trackedImages.get(img);
        if (realUrl && realUrl !== info.src && info.status !== "working") {
          info.src = realUrl;
          info.status = "idle";
          info.blocks = [];
          info.retries = 0;
          if (info.overlay) info.overlay.innerHTML = "";
        }
        continue;
      }

      const id = imgSeq++;
      trackedImages.set(img, {
        id,
        overlay: null,
        blocks: [],
        status: "idle",
        forceFresh: false,
        retries: 0,
        src: realUrl
      });
      idToImage.set(id, img);

      if (resizeObserver) resizeObserver.observe(img);

      img.addEventListener(
        "load",
        () => {
          const info = trackedImages.get(img);
          if (info && info.status === "done" && info.blocks.length > 0 && isLargeEnough(img)) {
            // Instant 0ms paint for pages that finished pre-translating before browser loaded them!
            ensureOverlay(img, info);
            renderOverlayBlocks(img, info, false);
          }
          scheduleSync();
          recountTotals();
          scheduleWork();
        },
        { passive: true }
      );
    }
    recountTotals();
  }

  function couldBeMangaImage(img) {
    const realUrl = getRealMangaUrl(img).toLowerCase();
    if (!realUrl && !hasLazyAttr(img)) return false;
    if (realUrl.startsWith("data:image/svg")) return false;
    const hint = (img.className + " " + img.id + " " + (img.alt || "")).toLowerCase();
    if (/(avatar|logo|icon|emoji|spinner|loader|banner-ad|flag|badge|thumb)/i.test(hint)) {
      const rect = img.getBoundingClientRect();
      if (rect.width < 320) return false;
    }
    return true;
  }

  function isLargeEnough(img) {
    const rect = img.getBoundingClientRect();
    const natW = img.naturalWidth || 0;
    const natH = img.naturalHeight || 0;
    if (natW < 260 || natH < 180) return false;
    if (rect.width < 220 || rect.height < 140) return false;
    if (natW / natH > 4.2 && natH < 250) return false;
    return true;
  }

  function isLikelyChapterPageBeforeLoad(img, realUrl) {
    if (!realUrl || !/^https?:\/\//i.test(realUrl)) return false;
    if (hasLazyAttr(img)) return true;
    const rect = img.getBoundingClientRect();
    // If already has wide box or is inside main vertical reader column
    if (rect.width >= 260) return true;
    if (rect.width === 0 && !img.complete) return true;
    // Check if URL matches comic image extensions
    if (/\.(jpe?g|png|webp)(\?|$)/i.test(realUrl) && !/(logo|avatar|icon|banner|cover|thumb)/i.test(realUrl)) {
      return true;
    }
    return false;
  }

  function recountTotals() {
    let total = 0;
    let done = 0;
    for (const [img, info] of trackedImages.entries()) {
      if (!document.body.contains(img)) continue;
      if (info.status === "skipped") continue;
      const realUrl = getRealMangaUrl(img);
      const loadedReal = img.complete && !isPlaceholderUrl(img.currentSrc || img.src);
      if (loadedReal && !isLargeEnough(img)) continue;
      if (!loadedReal && !isLikelyChapterPageBeforeLoad(img, realUrl)) continue;
      total++;
      if (info.status === "done") done++;
    }
    stats.total = total;
    stats.done = done;
  }

  // PRIORITY ORDER:
  // 0..1   = Current screen RIGHT NOW (immediate 1-2 page batch)
  // 10..20 = Next 1-3 screens below (packed 3-4 pages per 1 API call)
  // 25..99 = Rest of the ENTIRE chapter below (packed 3-4 pages per 1 API call!)
  // 100+   = Panels above current screen
  function scheduleWork() {
    if (!isEnabled || isPaused) return;
    if (inflightImages >= MAX_INFLIGHT_IMAGES) return;

    const activePort = ensurePort();
    if (!activePort) return;

    const vh = window.innerHeight || 900;
    const preloadAll = settings.preloadChapter !== false;
    const candidates = [];

    for (const [img, info] of trackedImages.entries()) {
      if (info.status !== "idle") continue;
      if (!document.body.contains(img)) continue;

      const realUrl = getRealMangaUrl(img);
      if (!realUrl) continue;

      const loadedReal = img.complete && !isPlaceholderUrl(img.currentSrc || img.src);
      if (loadedReal) {
        if (!isLargeEnough(img)) {
          info.status = "skipped";
          continue;
        }
      } else {
        // Not loaded in browser yet (lazy placeholder or below fold) -> STILL PRE-TRANSLATE via realUrl!
        if (!preloadAll || !isLikelyChapterPageBeforeLoad(img, realUrl)) continue;
      }

      const r = img.getBoundingClientRect();
      const visibleNow = r.bottom > 0 && r.top < vh;
      const aheadNear = r.top >= vh && r.top < vh * 3;
      const aheadFar = r.top >= vh * 3;
      const above = r.bottom <= 0;

      if (!preloadAll && !visibleNow && !aheadNear && !(above && r.bottom > -vh * 0.5)) {
        continue;
      }

      let priority;
      if (visibleNow) {
        priority = Math.abs((r.top + r.bottom) / 2 - vh / 2) / vh;
      } else if (aheadNear) {
        priority = 10 + (r.top - vh) / vh;
      } else if (aheadFar) {
        priority = 25 + Math.min(70, (r.top - vh * 3) / (vh * 4));
      } else {
        priority = 100 + Math.abs(r.bottom) / vh;
      }

      candidates.push({ img, info, realUrl, priority });
    }

    candidates.sort((a, b) => a.priority - b.priority);

    for (const c of candidates) {
      if (inflightImages >= MAX_INFLIGHT_IMAGES) break;
      dispatchImage(activePort, c.img, c.info, c.realUrl, c.priority);
    }

    recountTotals();
    updateBadge();
  }

  function dispatchImage(activePort, img, info, realUrl, priority, fallbackDataUrl = null) {
    if (!realUrl || isPlaceholderUrl(realUrl)) return;

    const forceFresh = Boolean(info.forceFresh);
    info.forceFresh = false;
    info.src = realUrl;
    info.status = "working";
    if (!fallbackDataUrl) info.blocks = [];

    inflightImages++;
    stats.working++;
    stats.error = "";

    const loadedReal = img.complete && !isPlaceholderUrl(img.currentSrc || img.src);
    if (loadedReal && isLargeEnough(img)) {
      ensureOverlay(img, info);
      showLoadingTag(info.overlay, true);
    }

    const reqId = reqSeq++;
    pendingReqs.set(reqId, { img, info, realUrl, priority, usedFallback: Boolean(fallbackDataUrl) });

    try {
      activePort.postMessage({
        type: "TRANSLATE_IMAGE",
        reqId,
        imgId: info.id,
        imgUrl: realUrl,
        pageOrigin: location.origin,
        priority,
        forceFresh,
        fallbackDataUrl,
        settings
      });
    } catch (_) {
      pendingReqs.delete(reqId);
      info.status = "idle";
      inflightImages = Math.max(0, inflightImages - 1);
      stats.working = Math.max(0, stats.working - 1);
    }

    updateBadge();
  }

  function handleImageResult(req, res) {
    const { img, info, realUrl, priority, usedFallback } = req;

    inflightImages = Math.max(0, inflightImages - 1);
    stats.working = Math.max(0, stats.working - 1);

    if (!isEnabled) return;

    const loadedReal = img.complete && !isPlaceholderUrl(img.currentSrc || img.src);
    if (res && !res.ok && res.code === "NEED_CANVAS_FALLBACK" && !usedFallback && loadedReal) {
      const dataUrl = tryCaptureImageLocally(img);
      const activePort = ensurePort();
      if (dataUrl && activePort) {
        dispatchImage(activePort, img, info, realUrl, priority, dataUrl);
        return;
      }
    }

    if (res && res.ok) {
      info.blocks = res.blocks || [];
      info.status = res.partial ? "partial" : "done";
      if (res.elapsedMs && res.elapsedMs > 50 && res.elapsedMs < 60000) {
        stats.lastSec = (res.elapsedMs / 1000).toFixed(1);
      }
      if (loadedReal && isLargeEnough(img)) {
        ensureOverlay(img, info);
        renderOverlayBlocks(img, info, false);
      }
      if (res.partial && (info.retries || 0) < 2) {
        info.retries = (info.retries || 0) + 1;
        setTimeout(() => {
          if (isEnabled && info.status === "partial") {
            info.status = "idle";
            scheduleWork();
          }
        }, 5000);
      }
    } else {
      const errTxt = (res && res.error) || "Ошибка перевода";
      if (info.overlay) showLoadingTag(info.overlay, false);

      if ((info.retries || 0) < 2 && res?.code !== "NO_KEY" && res?.code !== "DAILY_QUOTA") {
        info.retries = (info.retries || 0) + 1;
        info.status = "error";
        stats.error = errTxt;
        if (!retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (!isEnabled || isPaused) return;
            for (const [, it] of trackedImages.entries()) {
              if (it.status === "error" && (it.retries || 0) <= 2) {
                it.status = "idle";
              }
            }
            stats.error = "";
            scheduleWork();
          }, 5000);
        }
      } else {
        info.status = "error";
        stats.error = errTxt;
      }
    }

    recountTotals();
    updateBadge();
    scheduleWork();
  }

  function tryCaptureImageLocally(img) {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return c.toDataURL("image/jpeg", 0.76);
    } catch (_) {
      return null;
    }
  }

  function ensureOverlay(img, info) {
    if (!info.overlay && rootLayer) {
      const ov = document.createElement("div");
      ov.className = "mat-img-overlay";
      rootLayer.appendChild(ov);
      info.overlay = ov;
      syncSingleOverlay(img, info);
    }
  }

  function showLoadingTag(overlay, show) {
    if (!overlay) return;
    let tag = overlay.querySelector(".mat-img-loading");
    if (show) {
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "mat-img-loading";
        tag.textContent = "Перевод…";
        overlay.appendChild(tag);
      }
    } else if (tag) {
      tag.remove();
    }
  }

  function renderOverlayBlocks(img, info, keepLoadingTag = false) {
    if (!info.overlay) return;
    info.overlay.innerHTML = "";
    syncSingleOverlay(img, info);

    if (keepLoadingTag) {
      showLoadingTag(info.overlay, true);
    }

    const imgRect = img.getBoundingClientRect();
    const imgW = imgRect.width || img.clientWidth;
    const imgH = imgRect.height || img.clientHeight;
    if (!imgW || !imgH) return;

    const fontScale = Number(settings.fontScale || 1.0);
    const softEdges = settings.softEdges !== false;

    for (const block of info.blocks) {
      const el = document.createElement("div");
      el.className = `mat-bubble mat-style-${block.style || "white_bubble"}`;
      el.style.left = `${block.leftPct}%`;
      el.style.top = `${block.topPct}%`;
      el.style.width = `${block.widthPct}%`;
      el.style.height = `${block.heightPct}%`;
      el.style.backgroundColor = block.bgColor;
      el.style.color = block.fgColor;

      if (softEdges && block.style !== "system_box" && block.style !== "narration") {
        el.style.boxShadow = `0 0 10px 5px ${block.shadowColor}`;
      }

      const span = document.createElement("span");
      span.textContent = block.ru;
      el.appendChild(span);

      el.title = "Нажмите, чтобы увидеть оригинал";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("mat-peek");
      });

      info.overlay.appendChild(el);

      const boxW = (block.widthPct / 100) * imgW;
      const boxH = (block.heightPct / 100) * imgH;
      fitTextToBox(el, boxW, boxH, fontScale);
    }
  }

  // Clean word-preserving font fitter: NEVER splits Russian words mid-letter like "СОБСТВЕННО / Е"!
  function fitTextToBox(el, boxW, boxH, fontScale) {
    const w = Math.max(28, el.clientWidth || boxW);
    const h = Math.max(18, el.clientHeight || boxH);

    el.style.overflowWrap = "normal";
    el.style.wordBreak = "normal";

    let low = 8;
    let high = Math.min(32, Math.max(11, Math.round(h * 0.44 * fontScale)));
    let best = low;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      el.style.fontSize = `${mid}px`;
      if (el.scrollHeight <= h + 1 && el.scrollWidth <= w + 2) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    el.style.fontSize = `${Math.max(8, Math.round(best * Math.min(1.12, fontScale)))}px`;
    let current = parseInt(el.style.fontSize, 10);
    while (current > 8 && (el.scrollHeight > h + 2 || el.scrollWidth > w + 2)) {
      current--;
      el.style.fontSize = `${current}px`;
    }

    // Only allow word break as absolute last resort if a single giant word exceeds box width at 8px
    if (el.scrollWidth > w + 3) {
      el.style.overflowWrap = "anywhere";
    }
  }

  function rerenderAllOverlays() {
    for (const [img, info] of trackedImages.entries()) {
      if ((info.status === "done" || info.status === "partial") && info.overlay) {
        renderOverlayBlocks(img, info, false);
      }
    }
  }

  function scheduleSync() {
    if (syncRaf) return;
    syncRaf = requestAnimationFrame(() => {
      syncRaf = null;
      syncAllPositions();
    });
  }

  function syncAllPositions() {
    if (!rootLayer) return;
    const rootRect = rootLayer.getBoundingClientRect();
    for (const [img, info] of trackedImages.entries()) {
      if (!info.overlay) continue;
      if (!document.body.contains(img)) {
        info.overlay.remove();
        trackedImages.delete(img);
        idToImage.delete(info.id);
        continue;
      }
      const r = img.getBoundingClientRect();
      info.overlay.style.left = `${r.left - rootRect.left}px`;
      info.overlay.style.top = `${r.top - rootRect.top}px`;
      info.overlay.style.width = `${r.width}px`;
      info.overlay.style.height = `${r.height}px`;
    }
  }

  function syncSingleOverlay(img, info) {
    if (!rootLayer || !info.overlay) return;
    const rootRect = rootLayer.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    info.overlay.style.left = `${r.left - rootRect.left}px`;
    info.overlay.style.top = `${r.top - rootRect.top}px`;
    info.overlay.style.width = `${r.width}px`;
    info.overlay.style.height = `${r.height}px`;
  }

  function toggleOverlaysHidden() {
    overlaysHidden = !overlaysHidden;
    if (rootLayer) rootLayer.classList.toggle("mat-hidden", overlaysHidden);
    if (cropLayer) cropLayer.classList.toggle("mat-hidden", overlaysHidden);
    updateBadge();
    updateSideDockVisibility();
  }

  function createBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement("div");
    badgeEl.id = "mat-floating-badge";
    badgeEl.innerHTML = `
      <span class="mat-dot"></span>
      <span class="mat-status-text">Batch RU</span>
      <button type="button" class="mat-btn-snip-mini" title="Обрезать и перевести область (Alt+S)">✂ Область</button>
      <button type="button" class="mat-btn-retry" style="display:none;" title="Повторить перевод">Повтор</button>
      <button type="button" class="mat-btn-eye" title="Скрыть/показать перевод (Alt+H)">Скрыть</button>
      <button type="button" class="mat-btn-pause" title="Пауза">Пауза</button>
    `;
    document.body.appendChild(badgeEl);

    badgeEl.querySelector(".mat-btn-snip-mini").addEventListener("click", () => {
      startSnipMode();
    });

    badgeEl.querySelector(".mat-btn-retry").addEventListener("click", () => {
      stats.error = "";
      for (const [, info] of trackedImages.entries()) {
        if (info.status === "error" || info.status === "partial") {
          info.status = "idle";
          info.retries = 0;
        }
      }
      scheduleWork();
      updateBadge();
    });

    badgeEl.querySelector(".mat-btn-eye").addEventListener("click", () => {
      toggleOverlaysHidden();
    });

    badgeEl.querySelector(".mat-btn-pause").addEventListener("click", () => {
      isPaused = !isPaused;
      if (!isPaused) {
        for (const [, info] of trackedImages.entries()) {
          if (info.status === "error" || info.status === "partial") {
            info.status = "idle";
            info.retries = 0;
          }
        }
        scheduleWork();
      }
      updateBadge();
    });

    updateBadge();
  }

  function updateBadge() {
    if (!badgeEl) return;
    badgeEl.style.display = settings.showBadge === false ? "none" : "flex";

    const dot = badgeEl.querySelector(".mat-dot");
    const txt = badgeEl.querySelector(".mat-status-text");
    const btnRetry = badgeEl.querySelector(".mat-btn-retry");
    const btnEye = badgeEl.querySelector(".mat-btn-eye");
    const btnPause = badgeEl.querySelector(".mat-btn-pause");

    dot.className = "mat-dot";
    btnRetry.style.display = "none";

    const speedPart = stats.lastSec ? ` • ${stats.lastSec}с` : "";
    const progress = stats.total > 0 ? `${stats.done}/${stats.total}` : `${stats.done}`;

    if (isPaused) {
      dot.classList.add("paused");
      txt.textContent = `Пауза (${progress})`;
      txt.title = "";
    } else if (stats.notice) {
      dot.classList.add("paused");
      txt.textContent = `${stats.notice} (${progress})`;
      txt.title = stats.notice;
    } else if (stats.error && stats.working === 0) {
      dot.classList.add("error");
      txt.textContent = stats.error.length > 30 ? stats.error.slice(0, 30) + "…" : stats.error;
      txt.title = stats.error;
      btnRetry.style.display = "inline-block";
    } else if (stats.working > 0) {
      dot.classList.add("working");
      txt.textContent = `Глава: ${progress}${speedPart}`;
      txt.title = "Пакетная предзагрузка всей главы (3–4 страницы за 1 запрос)";
    } else if (stats.total > 0 && stats.done >= stats.total) {
      txt.textContent = `Глава готова (${progress})${speedPart}`;
      txt.title = "Вся глава переведена заранее — можно листать без остановок";
    } else {
      txt.textContent = stats.done > 0 ? `Готово: ${progress}${speedPart}` : "Готов к чтению";
      txt.title = "";
    }

    btnEye.textContent = overlaysHidden ? "Показать" : "Скрыть";
    btnPause.textContent = isPaused ? "Старт" : "Пауза";
  }
})();
