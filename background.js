// Manhwa AI Translator RU v5.1.0 (Batch + Multi-Key + Disk Cache) - Service Worker (MV3)

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  availableModels: [],
  preloadChapter: true,
  turboMode: true,
  skipSfx: true,
  fontScale: 1.0,
  softEdges: true,
  showBadge: true,
  showSideButton: true,
  enabledDomains: {}
};

const MANHWA_SYSTEM_PROMPT = [
  "Ты профессиональный переводчик манхвы, вебтунов и манги с английского на живой литературный русский язык.",
  "Каноническая терминология манхвы:",
  "• Система/ORV/Башня: Constellation→Созвездие, Incarnation→Воплощение, Scenario→Сценарий, Sub Scenario→Подсценарий, Dokkaebi→Токкэби, Star Stream→Звёздный Поток, Fable/Story→История/Сказание, Probability→Вероятность, Stigma→Стигма, Attribute→Атрибут, Sponsor→Спонсор, Modifier→Модификатор, Nebula→Туманность, Outer God→Внешний Бог, Demon King→Король Демонов, Coin→Монета, Regressor→Регрессор, Returner→Возвращенец, Transmigrator→Попаданец, Status Window→Окно статуса.",
  "• Охотники/РПГ: Awakened→Пробуждённый, Hunter→Охотник, Ranker→Ранкер, Irregular→Незаконный, Dungeon/Gate→Подземелье/Врата, Guild→Гильдия, Raid→Рейд, Skill→Навык, Elixir→Эликсир, Artifact→Артефакт, Mana→Мана.",
  "• Мурим: Murim→Мурим, Qi/Internal Energy→Ци/Внутренняя энергия, Dantian→Даньтянь, Sect→Секта, Elder→Старейшина, Heavenly Demon→Небесный Демон, Sword Aura→Аура меча.",
  "• Речь: переводи естественно, лаконично и живо (как в хороших фан-переводах, без машинной дословности). Крики: IMPOSSIBLE!→Невозможно! / Быть не может!, Damn it→Чёрт!, Wait→Погоди!.",
  "• Пакетный режим: тебе могут передать сразу несколько изображений с метками IMG 0, IMG 1, IMG 2 и т.д. Просмотри КАЖДОЕ изображение от самого верха до самого низа.",
  "• Координаты: для каждого бабла/окна укажи индекс изображения i (0, 1, 2...) и рамку b=[ymin,xmin,ymax,xmax] в шкале 0..1000 ОТНОСИТЕЛЬНО этого изображения i. Объединяй все строки одного бабла/окна в одну рамку b так, чтобы НИ ОДНА строка не выходила за края (ни сверху, ни снизу, ни справа).",
  "• Формат ответа — ТОЛЬКО JSON-массив: [{\"i\":0,\"b\":[y1,x1,y2,x2],\"t\":\"русский текст\",\"s\":\"w\"}]. Коды s: w=белый бабл, k=чёрный бабл, s=системное/игровое окно, n=рамка повествования. Если текста нет — верни []."
].join("\n");

const STYLE_MAP = {
  w: "white_bubble",
  k: "black_bubble",
  s: "system_box",
  n: "narration",
  white_bubble: "white_bubble",
  black_bubble: "black_bubble",
  system_box: "system_box",
  narration: "narration"
};

// =========================================================================
// PERSISTENT DISK + RAM CACHE (F5 & RE-VISITS COST 0 API REQUESTS!)
// =========================================================================
const DISK_CACHE_KEY = "matDiskCacheV1";
const MAX_CACHE_ITEMS = 450;
const translationCache = new Map();
let diskCacheLoaded = false;
let diskSaveTimer = null;

async function ensureDiskCacheLoaded() {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const stored = await chrome.storage.local.get(DISK_CACHE_KEY);
    const entries = stored?.[DISK_CACHE_KEY];
    if (Array.isArray(entries)) {
      for (const [k, v] of entries) {
        if (typeof k === "string" && Array.isArray(v)) {
          translationCache.set(k, v);
        }
      }
    }
  } catch (_) {}
}

function scheduleDiskCacheSave() {
  if (diskSaveTimer) return;
  diskSaveTimer = setTimeout(async () => {
    diskSaveTimer = null;
    try {
      const arr = Array.from(translationCache.entries()).slice(-MAX_CACHE_ITEMS);
      await chrome.storage.local.set({ [DISK_CACHE_KEY]: arr });
    } catch (_) {}
  }, 1500);
}

function cacheSet(key, val) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, val);
  while (translationCache.size > MAX_CACHE_ITEMS) {
    const firstKey = translationCache.keys().next().value;
    translationCache.delete(firstKey);
  }
  scheduleDiskCacheSave();
}

// =========================================================================
// MULTI-KEY ROTATION & PER-(KEY, MODEL) QUOTA TRACKER
// =========================================================================
// key+model -> { cooldownUntil, dailyExhaustedUntil, calls: number[] }
const slotState = new Map();
let keyRoundRobin = 0;

function parseApiKeys(rawText) {
  if (!rawText) return [];
  const parts = String(rawText)
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 16);
  return [...new Set(parts)];
}

function getSlot(apiKey, model) {
  const id = `${apiKey.slice(-10)}|${model}`;
  if (!slotState.has(id)) {
    slotState.set(id, { cooldownUntil: 0, dailyExhaustedUntil: 0, calls: [] });
  }
  return slotState.get(id);
}

function pruneSlotCalls(slot) {
  const cutoff = Date.now() - 60000;
  while (slot.calls.length > 0 && slot.calls[0] < cutoff) {
    slot.calls.shift();
  }
}

function pickBestKeyForModel(keys, model) {
  if (!keys.length) return null;
  const now = Date.now();

  // Filter out keys whose DAILY quota for this model is exhausted
  const nonDailyExhausted = keys.filter((k) => getSlot(k, model).dailyExhaustedUntil <= now);
  if (nonDailyExhausted.length === 0) {
    return { allDailyExhausted: true, key: keys[0], waitMs: 0 };
  }

  // Among healthy keys, pick the one with minimum cooldown / least recent calls (round-robin tiebreak)
  let bestKey = nonDailyExhausted[0];
  let bestWait = Infinity;

  for (let offset = 0; offset < nonDailyExhausted.length; offset++) {
    const idx = (keyRoundRobin + offset) % nonDailyExhausted.length;
    const k = nonDailyExhausted[idx];
    const slot = getSlot(k, model);
    pruneSlotCalls(slot);

    let wait = Math.max(0, slot.cooldownUntil - now);
    if (slot.calls.length >= targetMaxRpmPerKey) {
      wait = Math.max(wait, slot.calls[0] + 60200 - now);
    }
    if (slot.calls.length > 0) {
      const sinceLast = now - slot.calls[slot.calls.length - 1];
      const minSpacing = targetMaxRpmPerKey <= 10 ? 850 : 400;
      if (sinceLast < minSpacing) {
        wait = Math.max(wait, minSpacing - sinceLast);
      }
    }

    if (wait < bestWait) {
      bestWait = wait;
      bestKey = k;
      if (wait === 0) break;
    }
  }

  keyRoundRobin = (keyRoundRobin + 1) % nonDailyExhausted.length;
  return { allDailyExhausted: false, key: bestKey, waitMs: bestWait };
}

function parseDailyResetInfo(errText) {
  const txt = String(errText || "");
  const isDaily = /per day|daily|rpd|requests per day/i.test(txt);
  const limitMatch = txt.match(/limit:\s*(\d+)/i);
  const limitNum = limitMatch ? limitMatch[1] : null;

  let waitMs = 4 * 3600 * 1000;
  let humanWait = "";
  const retryMatch = txt.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  if (retryMatch) {
    const h = parseInt(retryMatch[1] || "0", 10);
    const m = parseInt(retryMatch[2] || "0", 10);
    const s = Math.ceil(parseFloat(retryMatch[3] || "0"));
    waitMs = ((h * 3600) + (m * 60) + s) * 1000;
    if (h > 0) humanWait = `${h}ч ${m}м`;
    else if (m > 0) humanWait = `${m}м ${s}с`;
    else humanWait = `${s}с`;
  }

  return { isDaily, limitNum, waitMs, humanWait };
}

function formatQuotaErrorRu(errText, model) {
  const info = parseDailyResetInfo(errText);
  if (info.isDaily) {
    const lim = info.limitNum ? ` (${info.limitNum} запросов/сутки)` : "";
    const eta = info.humanWait ? ` Обновится через ${info.humanWait}.` : "";
    return `Исчерпан бесплатный дневной лимит${lim} для ${model}.${eta} Выберите другую модель ниже или добавьте 2-й бесплатный ключ с новой строки.`;
  }
  if (/quota|rate|429/i.test(String(errText || ""))) {
    const eta = info.humanWait ? ` (${info.humanWait})` : "";
    return `Превышен минутный лимит бесплатного API${eta}. Подождите немного или добавьте 2-й ключ.`;
  }
  return String(errText || "Ошибка API");
}

// Learned API flags per model
const modelCaps = new Map();
const connectedPorts = new Set();

// Batch scheduler state
const pendingTiles = [];
let activeBatches = 0;
let maxConcurrentBatches = 2;
let batchTimer = null;
let manualSnipActive = false;
let targetMaxRpmPerKey = 14;

// Dynamic Referer rules
const refererRules = new Map();
let nextRuleId = 5000;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const toSet = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  if (existing.model && /^gemini-2\./i.test(existing.model)) {
    toSet.model = DEFAULT_MODEL;
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
});

function broadcastStatus(notice) {
  for (const p of connectedPorts) {
    try {
      p.postMessage({ type: "ENGINE_NOTICE", notice });
    } catch (_) {}
  }
}

// =========================================================================
// LONG-LIVED PORT CHANNEL
// =========================================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mat-stream") return;

  let connected = true;
  connectedPorts.add(port);

  port.onDisconnect.addListener(() => {
    connected = false;
    connectedPorts.delete(port);
  });

  const safePost = (payload) => {
    if (!connected) return;
    try {
      port.postMessage(payload);
    } catch (_) {
      connected = false;
      connectedPorts.delete(port);
    }
  };

  port.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "PING") {
      safePost({ type: "PONG" });
      return;
    }
    if (msg.type === "TRANSLATE_IMAGE") {
      handleTranslateImage(msg, (tileBlocks, apiMs) => {
        safePost({
          type: "TILE_BLOCKS",
          reqId: msg.reqId,
          imgId: msg.imgId,
          blocks: tileBlocks,
          elapsedMs: apiMs
        });
      })
        .then((res) => {
          safePost({
            type: "IMAGE_RESULT",
            reqId: msg.reqId,
            imgId: msg.imgId,
            ...res
          });
        })
        .catch((err) => {
          safePost({
            type: "IMAGE_RESULT",
            reqId: msg.reqId,
            imgId: msg.imgId,
            ok: false,
            error: err.message || String(err)
          });
        });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TEST_API_KEY") {
    testAndSyncGeminiKeys(msg.apiKey, msg.model || DEFAULT_MODEL)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "CLEAR_CACHE") {
    translationCache.clear();
    chrome.storage.local.remove(DISK_CACHE_KEY).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_CACHE_STATS") {
    ensureDiskCacheLoaded().then(() => {
      sendResponse({ count: translationCache.size });
    });
    return true;
  }

  if (msg.type === "TRANSLATE_CROP_REGION") {
    const windowId = sender?.tab?.windowId ?? null;
    handleTranslateCropRegion(msg, windowId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});

// =========================================================================
// MULTI-TILE BATCH SCHEDULER
// =========================================================================
function enqueueTileJob(job) {
  return new Promise((resolve, reject) => {
    pendingTiles.push({ ...job, resolve, reject, enqueuedAt: Date.now() });
    pendingTiles.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    scheduleBatchPump();
  });
}

function scheduleBatchPump(explicitDelayMs = null) {
  if (batchTimer) {
    if (explicitDelayMs === null) return;
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  if (pendingTiles.length === 0 || activeBatches >= maxConcurrentBatches || manualSnipActive) {
    return;
  }

  const top = pendingTiles[0];
  const pick = pickBestKeyForModel(top.apiKeys, top.model);
  if (pick && !pick.allDailyExhausted && pick.waitMs > 0) {
    if (pick.waitMs >= 1500) {
      broadcastStatus(`Пауза лимита API: ${Math.ceil(pick.waitMs / 1000)}с…`);
    }
    batchTimer = setTimeout(() => {
      batchTimer = null;
      broadcastStatus("");
      pumpBatches();
    }, pick.waitMs + 60);
    return;
  }

  const targetBatchSize = top.priority < 2 ? 2 : 3;
  let delay = explicitDelayMs;
  if (delay === null) {
    if (pendingTiles.length >= targetBatchSize) delay = 15;
    else delay = top.priority < 2 ? 90 : 240;
  }

  batchTimer = setTimeout(() => {
    batchTimer = null;
    pumpBatches();
  }, delay);
}

function pumpBatches() {
  if (manualSnipActive) return;

  while (activeBatches < maxConcurrentBatches && pendingTiles.length > 0) {
    pendingTiles.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    const first = pendingTiles[0];

    const pick = pickBestKeyForModel(first.apiKeys, first.model);
    if (pick && !pick.allDailyExhausted && pick.waitMs > 0) {
      scheduleBatchPump(pick.waitMs + 60);
      return;
    }

    const maxBatch = first.priority < 2 ? 2 : (first.turboMode ? 4 : 3);
    const batch = [];
    for (let i = 0; i < pendingTiles.length && batch.length < maxBatch; ) {
      const cand = pendingTiles[i];
      if (
        cand.keysSig === first.keysSig &&
        cand.model === first.model &&
        cand.skipSfx === first.skipSfx &&
        cand.turboMode === first.turboMode
      ) {
        batch.push(cand);
        pendingTiles.splice(i, 1);
      } else {
        i++;
      }
    }

    if (batch.length === 0) break;

    activeBatches++;
    runTileBatch(batch).finally(() => {
      activeBatches--;
      scheduleBatchPump();
    });
  }
}

async function runTileBatch(batch) {
  const { apiKeys, model, skipSfx, turboMode } = batch[0];
  const t0 = Date.now();
  try {
    const grouped = await callGeminiVisionBatch(apiKeys, model, batch, skipSfx, turboMode, 0, false);
    const apiMs = Date.now() - t0;
    for (let i = 0; i < batch.length; i++) {
      batch[i].resolve({ items: grouped[i] || [], apiMs });
    }
  } catch (err) {
    for (const job of batch) {
      job.reject(err);
    }
  }
}

function getCaps(model) {
  if (!modelCaps.has(model)) {
    const isGemini25 = /gemini-2\.5/i.test(model);
    const isFlashLite = /lite/i.test(model);
    modelCaps.set(model, {
      thinkingMode: isGemini25 ? "BUDGET0" : isFlashLite ? "MINIMAL" : "LOW",
      useMediaRes: !isGemini25,
      useSchema: true,
      useSysInstr: true
    });
  }
  return modelCaps.get(model);
}

function extractSuggestedModel(errText) {
  if (!errText) return null;
  const m = String(errText).match(/use\s+models\/([a-zA-Z0-9._-]+)/i);
  return m ? m[1] : null;
}

function parseRetryDelayMs(errJson, fallbackMs) {
  try {
    const details = errJson?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d?.retryDelay) {
          const sec = parseFloat(String(d.retryDelay).replace(/s$/i, ""));
          if (!Number.isNaN(sec) && sec > 0) {
            return Math.min(25000, Math.ceil(sec * 1000) + 400);
          }
        }
      }
    }
    const msg = String(errJson?.error?.message || "");
    const m = msg.match(/retry in\s+([\d.]+)\s*s/i);
    if (m) {
      return Math.min(25000, Math.ceil(parseFloat(m[1]) * 1000) + 400);
    }
  } catch (_) {}
  return fallbackMs;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Таймаут сети (${Math.round(timeoutMs / 1000)}с)`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureRefererRule(imgUrl, pageOrigin) {
  if (!chrome.declarativeNetRequest || !pageOrigin) return false;
  try {
    const imgHost = new URL(imgUrl).hostname;
    const key = `${imgHost}|${pageOrigin}`;
    if (refererRules.has(key)) return true;

    const ruleId = nextRuleId++;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: pageOrigin + "/" }
            ]
          },
          condition: {
            urlFilter: `||${imgHost}/`,
            resourceTypes: ["xmlhttprequest", "other"]
          }
        }
      ]
    });
    refererRules.set(key, ruleId);
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchAvailableModels(apiKey) {
  const cleanKey = (apiKey || "").trim();
  if (!cleanKey) return [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100`;
  const resp = await fetchWithTimeout(
    url,
    { headers: { "x-goog-api-key": cleanKey } },
    10000
  );
  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error?.message) errText = j.error.message;
    } catch (_) {}
    const err = new Error(errText);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const raw = Array.isArray(data?.models) ? data.models : [];

  const filtered = raw
    .filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes("generateContent")) return false;
      const id = String(m.name || "").replace(/^models\//, "");
      if (!/^gemini-/i.test(id)) return false;
      if (/(embedding|imagen|veo|tts|audio|live|aqa|robotics|computer-use|image-preview|nano-banana)/i.test(id)) return false;
      return true;
    })
    .map((m) => ({
      id: String(m.name).replace(/^models\//, ""),
      displayName: m.displayName || String(m.name).replace(/^models\//, "")
    }));

  filtered.sort((a, b) => scoreModel(b.id) - scoreModel(a.id));
  return filtered;
}

function scoreModel(id) {
  let score = 0;
  const verMatch = id.match(/gemini-(\d+)(?:\.(\d+))?/i);
  if (verMatch) {
    score += parseInt(verMatch[1], 10) * 1000 + parseInt(verMatch[2] || "0", 10) * 100;
  }
  if (/flash/i.test(id)) score += 100;
  if (/lite/i.test(id)) score += 600;
  if (/exp|preview/i.test(id)) score -= 25;
  if (/pro/i.test(id)) score -= 200;
  return score;
}

async function pingModel(apiKey, model, timeoutMs = 18000) {
  const caps = getCaps(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const generationConfig = { maxOutputTokens: 24, temperature: 0 };
  applyThinkingConfig(generationConfig, caps);

  const t0 = Date.now();
  let resp;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "OK" }] }],
          generationConfig
        })
      },
      timeoutMs
    );
  } catch (e) {
    return { ok: false, timeout: true, error: e.message || "Таймаут сети" };
  }

  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error?.message) errText = j.error.message;
    } catch (_) {}

    if (resp.status === 400 && /thinking/i.test(errText) && downgradeThinking(caps)) {
      return pingModel(apiKey, model, timeoutMs);
    }
    const dailyInfo = parseDailyResetInfo(errText);
    return { ok: false, status: resp.status, isDailyQuota: resp.status === 429 && dailyInfo.isDaily, error: errText };
  }
  return { ok: true, elapsedMs: Date.now() - t0 };
}

async function testAndSyncGeminiKeys(rawKeysText, requestedModel) {
  const keys = parseApiKeys(rawKeysText);
  if (keys.length === 0) {
    return { ok: false, error: "Введите хотя бы один API-ключ." };
  }

  // Reset old session daily exhaustion flags when user explicitly clicks "Сохранить и проверить"
  slotState.clear();

  let activeModel = (requestedModel || DEFAULT_MODEL).trim();
  let availableModels = [];

  try {
    availableModels = await fetchAvailableModels(keys[0]);
    if (availableModels.length > 0) {
      await chrome.storage.local.set({ availableModels });
    }
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 403) {
      return { ok: false, error: `Ключ отклонён (${e.message})` };
    }
    return { ok: false, error: "Нет связи с Google API. Проверьте интернет/VPN и попробуйте снова." };
  }

  // Test all supplied keys against requestedModel
  let workingKeysCount = 0;
  let bestElapsed = null;
  let lastError = "";
  let sawDailyQuota = false;

  for (const k of keys) {
    const res = await pingModel(k, activeModel, 18000);
    if (res.ok) {
      workingKeysCount++;
      if (bestElapsed === null || res.elapsedMs < bestElapsed) bestElapsed = res.elapsedMs;
    } else {
      lastError = res.error;
      if (res.isDailyQuota) {
        sawDailyQuota = true;
        const dInfo = parseDailyResetInfo(res.error);
        getSlot(k, activeModel).dailyExhaustedUntil = Date.now() + dInfo.waitMs;
      }
    }
  }

  if (workingKeysCount > 0) {
    await chrome.storage.local.set({ apiKey: keys.join("\n"), model: activeModel });
    return {
      ok: true,
      activeModel,
      elapsedMs: bestElapsed,
      workingKeysCount,
      totalKeysCount: keys.length,
      availableModels
    };
  }

  // All keys failed on activeModel (e.g. daily 500/day limit exhausted on 3.5-flash-lite).
  // Automatically search for another FREE model that still has fresh daily quota!
  const suggested = extractSuggestedModel(lastError);
  const candidateModels = [
    ...(suggested ? [suggested] : []),
    ...availableModels.map((m) => m.id).filter((id) => /flash/i.test(id))
  ];
  const uniqueModels = [...new Set(candidateModels)].filter((id) => id !== activeModel).slice(0, 5);

  for (const candModel of uniqueModels) {
    const retry = await pingModel(keys[0], candModel, 16000);
    if (retry.ok) {
      await chrome.storage.local.set({ apiKey: keys.join("\n"), model: candModel });
      return {
        ok: true,
        activeModel: candModel,
        switchedFrom: activeModel,
        switchedReason: sawDailyQuota ? "исчерпала дневной лимит" : "не ответила",
        elapsedMs: retry.elapsedMs,
        workingKeysCount: 1,
        totalKeysCount: keys.length,
        availableModels
      };
    }
  }

  return {
    ok: false,
    error: formatQuotaErrorRu(lastError, activeModel),
    availableModels
  };
}

// =========================================================================
// EXPRESS MANUAL CROP TRANSLATOR
// =========================================================================
async function handleTranslateCropRegion(msg, windowId) {
  const { rect, viewportW, viewportH } = msg;
  const stored = await chrome.storage.local.get({ apiKey: "", model: DEFAULT_MODEL });

  const keys = parseApiKeys(stored.apiKey);
  if (keys.length === 0) {
    return { ok: false, error: "Не указан API-ключ Gemini. Откройте иконку расширения." };
  }

  const model = (stored.model || DEFAULT_MODEL).trim();
  const t0 = Date.now();
  manualSnipActive = true;

  try {
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 88 });
    } catch (e) {
      return { ok: false, error: "Не удалось захватить экран: " + e.message };
    }

    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    try {
      const scaleX = bitmap.width / Math.max(1, viewportW);
      const scaleY = bitmap.height / Math.max(1, viewportH);

      const sx = clamp(Math.floor(rect.left * scaleX), 0, bitmap.width - 1);
      const sy = clamp(Math.floor(rect.top * scaleY), 0, bitmap.height - 1);
      const sw = clamp(Math.ceil(rect.width * scaleX), 8, bitmap.width - sx);
      const sh = clamp(Math.ceil(rect.height * scaleY), 8, bitmap.height - sy);

      const maxCropDim = 760;
      const resizeRatio = Math.max(sw, sh) > maxCropDim ? maxCropDim / Math.max(sw, sh) : 1;
      const outW = Math.max(8, Math.round(sw * resizeRatio));
      const outH = Math.max(8, Math.round(sh * resizeRatio));

      const canvas = new OffscreenCanvas(outW, outH);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);

      const imgData = ctx.getImageData(0, 0, outW, outH);
      const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.80 });
      const base64 = await blobToBase64(jpegBlob);

      const grouped = await callGeminiVisionBatch(keys, model, [{ base64 }], false, true, 0, true);
      const rawItems = grouped[0] || [];
      const blocks = buildBlocksFromItems(rawItems, imgData, { y: 0, h: outH }, outW, outH, true);

      const elapsedMs = Date.now() - t0;
      if (blocks.length === 0) {
        return { ok: false, error: "Текст в выделенной области не найден", elapsedMs };
      }

      const cropColors = sampleBoxColors(imgData, 2, 2, outW - 3, outH - 3, blocks[0].style || "white_bubble");
      return { ok: true, blocks, cropColors, elapsedMs };
    } finally {
      bitmap.close();
    }
  } finally {
    manualSnipActive = false;
    scheduleBatchPump(50);
  }
}

// =========================================================================
// IMAGE DOWNLOAD, SMART SEAM SLICING & TRANSLATION
// =========================================================================
async function downloadImageBlob(imgUrl, pageOrigin, fallbackDataUrl) {
  if (fallbackDataUrl) {
    return await (await fetch(fallbackDataUrl)).blob();
  }

  try {
    const res = await fetchWithTimeout(imgUrl, { credentials: "include" }, 9000);
    if (res.ok) return await res.blob();

    if ((res.status === 403 || res.status === 401) && pageOrigin) {
      const added = await ensureRefererRule(imgUrl, pageOrigin);
      if (added) {
        const retry = await fetchWithTimeout(imgUrl, { credentials: "include" }, 9000);
        if (retry.ok) return await retry.blob();
      }
    }

    const res2 = await fetchWithTimeout(imgUrl, { credentials: "omit" }, 8000);
    if (res2.ok) return await res2.blob();

    const err = new Error(`HTTP ${res.status}`);
    err.code = "NEED_CANVAS_FALLBACK";
    throw err;
  } catch (e) {
    if (!e.code) e.code = "NEED_CANVAS_FALLBACK";
    throw e;
  }
}

function findSmartTilesFromBitmap(bitmap, origW, origH, scaledW, scaledH, maxTileH) {
  if (scaledH <= maxTileH + 340) {
    return [{ idx: 0, y: 0, h: scaledH }];
  }

  const scale = scaledW / origW;
  const tiles = [];
  let curY = 0;
  let idx = 0;
  const probeW = Math.min(240, scaledW);

  while (curY < scaledH) {
    const remaining = scaledH - curY;
    if (remaining <= maxTileH + 300) {
      tiles.push({ idx: idx++, y: curY, h: remaining });
      break;
    }

    const idealCut = curY + maxTileH;
    const searchTop = Math.max(curY + Math.floor(maxTileH * 0.72), idealCut - 210);
    const searchBot = Math.min(scaledH - 160, idealCut + 170);
    const searchH = searchBot - searchTop;

    let bestCut = idealCut;
    let foundCleanSeam = false;

    if (searchH > 24) {
      const probeCanvas = new OffscreenCanvas(probeW, searchH);
      const pctx = probeCanvas.getContext("2d", { willReadFrequently: true });
      pctx.drawImage(bitmap, 0, searchTop / scale, origW, searchH / scale, 0, 0, probeW, searchH);
      const strip = pctx.getImageData(0, 0, probeW, searchH).data;

      let bestScore = Infinity;
      const stepX = Math.max(2, Math.floor(probeW / 48));

      for (let ry = 0; ry < searchH; ry += 2) {
        let sum = 0, sumSq = 0, count = 0;
        const rowOff = ry * probeW * 4;
        for (let x = 4; x < probeW - 4; x += stepX) {
          const i = rowOff + x * 4;
          const lum = 0.299 * strip[i] + 0.587 * strip[i + 1] + 0.114 * strip[i + 2];
          sum += lum;
          sumSq += lum * lum;
          count++;
        }
        const mean = sum / count;
        const variance = Math.max(0, sumSq / count - mean * mean);
        const distPenalty = Math.abs((searchTop + ry) - idealCut) * 0.015;
        const score = variance + distPenalty;
        if (score < bestScore) {
          bestScore = score;
          bestCut = searchTop + ry;
        }
      }

      if (bestScore < 68) foundCleanSeam = true;
    }

    tiles.push({ idx: idx++, y: curY, h: bestCut - curY });
    curY = foundCleanSeam ? bestCut : Math.max(curY + 350, bestCut - 140);
  }

  return tiles;
}

async function handleTranslateImage(msg, onTileReady) {
  await ensureDiskCacheLoaded();

  const { imgUrl, pageOrigin, priority = 0, fallbackDataUrl, forceFresh = false, settings } = msg;
  const latest = await chrome.storage.local.get({ apiKey: "", model: DEFAULT_MODEL, turboMode: true });
  const apiKeys = parseApiKeys(latest.apiKey || settings?.apiKey || "");
  if (apiKeys.length === 0) {
    return { ok: false, code: "NO_KEY", error: "Нет API-ключа Gemini" };
  }

  const model = (latest.model || settings?.model || DEFAULT_MODEL).trim();
  const turboMode = latest.turboMode !== false;
  const skipSfx = settings?.skipSfx !== false;
  // Cache key independent of model name so switching models still reuses already-translated chapters!
  const cacheKey = `${imgUrl}|${skipSfx ? "1" : "0"}`;

  if (!forceFresh && translationCache.has(cacheKey)) {
    return { ok: true, blocks: translationCache.get(cacheKey), cached: true, elapsedMs: 0 };
  }

  let blob;
  try {
    blob = await downloadImageBlob(imgUrl, pageOrigin, fallbackDataUrl);
  } catch (e) {
    return { ok: false, code: e.code || "DOWNLOAD_ERR", error: e.message };
  }

  if (!blob || blob.size < 1800) {
    return { ok: true, blocks: [], elapsedMs: 0 };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return { ok: false, error: "Ошибка картинки: " + e.message };
  }

  const origW = bitmap.width;
  const origH = bitmap.height;

  if (origW < 220 || origH < 140) {
    bitmap.close();
    return { ok: true, blocks: [], elapsedMs: 0 };
  }

  const MAX_WIDTH = turboMode ? 720 : 960;
  const JPEG_QUALITY = turboMode ? 0.72 : 0.84;
  const MAX_TILE_H = turboMode ? 1700 : 1400;

  const scale = origW > MAX_WIDTH ? MAX_WIDTH / origW : 1;
  const scaledW = Math.round(origW * scale);
  const scaledH = Math.round(origH * scale);

  const preparedTiles = [];
  try {
    const tiles = findSmartTilesFromBitmap(bitmap, origW, origH, scaledW, scaledH, MAX_TILE_H);

    for (const tile of tiles) {
      const canvas = new OffscreenCanvas(scaledW, tile.h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, tile.y / scale, origW, tile.h / scale, 0, 0, scaledW, tile.h);

      const imgData = ctx.getImageData(0, 0, scaledW, tile.h);
      if (isBlankTile(imgData)) continue;

      const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
      const base64 = await blobToBase64(jpegBlob);
      preparedTiles.push({ tile, imgData, base64 });
    }
  } finally {
    bitmap.close();
  }

  if (preparedTiles.length === 0) {
    cacheSet(cacheKey, []);
    return { ok: true, blocks: [], elapsedMs: 0 };
  }

  const keysSig = apiKeys.join("|");
  const allBlocks = [];
  let failedTiles = 0;
  let firstError = null;
  let lastApiMs = 0;

  await Promise.all(
    preparedTiles.map(({ tile, imgData, base64 }) =>
      enqueueTileJob({
        apiKeys,
        keysSig,
        model,
        skipSfx,
        turboMode,
        base64,
        priority: priority + tile.idx * 0.05
      })
        .then(({ items, apiMs }) => {
          lastApiMs = apiMs;
          const tileBlocks = buildBlocksFromItems(items, imgData, tile, scaledW, scaledH, false);
          const newlyAdded = [];
          for (const b of tileBlocks) {
            if (!isDuplicateBlock(allBlocks, b)) {
              allBlocks.push(b);
              newlyAdded.push(b);
            }
          }
          if (onTileReady && newlyAdded.length > 0 && preparedTiles.length > 1) {
            onTileReady(newlyAdded, apiMs);
          }
        })
        .catch((err) => {
          failedTiles++;
          if (!firstError) firstError = err;
        })
    )
  );

  if (failedTiles > 0) {
    if (allBlocks.length > 0) {
      return {
        ok: true,
        partial: true,
        blocks: allBlocks,
        warning: firstError ? firstError.message : "Часть полосы не загрузилась",
        elapsedMs: lastApiMs
      };
    }
    return { ok: false, code: firstError?.code, error: (firstError && firstError.message) || "Ошибка нейросети" };
  }

  cacheSet(cacheKey, allBlocks);
  return { ok: true, blocks: allBlocks, elapsedMs: lastApiMs };
}

function isBlankTile(imgData) {
  const { data, width, height } = imgData;
  const stepX = Math.max(8, Math.floor(width / 24));
  const stepY = Math.max(8, Math.floor(height / 32));

  let minLum = 255, maxLum = 0;
  for (let y = 4; y < height - 4; y += stepY) {
    for (let x = 4; x < width - 4; x += stepX) {
      const idx = (y * width + x) * 4;
      const lum = (data[idx] * 3 + data[idx + 1] * 6 + data[idx + 2]) / 10;
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
      if (maxLum - minLum > 35) return false;
    }
  }
  return true;
}

// =========================================================================
// PIXEL-AWARE BUBBLE & NARRATION BOX EXPANDER
// =========================================================================
function analyzeBubbleLine(imgData, y, x1, x2, isDarkBubble) {
  const { data, width } = imgData;
  const pad = Math.floor((x2 - x1) * 0.14);
  const ix1 = clamp(x1 + pad, 0, width - 1);
  const ix2 = clamp(x2 - pad, ix1 + 1, width);
  const n = ix2 - ix1;
  if (n < 6) return { bg: 0, ink: 0, colored: 1, maxInkRun: 1 };

  let bg = 0, ink = 0, colored = 0, curRun = 0, maxRun = 0;
  const rowOff = y * width * 4;

  for (let x = ix1; x < ix2; x++) {
    const i = rowOff + x * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);

    if (sat > 32) colored++;
    const isBg = isDarkBubble ? (lum < 60 && sat < 30) : (lum > 212 && sat < 28);
    const isInk = isDarkBubble ? (lum > 150 && sat < 48) : (lum < 148 && sat < 42);

    if (isBg) bg++;
    if (isInk) {
      ink++;
      curRun++;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curRun = 0;
    }
  }

  return { bg: bg / n, ink: ink / n, colored: colored / n, maxInkRun: maxRun / n };
}

function analyzeBubbleCol(imgData, x, y1, y2, isDarkBubble) {
  const { data, width, height } = imgData;
  const pad = Math.floor((y2 - y1) * 0.14);
  const iy1 = clamp(y1 + pad, 0, height - 1);
  const iy2 = clamp(y2 - pad, iy1 + 1, height);
  const n = iy2 - iy1;
  if (n < 6) return { bg: 0, ink: 0, colored: 1, maxInkRun: 1 };

  let bg = 0, ink = 0, colored = 0, curRun = 0, maxRun = 0;

  for (let y = iy1; y < iy2; y++) {
    const i = (y * width + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);

    if (sat > 32) colored++;
    const isBg = isDarkBubble ? (lum < 60 && sat < 30) : (lum > 212 && sat < 28);
    const isInk = isDarkBubble ? (lum > 150 && sat < 48) : (lum < 148 && sat < 42);

    if (isBg) bg++;
    if (isInk) {
      ink++;
      curRun++;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      curRun = 0;
    }
  }

  return { bg: bg / n, ink: ink / n, colored: colored / n, maxInkRun: maxRun / n };
}

function detectBoxLuminance(imgData, bx1, by1, bx2, by2) {
  const { data, width, height } = imgData;
  const lums = [];
  const sample = (x, y) => {
    const i = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    lums.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  };
  for (let t = 0; t <= 8; t++) {
    const f = t / 8;
    const px = Math.round(bx1 + (bx2 - bx1) * f);
    const py = Math.round(by1 + (by2 - by1) * f);
    sample(px, by1 + 2);
    sample(px, by2 - 2);
    sample(bx1 + 2, py);
    sample(bx2 - 2, py);
  }
  lums.sort((a, b) => a - b);
  return lums[Math.floor(lums.length / 2)] || 255;
}

function expandBubbleBox(imgData, bx1, by1, bx2, by2, style) {
  if (style === "system_box") return [bx1, by1, bx2, by2];

  const { width, height } = imgData;
  const lum = detectBoxLuminance(imgData, bx1, by1, bx2, by2);
  let isDark;
  if (style === "black_bubble") isDark = true;
  else if (style === "white_bubble") isDark = false;
  else {
    if (lum < 72) isDark = true;
    else if (lum > 195) isDark = false;
    else return [bx1, by1, bx2, by2];
  }

  const boxW = Math.max(12, bx2 - bx1);
  const boxH = Math.max(12, by2 - by1);
  const isNarration = style === "narration";
  const maxVertExpand = Math.min(120, Math.round(boxH * 0.60));
  const maxHorizExpand = Math.min(isNarration ? 200 : 90, Math.round(boxW * (isNarration ? 0.90 : 0.40)));
  const maxGapY = Math.max(12, Math.round(width * 0.024));
  const maxGapX = Math.max(isNarration ? 22 : 12, Math.round(width * (isNarration ? 0.040 : 0.020)));

  let newY2 = by2, lastTextY = by2, gap = 0;
  for (let y = by2 + 1; y < Math.min(height - 2, by2 + maxVertExpand); y++) {
    const s = analyzeBubbleLine(imgData, y, bx1, bx2, isDark);
    if (s.colored > 0.14 || s.maxInkRun > 0.30 || s.bg + s.ink < 0.42) break;
    if (s.ink >= 0.025) { lastTextY = y; gap = 0; }
    else if (s.bg > 0.80) { if (++gap > maxGapY) break; }
    else break;
  }
  if (lastTextY > by2) newY2 = Math.min(height - 2, lastTextY + 6);

  let newY1 = by1;
  lastTextY = by1; gap = 0;
  for (let y = by1 - 1; y > Math.max(1, by1 - maxVertExpand); y--) {
    const s = analyzeBubbleLine(imgData, y, bx1, bx2, isDark);
    if (s.colored > 0.14 || s.maxInkRun > 0.30 || s.bg + s.ink < 0.42) break;
    if (s.ink >= 0.025) { lastTextY = y; gap = 0; }
    else if (s.bg > 0.80) { if (++gap > maxGapY) break; }
    else break;
  }
  if (lastTextY < by1) newY1 = Math.max(1, lastTextY - 6);

  let newX1 = bx1, lastTextX = bx1;
  gap = 0;
  for (let x = bx1 - 1; x > Math.max(1, bx1 - maxHorizExpand); x--) {
    const s = analyzeBubbleCol(imgData, x, newY1, newY2, isDark);
    if (s.colored > 0.14 || s.maxInkRun > 0.30 || s.bg + s.ink < 0.42) break;
    if (s.ink >= 0.02) { lastTextX = x; gap = 0; }
    else if (s.bg > 0.80) { if (++gap > maxGapX) break; }
    else break;
  }
  if (lastTextX < bx1) newX1 = Math.max(1, lastTextX - 6);

  let newX2 = bx2;
  lastTextX = bx2; gap = 0;
  for (let x = bx2 + 1; x < Math.min(width - 2, bx2 + maxHorizExpand); x++) {
    const s = analyzeBubbleCol(imgData, x, newY1, newY2, isDark);
    if (s.colored > 0.14 || s.maxInkRun > 0.30 || s.bg + s.ink < 0.42) break;
    if (s.ink >= 0.02) { lastTextX = x; gap = 0; }
    else if (s.bg > 0.80) { if (++gap > maxGapX) break; }
    else break;
  }
  if (lastTextX > bx2) newX2 = Math.min(width - 2, lastTextX + 6);

  return [newX1, newY1, newX2, newY2];
}

function buildBlocksFromItems(rawItems, imgData, tile, scaledW, scaledH, isManualCrop = false) {
  const blocks = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) return blocks;

  for (const item of rawItems) {
    if (!item) continue;
    const rawBox = item.b || item.box_2d;
    const rawText = item.t !== undefined ? item.t : item.ru;
    const rawStyle = item.s || item.style || "w";

    if (!Array.isArray(rawBox) || rawBox.length !== 4) continue;
    const ru = String(rawText || "").trim();
    if (!ru) continue;

    let [ymin, xmin, ymax, xmax] = rawBox.map((n) => Number(n));
    if ([ymin, xmin, ymax, xmax].some((n) => Number.isNaN(n))) continue;

    ymin = clamp(ymin, 0, 1000);
    xmin = clamp(xmin, 0, 1000);
    ymax = clamp(ymax, 0, 1000);
    xmax = clamp(xmax, 0, 1000);
    if (ymax - ymin < 6 || xmax - xmin < 10) continue;

    const padY = isManualCrop ? 18 : 14;
    const padX = isManualCrop ? 18 : 16;
    const pyMin = clamp(ymin - padY, 0, 1000);
    const pxMin = clamp(xmin - padX, 0, 1000);
    const pyMax = clamp(ymax + padY, 0, 1000);
    const pxMax = clamp(xmax + padX, 0, 1000);

    let bx1 = Math.floor((pxMin / 1000) * scaledW);
    let by1 = Math.floor((pyMin / 1000) * tile.h);
    let bx2 = Math.min(scaledW - 1, Math.ceil((pxMax / 1000) * scaledW));
    let by2 = Math.min(tile.h - 1, Math.ceil((pyMax / 1000) * tile.h));

    const style = STYLE_MAP[rawStyle] || "white_bubble";
    [bx1, by1, bx2, by2] = expandBubbleBox(imgData, bx1, by1, bx2, by2, style);

    const sampled = sampleBoxColors(imgData, bx1, by1, bx2, by2, style);
    const absTopPx = tile.y + by1;
    const absBotPx = tile.y + by2;

    blocks.push({
      topPct: (absTopPx / scaledH) * 100,
      leftPct: (bx1 / scaledW) * 100,
      widthPct: ((bx2 - bx1) / scaledW) * 100,
      heightPct: ((absBotPx - absTopPx) / scaledH) * 100,
      ru,
      style,
      bgColor: sampled.bgColor,
      fgColor: sampled.fgColor,
      shadowColor: sampled.shadowColor,
      isDark: sampled.isDark
    });
  }
  return blocks;
}

function isDuplicateBlock(existing, candidate) {
  for (const b of existing) {
    const xOverlap = Math.max(0, Math.min(b.leftPct + b.widthPct, candidate.leftPct + candidate.widthPct) - Math.max(b.leftPct, candidate.leftPct));
    const yOverlap = Math.max(0, Math.min(b.topPct + b.heightPct, candidate.topPct + candidate.heightPct) - Math.max(b.topPct, candidate.topPct));
    const interArea = xOverlap * yOverlap;
    const minArea = Math.min(b.widthPct * b.heightPct, candidate.widthPct * candidate.heightPct);
    if (minArea > 0 && interArea / minArea > 0.42) return true;
  }
  return false;
}

function sampleBoxColors(imgData, x1, y1, x2, y2, style) {
  const { data, width, height } = imgData;
  const rs = [], gs = [], bs = [];

  const samplePoint = (x, y) => {
    const cx = clamp(x, 0, width - 1);
    const cy = clamp(y, 0, height - 1);
    const idx = (cy * width + cx) * 4;
    rs.push(data[idx]);
    gs.push(data[idx + 1]);
    bs.push(data[idx + 2]);
  };

  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = Math.round(x1 + (x2 - x1) * t);
    const py = Math.round(y1 + (y2 - y1) * t);
    samplePoint(px, y1 + 1);
    samplePoint(px, y2 - 1);
    samplePoint(x1 + 1, py);
    samplePoint(x2 - 1, py);
  }

  const median = (arr) => {
    if (!arr.length) return 255;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const r = median(rs), g = median(gs), b = median(bs);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;

  if (style === "system_box") {
    const isLight = lum > 185;
    return {
      bgColor: `rgba(${r}, ${g}, ${b}, 0.94)`,
      shadowColor: `rgba(${r}, ${g}, ${b}, 0.72)`,
      fgColor: isLight ? "#0f172a" : "#ffffff",
      isDark: !isLight
    };
  }

  if (style === "black_bubble" || (style === "narration" && lum < 80) || lum < 85) {
    const dr = Math.min(r, 24), dg = Math.min(g, 24), db = Math.min(b, 28);
    return {
      bgColor: `rgb(${dr}, ${dg}, ${db})`,
      shadowColor: `rgba(${dr}, ${dg}, ${db}, 0.96)`,
      fgColor: "#f8fafc",
      isDark: true
    };
  }

  if (style === "white_bubble" || lum > 175) {
    const lr = Math.max(r, 246), lg = Math.max(g, 246), lb = Math.max(b, 248);
    return {
      bgColor: `rgb(${lr}, ${lg}, ${lb})`,
      shadowColor: `rgba(${lr}, ${lg}, ${lb}, 0.98)`,
      fgColor: "#111318",
      isDark: false
    };
  }

  const isDark = lum < 140;
  return {
    bgColor: `rgba(${r}, ${g}, ${b}, 0.98)`,
    shadowColor: `rgba(${r}, ${g}, ${b}, 0.92)`,
    fgColor: isDark ? "#ffffff" : "#111318",
    isDark
  };
}

function applyThinkingConfig(generationConfig, caps) {
  if (caps.thinkingMode === "MINIMAL") {
    generationConfig.thinkingConfig = { thinkingLevel: "MINIMAL" };
  } else if (caps.thinkingMode === "LOW") {
    generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
  } else if (caps.thinkingMode === "BUDGET0") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
}

function downgradeThinking(caps) {
  if (caps.thinkingMode === "MINIMAL") { caps.thinkingMode = "LOW"; return true; }
  if (caps.thinkingMode === "LOW" || caps.thinkingMode === "BUDGET0") { caps.thinkingMode = "NONE"; return true; }
  return false;
}

// =========================================================================
// MULTI-IMAGE, MULTI-KEY GEMINI VISION CALL WITH SMART QUOTA FAILOVER
// =========================================================================
async function callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt = 0, isManualCrop = false) {
  const pick = pickBestKeyForModel(apiKeys, model);
  if (!pick) throw new Error("Нет API-ключа Gemini");

  if (pick.allDailyExhausted) {
    // Try automatic fallback to another Flash model on disk if available!
    const stored = await chrome.storage.local.get({ availableModels: [] });
    const altModels = (stored.availableModels || [])
      .map((m) => m.id)
      .filter((id) => id !== model && /flash/i.test(id));
    for (const alt of altModels) {
      const altPick = pickBestKeyForModel(apiKeys, alt);
      if (altPick && !altPick.allDailyExhausted) {
        broadcastStatus(`Дневной лимит ${model} → ${alt}`);
        await chrome.storage.local.set({ model: alt });
        return callGeminiVisionBatch(apiKeys, alt, batchItems, skipSfx, turboMode, attempt, isManualCrop);
      }
    }
    const err = new Error(`Дневной лимит (500/день) исчерпан на всех ключах. Добавьте новый ключ в расширении.`);
    err.code = "DAILY_QUOTA";
    throw err;
  }

  const apiKey = pick.key;
  const slot = getSlot(apiKey, model);
  const caps = getCaps(model);
  const count = batchItems.length;

  const taskLine = isManualCrop
    ? "Переведи ВЕСЬ текст на IMG 0 в компактный JSON (i=0)."
    : skipSfx
      ? `Переведи все диалоги, мысли, крики и системные окна на всех ${count} изображениях (IMG 0..IMG ${count - 1}). Пропускай только рисованные звуки (KRRACK/BOOM) и водяные знаки сайтов.`
      : `Переведи весь видимый английский текст на всех ${count} изображениях (IMG 0..IMG ${count - 1}), кроме водяных знаков сайтов.`;

  const parts = [
    { text: caps.useSysInstr ? taskLine : (MANHWA_SYSTEM_PROMPT + "\n\n" + taskLine) }
  ];

  for (let i = 0; i < count; i++) {
    parts.push({ text: `--- IMG ${i} ---` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: batchItems[i].base64 } });
  }

  const generationConfig = {
    temperature: 0.12,
    maxOutputTokens: Math.min(4096, 1200 * count),
    responseMimeType: "application/json"
  };

  applyThinkingConfig(generationConfig, caps);

  if (caps.useMediaRes) {
    generationConfig.mediaResolution = (!isManualCrop && turboMode)
      ? "MEDIA_RESOLUTION_MEDIUM"
      : "MEDIA_RESOLUTION_HIGH";
  }

  if (caps.useSchema) {
    generationConfig.responseSchema = {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          i: { type: "INTEGER" },
          b: { type: "ARRAY", items: { type: "INTEGER" } },
          t: { type: "STRING" },
          s: { type: "STRING", enum: ["w", "k", "s", "n"] }
        },
        required: ["i", "b", "t", "s"]
      }
    };
  }

  const body = {
    contents: [{ parts }],
    generationConfig,
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  if (caps.useSysInstr) {
    body.systemInstruction = { parts: [{ text: MANHWA_SYSTEM_PROMPT }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  slot.calls.push(Date.now());
  pruneSlotCalls(slot);

  let resp;
  try {
    resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body)
      },
      isManualCrop ? 15000 : (18000 + count * 3000)
    );
  } catch (netErr) {
    if (attempt < 2) {
      await sleep(600);
      return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
    }
    throw netErr;
  }

  if (resp.status === 429) {
    let errJson = null;
    try { errJson = await resp.json(); } catch (_) {}
    const errMsg = errJson?.error?.message || "";
    const dailyInfo = parseDailyResetInfo(errMsg);

    if (dailyInfo.isDaily) {
      // Mark THIS key+model as exhausted for the day and immediately fail over to next key or model!
      slot.dailyExhaustedUntil = Date.now() + dailyInfo.waitMs;
      const nextPick = pickBestKeyForModel(apiKeys, model);
      if (nextPick && !nextPick.allDailyExhausted && attempt < apiKeys.length + 1) {
        broadcastStatus("Лимит ключа #1 → переключение на запасной ключ…");
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
      // No keys left for this model -> trigger model failover once
      if (attempt < apiKeys.length + 2) {
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
      const err = new Error(formatQuotaErrorRu(errMsg, model));
      err.code = "DAILY_QUOTA";
      throw err;
    }

    // Minute RPM limit: cool down this specific key, and if user has another key, rotate immediately!
    const waitMs = parseRetryDelayMs(errJson, Math.min(18000, (attempt + 1) * 4500));
    slot.cooldownUntil = Math.max(slot.cooldownUntil, Date.now() + waitMs);
    targetMaxRpmPerKey = Math.max(6, targetMaxRpmPerKey - 2);
    if (apiKeys.length === 1) maxConcurrentBatches = 1;

    const otherPick = pickBestKeyForModel(apiKeys, model);
    if (otherPick && !otherPick.allDailyExhausted && otherPick.waitMs === 0 && attempt < 4) {
      return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
    }

    if (attempt < 3) {
      broadcastStatus(`Лимит API/мин: ждём ${Math.ceil(waitMs / 1000)}с…`);
      await sleep(waitMs);
      broadcastStatus("");
      return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
    }
    throw new Error(formatQuotaErrorRu(errMsg, model));
  }

  if (!resp.ok) {
    let errMsg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      if (j?.error?.message) errMsg = j.error.message;
    } catch (_) {}

    const suggested = extractSuggestedModel(errMsg);
    if (suggested && suggested !== model && attempt < 2) {
      await chrome.storage.local.set({ model: suggested });
      return callGeminiVisionBatch(apiKeys, suggested, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
    }

    if (resp.status === 400 && attempt < 5) {
      const lowErr = errMsg.toLowerCase();
      if (lowErr.includes("thinking") && downgradeThinking(caps)) {
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
      if ((lowErr.includes("media_resolution") || lowErr.includes("mediaresolution")) && caps.useMediaRes) {
        caps.useMediaRes = false;
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
      if (lowErr.includes("system") && caps.useSysInstr) {
        caps.useSysInstr = false;
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
      if (lowErr.includes("schema") && caps.useSchema) {
        caps.useSchema = false;
        return callGeminiVisionBatch(apiKeys, model, batchItems, skipSfx, turboMode, attempt + 1, isManualCrop);
      }
    }

    throw new Error(errMsg);
  }

  // Smooth recovery on success
  if (Date.now() > slot.cooldownUntil + 18000) {
    maxConcurrentBatches = Math.min(3, Math.max(2, apiKeys.length));
    if (targetMaxRpmPerKey < 14) targetMaxRpmPerKey++;
  }

  const json = await resp.json();
  const respParts = json?.candidates?.[0]?.content?.parts || [];
  const text = respParts
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("\n")
    .trim();

  const grouped = Array.from({ length: count }, () => []);
  if (!text) return grouped;

  let parsed = [];
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch (__) {}
    }
  }

  if (!Array.isArray(parsed)) return grouped;

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    let idx = count === 1 ? 0 : Number(item.i);
    if (Number.isNaN(idx) || idx < 0 || idx >= count) {
      if (count === 1) idx = 0;
      else continue;
    }
    grouped[idx].push(item);
  }

  return grouped;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
