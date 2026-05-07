const GLEAN_TOKEN_KEY = "gleanApiToken";
const GLEAN_INSTANCE_KEY = "gleanInstance";

export async function getGleanConfig() {
  const data = await chrome.storage.local.get([GLEAN_TOKEN_KEY, GLEAN_INSTANCE_KEY]);
  return {
    token: data[GLEAN_TOKEN_KEY] || "",
    instance: data[GLEAN_INSTANCE_KEY] || ""
  };
}

export async function saveGleanConfig(token, instance) {
  await chrome.storage.local.set({
    [GLEAN_TOKEN_KEY]: token,
    [GLEAN_INSTANCE_KEY]: instance
  });
}

export async function clearGleanConfig() {
  await chrome.storage.local.remove([GLEAN_TOKEN_KEY, GLEAN_INSTANCE_KEY]);
}

export function isGleanConfigured(config) {
  return !!(config.token && config.instance);
}

function buildGleanUrl(instance) {
  const cleaned = instance.replace(/^https?:\/\//, "").replace(/-be\.glean\.com.*$/, "").replace(/\.glean\.com.*$/, "");
  return `https://${cleaned}-be.glean.com/rest/api/v1/chat`;
}

const RESPONSE_SCHEMA = `{
  "groups": [
    {
      "groupName": "string - short display name for the tab group (max 20 chars)",
      "tabs": [
        {
          "url": "string - the exact URL of the tab",
          "title": "string - the tab title"
        }
      ],
      "explanation": "string - brief explanation of why these tabs are grouped together"
    }
  ]
}`;

function buildOrganizePrompt(tabs) {
  const tabList = tabs.map(t => ({ url: t.url, title: t.title }));

  return `You are a productivity assistant that organizes browser tabs into meaningful groups.

Given the following list of open browser tabs, organize ALL of them into logical groups that would be most relevant and useful to the user. Consider grouping by:
- Workstreams or projects (e.g. tabs related to the same initiative)
- To-do tasks (e.g. tabs the user likely needs to act on)
- Customers or partners (e.g. tabs related to specific companies)
- Meetings (e.g. calendar, video call, meeting notes tabs)
- Teams or people (e.g. tabs related to team communication)
- Tools or platforms (e.g. development tools, design tools)
- Reference or research (e.g. documentation, articles being read)
- Any other dynamic categories that make sense for this set of tabs

Rules:
1. EVERY tab must be placed in exactly one group - no tab should be left out.
2. If a tab does not clearly fit any group, place it in an "Other" group.
3. Group names should be concise (max 20 characters) and descriptive.
4. Create as many or as few groups as makes sense - aim for useful groupings, not arbitrary splits.
5. Return ONLY valid JSON matching the schema below. No markdown fences, no extra text.

Response JSON schema:
${RESPONSE_SCHEMA}

Here are the tabs to organize (as JSON):
${JSON.stringify(tabList)}`;
}

export async function organizeTabsWithGlean(tabs, config) {
  if (!tabs.length) {
    return { groups: [] };
  }

  const url = buildGleanUrl(config.instance);
  const prompt = buildOrganizePrompt(tabs);

  const body = {
    messages: [
      {
        author: "USER",
        fragments: [{ text: prompt }]
      }
    ]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error("Glean API token is invalid or expired. Please update your token in settings.");
    }
    if (response.status === 429) {
      throw new Error("Glean API rate limit exceeded. Please try again in a moment.");
    }
    throw new Error(`Glean API error (${response.status}): ${errorText || response.statusText}`);
  }

  const result = await response.json();

  const aiText = extractAiResponseText(result);
  if (!aiText) {
    throw new Error("Glean returned an empty response. Please try again.");
  }

  return parseGleanResponse(aiText, tabs);
}

function extractAiResponseText(chatResponse) {
  const messages = chatResponse.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.author === "GLEAN_AI" || msg.messageType === "CONTENT") {
      const fragments = msg.fragments || [];
      const textParts = fragments
        .filter(f => f.text)
        .map(f => f.text);
      if (textParts.length) return textParts.join("");
    }
  }
  return null;
}

function parseGleanResponse(text, originalTabs) {
  let jsonStr = text.trim();

  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  const braceStart = jsonStr.indexOf("{");
  const braceEnd = jsonStr.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Glean returned a response that could not be parsed as JSON. Please try again.");
  }

  const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
  if (!groups.length) {
    throw new Error("Glean returned no tab groups. Please try again.");
  }

  const urlToTab = new Map();
  for (const tab of originalTabs) {
    urlToTab.set(tab.url, tab);
  }

  const assignedUrls = new Set();
  const validatedGroups = [];

  for (const group of groups) {
    const name = String(group.groupName || "Unnamed").slice(0, 20);
    const explanation = String(group.explanation || "");
    const matchedTabs = [];

    for (const entry of (group.tabs || [])) {
      const entryUrl = entry.url || "";
      const matched = urlToTab.get(entryUrl);
      if (matched && !assignedUrls.has(entryUrl)) {
        matchedTabs.push(matched);
        assignedUrls.add(entryUrl);
      }
    }

    if (matchedTabs.length) {
      validatedGroups.push({ groupName: name, tabs: matchedTabs, explanation });
    }
  }

  const orphaned = originalTabs.filter(t => !assignedUrls.has(t.url));
  if (orphaned.length) {
    const existingOther = validatedGroups.find(
      g => g.groupName.toLowerCase() === "other"
    );
    if (existingOther) {
      existingOther.tabs.push(...orphaned);
    } else {
      validatedGroups.push({
        groupName: "Other",
        tabs: orphaned,
        explanation: "Tabs that did not fit neatly into another group."
      });
    }
  }

  return { groups: validatedGroups };
}
