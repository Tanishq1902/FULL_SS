# Scroll Region Capture — Chrome Extension

Capture a scrolling region of any page as one tall PNG. Drag a box, drag it down, get a screenshot.

Unlike existing tools that capture the entire page from top to bottom, this captures **an arbitrary region starting and ending wherever you choose** — for example, questions 3 through 9 of a 100-question chat transcript.

Works on any site: Claude, ChatGPT, Gemini, Wikipedia, docs, dashboards. No site-specific selectors.

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue) ![License MIT](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Arbitrary region capture** — drag any rectangle, extend it vertically through scrolling content
- **Universal scroll detection** — automatically finds the real scroll container (inner `div` or `window`)
- **High-DPI aware** — preserves full device pixel ratio, no blurry crops on Retina displays
- **Seamless stitching** — overlaps strips by 40px+ and trims faded edge rows to avoid white-line seams and duplicated fade bands
- **Smart alignment** — pixel-level seam matching corrects for lazy-loaded content shifting scroll positions
- **Sticky-header handling** — temporarily hides fixed/sticky bars that would otherwise repeat down the image
- **Minimal permissions** — only `activeTab` + `scripting`, no `<all_urls>`, no network requests

---

## Install (Load Unpacked)

1. Clone this repo or download as ZIP and extract:
   ```bash
   git clone https://github.com/Tanishq1902/FULL_SS.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked** → select the project folder (the one containing `manifest.json`)
5. Pin the extension to your toolbar if you like

No build step, no npm, no bundler — plain files loadable directly.

---

## How to Use

1. Click the extension icon in the toolbar — the page dims and cursor becomes a crosshair
2. **Drag** a rectangle over the region you want
3. A blue box with a handle on its bottom edge appears
4. **Drag the handle downward** — when near the viewport bottom, content auto-scrolls under the fixed box (speed ramps from ~2px to ~35px per frame)
5. **Release** the handle — capture runs automatically with progress text (`Capturing 3 of 12…`)
6. A stitched PNG downloads (`capture-YYYYMMDD-HHMMSS.png`) and the page scroll is restored
7. Press `Esc` at any time to cancel and clean up

---

## Project Structure

```
.
├── manifest.json      # Manifest V3 — activeTab + scripting only
├── src/
│   ├── background.js  # Service worker: injects overlay + handles captureVisibleTab
│   ├── overlay.js     # Content script: UI, drag, scroll, crop, stitch, download
│   └── overlay.css    # Overlay styles (all classes prefixed src-capture-)
├── SPEC.md            # Full product spec and build phases
└── LICENSE            # MIT
```

### Architecture

- **`src/background.js`** — tiny service worker. Two jobs only: `chrome.scripting.executeScript` injection on icon click, and `chrome.tabs.captureVisibleTab` in response to `CAPTURE_VIEWPORT` messages.
- **`src/overlay.js`** — everything else. DOM overlay, rectangle/handle logic, ramped edge-scroll via `requestAnimationFrame`, scroll-container detection (`elementFromPoint` + ancestor walk), capture loop, `devicePixelRatio` cropping via `createImageBitmap`, canvas stitching, and download via object URL.
- **`src/overlay.css`** — fixed fullscreen dim sheet (`z-index: 2147483647`), box with `box-shadow` cutout, handle, hint/label, and `.src-capture-invisible` for hiding UI during screenshots.

Injection uses `activeTab` so the extension has zero access until you click the icon.

---

## Permissions Explained

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab only after you click the icon |
| `scripting` | Inject the overlay CSS/JS once |

No `host_permissions`, no `tabs`, no `downloads` (download uses a synthetic anchor click), no analytics, no network calls.

---

## Development

Reload after editing:

1. `chrome://extensions` → click the refresh icon on the extension card
2. Reload the test page

Test checklist (from `SPEC.md`):

- [ ] Long Wikipedia article (window scrolls)
- [ ] Long Claude/ChatGPT thread (inner div scrolls)
- [ ] Page with sticky header (header should not repeat)
- [ ] High-DPI display (crop at correct coordinates)
- [ ] Very long selection (split at 30,000px)
- [ ] Capture twice without reloading
- [ ] `Esc` mid-drag then restart
- [ ] Scroll position restored after capture

---

## License

MIT © 2026 Sadaram Tanishq — see [LICENSE](LICENSE).
