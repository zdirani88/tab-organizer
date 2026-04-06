const modeEl = document.getElementById("mode");
const maxTabsEl = document.getElementById("maxTabsPerWindow");
const includePinnedEl = document.getElementById("includePinned");
const separateWorkspaceEl = document.getElementById("separateGoogleWorkspace");
const cleanupStaleDaysEl = document.getElementById("cleanupStaleDays");
const scheduleModeEl = document.getElementById("scheduleMode");
const scheduleIntervalHoursEl = document.getElementById("scheduleIntervalHours");
const scheduleWeekdayEl = document.getElementById("scheduleWeekday");
const scheduleTimeEl = document.getElementById("scheduleTime");
const scheduleIntervalWrapEl = document.getElementById("scheduleIntervalWrap");
const scheduleTimeWrapEl = document.getElementById("scheduleTimeWrap");
const searchInputEl = document.getElementById("searchInput");
const searchResultsEl = document.getElementById("searchResults");
const recentTabsEl = document.getElementById("recentTabs");
const organizeBtn = document.getElementById("organizeBtn");
const cleanupBtn = document.getElementById("cleanupBtn");
const restoreBtn = document.getElementById("restoreBtn");
const dashboardBtn = document.getElementById("dashboardBtn");
const statusEl = document.getElementById("status");
let searchTimer = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function updateScheduleVisibility() {
  const mode = scheduleModeEl.value;
  scheduleIntervalWrapEl.style.display = mode === "hourly" ? "block" : "none";
  scheduleTimeWrapEl.style.display = mode === "daily" || mode === "weekly" ? "grid" : "none";
  scheduleWeekdayEl.disabled = mode !== "weekly";
}

function collectSettings() {
  return {
    mode: modeEl.value,
    maxTabsPerWindow: Math.max(1, Number(maxTabsEl.value) || 10),
    includePinned: includePinnedEl.checked,
    separateGoogleWorkspace: separateWorkspaceEl.checked,
    cleanupStaleDays: Math.max(1, Number(cleanupStaleDaysEl.value) || 14),
    scheduleMode: scheduleModeEl.value,
    scheduleIntervalHours: Math.max(1, Number(scheduleIntervalHoursEl.value) || 24),
    scheduleWeekday: Math.max(0, Math.min(6, Number(scheduleWeekdayEl.value) || 1)),
    scheduleTime: scheduleTimeEl.value || "09:00"
  };
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

async function loadSettings() {
  try {
    const settings = await sendMessage("GET_SETTINGS");
    modeEl.value = settings.mode;
    maxTabsEl.value = settings.maxTabsPerWindow;
    includePinnedEl.checked = settings.includePinned;
    separateWorkspaceEl.checked = settings.separateGoogleWorkspace;
    cleanupStaleDaysEl.value = settings.cleanupStaleDays;
    scheduleModeEl.value = settings.scheduleMode;
    scheduleIntervalHoursEl.value = settings.scheduleIntervalHours;
    scheduleWeekdayEl.value = String(settings.scheduleWeekday);
    scheduleTimeEl.value = settings.scheduleTime;
    updateScheduleVisibility();

    if (settings.schedule?.enabled && settings.schedule.nextRunAt) {
      setStatus(`Next auto organize: ${new Date(settings.schedule.nextRunAt).toLocaleString()}`);
    }

    // Put typing focus in search on popup open.
    searchInputEl.focus();
    searchInputEl.select();
    await loadRecentTabs();
  } catch (error) {
    setStatus(error.message);
  }
}

async function saveSettings() {
  const settings = collectSettings();
  const result = await sendMessage("SAVE_SETTINGS", { settings });
  if (result.schedule?.enabled && result.schedule.nextRunAt) {
    setStatus(`Saved. Next run: ${new Date(result.schedule.nextRunAt).toLocaleString()}`);
  } else {
    setStatus("Saved.");
  }
}

function truncateText(text, max = 70) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function friendlyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return truncateText(`${url.hostname}${url.pathname}`.replace(/\/$/, ""), 62);
  } catch {
    return truncateText(rawUrl, 62);
  }
}

function renderTabList(targetEl, results = [], emptyText = "No tabs found.") {
  targetEl.innerHTML = "";
  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = emptyText;
    targetEl.appendChild(empty);
    return;
  }

  for (const tab of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-item";
    button.title = tab.title || tab.url;

    const titleEl = document.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = truncateText(tab.title || "Untitled", 62);

    const metaEl = document.createElement("span");
    metaEl.className = "meta";
    metaEl.textContent = friendlyUrl(tab.url || "");

    button.appendChild(titleEl);
    button.appendChild(metaEl);
    button.addEventListener("click", async () => {
      try {
        await sendMessage("ACTIVATE_TAB", { tabId: tab.id });
        window.close();
      } catch (error) {
        setStatus(error.message);
      }
    });
    targetEl.appendChild(button);
  }
}

async function runTabSearch() {
  const query = searchInputEl.value.trim();
  if (!query) {
    searchResultsEl.innerHTML = "";
    return;
  }

  try {
    const payload = {
      query,
      limit: 15,
      includePinned: includePinnedEl.checked,
      settings: collectSettings()
    };
    const result = await sendMessage("SEARCH_TABS", { payload });
    renderTabList(searchResultsEl, result.results || [], "No matching tabs.");
  } catch (error) {
    setStatus(error.message);
  }
}

async function loadRecentTabs() {
  try {
    const payload = {
      limit: 5,
      includePinned: true,
      settings: collectSettings()
    };
    const result = await sendMessage("GET_RECENT_TABS", { payload });
    renderTabList(recentTabsEl, result.results || [], "No recent tabs.");
  } catch (error) {
    setStatus(error.message);
  }
}

organizeBtn.addEventListener("click", async () => {
  setStatus("Organizing tabs...");
  organizeBtn.disabled = true;

  try {
    const result = await sendMessage("ORGANIZE_TABS", { settings: collectSettings() });
    setStatus(`Done: ${result.totalTabs} tabs, ${result.totalGroups} clusters, ${result.totalWindows} windows.`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    organizeBtn.disabled = false;
  }
});

cleanupBtn.addEventListener("click", async () => {
  cleanupBtn.disabled = true;
  setStatus("Scanning for duplicate/stale tabs...");

  try {
    const settings = collectSettings();
    const candidates = await sendMessage("GET_CLEANUP_CANDIDATES", { settings });

    if (!candidates.totalCount) {
      setStatus("No cleanup candidates found.");
      return;
    }

    const message = [
      `Close ${candidates.totalCount} tabs?`,
      `Duplicates: ${candidates.duplicateCount}`,
      `Stale (${candidates.staleDays}+ days): ${candidates.staleCount}`,
      "You can undo using Restore last session."
    ].join("\n");

    const confirmed = window.confirm(message);
    if (!confirmed) {
      setStatus("Cleanup canceled.");
      return;
    }

    const result = await sendMessage("APPLY_CLEANUP", {
      payload: {
        tabIds: candidates.tabIds,
        settings
      }
    });

    setStatus(`Cleanup complete. Closed ${result.closedCount} tabs.`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    cleanupBtn.disabled = false;
  }
});

restoreBtn.addEventListener("click", async () => {
  restoreBtn.disabled = true;
  setStatus("Restoring last session...");

  try {
    const result = await sendMessage("RESTORE_LAST_SESSION");
    setStatus(`Restored ${result.restoredTabs} tabs across ${result.restoredWindows} windows.`);
  } catch (error) {
    setStatus(error.message);
  } finally {
    restoreBtn.disabled = false;
  }
});

dashboardBtn.addEventListener("click", async () => {
  try {
    await sendMessage("OPEN_DASHBOARD");
    window.close();
  } catch (error) {
    setStatus(error.message);
  }
});

searchInputEl.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    runTabSearch();
  }, 120);
});

for (const element of [
  modeEl,
  maxTabsEl,
  includePinnedEl,
  separateWorkspaceEl,
  cleanupStaleDaysEl,
  scheduleModeEl,
  scheduleIntervalHoursEl,
  scheduleWeekdayEl,
  scheduleTimeEl
]) {
  element.addEventListener("change", async () => {
    try {
      updateScheduleVisibility();
      await saveSettings();
      await loadRecentTabs();
      if (searchInputEl.value.trim()) {
        await runTabSearch();
      }
    } catch (error) {
      setStatus(error.message);
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadRecentTabs().catch((error) => setStatus(error.message));
  }
});

loadSettings();
