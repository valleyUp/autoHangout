# Repository Guidelines

## Project Structure & Module Organization
`manifest.json` is the source of truth for the Chrome Extension entry points, permissions, and content-script matches. Core runtime logic lives in `background.js` (MV3 service worker), `content.js` (page automation on `https://linux.do/*`), and `offscreen.html` + `offscreen.js` (background keepalive ticks). The popup UI is split across `popup.html`, `popup.css`, and `popup.js`. Packaged assets live in `icons/`. Keep related changes grouped by feature so manifest, worker, and UI updates stay in sync.

## Build, Test, and Development Commands
This repository does not use `npm`, a bundler, or a generated build step. Develop directly from source:

- Load locally: open `chrome://extensions/`, enable Developer Mode, then choose **Load unpacked** and select this repo.
- Reload after edits: use the extension card’s **Reload** button, then refresh the target `linux.do` tab.
- Inspect changes: `git status` and `git diff --stat`
- Review recent conventions: `git log --oneline -5`

## Coding Style & Naming Conventions
Use plain JavaScript with 2-space indentation, semicolons, and descriptive `camelCase` names for variables and functions. Reserve `UPPER_SNAKE_CASE` for constants such as timing thresholds and storage keys. Match file names to Chrome extension roles (`background.js`, `content.js`, `popup.js`) and keep console prefixes explicit, for example `[AutoHangout BG]`, so logs remain traceable across contexts.

## Testing Guidelines
There is no automated test suite in the repo today; changes require manual validation in Chrome. At minimum, verify popup start/stop behavior, scrolling on `linux.do`, background behavior when the tab is unfocused or minimized, and any state persisted through `chrome.storage`. Re-test install/update flows when changing `manifest.json`, `chrome.debugger`, `offscreen`, or permissions.

## Commit & Pull Request Guidelines
Follow the commit style already used in history: `feat:`, `fix:`, `docs:`. Keep subjects imperative and behavior-focused, for example `fix: correct debugger attachment state management`. PRs should include a short summary, manual test notes, linked issues when applicable, and screenshots or recordings for popup/UI changes. Call out any permission or host-matching changes in `manifest.json` explicitly.

## Security & Configuration Notes
Keep `host_permissions` as narrow as possible and avoid broadening access beyond `https://linux.do/*` without justification. Treat changes involving `chrome.debugger`, tab control, and persisted browsing history as sensitive and document the user impact in the PR.
