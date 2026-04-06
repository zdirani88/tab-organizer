# Chrome Web Store Submission Checklist

This project is already on Manifest V3 and includes the required extension icons.

## Current package status

- Manifest: `manifest_version` is `3`
- Version: `0.1.4`
- Required icons included: `16`, `48`, `128`
- Permissions currently requested: `tabs`, `storage`, `alarms`

## Before upload

1. Load the unpacked extension in Chrome:
   - Open `chrome://extensions`
   - Enable `Developer mode`
   - Click `Load unpacked`
   - Select this folder
2. Test the main flows:
   - popup organize flow
   - dashboard drag/drop flow
   - Read Later / TODO add, open, remove, clear
   - cleanup duplicates/stale tabs
   - restore last session
   - scheduled organize settings save correctly
3. Confirm the store-facing copy:
   - extension name
   - short description
   - detailed description
4. Prepare store assets:
   - store icon: `128 x 128`
   - screenshots: at least one `1280 x 800` or `640 x 400`
   - small promo tile: `440 x 280`
   - optional marquee: `1400 x 560`
5. Publish a privacy policy URL:
   - recommended file in this repo: `PRIVACY_POLICY.md`
   - host it through GitHub Pages, a personal site, or another public URL

## Recommended store listing copy

### Short description

Organize browser tabs into clean windows, manage layouts visually, and keep a Read Later list.

### Key features to mention

- auto-organize tabs by smart grouping, domain, title similarity, or category
- split large tab sets into multiple windows with a max-tabs limit
- drag tabs between windows in a visual dashboard
- search and reopen active tabs quickly
- save a Read Later / TODO list
- find duplicate or stale tabs and clean them up
- restore the last saved session snapshot
- optional scheduled auto-organize

## Packaging

Create the upload ZIP from the extension root. Do not include `.git`.

Example:

```bash
cd /Users/zubinirani/Downloads/zeveloper/tab-organizer
zip -r ../tab-organizer-webstore.zip . -x "*.git*" -x "*.DS_Store"
```

## Submission notes

- The `tabs` permission is justified because the extension organizes, searches, reorders, closes, restores, and moves tabs between windows.
- The `storage` permission is justified because settings, snapshots, and Read Later items are saved locally.
- The `alarms` permission is justified because scheduled organization is a user-facing feature.
- Do not add extra permissions unless a feature truly requires them.

## After each update

1. Increase the version in `manifest.json`
2. Rebuild the ZIP
3. Upload the new package in the Chrome Web Store Developer Dashboard
