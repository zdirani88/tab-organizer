# Tab Organizer Pro (Chrome Extension)

Chrome extension to auto-organize tabs by similarity, split tabs into windows with a max-tab limit, and manage tabs visually with drag-and-drop.

## What it does

- Auto-clusters similar tabs so related tabs sit next to each other.
- Splits tabs into multiple windows with a configurable max (default `10` tabs/window).
- Separates Google Workspace tabs by type:
  - `docs.google.com/document/...` -> Google Docs
  - `docs.google.com/spreadsheets/...` -> Google Sheets
  - `docs.google.com/presentation/...` -> Google Slides
- Supports multiple organize modes:
  - Smart (category + domain + title token)
  - Domain
  - Title similarity
  - Category first
- Includes a dashboard page for manual organization:
  - Each column is one browser window
  - Drag/drop tabs between window columns
  - Reorder tabs inside each window column
  - Apply manual layout back into browser windows
- Does not use native Chrome tab groups.
- Saves a pre-change session snapshot before organize/manual cleanup operations.
- Supports one-click restore of the last saved session snapshot.
- Cleanup flow finds duplicate/stale tabs and asks for confirmation before closing.
- Supports scheduled auto-organize:
  - Every X hours
  - Daily at a chosen time
  - Weekly on a chosen day/time

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/zubinirani/Downloads/zeveloper/tab-organizer`

## Usage

1. Click the extension icon.
2. Choose organize options.
3. Click **Auto organize now**.
4. Optional: Click **Open dashboard** for drag/drop manual control.

## Files

- `manifest.json` - MV3 extension config
- `background.js` - main organizing engine + message APIs
- `organizer-core.js` - tab classification/sorting logic
- `popup.html`, `popup.css`, `popup.js` - popup controls
- `dashboard.html`, `dashboard.css`, `dashboard.js` - drag/drop tab manager

## Notes

- Extension pages are excluded from auto-organization.
- If no eligible tabs are found, the organizer exits safely.
- JavaScript syntax checks were not run locally because `node` is not installed in this environment.

## Chrome Web Store

- Submission checklist: `CHROME_WEB_STORE.md`
- Privacy policy source: `PRIVACY_POLICY.md`
