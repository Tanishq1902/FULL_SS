# 📐 SPEC.md — Scroll Region Capture

The full specification for this extension: what it does, how it is built, and — for the
parts that took several attempts to get right — **why** it is built that way.

This document describes the software as it currently stands. Where something is
deliberately absent, it says so. Where something is a known gap, it says that too.

---

## 🧭 Ground rules

These constraints define the project. Any change that breaks one of them is the wrong
change.

- **Plain files only.** No npm, no bundler, no TypeScript, no build step. The folder must
  stay loadable directly via `chrome://extensions` → Load unpacked.
- **No external libraries.** Everything with built-in browser APIs.
- **No site-specific selectors.** Not one hardcoded class name from any website.
- **No network requests of any kind.** No cloud upload, no analytics, no telemetry.
- **Minimal permissions.** `activeTab` and `scripting`. Nothing else, ever.
- **Comment generously.** Every function gets a short comment saying what it does and
  why. Prefer clear, boring code over clever code.

---

## 1. 🎯 What this extension does

A general-purpose scrolling region screenshot tool. The user drags a rectangle over any
part of any webpage, adjusts it, then drags handles up or down to extend the capture
through scrolling content. The result is one tall PNG containing only the selected column
of content.

The point of difference from existing extensions: those capture the *entire page* top to
bottom. This captures **an arbitrary region starting and ending wherever the user
chooses** — for example, questions 3 through 9 of a 100-question chat transcript.

It works on any site: chat interfaces (Claude, ChatGPT, Gemini), articles, documentation,
dashboards.

### 🚫 Non-goals

- No annotation, blurring, or editing tools.
- No cloud upload, no analytics, no network requests.
- No horizontal scroll capture (vertical only).

---

## 2. 🕹️ User flow

1. User clicks the extension's toolbar icon, or presses `Alt+Shift+S` (a
   `_execute_action` command in the manifest, delivered as if the icon had been
   clicked). The page dims slightly; a crosshair cursor
   appears; an instruction bar shows at the top of the screen.
2. User drags a rectangle over the region of interest — or clicks once inside a
   scrolling area to select the whole of it, top to bottom, with no dragging
   (see 4.10). On release the rectangle stays
   fixed on screen with a visible border, a **pill handle centred on its top and bottom
   edges**, and **six resize grips** (four corners, left and right sides).
3. The box can be adjusted before capturing:
   - Dragging **inside** it moves the whole box.
   - Dragging a **grip** resizes it from that edge or corner.
   - Any such edit **resets the marked scroll range** and re-detects the scroll
     container, because a box that has moved may sit over a different scrolling element,
     and a range recorded against the old position no longer describes a rectangle that
     exists.
4. User presses a pill and drags it away from the box.
   - The dragged edge follows the cursor; the opposite edge and both sides never move.
     The box is a fixed window on the screen; content moves behind it.
   - Once the cursor comes within `EDGE_ZONE` (120px) of the top or bottom of the
     viewport, the scrollable content underneath begins scrolling in that direction.
     Speed ramps with distance: `SLOW_SPEED` (2px/frame) at the threshold rising to
     `FAST_SPEED` (35px/frame) at the very edge, driven by `requestAnimationFrame`.
   - Both pills can be used, in either order. The capture covers the full range of scroll
     positions visited (`rangeTop` … `rangeBottom`).
5. User presses `Enter`, or clicks **Capture**.

    > Capture is an explicit step rather than something that happens on handle release,
    > because with two handles a release cannot mean "done" — the user may still want to
    > extend the other way.

    The bar also has a **Full page** button: one click selects the scrolling area behind
    the middle of the screen at its natural width and captures it top to bottom
    immediately, replacing any drawn box and skipping `Enter`.

6. A progress card appears: one dot per screenshot filling in as they are taken, an exact
   progress bar, a count, and — when the image will exceed one canvas — a warning stating
   how many files it will be split into.
7. The stitched PNG (or PNGs) download automatically and are copied to the clipboard. The
   page's original scroll position is restored and every overlay element is removed,
   apart from a small result panel offering to copy again.

`Esc` cancels at any point — including mid-capture — and cleans up completely.

---

## 3. 🏗️ Architecture

Three files:

- **`src/background.js`** — service worker. Two jobs only: inject the content script when
  the toolbar icon is clicked, and respond to `CAPTURE_VIEWPORT` messages by calling
  `chrome.tabs.captureVisibleTab`. Nothing else lives here.
- **`src/overlay.js`** — content script. Owns everything else: the overlay UI, the drag
  and resize logic, the scroll logic, cropping, stitching, splitting, saving and
  clipboard. It has DOM access, so canvas work belongs here.
- **`src/overlay.css`** — styles for the overlay.

Injection uses `chrome.scripting.executeScript` on toolbar click with the `activeTab`
permission, rather than a declared `content_scripts` block. This means the extension has
zero access to any page until the user explicitly clicks the icon — important for a
public extension people must trust.

### manifest.json

Manifest V3. Permissions: `activeTab`, `scripting`. Nothing else. Not `<all_urls>`, not
`tabs`, not `host_permissions`. Downloads happen via an object URL and a synthetic anchor
click from the content script, so the `downloads` permission is not needed either.
The `commands` block declares `_execute_action` on `Alt+Shift+S`, which needs no
permission and reuses the toolbar-click injection path unchanged.

### Overlay hygiene

- Root overlay element: `position: fixed; inset: 0; z-index: 2147483647`.
- Every injected element carries a `src-capture-` prefixed class name, so page CSS cannot
  accidentally style it and vice versa. Every CSS property is `!important`, because some
  sites set rules aggressive enough (`div { all: unset }`) to wreck the overlay.
- Overlay children have an explicit `z-index` order — bar above box, result panel above
  everything — so a handle can never paint over the instruction text.
- The whole file is wrapped in an IIFE: the script is injected again on every icon click,
  and a top-level `const` would throw "already declared" the second time.
- Double injection is guarded: if the overlay already exists, clicking the icon removes it
  and exits rather than stacking a second one.
- All injected DOM, event listeners, timers and animation frames are removed on completion
  or cancellation.

---

## 4. 🧠 The hard parts

Each of these caused a real, visible bug during development. The reasoning is recorded so
nobody has to rediscover it.

### 4.1 Finding what actually scrolls

On chat sites the scrolling element is usually an inner `div`, not the window.
`window.scrollBy` does nothing there. This is the single most likely cause of total
failure.

With the overlay temporarily set to `pointer-events: none`, take the centre point of the
user's box, call `document.elementFromPoint` (stepping into shadow roots where present),
then walk up the ancestor chain. Return the first ancestor whose computed `overflow-y` is
`auto`, `scroll`, or `overlay` **and** whose `scrollHeight` exceeds its `clientHeight` by
more than a few pixels. If nothing matches, fall back to `document.scrollingElement`.

One `getScrollTop(container)` / `scrollContainerTo(container, top)` pair handles both
cases — `window.scrollTo` when the container is the document scrolling element,
`container.scrollTop` otherwise. They are used everywhere, so the two cases never diverge.

### 4.2 The capture column, and why steps are screen-sized

A screenshot only advances the capture by as much **content** as it contains. Cropping
each shot to the user's box would mean scrolling only a box-height between shots, so a
short box would need many more screenshots than a tall one for the same region — capture
time scaling with box size, which is the wrong shape for the tool.

So each screenshot is cropped to the **full visible height of the scrolling area** at the
box's width, and the page steps a screenful at a time. The box's top and bottom edges only
determine where the *first* strip starts and the *last* one ends.

The column is clamped to the scroll container's visible rectangle
(`getColumnRect`). Content outside that rectangle does not move when the container
scrolls, so including it would stamp the same static band down the image repeatedly. When
the window itself is the scroller, that rectangle is the whole viewport, which is the best
case. If the rectangle is degenerate or barely overlaps the box, the code falls back to
the box's own rectangle — correct, just slower.

### 4.3 The capture pass

Triggered by `Enter` or the Capture button, never during a drag. Chrome throttles
`captureVisibleTab` to about two calls per second; capturing live during a drag produces
gaps in the output.

For each stop, from `rangeTop` down to `rangeBottom` in increments of the current stride:

1. Scroll the container to the target offset.
2. Wait `SETTLE_DELAY` (350ms) plus two animation frames, then wait until the container
   has actually stopped moving.
3. Wait out the screenshot rate limit **now**, while the page is still free to move.
   Doing this after measuring the scroll position would leave a window in which the page
   could shift between the measurement and the photograph.
4. Hide the overlay (`visibility: hidden`) and wait two frames, or the selection border
   and progress card get baked into every strip.
5. Read where the container **actually** is — the requested position and the real one
   often differ.
6. Message the service worker for a viewport capture; await the data URL.
7. Restore the overlay, crop, align, draw.

Smooth scrolling is forced off (`scroll-behavior: auto`) for the duration, or the page
would be photographed mid-animation at a position that is not the one requested.

The last stop is clamped exactly to `rangeBottom`, so the output ends precisely where the
user released. The loop also ends early if the container refuses to scroll any further,
and is bounded by `MAX_STRIPS` (400) so it can never run away. Every strip is checked
against the viewport size, zoom and pixel ratio from the start of the pass — a window
that is resized, zoomed, or moved to a differently-scaled display mid-capture stops the
pass with a plain message rather than stitching a silently broken image.

### 4.4 Device pixel ratio

`captureVisibleTab` returns an image at the display's device pixel ratio. On a high-DPI
screen a 1400px-wide viewport comes back as a 2800px-wide image. The user's box
coordinates are in CSS pixels.

Every crop coordinate is multiplied by `window.devicePixelRatio` when reading from the
captured image, and the output canvas stays at full device resolution — never downscaled.
Getting this wrong produces images that are cropped in the wrong place and look correct
only on non-retina displays, so test it explicitly.

`createImageBitmap` is used on the captured blob rather than an `<img>` element with an
`onload` handler; it can be awaited directly and can crop while decoding.

### 4.5 Seam alignment

Where a strip belongs is predicted from the scroll position, but pages do not always
honour a scroll request exactly: lazy-loaded images resize things, chat apps re-render,
smooth scrolling lands late. A few pixels out and lines of text appear duplicated at the
seam.

So the prediction is checked against the pixels. An `ALIGN_BAND` (28) row band of the new
strip is compared against the image already drawn, sliding ±`ALIGN_SEARCH` (120) device
pixels to find the best match, scoring by mean absolute difference on a subsampled grid.

Two safety rails:

- A band with less than `ALIGN_MIN_DETAIL` variation is featureless background and would
  match anywhere, so it is never aligned on.
- A best match worse than `ALIGN_MAX_ERROR` means the overlap does not really hold the
  same content; the scroll estimate is used instead and a warning is logged.

Corrections accumulate into a running `drift`, so a correction found at one seam carries
forward instead of being rediscovered at every seam below it.

### 4.6 Edge fades, and the adaptive trim

Many apps fade content out at the edges of their scrolling area — Claude's chat does it at
both ends, with a gradient mask under the header and another above the message box. Those
faded rows are real pixels in the screenshot. Drawing them puts a washed-out, duplicated
band at every seam, **and** defeats the seam matcher, which was matching faded rows
against crisp ones and scoring them as "no match".

The fix has two halves:

1. **Trim.** Rows are dropped from the top and bottom of each strip; the neighbouring
   strip always holds a crisp copy of the same content. The first strip keeps its top and
   the last keeps its bottom, since those are the edges the user chose.
2. **Measure.** The overlap region holds the same content twice — crisp in one strip,
   possibly faded in its neighbour. Rows that *disagree* are faded rows, and the deepest
   disagreement marks where the fade ends. Only the outer half of the overlap is scanned
   from each side, so the top-fade scan can never wander into the bottom fade.

The pass starts cautious (`MAX_TRIM`, 60px each end), measures at the first seam, then
resizes every later strip to fit. Pages that fade nothing — most of them — drop to a 6px
trim and a much smaller overlap, and so need noticeably fewer screenshots. If the
measurement cannot be trusted (the alignment was not confident, or the fade fills the
probe), the cautious numbers are kept and that is logged.

The overlap must hold both trims and still leave `MATCH_MARGIN` (60px) for the matcher,
while fitting comfortably inside the column. Where those demands collide, the column wins
and the trims are scaled down.

### 4.7 Sticky and fixed elements

A sticky nav bar stays glued to the top of the viewport, so it appears in *every* strip
and stacks up down the finished image.

For a multi-strip capture, `fixed` and `sticky` elements that overlap the box horizontally
are set to `visibility: hidden` for the duration, revealing the real content underneath.
`visibility` rather than `display`, so nothing on the page reflows between strips.

Two exclusions matter:

- Anything that **contains the scroll container** is spared. Chat apps often make the
  whole app shell fixed, and hiding it would blank the page.
- Anything taller than 60% of the viewport is spared, on the grounds that it is a layout
  wrapper rather than a bar.

Single-shot captures skip this entirely — with nothing to repeat, the image should look
exactly like the screen did.

### 4.8 Stitching, and the canvas height limit

Chrome canvases fail above roughly 32,767 pixels in either dimension, and — the dangerous
part — **a canvas past the limit returns a blank image rather than throwing**.

So the image is built in pages of at most `MAX_PAGE_HEIGHT` (30,000) device pixels. When a
strip would run off the end of the current page, that page is cut **exactly at the strip's
first row**, so the two files join with nothing missing and nothing repeated. The finished
page is trimmed to its filled height, encoded, downloaded and released before the next
page begins — a full page is well over a hundred megabytes, so it is not kept around.

Output files are `<page-title>-<timestamp>.png`, or `-part-1.png`, `-part-2.png` and so on
when split. The user is told about a split before the first screenshot is taken, since the
part count can be predicted from the marked range.

### 4.9 Restoring the page

A capture temporarily changes the page: `scroll-behavior` is forced to `auto`, sticky
elements are hidden, and the container is scrolled around. Every one of those is undone in
a `finally` block, so a successful finish, a thrown error and an `Esc` all leave the page
exactly as it was found — including the scroll position it started at.

### 4.10 Whole-container selection

Clicking without dragging (a release smaller than `MIN_DRAG`) selects the whole
scrolling area behind the cursor instead of resetting to the empty state. The scroll
container is found with the usual 4.1 lookup at the click point; the box becomes its
visible rectangle (the full viewport when the page itself scrolls), and the range
becomes its full scroll height, `0` to `getMaxScrollTop` — the pill-dragging step is
skipped entirely.

Capture stays an explicit step: the box is shown with its handles, the bar reads
"Whole area selected", and `Enter` starts the pass as usual, so a stray click can
never fire off screenshots by itself. Moving or resizing such a box re-detects the
container and keeps the full height (`wholeContainer` flag) rather than resetting
the range, so the box can be narrowed to a column and still capture top-to-bottom.
Drawing a fresh box clears the flag and returns to manual ranging. A click somewhere
too small to be useful still resets, exactly as before.

The bar's **Full page** button is the same path without the confirmation: it calls
`selectWholeContainer` at the middle of the screen and starts the pass at once,
replacing any drawn box. It only runs from `idle` or `ready` — never mid-drag and
never while a capture is in flight. The button needs no visibility handling: it lives
in the bar, which is hidden as a whole during capturing and after finishing.

---

## 5. ⚙️ Tuning constants

All at the top of `src/overlay.js`. CSS pixels unless stated.

| Constant | Default | Purpose |
|---|---|---|
| `EDGE_ZONE` | 120 | Distance from the screen edge at which auto-scroll begins |
| `SLOW_SPEED` / `FAST_SPEED` | 2 / 35 | Scroll speed ramp, px per animation frame |
| `MIN_DRAG` | 12 | Below this, a drag counts as a click and selects the whole area behind it |
| `MIN_BOX_WIDTH` / `MIN_BOX_HEIGHT` | 40 / 40 | Smallest the box can be resized to |
| `MAX_OVERLAP` | 180 | Most that consecutive screenshots overlap |
| `MAX_TRIM` | 60 | Most that can be trimmed from a strip edge |
| `TRIM_MARGIN` | 6 | Spare pixels added to a measured fade |
| `MATCH_MARGIN` | 60 | Overlap reserved for the seam matcher |
| `SETTLE_DELAY` | 350 | Pause after scrolling, for repaint and lazy loading |
| `CAPTURE_GAP` | 650 | Minimum ms between screenshots |
| `MAX_PAGE_HEIGHT` | 30000 | Device pixels per file before splitting |
| `MAX_STRIPS` | 400 | Hard stop on the capture loop |
| `RESULT_TIMEOUT` | 20000 | How long the result panel lingers |
| `ALIGN_BAND` | 28 | Rows matched at each seam (device px) |
| `ALIGN_SEARCH` | 120 | Search range either side of the prediction (device px) |
| `ALIGN_MIN_DETAIL` | 6 | Below this a band is featureless and not trusted |
| `ALIGN_MAX_ERROR` | 26 | Above this a best match is not a real match |
| `FADE_ROW_DIFFERENCE` | 10 | Row difference above which two rows are "not the same" |

`MIN_GAP_BETWEEN_CAPTURES` (600ms) in `src/background.js` is a second, independent guard
on the same rate limit.

---

## 6. ✅ Acceptance tests

Run these before shipping any change:

1. A long Wikipedia article — the window itself scrolls.
2. A long Claude or ChatGPT conversation — an inner div scrolls, with edge fades at both
   ends of the message area.
3. A page with a sticky header, verifying the header does not repeat down the image.
4. A high-DPI display, verifying the crop lands where the box was drawn.
5. A selection long enough to trigger the multi-part split, verifying the join between
   part 1 and part 2 has nothing missing or repeated.
6. Capturing twice in a row without reloading the page.
7. Moving and resizing the box, then capturing — the output matches its final position.
8. Extending upward, then downward, then capturing — the output spans the whole range.
9. Pressing `Esc` mid-drag and mid-capture, then starting over cleanly.
10. Confirming the page's scroll position is exactly where it started afterwards.
11. A short box (200px) over a long range — the screenshot count should be close to that
    of a tall box over the same range, not several times higher.
12. `Alt+Shift+S` opens the overlay without touching the toolbar icon.
13. Clicking (no drag) inside a chat thread selects the whole thread; narrowing the box
    keeps the full height; `Enter` captures it top to bottom.
14. Resizing the window or zooming mid-capture stops the pass with a plain message —
    no broken PNG, and the page's scroll position is restored.

Console logging is deliberately verbose and is the first diagnostic tool: it reports the
chosen scroll container, the column, the stride, the measured fade, every seam nudge, any
alignment fallback, each saved file, and the final dimensions.

---

## 7. 🚧 Known gaps

Honest limitations, not bugs to be surprised by:

- **iframes.** Content inside an `<iframe>` will not scroll. `elementFromPoint` returns
  the frame element and reaching inside needs broader injection permissions, which would
  weaken the `activeTab` privacy story.
- **Sticky bars inside shadow DOM** are not hidden; the scan only walks the light DOM.
- **Virtualised lists** can genuinely re-render between screenshots. When the seam
  matcher cannot find a confident match it refuses the match and falls back to the
  scroll-position estimate, which is safe but not always pixel-perfect.
- **Whole-area click on a page-scrolled article** selects the full viewport width. Narrow
  the box first if you only want the article column — the full height is kept.
- **The first strip's top and the last strip's bottom are never trimmed**, so if the user
  places an edge inside a page's fade zone, that fade appears in the output. This is
  deliberate: those two edges are what the user chose.
- **A page boundary in a split capture** is placed at a strip boundary and is not
  re-aligned across files.
- **Icons.** `manifest.json` declares none, so Chrome shows the default puzzle piece. A
  16/48/128px set is needed before any store submission.
- **Clipboard.** The automatic copy can be refused if the window loses focus during a long
  capture; the result panel's Copy button is the fallback. Only the first part of a split
  capture is copied.

---

## 8. 📄 Licence

MIT. Intended for public release on GitHub, so keep permissions minimal and the code
readable.
