# SPEC.md — Scroll Region Capture (Chrome Extension)

## Context for the assistant

The person building this is a beginner with no JavaScript background. Follow these rules
throughout:

- **Plain files only.** No npm, no bundler, no TypeScript, no build step. The folder must be
  loadable directly via `chrome://extensions` → Load unpacked.
- **No external libraries.** Everything with built-in browser APIs.
- **Comment generously.** Every function gets a short comment saying what it does and why.
- **Build in the phases below. Stop after each phase**, state exactly how to test it manually,
  and wait for confirmation before continuing.
- Prefer clear, boring code over clever code.

---

## 1. What this extension does

A general-purpose scrolling region screenshot tool. The user drags a rectangle over any part of
any webpage, then drags a handle downward to extend the capture through scrolling content. The
result is one tall PNG containing only the selected column of content.

The point of difference from existing extensions: those capture the *entire page* top to bottom.
This captures **an arbitrary region starting and ending wherever the user chooses** — for example,
questions 3 through 9 of a 100-question chat transcript.

It must work on any site: chat interfaces (Claude, ChatGPT, Gemini), articles, documentation,
dashboards. No site-specific selectors or hardcoded class names anywhere.

Intended for public release on GitHub under the MIT licence, so keep permissions minimal and the
code readable.

### Non-goals

- No full-page capture mode.
- No annotation, blurring, or editing tools.
- No cloud upload, no analytics, no network requests of any kind.
- No horizontal scroll capture (vertical only).

---

## 2. User flow

1. User clicks the extension's toolbar icon.
2. The page dims slightly. A crosshair cursor appears.
3. User drags a rectangle over the region of interest. On release, the rectangle stays fixed on
   screen with a visible border and a **drag handle centred on its bottom edge**.
4. User presses the handle and drags downward.
   - While dragging, the box's bottom edge follows the cursor and the box grows.
   - Once the cursor comes within 120px of the bottom of the viewport, the scrollable content
     underneath begins scrolling. Scroll speed ramps with distance: gentle near the threshold,
     fast when the cursor is at the very bottom edge. Use `requestAnimationFrame`, roughly 2px
     per frame at the threshold rising to about 35px per frame at the edge.
   - The box's top edge and left/right edges never move. The box is a fixed window on the screen;
     content moves behind it.
5. User releases the mouse. The extension now knows the full scroll range covered.
6. A small progress indicator appears ("Capturing 3 of 12…"). The extension performs the capture
   pass described below.
7. The stitched PNG downloads automatically. The page's original scroll position is restored and
   all overlay UI is removed.

`Esc` cancels at any point and cleans up completely.

---

## 3. Architecture

Three pieces:

- `src/background.js` — service worker. Its **only** jobs: inject the content script when the
  toolbar icon is clicked, and respond to `CAPTURE_VIEWPORT` messages by calling
  `chrome.tabs.captureVisibleTab` and returning the data URL. Nothing else lives here.
- `src/overlay.js` — content script. Owns everything else: the overlay UI, the drag logic, the
  scroll logic, cropping, stitching, and triggering the download. It has DOM access, so canvas
  work belongs here.
- `src/overlay.css` — styles for the overlay.

Injection uses `chrome.scripting.executeScript` on toolbar click with the `activeTab` permission,
rather than a declared `content_scripts` block. This means the extension has zero access to any
page until the user explicitly clicks the icon — important for a public extension people must
trust.

### manifest.json

Manifest V3. Permissions: `activeTab`, `scripting`. Nothing else. Do **not** request
`<all_urls>`, `tabs`, or `host_permissions`. Downloads happen via an object URL and a synthetic
anchor click from the content script, so the `downloads` permission is not needed.

---

## 4. The hard parts — implement these carefully

### 4.1 Finding what actually scrolls

On chat sites the scrolling element is usually an inner `div`, not the window. `window.scrollBy`
does nothing there. This is the single most likely cause of total failure, so get it right.

With the overlay temporarily set to `pointer-events: none`, take the centre point of the user's
box, call `document.elementFromPoint`, then walk up the ancestor chain. Return the first ancestor
whose computed `overflow-y` is `auto`, `scroll`, or `overlay` **and** whose `scrollHeight` exceeds
its `clientHeight` by more than a few pixels. If nothing matches, fall back to
`document.scrollingElement`.

Write one `scrollTo(container, top)` helper that handles both cases: `window.scrollTo` when the
container is the document scrolling element, `container.scrollTop = top` otherwise. Use it
everywhere so the two cases never diverge.

### 4.2 The capture pass

Triggered on mouse release, not during the drag. Chrome throttles `captureVisibleTab` to about
two calls per second; capturing live during a drag produces gaps in the output.

During the drag, record `startScrollTop` (the container's scroll position when the drag began)
and `endScrollTop` (its position on release). Also record the box rectangle in CSS pixels relative
to the viewport.

Then:

1. Store the original scroll position for later restoration.
2. Compute `step = boxHeight - OVERLAP`, where `OVERLAP` is 40px. The overlap absorbs sub-pixel
   scroll rounding, which otherwise leaves thin white lines at every seam.
3. For each offset from `startScrollTop` to `endScrollTop` in increments of `step`:
   - Scroll the container to that offset.
   - Wait for two `requestAnimationFrame` ticks plus 250ms so the page can repaint and lazy-loaded
     content can appear.
   - Hide the overlay (`visibility: hidden`), or the selection border appears baked into every
     strip.
   - Message the service worker for a viewport capture; await the data URL.
   - Restore the overlay.
   - Crop the capture to the box rectangle (see 4.3) and push the result into an array.
   - Update the progress indicator.
4. The final strip will usually overshoot the endpoint. Clamp its height so the output ends
   exactly where the user released.
5. Restore the original scroll position.

### 4.3 Device pixel ratio

`captureVisibleTab` returns an image at the display's device pixel ratio. On a high-DPI screen a
1400px-wide viewport comes back as a 2800px-wide image. The user's box coordinates are in CSS
pixels.

Multiply every crop coordinate by `window.devicePixelRatio` when reading from the captured image.
Keep the output canvas at full device resolution — do not downscale. Getting this wrong produces
images that are cropped in the wrong place and look correct only on non-retina displays, so test
this explicitly.

Use `createImageBitmap` on the captured blob rather than an `<img>` element with an onload
handler; it's cleaner to await.

### 4.4 Stitching and the height limit

Draw each strip onto a canvas of width `boxWidth * dpr`, stacking vertically with the overlap
subtracted.

Chrome canvases fail above roughly 32,767 pixels in either dimension, and very large canvases can
fail earlier on total area. If the stitched height would exceed **30,000px**, split the output
into multiple canvases and download `capture-part-1.png`, `capture-part-2.png`, and so on. Tell
the user in the progress indicator that this is happening. Never fail silently — a canvas that
exceeds the limit returns a blank image rather than throwing.

### 4.5 Overlay hygiene

- Root overlay element: `position: fixed; inset: 0; z-index: 2147483647`.
- Give every injected element a distinctive prefixed class name (e.g. `src-capture-`) so page CSS
  can't accidentally style it and vice versa.
- Guard against double injection: if the overlay already exists when the icon is clicked, remove
  it and exit rather than stacking a second one.
- Remove all injected DOM and event listeners on completion or cancellation.

---

## 5. Build phases

**Phase 1 — Skeleton.** `manifest.json`, a service worker that logs on icon click, a content
script that gets injected and shows a dimmed overlay with a crosshair cursor. `Esc` removes it.
Nothing else. *Test: load unpacked, click the icon on any website, confirm the dim appears and Esc
clears it.*

**Phase 2 — Selection and scroll drag.** Rectangle drawing, the bottom handle, box growth, and
the ramped edge-scroll. Include the scroll-container detection from 4.1 and log which element it
picked. No capturing yet. *Test: draw a box on a long article and on a Claude chat, drag the
handle, confirm content scrolls smoothly under the fixed box on both.*

**Phase 3 — Capture and stitch.** The capture pass, cropping, DPI handling, stitching, download.
*Test: capture a short region, confirm the PNG contains exactly the selected content with no
visible seams and no selection border.*

**Phase 4 — Polish.** Progress indicator, the 30,000px split, scroll-position restoration,
double-injection guard, cleanup of listeners, `README.md` with install instructions, MIT
`LICENSE`, and a 128/48/16px icon set.

---

## 6. Acceptance tests

Confirm each of these before considering the project done:

1. A long Wikipedia article — the window itself scrolls.
2. A long Claude or ChatGPT conversation — an inner div scrolls.
3. A page with a sticky header, verifying the header does not repeat down the image.
4. A high-DPI display, verifying the crop lands where the box was drawn.
5. A selection long enough to trigger the multi-part split.
6. Capturing twice in a row without reloading the page.
7. Pressing `Esc` mid-drag, then starting over cleanly.
8. Confirming the page's scroll position is exactly where it started afterwards.
