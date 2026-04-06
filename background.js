import {
  DEFAULT_SETTINGS,
  buildOrderedItems,
  chunkItems,
  planWindowsByGroup,
  summarizeCounts,
  classifyTab
} from "./organizer-core.js";

const EXTENSION_ROOT = chrome.runtime.getURL("");
const LAST_SESSION_KEY = "lastSessionSnapshot";
const AUTO_ORGANIZE_ALARM = "auto-organize-alarm";
const READ_LATER_KEY = "readLaterItems";

async function getSettings(overrides = {}) {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored, ...overrides };
}

async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

function isManagedTab(tab, settings) {
  if (!tab || typeof tab.id !== "number") return false;
  if (!settings.includePinned && tab.pinned) return false;
  if ((tab.url || "").startsWith(EXTENSION_ROOT)) return false;
  return true;
}

function isSessionTab(tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if ((tab.url || "").startsWith(EXTENSION_ROOT)) return false;
  return true;
}

async function queryEligibleTabs(settings) {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => isManagedTab(tab, settings));
}

function normalizeRestoreUrl(url) {
  if (typeof url !== "string") return "chrome://newtab/";
  if (/^(https?:|file:|chrome:\/\/newtab\/)/i.test(url)) return url;
  return "chrome://newtab/";
}

async function snapshotCurrentSession() {
  const tabs = await chrome.tabs.query({});
  const sessionTabs = tabs
    .filter(isSessionTab)
    .sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    });

  const byWindow = new Map();
  for (const tab of sessionTabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push({
      url: normalizeRestoreUrl(tab.url),
      pinned: !!tab.pinned,
      active: !!tab.active,
      title: tab.title || ""
    });
  }

  return {
    capturedAt: new Date().toISOString(),
    windows: Array.from(byWindow.values())
  };
}

async function backupCurrentSession() {
  const snapshot = await snapshotCurrentSession();
  await chrome.storage.local.set({ [LAST_SESSION_KEY]: snapshot });
  return snapshot;
}

async function getLastSessionInfo() {
  const data = await chrome.storage.local.get(LAST_SESSION_KEY);
  const snapshot = data[LAST_SESSION_KEY];
  if (!snapshot || !Array.isArray(snapshot.windows)) return null;

  const totalTabs = snapshot.windows.reduce((sum, windowTabs) => sum + windowTabs.length, 0);
  return {
    capturedAt: snapshot.capturedAt,
    windows: snapshot.windows.length,
    tabs: totalTabs
  };
}

function normalizeUrlForReadLater(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}

async function getReadLaterItems() {
  const data = await chrome.storage.local.get(READ_LATER_KEY);
  const items = Array.isArray(data[READ_LATER_KEY]) ? data[READ_LATER_KEY] : [];
  items.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
  return { items };
}

async function addReadLaterItem(payload = {}) {
  const url = normalizeUrlForReadLater(payload.url);
  if (!url) {
    throw new Error("Invalid URL");
  }

  const data = await chrome.storage.local.get(READ_LATER_KEY);
  const existing = Array.isArray(data[READ_LATER_KEY]) ? data[READ_LATER_KEY] : [];
  const canonical = normalizeUrlForReadLater(url);
  const now = Date.now();

  const filtered = existing.filter((item) => normalizeUrlForReadLater(item.url) !== canonical);
  const nextItem = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(payload.title || "Untitled"),
    url,
    addedAt: now
  };

  const next = [nextItem, ...filtered].slice(0, 200);
  await chrome.storage.local.set({ [READ_LATER_KEY]: next });
  return { item: nextItem, total: next.length };
}

async function removeReadLaterItem(itemId) {
  const data = await chrome.storage.local.get(READ_LATER_KEY);
  const existing = Array.isArray(data[READ_LATER_KEY]) ? data[READ_LATER_KEY] : [];
  const next = existing.filter((item) => item.id !== itemId);
  await chrome.storage.local.set({ [READ_LATER_KEY]: next });
  return { total: next.length };
}

async function openReadLaterItem(itemId) {
  const data = await chrome.storage.local.get(READ_LATER_KEY);
  const existing = Array.isArray(data[READ_LATER_KEY]) ? data[READ_LATER_KEY] : [];
  const item = existing.find((entry) => entry.id === itemId);
  if (!item) {
    throw new Error("Saved item not found");
  }

  await chrome.tabs.create({ url: item.url });
  return { opened: true, itemId };
}

async function clearReadLaterItems() {
  await chrome.storage.local.set({ [READ_LATER_KEY]: [] });
  return { total: 0 };
}

async function restoreLastSession() {
  const data = await chrome.storage.local.get(LAST_SESSION_KEY);
  const snapshot = data[LAST_SESSION_KEY];
  if (!snapshot || !Array.isArray(snapshot.windows) || snapshot.windows.length === 0) {
    throw new Error("No saved session available to restore");
  }

  const currentTabs = await chrome.tabs.query({});
  const currentSessionTabIds = currentTabs.filter(isSessionTab).map((tab) => tab.id);
  if (currentSessionTabIds.length) {
    await chrome.tabs.remove(currentSessionTabIds);
  }

  let restoredTabs = 0;
  let restoredWindows = 0;

  for (let i = 0; i < snapshot.windows.length; i += 1) {
    const windowTabs = snapshot.windows[i];
    if (!Array.isArray(windowTabs) || windowTabs.length === 0) continue;

    const createdWindow = await chrome.windows.create({ url: "chrome://newtab/", focused: i === 0 });
    const seedTabs = await chrome.tabs.query({ windowId: createdWindow.id });
    const seedTabId = seedTabs[0]?.id;

    const createdTabs = [];
    for (let tabIndex = 0; tabIndex < windowTabs.length; tabIndex += 1) {
      const spec = windowTabs[tabIndex];
      const createdTab = await chrome.tabs.create({
        windowId: createdWindow.id,
        url: normalizeRestoreUrl(spec.url),
        index: tabIndex,
        active: false
      });
      createdTabs.push({ id: createdTab.id, pinned: !!spec.pinned, active: !!spec.active });
    }

    if (typeof seedTabId === "number") {
      await chrome.tabs.remove(seedTabId).catch(() => {});
    }

    for (const created of createdTabs) {
      if (created.pinned) {
        await chrome.tabs.update(created.id, { pinned: true });
      }
    }

    const activeTab = createdTabs.find((tab) => tab.active) || createdTabs[0];
    if (activeTab) {
      await chrome.tabs.update(activeTab.id, { active: true });
    }

    restoredTabs += createdTabs.length;
    restoredWindows += 1;
  }

  return { restoredTabs, restoredWindows };
}

function computeNextScheduleWhen(settings) {
  const now = new Date();
  const mode = settings.scheduleMode;

  if (mode === "off") return null;

  if (mode === "hourly") {
    const hours = Math.min(168, Math.max(1, Number(settings.scheduleIntervalHours) || 24));
    return now.getTime() + hours * 60 * 60 * 1000;
  }

  const [hourText, minuteText] = String(settings.scheduleTime || "09:00").split(":");
  const hour = Math.min(23, Math.max(0, Number(hourText) || 9));
  const minute = Math.min(59, Math.max(0, Number(minuteText) || 0));

  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  if (mode === "daily") {
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }

  if (mode === "weekly") {
    const weekday = Math.min(6, Math.max(0, Number(settings.scheduleWeekday) || 1));
    const currentDay = next.getDay();
    let delta = weekday - currentDay;
    if (delta < 0 || (delta === 0 && next.getTime() <= now.getTime())) {
      delta += 7;
    }
    next.setDate(next.getDate() + delta);
    return next.getTime();
  }

  return null;
}

async function configureAutoSchedule(settings) {
  await chrome.alarms.clear(AUTO_ORGANIZE_ALARM);

  const when = computeNextScheduleWhen(settings);
  if (!when) return { enabled: false };

  await chrome.alarms.create(AUTO_ORGANIZE_ALARM, { when });
  return { enabled: true, nextRunAt: new Date(when).toISOString() };
}

async function getScheduleState() {
  const alarm = await chrome.alarms.get(AUTO_ORGANIZE_ALARM);
  if (!alarm) return { enabled: false };
  return {
    enabled: true,
    nextRunAt: new Date(alarm.scheduledTime).toISOString()
  };
}

async function moveItemsToFreshWindows(items, maxTabsPerWindow) {
  const chunks = chunkItems(items, maxTabsPerWindow);
  const windows = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk.length) continue;

    const [first, ...rest] = chunk;
    const win = await chrome.windows.create({ tabId: first.tab.id, focused: i === 0 });
    windows.push({ windowId: win.id, items: chunk });

    if (rest.length) {
      await chrome.tabs.move(rest.map((item) => item.tab.id), { windowId: win.id, index: -1 });
    }
  }

  return windows;
}

async function movePlannedWindows(plannedWindows, focusedFirst = true) {
  for (let i = 0; i < plannedWindows.length; i += 1) {
    const chunk = plannedWindows[i];
    if (!chunk.length) continue;

    const [first, ...rest] = chunk;
    const win = await chrome.windows.create({ tabId: first.tab.id, focused: focusedFirst && i === 0 });
    if (rest.length) {
      await chrome.tabs.move(rest.map((item) => item.tab.id), { windowId: win.id, index: -1 });
    }
  }
}

async function enforceWindowCap(maxTabsPerWindow, settings) {
  const size = Math.max(1, Number(maxTabsPerWindow) || 10);
  const tabs = await chrome.tabs.query({});
  const eligible = tabs
    .filter((tab) => isManagedTab(tab, { ...settings, includePinned: true }))
    .sort((a, b) => {
      if (a.windowId !== b.windowId) return a.windowId - b.windowId;
      return a.index - b.index;
    });

  const byWindow = new Map();
  for (const tab of eligible) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }

  for (const windowTabs of byWindow.values()) {
    if (windowTabs.length <= size) continue;
    const overflowIds = windowTabs.slice(size).map((tab) => tab.id);

    for (let i = 0; i < overflowIds.length; i += size) {
      const chunk = overflowIds.slice(i, i + size);
      if (!chunk.length) continue;

      const [first, ...rest] = chunk;
      const created = await chrome.windows.create({ tabId: first, focused: false });
      if (rest.length) {
        await chrome.tabs.move(rest, { windowId: created.id, index: -1 });
      }
    }
  }
}

async function organizeTabs(overrides = {}, options = {}) {
  const settings = await getSettings(overrides);
  await saveSettings(settings);

  const tabs = await queryEligibleTabs(settings);
  const items = buildOrderedItems(tabs, settings);
  if (!items.length) {
    return { settings, totalTabs: 0, totalGroups: 0, totalWindows: 0 };
  }

  const plannedWindows = planWindowsByGroup(items, settings.maxTabsPerWindow, settings);
  await backupCurrentSession();
  await movePlannedWindows(plannedWindows, !options.preserveFocus);
  await enforceWindowCap(settings.maxTabsPerWindow, settings);

  if (options.preserveFocusTabId) {
    await activateTab(options.preserveFocusTabId).catch(() => {});
  }

  return {
    settings,
    ...summarizeCounts(items, plannedWindows)
  };
}

async function getSnapshot(overrides = {}) {
  const settings = await getSettings(overrides);
  const tabs = await chrome.tabs.query({});

  const payload = tabs
    .filter((tab) => isManagedTab(tab, settings))
    .map((tab) => ({
      id: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      pinned: !!tab.pinned,
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl || "",
      ...classifyTab(tab, settings)
    }));

  return { settings, tabs: payload };
}

async function applyManualLayout(data = {}, options = {}) {
  const settings = await getSettings(data.settings || {});
  const orderedTabIds = Array.isArray(data.orderedTabIds) ? data.orderedTabIds : [];
  const windowTabIds = Array.isArray(data.windowTabIds) ? data.windowTabIds : [];

  const allTabs = await chrome.tabs.query({});
  const byId = new Map(allTabs.map((tab) => [tab.id, tab]));

  const fallbackItems = orderedTabIds
    .map((id) => byId.get(id))
    .filter((tab) => isManagedTab(tab, settings))
    .map((tab) => ({ tab, groupKey: "manual", groupLabel: "Manual", groupColor: "blue" }));

  const plannedWindows = windowTabIds
    .map((tabIds) =>
      (Array.isArray(tabIds) ? tabIds : [])
        .map((id) => byId.get(id))
        .filter((tab) => isManagedTab(tab, settings))
        .map((tab) => ({ tab, groupKey: "manual", groupLabel: "Manual", groupColor: "blue" }))
    )
    .filter((items) => items.length > 0);

  const windowsToCreate = plannedWindows.length ? plannedWindows : chunkItems(fallbackItems, settings.maxTabsPerWindow);
  const totalItems = windowsToCreate.flat();
  if (!totalItems.length) {
    return { settings, totalTabs: 0, totalGroups: 0, totalWindows: 0 };
  }

  await backupCurrentSession();
  for (const plannedItems of windowsToCreate) {
    await moveItemsToFreshWindows(plannedItems, settings.maxTabsPerWindow);
  }
  await enforceWindowCap(settings.maxTabsPerWindow, settings);

  if (options.preserveFocusTabId) {
    await activateTab(options.preserveFocusTabId).catch(() => {});
  }

  return {
    settings,
    ...summarizeCounts(totalItems, chunkItems(totalItems, settings.maxTabsPerWindow))
  };
}

function canonicalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl || "");
  }
}

async function getCleanupCandidates(overrides = {}) {
  const settings = await getSettings(overrides);
  const allTabs = await chrome.tabs.query({});
  const candidates = allTabs.filter((tab) => isManagedTab(tab, { ...settings, includePinned: true }));
  const now = Date.now();
  const staleDays = Math.min(365, Math.max(1, Number(settings.cleanupStaleDays) || 14));
  const staleBefore = now - staleDays * 24 * 60 * 60 * 1000;

  const duplicateIds = new Set();
  const staleIds = new Set();

  const byUrl = new Map();
  for (const tab of candidates) {
    if (tab.pinned) continue;
    const key = canonicalUrl(tab.url || "");
    if (!key) continue;
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(tab);
  }

  for (const list of byUrl.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
    for (let i = 1; i < list.length; i += 1) {
      duplicateIds.add(list[i].id);
    }
  }

  for (const tab of candidates) {
    if (tab.pinned) continue;
    if (duplicateIds.has(tab.id)) continue;
    const lastAccessed = Number(tab.lastAccessed || 0);
    if (lastAccessed > 0 && lastAccessed < staleBefore) {
      staleIds.add(tab.id);
    }
  }

  const allIds = [...new Set([...duplicateIds, ...staleIds])];
  const byId = new Map(candidates.map((tab) => [tab.id, tab]));

  return {
    duplicateCount: duplicateIds.size,
    staleCount: staleIds.size,
    totalCount: allIds.length,
    staleDays,
    tabIds: allIds,
    preview: allIds.slice(0, 12).map((id) => {
      const tab = byId.get(id);
      return {
        id,
        title: tab?.title || "Untitled",
        url: tab?.url || "",
        reason: duplicateIds.has(id) ? "duplicate" : "stale"
      };
    })
  };
}

async function applyCleanup(data = {}) {
  const requestedIds = Array.isArray(data.tabIds) ? data.tabIds : [];
  const settings = await getSettings(data.settings || {});
  const allTabs = await chrome.tabs.query({});
  const allowed = new Set(
    allTabs
      .filter((tab) => isManagedTab(tab, { ...settings, includePinned: true }))
      .filter((tab) => !tab.pinned)
      .map((tab) => tab.id)
  );

  const tabIds = requestedIds.filter((id) => typeof id === "number" && allowed.has(id));
  if (!tabIds.length) {
    return { closedCount: 0 };
  }

  await backupCurrentSession();
  await chrome.tabs.remove(tabIds);
  return { closedCount: tabIds.length };
}

async function closeTab(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("Invalid tab id");
  }
  await chrome.tabs.remove(tabId);
  return { closedTabId: tabId };
}

async function closeWindow(windowId) {
  if (typeof windowId !== "number") {
    throw new Error("Invalid window id");
  }
  await chrome.windows.remove(windowId);
  return { closedWindowId: windowId };
}

async function activateTab(tabId) {
  if (typeof tabId !== "number") {
    throw new Error("Invalid tab id");
  }
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return { tabId, windowId: tab.windowId };
}

async function searchTabs(data = {}) {
  const query = String(data.query || "").trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(data.limit) || 15));
  if (!query) {
    return { query: "", results: [] };
  }

  const settings = await getSettings(data.settings || {});
  const includePinned = typeof data.includePinned === "boolean" ? data.includePinned : settings.includePinned;
  const tabs = await chrome.tabs.query({});
  const eligible = tabs.filter((tab) => isManagedTab(tab, { ...settings, includePinned }));
  const tokens = query.split(/\s+/).filter(Boolean);

  const matches = [];
  for (const tab of eligible) {
    const title = String(tab.title || "");
    const url = String(tab.url || "");
    const textTitle = title.toLowerCase();
    const textUrl = url.toLowerCase();
    const combined = `${textTitle} ${textUrl}`;

    const matchesAllTokens = tokens.every((token) => combined.includes(token));
    if (!matchesAllTokens) continue;

    let score = 0;
    if (textTitle.includes(query)) score += 5;
    if (textTitle.startsWith(query)) score += 3;
    if (textUrl.includes(query)) score += 2;

    for (const token of tokens) {
      if (textTitle.includes(token)) score += 1;
    }

    matches.push({
      id: tab.id,
      windowId: tab.windowId,
      title,
      url,
      favIconUrl: tab.favIconUrl || "",
      lastAccessed: Number(tab.lastAccessed || 0),
      pinned: !!tab.pinned,
      score
    });
  }

  matches.sort((a, b) => {
    if (b.lastAccessed !== a.lastAccessed) return b.lastAccessed - a.lastAccessed;
    return b.score - a.score;
  });

  return { query, results: matches.slice(0, limit) };
}

async function getRecentTabs(data = {}) {
  const limit = Math.min(20, Math.max(1, Number(data.limit) || 5));
  const settings = await getSettings(data.settings || {});
  const includePinned = typeof data.includePinned === "boolean" ? data.includePinned : true;
  const tabs = await chrome.tabs.query({});

  const recent = tabs
    .filter((tab) => isManagedTab(tab, { ...settings, includePinned }))
    .sort((a, b) => {
      const accessDelta = Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
      if (accessDelta !== 0) return accessDelta;
      return Number(b.id || 0) - Number(a.id || 0);
    })
    .slice(0, limit)
    .map((tab) => ({
      id: tab.id,
      title: tab.title || "Untitled",
      url: tab.url || "",
      windowId: tab.windowId,
      favIconUrl: tab.favIconUrl || "",
      lastAccessed: Number(tab.lastAccessed || 0),
      pinned: !!tab.pinned
    }));

  return { results: recent };
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...existing };
  await chrome.storage.sync.set(merged);
  await configureAutoSchedule(merged);
});

chrome.runtime.onStartup?.addListener(async () => {
  const settings = await getSettings();
  await configureAutoSchedule(settings);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_ORGANIZE_ALARM) return;

  (async () => {
    const settings = await getSettings();
    if (settings.scheduleMode === "off") {
      await configureAutoSchedule(settings);
      return;
    }

    await organizeTabs(settings);
    await configureAutoSchedule(settings);
  })().catch(async () => {
    const settings = await getSettings();
    await configureAutoSchedule(settings);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "ORGANIZE_TABS") {
      const preserveFocusTabId = msg.preserveFocus ? sender?.tab?.id : null;
      const result = await organizeTabs(msg.settings || {}, {
        preserveFocus: !!msg.preserveFocus,
        preserveFocusTabId
      });
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_SNAPSHOT") {
      const result = await getSnapshot(msg.settings || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "APPLY_MANUAL_LAYOUT") {
      const preserveFocusTabId = msg.preserveFocus ? sender?.tab?.id : null;
      const result = await applyManualLayout(msg.payload || {}, {
        preserveFocusTabId
      });
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "OPEN_DASHBOARD") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "CLOSE_TAB") {
      const result = await closeTab(msg.tabId);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "CLOSE_WINDOW") {
      const result = await closeWindow(msg.windowId);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "ACTIVATE_TAB") {
      const result = await activateTab(msg.tabId);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "SEARCH_TABS") {
      const result = await searchTabs(msg.payload || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_RECENT_TABS") {
      const result = await getRecentTabs(msg.payload || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_CLEANUP_CANDIDATES") {
      const result = await getCleanupCandidates(msg.settings || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "APPLY_CLEANUP") {
      const result = await applyCleanup(msg.payload || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "RESTORE_LAST_SESSION") {
      const result = await restoreLastSession();
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_LAST_SESSION_INFO") {
      const result = await getLastSessionInfo();
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_READ_LATER_ITEMS") {
      const result = await getReadLaterItems();
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "ADD_READ_LATER_ITEM") {
      const result = await addReadLaterItem(msg.payload || {});
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "REMOVE_READ_LATER_ITEM") {
      const result = await removeReadLaterItem(msg.itemId);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "OPEN_READ_LATER_ITEM") {
      const result = await openReadLaterItem(msg.itemId);
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "CLEAR_READ_LATER_ITEMS") {
      const result = await clearReadLaterItems();
      sendResponse({ ok: true, result });
      return;
    }

    if (msg?.type === "GET_SETTINGS") {
      const settings = await getSettings();
      const schedule = await getScheduleState();
      sendResponse({ ok: true, result: { ...settings, schedule } });
      return;
    }

    if (msg?.type === "SAVE_SETTINGS") {
      const settings = await getSettings(msg.settings || {});
      await saveSettings(settings);
      const schedule = await configureAutoSchedule(settings);
      sendResponse({ ok: true, result: { ...settings, schedule } });
      return;
    }

    sendResponse({ ok: false, error: "Unknown action" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Unexpected error" });
  });

  return true;
});
