// Manhwa AI Translator RU v5.2.0 - Popup Controller + Built-in Guide

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const FALLBACK_MODELS = [
  { id: "gemini-3.5-flash-lite", displayName: "Gemini 3.5 Flash-Lite (быстрая)" },
  { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
  { id: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash" }
];

let currentDomain = "";
let currentTabId = null;

document.addEventListener("DOMContentLoaded", async () => {
  const mainView = document.getElementById("mainView");
  const guideView = document.getElementById("guideView");
  const openGuideBtn = document.getElementById("openGuideBtn");
  const openGuideInline = document.getElementById("openGuideInline");
  const closeGuideBtn = document.getElementById("closeGuideBtn");
  const firstRunHint = document.getElementById("firstRunHint");

  const domainEl = document.getElementById("domainName");
  const snipNowBtn = document.getElementById("snipNowBtn");
  const siteEnabledEl = document.getElementById("siteEnabled");
  const apiKeyEl = document.getElementById("apiKey");
  const modelEl = document.getElementById("model");
  const preloadChapterEl = document.getElementById("preloadChapter");
  const turboModeEl = document.getElementById("turboMode");
  const showSideButtonEl = document.getElementById("showSideButton");
  const skipSfxEl = document.getElementById("skipSfx");
  const softEdgesEl = document.getElementById("softEdges");
  const showBadgeEl = document.getElementById("showBadge");
  const fontScaleEl = document.getElementById("fontScale");
  const fontScaleValEl = document.getElementById("fontScaleVal");
  const saveTestBtn = document.getElementById("saveTestBtn");
  const retranslateBtn = document.getElementById("retranslateBtn");
  const statusMsg = document.getElementById("statusMsg");

  // Built-in Guide Toggle (zero clutter on main screen)
  const openGuide = () => {
    mainView.style.display = "none";
    guideView.style.display = "block";
    guideView.scrollTop = 0;
  };
  const closeGuide = () => {
    guideView.style.display = "none";
    mainView.style.display = "block";
  };

  openGuideBtn.addEventListener("click", openGuide);
  if (openGuideInline) openGuideInline.addEventListener("click", openGuide);
  closeGuideBtn.addEventListener("click", closeGuide);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && /^https?:\/\//i.test(tab.url)) {
    currentTabId = tab.id;
    currentDomain = new URL(tab.url).hostname;
    domainEl.textContent = currentDomain;
  } else {
    domainEl.textContent = "не веб-сайт";
    siteEnabledEl.disabled = true;
    snipNowBtn.disabled = true;
  }

  const settings = await chrome.storage.local.get({
    apiKey: "",
    model: DEFAULT_MODEL,
    availableModels: [],
    preloadChapter: true,
    turboMode: true,
    showSideButton: true,
    skipSfx: true,
    softEdges: true,
    showBadge: true,
    fontScale: 1.0,
    enabledDomains: {}
  });

  let activeModel = settings.model || DEFAULT_MODEL;
  if (/^gemini-2\./i.test(activeModel)) {
    activeModel = DEFAULT_MODEL;
    await chrome.storage.local.set({ model: activeModel });
  }

  populateModelSelect(modelEl, settings.availableModels, activeModel);

  apiKeyEl.value = settings.apiKey || "";
  if (firstRunHint) {
    firstRunHint.style.display = (settings.apiKey || "").trim() ? "none" : "block";
  }

  preloadChapterEl.checked = settings.preloadChapter !== false;
  turboModeEl.checked = settings.turboMode !== false;
  showSideButtonEl.checked = settings.showSideButton !== false;
  skipSfxEl.checked = settings.skipSfx !== false;
  softEdgesEl.checked = settings.softEdges !== false;
  showBadgeEl.checked = settings.showBadge !== false;
  fontScaleEl.value = settings.fontScale || 1.0;
  fontScaleValEl.textContent = `${Math.round((settings.fontScale || 1.0) * 100)}%`;

  if (currentDomain) {
    siteEnabledEl.checked = Boolean(settings.enabledDomains && settings.enabledDomains[currentDomain]);
  }

  snipNowBtn.addEventListener("click", async () => {
    if (!currentTabId) return;
    try {
      await chrome.tabs.sendMessage(currentTabId, { type: "START_SNIP" });
      window.close();
    } catch (_) {
      setStatus("Обновите вкладку (F5) один раз после установки/обновления расширения.", false);
    }
  });

  siteEnabledEl.addEventListener("change", async () => {
    if (!currentDomain) return;
    const latest = await chrome.storage.local.get({ enabledDomains: {} });
    const domains = { ...(latest.enabledDomains || {}) };
    if (siteEnabledEl.checked) {
      if (!apiKeyEl.value.trim()) {
        setStatus("Сначала вставьте бесплатный API-ключ ниже (см. «? Гайд»).", false);
      }
      domains[currentDomain] = true;
    } else {
      delete domains[currentDomain];
    }
    await chrome.storage.local.set({ enabledDomains: domains });
  });

  saveTestBtn.addEventListener("click", async () => {
    const apiKey = apiKeyEl.value.trim();
    const model = modelEl.value;
    await chrome.storage.local.set({ apiKey, model });

    if (firstRunHint) {
      firstRunHint.style.display = apiKey ? "none" : "block";
    }

    setStatus("Проверяю ключ и скорость ответа…", true);
    saveTestBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TEST_API_KEY",
        apiKey,
        model
      });
      if (res && res.availableModels && res.availableModels.length > 0) {
        populateModelSelect(modelEl, res.availableModels, res.activeModel || model);
      } else if (res && res.activeModel) {
        populateModelSelect(modelEl, [], res.activeModel);
      }

      if (res && res.ok) {
        const chosen = res.activeModel || model;
        const speed = res.elapsedMs ? ` (${(res.elapsedMs / 1000).toFixed(1)}с)` : "";
        const keyInfo = res.totalKeysCount > 1 ? ` • ключей активно: ${res.workingKeysCount}/${res.totalKeysCount}` : "";
        if (res.switchedFrom) {
          setStatus(`${res.switchedFrom} ${res.switchedReason || "не ответила"} → включена ${chosen}${speed}${keyInfo}!`, true);
        } else {
          setStatus(`Работает! ${chosen}${speed}${keyInfo}.`, true);
        }
      } else {
        setStatus("Ошибка: " + ((res && res.error) || "проверьте ключ"), false);
      }
    } catch (e) {
      setStatus("Ошибка проверки: " + e.message, false);
    } finally {
      saveTestBtn.disabled = false;
    }
  });

  preloadChapterEl.addEventListener("change", () => chrome.storage.local.set({ preloadChapter: preloadChapterEl.checked }));
  turboModeEl.addEventListener("change", () => chrome.storage.local.set({ turboMode: turboModeEl.checked }));
  showSideButtonEl.addEventListener("change", () => chrome.storage.local.set({ showSideButton: showSideButtonEl.checked }));
  skipSfxEl.addEventListener("change", () => chrome.storage.local.set({ skipSfx: skipSfxEl.checked }));
  softEdgesEl.addEventListener("change", () => chrome.storage.local.set({ softEdges: softEdgesEl.checked }));
  showBadgeEl.addEventListener("change", () => chrome.storage.local.set({ showBadge: showBadgeEl.checked }));
  modelEl.addEventListener("change", () => chrome.storage.local.set({ model: modelEl.value }));

  fontScaleEl.addEventListener("input", () => {
    const val = parseFloat(fontScaleEl.value);
    fontScaleValEl.textContent = `${Math.round(val * 100)}%`;
    chrome.storage.local.set({ fontScale: val });
  });

  retranslateBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_CACHE" });
    if (currentTabId) {
      try {
        await chrome.tabs.sendMessage(currentTabId, { type: "RETRANSLATE_PAGE" });
        setStatus("Кэш сброшен, переводим страницу заново…", true);
      } catch (_) {
        chrome.tabs.reload(currentTabId);
      }
    }
  });

  function setStatus(text, ok) {
    statusMsg.textContent = text;
    statusMsg.className = "status-msg " + (ok ? "status-ok" : "status-err");
  }
});

function populateModelSelect(selectEl, availableModels, selectedId) {
  const list = Array.isArray(availableModels) && availableModels.length > 0
    ? availableModels.slice()
    : FALLBACK_MODELS.slice();

  if (selectedId && !list.some((m) => m.id === selectedId)) {
    list.unshift({ id: selectedId, displayName: selectedId });
  }

  selectEl.innerHTML = "";
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.displayName && m.displayName !== m.id
      ? `${m.displayName} (${m.id})`
      : m.id;
    selectEl.appendChild(opt);
  }

  selectEl.value = selectedId || list[0].id;
}
