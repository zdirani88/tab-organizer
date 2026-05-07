export const DEFAULT_SETTINGS = {
  mode: "smart",
  groupingMethod: "tabGroups",
  profileScope: "allWindows",
  maxTabsPerWindow: 10,
  includePinned: false,
  separateGoogleWorkspace: true,
  cleanupStaleDays: 14,
  scheduleMode: "off",
  scheduleIntervalHours: 24,
  scheduleWeekday: 1,
  scheduleTime: "09:00"
};

export const ORGANIZE_MODES = [
  { value: "smart", label: "Smart (category + domain)" },
  { value: "domain", label: "Domain" },
  { value: "title", label: "Title similarity" },
  { value: "category", label: "Category first" }
];

export const GROUPING_METHODS = [
  { value: "windows", label: "Separate windows" },
  { value: "tabGroups", label: "Tab groups (single window)" }
];

export const PROFILE_SCOPES = [
  { value: "allWindows", label: "All windows (all profiles)" },
  { value: "currentWindow", label: "Current window only" }
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "you", "are", "from", "that", "this",
  "http", "https", "www", "com", "org", "net", "app", "home", "page"
]);

const GROUP_COLORS = ["blue", "green", "yellow", "purple", "cyan", "orange", "pink", "red", "grey"];

function safeUrl(rawUrl) {
  try {
    return new URL(rawUrl || "");
  } catch {
    return null;
  }
}

export function getDomain(rawUrl) {
  const parsed = safeUrl(rawUrl);
  if (!parsed || !parsed.hostname) return "unknown";
  return parsed.hostname.replace(/^www\./, "");
}

export function getGoogleWorkspaceType(rawUrl) {
  const parsed = safeUrl(rawUrl);
  if (!parsed || parsed.hostname !== "docs.google.com") return null;

  if (parsed.pathname.startsWith("/document/")) return "google-docs";
  if (parsed.pathname.startsWith("/spreadsheets/")) return "google-sheets";
  if (parsed.pathname.startsWith("/presentation/")) return "google-slides";
  if (parsed.pathname.startsWith("/forms/")) return "google-forms";
  if (parsed.pathname.startsWith("/drawings/")) return "google-drawings";
  return "google-workspace";
}

function titleTokens(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function topTitleToken(title) {
  const tokens = titleTokens(title);
  return tokens[0] || "general";
}

function categoryFor(tab, settings) {
  const workspaceType = settings.separateGoogleWorkspace ? getGoogleWorkspaceType(tab.url) : null;
  if (workspaceType) return workspaceType;

  const domain = getDomain(tab.url);
  if (domain.includes("github.com")) return "github";
  if (domain.includes("youtube.com")) return "youtube";
  if (domain.includes("figma.com")) return "design";
  if (domain.includes("notion.so")) return "notes";
  if (domain === "unknown") return "misc";
  return domain.split(".")[0] || "misc";
}

function groupLabelFromKey(key) {
  return key
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function classifyTab(tab, settings) {
  const domain = getDomain(tab.url);
  const category = categoryFor(tab, settings);

  let groupKey;
  if (settings.mode === "domain") {
    groupKey = domain;
  } else if (settings.mode === "title") {
    groupKey = `${domain}:${topTitleToken(tab.title)}`;
  } else if (settings.mode === "category") {
    groupKey = `${category}:${domain}`;
  } else {
    const token = topTitleToken(tab.title);
    groupKey = `${category}:${domain}:${token}`;
  }

  return {
    groupKey,
    groupLabel: groupLabelFromKey(groupKey),
    category,
    domain
  };
}

export function buildOrderedItems(tabs, inputSettings = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...inputSettings };
  const eligible = tabs.filter((tab) => settings.includePinned || !tab.pinned);

  const items = eligible.map((tab) => {
    const classification = classifyTab(tab, settings);
    return { tab, ...classification };
  });

  items.sort((a, b) => {
    if (a.groupKey < b.groupKey) return -1;
    if (a.groupKey > b.groupKey) return 1;
    return (a.tab.title || "").localeCompare(b.tab.title || "");
  });

  const colorMap = new Map();
  let colorIndex = 0;
  for (const item of items) {
    if (!colorMap.has(item.groupKey)) {
      colorMap.set(item.groupKey, GROUP_COLORS[colorIndex % GROUP_COLORS.length]);
      colorIndex += 1;
    }
    item.groupColor = colorMap.get(item.groupKey);
  }

  return items;
}

export function chunkItems(items, maxTabsPerWindow) {
  const size = Math.max(1, Number(maxTabsPerWindow) || 10);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function windowBucketKeyForItem(item, mode = "smart") {
  const category = item?.category || "misc";
  const domain = item?.domain || "unknown";

  if (mode === "domain") return `domain:${domain}`;
  if (mode === "title") return `domain:${domain}`;
  if (mode === "category") return `category:${category}`;
  return `category:${category}`;
}

export function planWindowsByGroup(items, maxTabsPerWindow, settings = {}) {
  const size = Math.max(1, Number(maxTabsPerWindow) || 10);
  if (!items.length) return [];

  const groups = [];
  let currentKey = null;
  let currentGroup = [];
  const mode = settings.mode || "smart";

  for (const item of items) {
    const bucketKey = windowBucketKeyForItem(item, mode);
    if (currentKey === null || bucketKey === currentKey) {
      currentGroup.push(item);
      currentKey = bucketKey;
      continue;
    }
    groups.push(currentGroup);
    currentGroup = [item];
    currentKey = bucketKey;
  }
  if (currentGroup.length) groups.push(currentGroup);

  const windows = [];
  let currentWindow = [];

  for (const groupItems of groups) {
    if (groupItems.length > size) {
      if (currentWindow.length) {
        windows.push(currentWindow);
        currentWindow = [];
      }
      windows.push(...chunkItems(groupItems, size));
      continue;
    }

    const remaining = size - currentWindow.length;
    if (groupItems.length <= remaining) {
      currentWindow.push(...groupItems);
    } else {
      if (currentWindow.length) windows.push(currentWindow);
      currentWindow = [...groupItems];
    }
  }

  if (currentWindow.length) windows.push(currentWindow);
  return windows;
}

export function planTabGroups(items, settings = {}) {
  if (!items.length) return [];

  const mode = settings.mode || "smart";
  const groupMap = new Map();

  for (const item of items) {
    const bucketKey = windowBucketKeyForItem(item, mode);
    if (!groupMap.has(bucketKey)) {
      groupMap.set(bucketKey, { label: item.groupLabel, color: item.groupColor, items: [] });
    }
    groupMap.get(bucketKey).items.push(item);
  }

  return Array.from(groupMap.values());
}

export function summarizeCounts(items, chunks) {
  const groupKeys = new Set(items.map((item) => item.groupKey));
  return {
    totalTabs: items.length,
    totalGroups: groupKeys.size,
    totalWindows: chunks.length
  };
}
