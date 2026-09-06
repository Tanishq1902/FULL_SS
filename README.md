# 📸 Scroll Region Capture

**Screenshot part of a scrolling page — not the whole thing.**

Draw a box around what you want, drag it through scrolling content, get one tall PNG with just that part. Works on any site — Claude, ChatGPT, Wikipedia, docs, dashboards — with no setup.

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![License MIT](https://img.shields.io/badge/license-MIT-green)
![No build step](https://img.shields.io/badge/build-none-lightgrey)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

---

## 🎬 Demo

<!-- Record a short GIF and save it as docs/demo.gif, then uncomment: -->
<!-- ![Demo](docs/demo.gif) -->

_A short GIF goes here — a chat thread or long article shows it best._

---

## ✨ What it can do

- 🎯 Capture **any rectangle**, extended through as much scrolled content as you like (up or down)
- 📦 **Click once** inside a chat/article to select the whole scrolling area — no dragging
- ⚡ **Full page button** captures the main scrolling area in one click
- ✏️ Move and resize the box before capturing (corners + sides)
- 🔍 Finds the real scroller automatically (window or inner `div`)
- 🖥️ Sharp on retina displays, 🧵 seamless joins, 🌫️ handles faded edges, 📌 hides sticky headers so they don't repeat
- ✂️ Very tall captures auto-split into numbered PNGs
- 📋 Downloads **and** copies to clipboard
- ⌨️ Shortcut: `Alt+Shift+S`
- 🔒 Only asks for `activeTab` + `scripting`. No tracking, no network requests.

---

## 🚀 Install (30 seconds)

Not on the Chrome Web Store yet — load it unpacked:

```bash
git clone https://github.com/Tanishq1902/Scroll_Capture.git
```

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the folder containing `manifest.json`
4. Pin it (puzzle icon 🧩 → pin **Scroll Region Capture**)

No npm, no build. Works in Chrome, Edge, Brave, Arc, Opera — anything with Manifest V3.

---

## 🕹️ How to use

1. Click the toolbar icon (or press `Alt+Shift+S`). The page dims.
2. **Drag a box** over what you want — or **click once** to grab the whole scrolling area.
3. Optional: drag inside to move, drag the squares to resize.
4. To include scrolled content: drag the **bottom pill down** (or top pill up). Near the screen edge, the page auto-scrolls behind the box.
5. Press `Enter` (or click **Capture**). The PNG downloads and copies to clipboard.

> Tip: position and size the box first, *then* extend it — moving/resizing resets the marked scroll range.

### ⌨️ Keys

| Key | Action |
|---|---|
| `Alt+Shift+S` | Open overlay |
| `Enter` | Start capture |
| `Esc` | Cancel (works mid-capture too) |
| Click icon again | Close overlay |

### 📁 Output

```
wikipedia-article-20260902-143022.png
wikipedia-article-20260902-143022-part-1.png   # only if very tall
wikipedia-article-20260902-143022-part-2.png
```

---

## 🔐 Privacy

| Permission | Why |
|---|---|
| `activeTab` | Touch the current tab only after you click the icon |
| `scripting` | Inject the overlay once |

Not requested: `<all_urls>`, `tabs`, `storage`, `downloads`.

- No network requests, no analytics, no accounts. You can search the source — there are none (the only `fetch()` reads a local `data:` URL to build the PNG).
- Nothing leaves your browser.

---

## 🗂️ Files

```
manifest.json       # Manifest V3, activeTab + scripting only
src/background.js   # Injects overlay + takes screenshots
src/overlay.js      # UI, scrolling, stitching, saving
src/overlay.css     # Overlay styles (src-capture-* classes)
SPEC.md             # Full technical spec
```

See [SPEC.md](SPEC.md) for how scrolling, seams, fades, and splitting work, plus the tuning constants.

---

## 🚧 Limitations

- **iframes** don't scroll (would need broader permissions).
- Sticky bars inside **shadow DOM** aren't hidden.
- **Virtualised / infinite lists** may re-render mid-capture — seams fall back to the scroll estimate.
- Vertical scrolling only. `chrome://` pages and the Web Store block all extensions.
- If you switch windows mid-capture, auto-copy may fail — use the **Copy** button. Only part 1 of a split capture goes to clipboard.

---

## 🧪 Before you contribute

Quick manual check: a Wikipedia article (window scroll), a Claude/ChatGPT thread (inner scroll + fades), a sticky header, a retina screen, `Esc` mid-capture, and capture twice without reload. Full list in [SPEC.md](SPEC.md).

Roadmap highlights: icon set, wheel-forwarding while overlay is open, preview before save, JPEG/WebP/PDF, Firefox port.

Ground rules: **no build step, no libraries, no site-specific selectors, no network requests.** Every function gets a short why-comment. See [SPEC.md](SPEC.md) § Ground rules.

---

## 📄 License

MIT © 2026 Sadaram Tanishq — see [LICENSE](LICENSE).
