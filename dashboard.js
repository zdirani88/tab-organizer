const boardEl = document.getElementById("board");
const modeEl = document.getElementById("mode");
const maxTabsEl = document.getElementById("maxTabsPerWindow");
const includePinnedEl = document.getElementById("includePinned");
const separateWorkspaceEl = document.getElementById("separateGoogleWorkspace");
const autoBtn = document.getElementById("autoBtn");
const applyBtn = document.getElementById("applyBtn");
const refreshBtn = document.getElementById("refreshBtn");
const todoListEl = document.getElementById("todoList");
const clearTodoBtn = document.getElementById("clearTodoBtn");
const statusEl = document.getElementById("status");
const template = document.getElementById("tabCardTemplate");
const READ_LATER_KEY = "readLaterItems";

const state = {
  tabs: new Map(),
  windows: [],
  readLater: [],
  settings: {
    mode: "smart",
    maxTabsPerWindow: 10,
    includePinned: false,
    separateGoogleWorkspace: true
  }
};

function setStatus(text) {
  statusEl.textContent = text;
}

function collectSettings() {
  return {
    mode: modeEl.value,
    maxTabsPerWindow: Math.max(1, Number(maxTabsEl.value) || 10),
    includePinned: includePinnedEl.checked,
    separateGoogleWorkspace: separateWorkspaceEl.checked
  };
}

function applySettingsToControls(settings) {
  modeEl.value = settings.mode;
  maxTabsEl.value = settings.maxTabsPerWindow;
  includePinnedEl.checked = !!settings.includePinned;
  separateWorkspaceEl.checked = !!settings.separateGoogleWorkspace;
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || "Request failed");
  return response.result;
}

function isUnknownActionError(error) {
  return /unknown (action|command)/i.test(String(error?.message || ""));
}

function normalizeReadLaterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    url.hash = "";
    return url.toString();
  } catch {
    return String(rawUrl || "").trim();
  }
}

async function getReadLaterLocal() {
  const data = await chrome.storage.local.get(READ_LATER_KEY);
  const items = Array.isArray(data[READ_LATER_KEY]) ? data[READ_LATER_KEY] : [];
  items.sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
  return items;
}

async function saveReadLaterLocal(items) {
  await chrome.storage.local.set({ [READ_LATER_KEY]: items });
}

function truncateText(value, max = 80) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function displayUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const output = `${url.hostname}${url.pathname}`.replace(/\/$/, "");
    return truncateText(output || rawUrl, 72);
  } catch {
    return truncateText(rawUrl, 72);
  }
}

function buildWindowsFromTabs(tabs) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) {
      byWindow.set(tab.windowId, []);
    }
    byWindow.get(tab.windowId).push(tab.id);
  }

  return Array.from(byWindow.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([windowId, tabIds]) => ({
      id: crypto.randomUUID(),
      windowId,
      tabIds
    }));
}

function getDragData(ev) {
  const value = ev.dataTransfer.getData("application/json");
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function removeTabFromWindows(tabId) {
  for (const win of state.windows) {
    win.tabIds = win.tabIds.filter((id) => id !== tabId);
  }
}

function prettifyKey(key) {
  return String(key || "")
    .replace(/^google-/, "Google ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferTabType(tab) {
  if (!tab) return "Other";
  const url = String(tab.url || "").toLowerCase();
  const domain = String(tab.domain || "").toLowerCase();
  const category = String(tab.category || "").toLowerCase();

  if (domain === "mail.google.com" || url.includes("mail.google.com")) return "Gmail";
  if (category === "google-docs") return "Google Docs";
  if (category === "google-sheets") return "Google Sheets";
  if (category === "google-slides") return "Google Slides";
  if (category === "google-forms") return "Google Forms";
  if (domain.includes("linkedin.com")) return "LinkedIn";
  if (domain.includes("chatgpt.com")) return "ChatGPT";
  if (category && category !== "misc") return prettifyKey(category);
  if (domain && domain !== "unknown") return prettifyKey(domain.split(".")[0]);
  return "Other";
}

function inferWindowLabel(tabIds) {
  const counts = new Map();
  for (const tabId of tabIds) {
    const tab = state.tabs.get(tabId);
    const type = inferTabType(tab);
    counts.set(type, (counts.get(type) || 0) + 1);
  }

  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "Empty";
  if (ranked.length === 1) return ranked[0][0];

  const [topLabel, topCount] = ranked[0];
  const [, secondCount] = ranked[1];
  if (topCount >= secondCount * 3 && topCount >= 4) return topLabel;
  return `${topLabel} + Mixed`;
}

async function closeTabFromDashboard(tabId) {
  await sendMessage("CLOSE_TAB", { tabId });
  state.tabs.delete(tabId);
  removeTabFromWindows(tabId);
  state.windows = state.windows.filter((win) => win.tabIds.length > 0);
  render();
}

async function closeWindowFromDashboard(windowId) {
  await sendMessage("CLOSE_WINDOW", { windowId });
  state.windows = state.windows.filter((win) => win.windowId !== windowId);
  render();
}

async function activateTabFromDashboard(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
}

function renderReadLaterList() {
  todoListEl.innerHTML = "";
  if (!state.readLater.length) {
    const empty = document.createElement("p");
    empty.className = "todo-empty";
    empty.textContent = "No saved items yet.";
    todoListEl.appendChild(empty);
    return;
  }

  for (const item of state.readLater) {
    const row = document.createElement("article");
    row.className = "todo-item";

    const meta = document.createElement("div");
    meta.className = "todo-meta";

    const strong = document.createElement("strong");
    strong.textContent = truncateText(item.title || "Untitled", 90);
    strong.title = item.title || "";
    meta.appendChild(strong);

    const span = document.createElement("span");
    span.textContent = displayUrl(item.url || "");
    span.title = item.url || "";
    meta.appendChild(span);

    const actions = document.createElement("div");
    actions.className = "todo-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "todo-btn";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", async () => {
      try {
        try {
          await sendMessage("OPEN_READ_LATER_ITEM", { itemId: item.id });
        } catch (error) {
          if (!isUnknownActionError(error)) throw error;
          await chrome.tabs.create({ url: item.url });
        }
      } catch (error) {
        setStatus(error.message);
      }
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "todo-btn remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      try {
        try {
          await sendMessage("REMOVE_READ_LATER_ITEM", { itemId: item.id });
        } catch (error) {
          if (!isUnknownActionError(error)) throw error;
          const local = await getReadLaterLocal();
          await saveReadLaterLocal(local.filter((entry) => entry.id !== item.id));
        }
        await reloadReadLater();
      } catch (error) {
        setStatus(error.message);
      }
    });

    actions.appendChild(openBtn);
    actions.appendChild(removeBtn);

    row.appendChild(meta);
    row.appendChild(actions);
    todoListEl.appendChild(row);
  }
}

async function reloadReadLater() {
  try {
    const result = await sendMessage("GET_READ_LATER_ITEMS");
    state.readLater = Array.isArray(result.items) ? result.items : [];
  } catch (error) {
    if (!isUnknownActionError(error)) throw error;
    state.readLater = await getReadLaterLocal();
  }
  renderReadLaterList();
}

function render() {
  boardEl.innerHTML = "";

  for (let col = 0; col < state.windows.length; col += 1) {
    const win = state.windows[col];
    const laneEl = document.createElement("section");
    laneEl.className = "lane";
    laneEl.dataset.windowId = String(win.windowId);

    const header = document.createElement("div");
    header.className = "lane-header";

    const title = document.createElement("h2");
    const inferred = inferWindowLabel(win.tabIds);
    title.textContent = `${inferred} (${win.tabIds.length})`;
    title.title = `Window ${col + 1}`;
    header.appendChild(title);

    const closeWindowBtn = document.createElement("button");
    closeWindowBtn.type = "button";
    closeWindowBtn.className = "close-window-btn";
    closeWindowBtn.textContent = "Close window";
    closeWindowBtn.title = "Close this window and all tabs in it";
    closeWindowBtn.addEventListener("click", async () => {
      const confirmed = window.confirm(`Close this window with ${win.tabIds.length} tabs?`);
      if (!confirmed) return;

      closeWindowBtn.disabled = true;
      try {
        await closeWindowFromDashboard(win.windowId);
        setStatus("Window closed.");
      } catch (error) {
        closeWindowBtn.disabled = false;
        setStatus(error.message);
      }
    });
    header.appendChild(closeWindowBtn);
    laneEl.appendChild(header);

    const list = document.createElement("div");
    list.className = "drop-zone";

    list.addEventListener("dragover", (ev) => {
      ev.preventDefault();
    });

    list.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const dragData = getDragData(ev);
      if (!dragData) return;

      const tabId = dragData.tabId;
      removeTabFromWindows(tabId);
      win.tabIds.push(tabId);
      render();
    });

    for (const tabId of win.tabIds) {
      const tab = state.tabs.get(tabId);
      if (!tab) continue;

      const fragment = template.content.cloneNode(true);
      const card = fragment.querySelector(".tab-card");
      const icon = fragment.querySelector(".favicon");
      const h3 = fragment.querySelector("h3");
      const p = fragment.querySelector("p");
      const laterBtn = fragment.querySelector(".later-tab");
      const closeBtn = fragment.querySelector(".close-tab");

      card.dataset.tabId = String(tab.id);
      card.draggable = true;

      card.addEventListener("dragstart", (ev) => {
        card.classList.add("dragging");
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("application/json", JSON.stringify({ tabId: tab.id }));
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
      });

      card.addEventListener("dragover", (ev) => {
        ev.preventDefault();
      });

      card.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const dragData = getDragData(ev);
        if (!dragData) return;

        const draggedTabId = dragData.tabId;
        if (draggedTabId === tab.id) return;

        removeTabFromWindows(draggedTabId);
        const idx = win.tabIds.indexOf(tab.id);
        win.tabIds.splice(idx < 0 ? win.tabIds.length : idx, 0, draggedTabId);
        render();
      });

      card.addEventListener("click", async (ev) => {
        if (ev.target.closest(".close-tab") || ev.target.closest(".later-tab")) return;
        try {
          await activateTabFromDashboard(tab.id);
          setStatus(`Opened: ${truncateText(tab.title, 40)}`);
        } catch (error) {
          setStatus(error.message);
        }
      });

      laterBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        laterBtn.disabled = true;
        try {
          try {
            await sendMessage("ADD_READ_LATER_ITEM", {
              payload: {
                title: tab.title,
                url: tab.url
              }
            });
          } catch (error) {
            if (!isUnknownActionError(error)) throw error;
            const now = Date.now();
            const local = await getReadLaterLocal();
            const next = [
              {
                id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
                title: String(tab.title || "Untitled"),
                url: normalizeReadLaterUrl(tab.url),
                addedAt: now
              },
              ...local.filter((entry) => normalizeReadLaterUrl(entry.url) !== normalizeReadLaterUrl(tab.url))
            ].slice(0, 200);
            await saveReadLaterLocal(next);
          }
          await reloadReadLater();
          setStatus("Added to Read Later.");
        } catch (error) {
          laterBtn.disabled = false;
          setStatus(error.message);
        }
      });

      closeBtn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeBtn.disabled = true;
        try {
          await closeTabFromDashboard(tab.id);
          setStatus(`Closed: ${truncateText(tab.title, 40)}`);
        } catch (error) {
          closeBtn.disabled = false;
          setStatus(error.message);
        }
      });

      icon.src = tab.favIconUrl || "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
      h3.textContent = truncateText(tab.title, 70);
      h3.title = tab.title;
      p.textContent = displayUrl(tab.url);
      p.title = tab.url;
      list.appendChild(fragment);
    }

    laneEl.appendChild(list);
    boardEl.appendChild(laneEl);
  }
}

async function reloadFromBrowser() {
  setStatus("Loading tabs...");

  const settings = collectSettings();
  const snapshot = await sendMessage("GET_SNAPSHOT", { settings });
  state.settings = snapshot.settings;
  applySettingsToControls(snapshot.settings);

  state.tabs = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));
  state.windows = buildWindowsFromTabs(snapshot.tabs);

  render();
  setStatus(`Loaded ${snapshot.tabs.length} tabs across ${state.windows.length} windows.`);
}

autoBtn.addEventListener("click", async () => {
  try {
    setStatus("Auto organizing...");
    const result = await sendMessage("ORGANIZE_TABS", { settings: collectSettings(), preserveFocus: true });
    await reloadFromBrowser();
    setStatus(`Auto organize complete: ${result.totalTabs} tabs in ${result.totalWindows} windows.`);
  } catch (error) {
    setStatus(error.message);
  }
});

applyBtn.addEventListener("click", async () => {
  try {
    setStatus("Applying manual layout...");

    const windowTabIds = state.windows
      .map((win) => win.tabIds.filter((tabId) => state.tabs.has(tabId)))
      .filter((tabIds) => tabIds.length > 0);

    const result = await sendMessage("APPLY_MANUAL_LAYOUT", {
      preserveFocus: true,
      payload: {
        windowTabIds,
        settings: collectSettings()
      }
    });

    await reloadFromBrowser();
    setStatus(`Manual layout applied: ${result.totalTabs} tabs in ${result.totalWindows} windows.`);
  } catch (error) {
    setStatus(error.message);
  }
});

refreshBtn.addEventListener("click", () => {
  reloadFromBrowser()
    .then(() => reloadReadLater())
    .catch((error) => setStatus(error.message));
});

clearTodoBtn.addEventListener("click", async () => {
  const confirmed = window.confirm("Clear all Read Later items?");
  if (!confirmed) return;

  clearTodoBtn.disabled = true;
  try {
    try {
      await sendMessage("CLEAR_READ_LATER_ITEMS");
    } catch (error) {
      if (!isUnknownActionError(error)) throw error;
      await saveReadLaterLocal([]);
    }
    await reloadReadLater();
    setStatus("Read Later list cleared.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    clearTodoBtn.disabled = false;
  }
});

for (const el of [modeEl, maxTabsEl, includePinnedEl, separateWorkspaceEl]) {
  el.addEventListener("change", async () => {
    try {
      await sendMessage("SAVE_SETTINGS", { settings: collectSettings() });
    } catch (error) {
      setStatus(error.message);
    }
  });
}

Promise.all([reloadFromBrowser(), reloadReadLater()]).catch((error) => setStatus(error.message));
