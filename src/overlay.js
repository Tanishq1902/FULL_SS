// overlay.js — the content script. background.js injects this into the page every
// time the toolbar icon is clicked.
//
// WHAT IT DOES, IN ORDER:
//   * dims the page and shows a crosshair
//   * lets the user drag out a selection rectangle
//   * gives that rectangle a drag handle on its bottom edge
//   * dragging the handle grows the box downward, and near the bottom of the screen
//     the page underneath starts scrolling, faster the closer to the edge
//   * works out WHICH element actually scrolls (the window, or an inner div)
//   * on release, photographs the region one screenful at a time, crops each shot to
//     the box, stitches them into one tall PNG and downloads it
//   * Esc cancels and cleans up at any point
//
// Still to come in phase 4: splitting very tall images into several files, and a
// tidier progress indicator.
//
// The whole file is wrapped in an IIFE — an immediately-invoked function — for one
// practical reason: this script gets injected again on every icon click, and a
// top-level `const` would throw "already declared" the second time round. Inside a
// function, every name is fresh and private.
(() => {
  "use strict";

  // Every class name and global we create is prefixed, so nothing can collide with
  // the page's own code or styles.
  const ROOT_CLASS = "src-capture-root";

  // We stash the teardown function on `window` so that a *later* injection (which is a
  // brand new run of this file, with no memory of this one) can still find it and
  // clean up properly. Content scripts get their own isolated `window`, so this is
  // invisible to the page.
  const CLEANUP_KEY = "__srcCaptureCleanup";

  // --- Double-injection guard -------------------------------------------------
  // Clicking the icon while the overlay is already up should dismiss it, not stack a
  // second dimmed sheet on top of the first.
  if (document.querySelector("." + ROOT_CLASS)) {
    console.log("[scroll-region-capture] overlay already open — closing it");
    if (typeof window[CLEANUP_KEY] === "function") {
      window[CLEANUP_KEY]();
    } else {
      // Belt and braces: if the cleanup function went missing somehow, at least get
      // the visible element off the screen.
      document.querySelectorAll("." + ROOT_CLASS).forEach((el) => el.remove());
    }
    return;
  }

  // --- Tuning numbers ---------------------------------------------------------
  // All in CSS pixels. Named constants rather than magic numbers sprinkled about.

  const EDGE_ZONE = 120; // start auto-scrolling within this many px of the viewport bottom
  const SLOW_SPEED = 2; // px per frame at the top edge of that zone
  const FAST_SPEED = 35; // px per frame with the cursor at the very bottom
  const MIN_DRAG = 12; // a drag smaller than this counts as a stray click, not a selection
  const MIN_BOX_HEIGHT = 40; // the handle can never shrink the box below this

  // How much each captured strip repeats the one above it. The overlap does two jobs:
  // it absorbs sub-pixel scroll rounding (which would otherwise leave thin white lines
  // at the seams), and it gives us spare pixels to throw away — see TRIM below.
  const MAX_OVERLAP = 180;

  // How much is discarded from the top and the bottom of each strip rather than drawn.
  //
  // Many apps fade content out at the edges of their scrolling area — Claude's chat
  // does it at both ends, with a gradient mask under the header and another above the
  // message box. Those faded rows are real pixels in the screenshot, and drawing them
  // puts a washed-out, duplicated band at every seam. The neighbouring strip always has
  // a crisp copy of the same content, so the honest fix is to drop the faded rows and
  // let the neighbour's pixels stand.
  //
  // Two exceptions: the first strip keeps its top and the last keeps its bottom, since
  // those are the edges the user actually chose.
  //
  // The overlap has to cover both trims and still leave a margin for seam matching,
  // which is why it is three times the trim.
  const MAX_TRIM = 60;

  // After scrolling, how long to let the page settle before photographing it. Two
  // animation frames for the browser to repaint, then a pause for lazily-loaded
  // images and fade-in animations to finish.
  const SETTLE_DELAY = 350;

  // Chrome allows roughly two screenshots a second. We pace ourselves to this gap so
  // that the wait happens BEFORE we look at the scroll position, not between looking
  // and shooting — during which the page could have moved.
  const CAPTURE_GAP = 650;

  // --- Seam alignment (all in device pixels, not CSS pixels) ------------------
  // Where a strip belongs is worked out from the scroll position, but pages do not
  // always honour a scroll request exactly: lazy-loaded images resize things, chat
  // apps re-render, smooth scrolling lands late. When that happens the seam is out by
  // a few pixels and lines of text appear duplicated. So rather than trusting the
  // number, each strip is nudged up and down until its top band actually lines up
  // with the image already drawn.
  const ALIGN_BAND = 28; // how many rows of the new strip to match on
  const ALIGN_SEARCH = 120; // how far up and down to look for the best match
  const ALIGN_MIN_DETAIL = 6; // bands flatter than this are blank; do not trust them
  const ALIGN_MAX_ERROR = 26; // above this the best match is not a real match

  // --- Mutable state ----------------------------------------------------------
  // "step" is a plain string describing what the user is doing right now. Keeping it
  // in one variable (instead of several booleans that can contradict each other)
  // makes the flow easy to follow.
  //   "idle"      – nothing drawn yet, waiting for the first drag
  //   "selecting" – the mouse is down, drawing the rectangle
  //   "ready"     – a box exists with a handle, waiting
  //   "extending" – the handle is being dragged downward
  //   "capturing" – the screenshot pass is running; the mouse is ignored
  let step = "idle";

  // Set by cleanup(). The capture pass is a long chain of awaits, and after every one
  // of them it checks this flag so that Esc stops the work promptly instead of
  // carrying on against a page that has already been tidied up.
  let cancelled = false;

  // The selection rectangle, in CSS pixels relative to the viewport (not the page).
  // The box is a fixed window on the screen: content moves behind it, it never moves.
  let box = { left: 0, top: 0, width: 0, height: 0 };

  let anchorX = 0; // where the selection drag started
  let anchorY = 0;
  let pointerY = 0; // latest cursor Y, read by the auto-scroll loop each frame

  let scrollContainer = null; // the element that actually scrolls behind the box
  let startScrollTop = 0; // its scroll position when the selection was made
  let endScrollTop = 0; // its scroll position when the handle was released
  let animationFrame = null; // id of the running auto-scroll loop, or null

  // --- Build the overlay ------------------------------------------------------

  // The root: a fixed, full-screen sheet above all page content.
  const root = document.createElement("div");
  root.className = ROOT_CLASS;
  // tabindex lets us focus the overlay. Focusing matters: if the user's keyboard
  // focus is sitting inside a text box (or an iframe), our Esc listener might never
  // hear the key press. Taking focus ourselves makes Esc reliable.
  root.tabIndex = -1;

  // The instruction line pinned to the top of the screen.
  const hint = document.createElement("div");
  hint.className = "src-capture-hint";

  // The selection rectangle, hidden until the user starts dragging.
  const boxEl = document.createElement("div");
  boxEl.className = "src-capture-box src-capture-hidden";

  // The grab handle lives inside the box, centred on its bottom edge.
  const handleEl = document.createElement("div");
  handleEl.className = "src-capture-handle src-capture-hidden";
  boxEl.append(handleEl);

  // A small readout showing the box size and how far we have scrolled.
  const labelEl = document.createElement("div");
  labelEl.className = "src-capture-label src-capture-hidden";

  root.append(hint, boxEl, labelEl);
  document.documentElement.append(root);
  // Focus after insertion, or there is nothing to focus yet.
  root.focus({ preventScroll: true });

  // --- Small helpers ----------------------------------------------------------

  // Sets the instruction text, always followed by the "Esc to cancel" reminder.
  // Built from text nodes rather than innerHTML — no HTML parsing, nothing injectable.
  function setHint(message) {
    hint.textContent = "";
    hint.append(message + "  ·  ");
    const key = document.createElement("span");
    key.className = "src-capture-key";
    key.textContent = "Esc";
    hint.append(key, " to cancel");
  }

  // Keeps a number inside a range. Used by the scroll-speed ramp.
  function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  // Shows or hides one of our elements. See .src-capture-hidden in the CSS for why
  // this is a class rather than the `hidden` attribute.
  function setVisible(element, visible) {
    element.classList.toggle("src-capture-hidden", !visible);
  }

  // Copies the current `box` numbers onto the rectangle element, and moves the readout
  // label just above it (or just below, if the box is at the very top of the screen).
  function drawBox() {
    boxEl.style.left = box.left + "px";
    boxEl.style.top = box.top + "px";
    boxEl.style.width = box.width + "px";
    boxEl.style.height = box.height + "px";

    labelEl.style.left = box.left + "px";
    labelEl.style.top =
      (box.top >= 24 ? box.top - 22 : box.top + box.height + 6) + "px";
  }

  // Updates the readout text: box size, plus the scroll distance once we have one.
  function drawLabel() {
    const size = Math.round(box.width) + " x " + Math.round(box.height) + " px";
    if (scrollContainer && step === "extending") {
      const scrolled = Math.round(getScrollTop(scrollContainer) - startScrollTop);
      labelEl.textContent = size + "  ·  scrolled " + scrolled + " px";
    } else {
      labelEl.textContent = size;
    }
  }

  // A short human-readable description of an element, for the console log.
  function describe(element) {
    if (!element) return "(none)";
    if (element === document.scrollingElement) return "the page itself (window scroll)";
    let text = element.tagName.toLowerCase();
    if (element.id) text += "#" + element.id;
    if (typeof element.className === "string" && element.className.trim()) {
      text += "." + element.className.trim().split(/\s+/).slice(0, 3).join(".");
    }
    return text;
  }

  // --- 4.1 Finding what actually scrolls --------------------------------------
  // On chat sites (Claude, ChatGPT, Gemini) the thing that scrolls is usually an inner
  // div, not the window — window.scrollBy does nothing there. So: look at what sits
  // underneath the centre of the user's box, then walk up its ancestors and return the
  // first one that is genuinely scrollable.

  // Returns the deepest element at a viewport point, ignoring our own overlay.
  function elementUnderPoint(x, y) {
    // Our overlay is on top of everything, so it would be the only thing we ever find.
    // Make it transparent to the mouse for the duration of this one lookup.
    root.classList.add("src-capture-root--passthrough");
    let element = document.elementFromPoint(x, y);
    root.classList.remove("src-capture-root--passthrough");

    // Some sites wrap their content in a shadow root, where elementFromPoint stops at
    // the outer host element. Step inside as far as we can.
    while (element && element.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element;
  }

  // Walks up from the given point and returns the nearest scrollable ancestor,
  // falling back to the page's own scrolling element.
  function findScrollContainer(x, y) {
    let element = elementUnderPoint(x, y);

    while (
      element &&
      element !== document.body &&
      element !== document.documentElement
    ) {
      const style = getComputedStyle(element);
      const scrollable = /^(auto|scroll|overlay)$/.test(style.overflowY);
      // "> 4" rather than "> 0": rounding means plenty of elements are a pixel or two
      // taller than their box without actually being scrollable.
      const hasRoom = element.scrollHeight - element.clientHeight > 4;
      if (scrollable && hasRoom) return element;
      element = element.parentElement;
    }

    // Nothing inner scrolls — it must be the page itself.
    return document.scrollingElement || document.documentElement;
  }

  // Is this container the page as a whole, rather than some inner div?
  function isPageScroller(container) {
    return (
      container === document.scrollingElement ||
      container === document.documentElement ||
      container === document.body
    );
  }

  // Reads the current scroll position. One helper covering both cases, used
  // everywhere, so the window and inner-div paths can never drift apart.
  function getScrollTop(container) {
    return isPageScroller(container) ? window.scrollY : container.scrollTop;
  }

  // The furthest down this container can scroll.
  function getMaxScrollTop(container) {
    if (isPageScroller(container)) {
      const doc = document.scrollingElement || document.documentElement;
      return Math.max(0, doc.scrollHeight - window.innerHeight);
    }
    return Math.max(0, container.scrollHeight - container.clientHeight);
  }

  // Scrolls the container to an absolute position. The partner of getScrollTop.
  function scrollContainerTo(container, top) {
    if (isPageScroller(container)) {
      window.scrollTo(0, top);
    } else {
      container.scrollTop = top;
    }
  }

  // --- Step 1: drawing the selection rectangle --------------------------------

  // Mouse pressed on the dimmed sheet: start a fresh rectangle. This also fires when a
  // box already exists, which is deliberate — it lets the user redraw without
  // cancelling first.
  function onRootMouseDown(event) {
    if (event.button !== 0) return; // left button only
    if (step === "capturing") return; // no redrawing while screenshots are being taken
    // The handle sits inside the root, and this listener runs in the capture phase, so
    // it sees handle presses first. Ignore those — they belong to onHandleMouseDown.
    if (event.target === handleEl) return;
    event.preventDefault();

    step = "selecting";
    anchorX = event.clientX;
    anchorY = event.clientY;
    box = { left: anchorX, top: anchorY, width: 0, height: 0 };

    setVisible(boxEl, true);
    setVisible(handleEl, false); // no handle until the drag is finished
    setVisible(labelEl, true);
    root.classList.add("src-capture-root--cutout");
    drawBox();
    drawLabel();

    document.addEventListener("mousemove", onSelectMove, true);
    document.addEventListener("mouseup", onSelectUp, true);
  }

  // While drawing: the rectangle spans from the anchor to the cursor, in whichever
  // direction the user drags.
  function onSelectMove(event) {
    box.left = Math.min(anchorX, event.clientX);
    box.top = Math.min(anchorY, event.clientY);
    box.width = Math.abs(event.clientX - anchorX);
    box.height = Math.abs(event.clientY - anchorY);
    drawBox();
    drawLabel();
  }

  // Mouse released: either accept the rectangle, or treat a tiny drag as a stray click.
  function onSelectUp() {
    document.removeEventListener("mousemove", onSelectMove, true);
    document.removeEventListener("mouseup", onSelectUp, true);

    if (box.width < MIN_DRAG || box.height < MIN_DRAG) {
      // Too small to be meaningful — go back to the empty state.
      step = "idle";
      setVisible(boxEl, false);
      setVisible(labelEl, false);
      root.classList.remove("src-capture-root--cutout");
      setHint("Drag to select a region");
      return;
    }

    step = "ready";
    setVisible(handleEl, true);

    // Work out what scrolls behind the middle of the box, and remember where that
    // container is scrolled to right now. This is the top of the capture range.
    scrollContainer = findScrollContainer(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    startScrollTop = getScrollTop(scrollContainer);
    endScrollTop = startScrollTop;

    console.log(
      "[scroll-region-capture] selection made:",
      {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      "| scroll container:",
      describe(scrollContainer),
      "| scrollTop:",
      Math.round(startScrollTop),
      "| max scroll:",
      Math.round(getMaxScrollTop(scrollContainer)),
      scrollContainer
    );

    setHint("Drag the handle down to extend through scrolling content");
    drawLabel();
  }

  // --- Step 2: dragging the handle, and the ramped edge-scroll ----------------

  // Handle pressed: begin extending. stopPropagation keeps this from also starting a
  // brand new selection on the sheet underneath.
  function onHandleMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    step = "extending";
    pointerY = event.clientY;

    document.addEventListener("mousemove", onExtendMove, true);
    document.addEventListener("mouseup", onExtendUp, true);

    // Start the loop that does the scrolling. It runs every frame until release, so
    // the page keeps scrolling even when the cursor is held perfectly still.
    animationFrame = requestAnimationFrame(autoScrollStep);
  }

  // While extending: only the bottom edge moves. Top, left and right stay put — the
  // box is a fixed window on the screen and the content moves behind it.
  function onExtendMove(event) {
    pointerY = event.clientY;
    const bottom = clamp(pointerY, box.top + MIN_BOX_HEIGHT, window.innerHeight);
    box.height = bottom - box.top;
    drawBox();
    drawLabel();
  }

  // Runs once per frame while the handle is held down. If the cursor is inside the
  // bottom edge zone, scroll the container — gently at the top of the zone, fast at
  // the very bottom.
  function autoScrollStep() {
    if (step !== "extending") return; // released or cancelled; stop looping

    const distanceToBottom = window.innerHeight - pointerY;
    if (distanceToBottom < EDGE_ZONE) {
      // 0 at the top of the zone, 1 with the cursor right at the screen edge.
      const ramp = clamp((EDGE_ZONE - distanceToBottom) / EDGE_ZONE, 0, 1);
      const speed = SLOW_SPEED + ramp * (FAST_SPEED - SLOW_SPEED);

      const current = getScrollTop(scrollContainer);
      const next = Math.min(current + speed, getMaxScrollTop(scrollContainer));
      if (next > current) {
        scrollContainerTo(scrollContainer, next);
        drawLabel();
      }
    }

    animationFrame = requestAnimationFrame(autoScrollStep);
  }

  // Handle released: stop scrolling, record where we ended up, and start the capture
  // pass.
  function onExtendUp() {
    document.removeEventListener("mousemove", onExtendMove, true);
    document.removeEventListener("mouseup", onExtendUp, true);
    stopAutoScroll();

    step = "ready";
    endScrollTop = getScrollTop(scrollContainer);

    console.log(
      "[scroll-region-capture] extend finished |",
      "box:",
      {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      "| startScrollTop:",
      Math.round(startScrollTop),
      "| endScrollTop:",
      Math.round(endScrollTop),
      "| scrolled:",
      Math.round(endScrollTop - startScrollTop),
      "px | capture height will be about",
      Math.round(endScrollTop - startScrollTop + box.height),
      "px"
    );

    // Everything the capture pass needs is now known, so off it goes. Capturing only
    // starts here, never during the drag: Chrome allows roughly two screenshots per
    // second, so shooting while the content is still moving would leave gaps.
    runCapture();
  }

  // Cancels the per-frame loop, if one is running.
  function stopAutoScroll() {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  // --- Step 3: the capture pass -----------------------------------------------
  // The plan: scroll the container down in fixed steps, photograph the screen at each
  // stop, cut the box out of each photograph, then stack those pieces into one tall
  // image and download it.

  // Waits for a number of milliseconds.
  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // Waits for the browser to paint one frame.
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  // Waits long enough after a scroll for the page to have repainted and for any
  // lazily-loaded content to have appeared.
  async function settle() {
    await nextFrame();
    await nextFrame();
    await wait(SETTLE_DELAY);
  }

  // Asks the service worker for a screenshot of the visible tab, because content
  // scripts are not allowed to call chrome.tabs.captureVisibleTab themselves.
  // Returns a PNG data URL.
  async function captureViewport() {
    const response = await chrome.runtime.sendMessage({ type: "CAPTURE_VIEWPORT" });
    if (!response || !response.ok) {
      throw new Error(
        response && response.error ? response.error : "no reply from the extension"
      );
    }
    return response.dataUrl;
  }

  // Cuts the selection box out of one full-screen capture.
  //
  // This is the device-pixel-ratio part, and it is easy to get wrong. The screenshot
  // comes back at the display's real resolution: on a 2x screen a 1400px-wide viewport
  // arrives as a 2800px-wide image. The box coordinates, meanwhile, are in CSS pixels.
  // So every coordinate is multiplied by dpr on the way in, and the result is kept at
  // full resolution — never scaled back down, which would throw away sharpness.
  async function cropToBox(dataUrl, dpr) {
    // fetch() reads a data: URL happily, and gives us a blob without any string work.
    const blob = await (await fetch(dataUrl)).blob();
    // createImageBitmap is used rather than an <img> with an onload handler: it can be
    // awaited directly, and it can crop while decoding.
    const shot = await createImageBitmap(blob);

    // Round once, then clamp, so a half-pixel of rounding can never ask for a region
    // that falls outside the image (which would throw).
    const x = clamp(Math.round(box.left * dpr), 0, shot.width);
    const y = clamp(Math.round(box.top * dpr), 0, shot.height);
    const width = clamp(Math.round(box.width * dpr), 1, shot.width - x);
    const height = clamp(Math.round(box.height * dpr), 1, shot.height - y);

    const piece = await createImageBitmap(shot, x, y, width, height);
    shot.close(); // free the full-screen copy straight away; these are large
    return piece;
  }

  // Works out the sizes the capture pass runs on, all in CSS pixels except trimPx.
  //
  // The overlap and trim shrink for small boxes: a 100px-tall box cannot spare 120px of
  // overlap, and asking it to would mean scrolling almost nowhere between shots.
  function captureGeometry(dpr) {
    const overlap = Math.min(MAX_OVERLAP, Math.max(8, Math.floor(box.height * 0.4)));
    // A third for the top trim, a third for the bottom trim, a third left over as the
    // margin the seam matcher works in.
    const trim = Math.min(MAX_TRIM, Math.floor(overlap / 3));
    return {
      overlap: overlap,
      trim: trim,
      trimPx: Math.round(trim * dpr), // the same thing in device pixels
      stride: Math.max(1, box.height - overlap), // how far to scroll between shots
    };
  }

  // Works out every scroll position we need to stop at, from where the box was drawn
  // down to where the user released the handle.
  function planOffsets(stride) {
    const offsets = [];

    for (let offset = startScrollTop; offset < endScrollTop; offset += stride) {
      offsets.push(offset);
    }

    // The loop above stops short of the end. Finish exactly where the user released,
    // rather than one stride past it, so the image ends where they expect. If the last
    // planned stop is already essentially there, replace it instead of adding a
    // near-duplicate.
    if (offsets.length > 0 && endScrollTop - offsets[offsets.length - 1] < 2) {
      offsets[offsets.length - 1] = endScrollTop;
    } else {
      offsets.push(endScrollTop);
    }

    return offsets;
  }

  // Reads a horizontal band of a strip as raw pixels, so it can be compared with what
  // is already on the tall canvas. `offset` says how far down the strip to read from —
  // never 0 in practice, because the very top rows are the faded ones we discard.
  function readBand(bitmap, offset) {
    const height = Math.min(ALIGN_BAND, Math.max(1, bitmap.height - offset));
    const scratch = document.createElement("canvas");
    scratch.width = bitmap.width;
    scratch.height = height;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    // Negative y shifts the strip up, so row `offset` lands on row 0 of the scratch.
    context.drawImage(bitmap, 0, -offset);
    return {
      data: context.getImageData(0, 0, bitmap.width, height).data,
      width: bitmap.width,
      height: height,
    };
  }

  // How much variation there is in a band of pixels. A band of plain background has
  // almost none, and would match anywhere — so we refuse to align on it.
  function bandDetail(band) {
    let total = 0;
    let count = 0;
    let minimum = 255;
    let maximum = 0;
    for (let y = 0; y < band.height; y += 2) {
      for (let x = 0; x < band.width; x += 8) {
        const value = band.data[(y * band.width + x) * 4]; // red channel is enough
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
        total += value;
        count++;
      }
    }
    return count === 0 ? 0 : maximum - minimum;
  }

  // Average difference between the strip's top band and the tall canvas, if the strip
  // were placed at `candidateY`. Lower is a better match; 0 would be identical.
  function bandError(band, region, regionTop, candidateY) {
    let total = 0;
    let count = 0;
    for (let y = 0; y < band.height; y += 2) {
      const regionRow = candidateY + y - regionTop;
      if (regionRow < 0 || regionRow >= region.height) return Infinity;
      for (let x = 0; x < band.width; x += 8) {
        const a = band.data[(y * band.width + x) * 4];
        const b = region.data[(regionRow * region.width + x) * 4];
        total += a > b ? a - b : b - a;
        count++;
      }
    }
    return count === 0 ? Infinity : total / count;
  }

  // Works out where a strip really belongs on the tall canvas.
  //
  // `expectedY` is the position the scroll numbers predict for the strip's first drawn
  // row (the one `trimPx` down from its top). This slides the strip within ALIGN_SEARCH
  // pixels of that and returns wherever its band matches the already-drawn image best.
  // If nothing matches well — or the band is featureless background with nothing to
  // match on — it gives back expectedY unchanged.
  function alignStrip(context, canvasHeight, bitmap, expectedY, bandOffset) {
    const band = readBand(bitmap, bandOffset);
    if (bandDetail(band) < ALIGN_MIN_DETAIL) return expectedY;

    // Read one slice of the canvas covering every candidate position at once; reading
    // per candidate would be far slower.
    const regionTop = Math.max(0, expectedY - ALIGN_SEARCH);
    const regionBottom = Math.min(canvasHeight, expectedY + ALIGN_SEARCH + band.height);
    if (regionBottom - regionTop < band.height) return expectedY;

    const imageData = context.getImageData(
      0,
      regionTop,
      bitmap.width,
      regionBottom - regionTop
    );
    const region = {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    };

    let bestY = expectedY;
    let bestError = Infinity;
    for (let offset = -ALIGN_SEARCH; offset <= ALIGN_SEARCH; offset++) {
      const candidateY = expectedY + offset;
      if (candidateY < 0) continue;
      const error = bandError(band, region, regionTop, candidateY);
      // On a tie, prefer the candidate closest to what the scroll position predicted.
      if (error < bestError) {
        bestError = error;
        bestY = candidateY;
      }
    }

    // A poor best match means the overlap does not really contain the same content
    // (the page changed under us). Trusting it would make things worse, so don't.
    if (bestError > ALIGN_MAX_ERROR) {
      console.warn(
        "[scroll-region-capture] no confident seam match (best error",
        Math.round(bestError) + "); falling back to the scroll position"
      );
      return expectedY;
    }
    return bestY;
  }

  // Turns a canvas into a PNG and saves it, using an object URL and a synthetic click.
  // Doing it this way means the extension does not need the "downloads" permission.
  function downloadCanvas(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("the browser could not turn the canvas into a PNG"));
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        // The link has to be in the document for a synthetic click to count.
        document.body.append(link);
        link.click();
        link.remove();
        // Give the download a moment to start before throwing the URL away.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        resolve();
      }, "image/png");
    });
  }

  // --- Keeping the page still while we photograph it --------------------------

  // Some sites set "scroll-behavior: smooth", which turns every scroll into a short
  // animation. We would then photograph the page mid-flight, at a position that is not
  // the one we asked for. Force instant scrolling for the duration of the pass, and
  // return a function that puts the original setting back.
  function forceInstantScrolling() {
    const targets = [document.documentElement, document.body, scrollContainer].filter(
      (element, index, list) => element && list.indexOf(element) === index
    );

    const saved = targets.map((element) => ({
      element: element,
      value: element.style.getPropertyValue("scroll-behavior"),
      priority: element.style.getPropertyPriority("scroll-behavior"),
    }));

    for (const target of targets) {
      target.style.setProperty("scroll-behavior", "auto", "important");
    }

    return function restore() {
      for (const entry of saved) {
        if (entry.value) {
          entry.element.style.setProperty("scroll-behavior", entry.value, entry.priority);
        } else {
          entry.element.style.removeProperty("scroll-behavior");
        }
      }
    };
  }

  // Sticky and fixed elements — nav bars, filter chips, floating toolbars — stay put
  // on screen while everything else scrolls past. Photographed once per strip, they
  // appear over and over down the finished image.
  //
  // So for a multi-strip capture we hide any of them that could sit inside the box,
  // revealing the real content underneath. Two elements are deliberately spared:
  // anything wrapping the scroll container (chat apps often make the whole app shell
  // fixed — hiding that would blank the page), and anything tall enough to be a layout
  // wrapper rather than a bar. Returns a function that puts them all back.
  function hideStickyElements() {
    const boxLeft = box.left;
    const boxRight = box.left + box.width;
    const tallLimit = window.innerHeight * 0.6;
    const hidden = [];

    for (const element of document.querySelectorAll("*")) {
      // Never touch our own overlay.
      if (element === root || root.contains(element)) continue;
      // Never touch something the scrolling content lives inside.
      if (scrollContainer && element.contains(scrollContainer)) continue;

      const style = getComputedStyle(element);
      if (style.position !== "fixed" && style.position !== "sticky") continue;
      if (style.visibility === "hidden" || style.display === "none") continue;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.height > tallLimit) continue; // a wrapper, not a bar
      // Only bars that overlap the box horizontally can ever intrude into it.
      if (rect.right <= boxLeft || rect.left >= boxRight) continue;

      hidden.push({
        element: element,
        value: element.style.getPropertyValue("visibility"),
        priority: element.style.getPropertyPriority("visibility"),
      });
      element.style.setProperty("visibility", "hidden", "important");
    }

    if (hidden.length > 0) {
      console.log(
        "[scroll-region-capture] hid",
        hidden.length,
        "sticky/fixed element(s) so they do not repeat down the image",
        hidden.map((entry) => describe(entry.element))
      );
    }

    return function restore() {
      for (const entry of hidden) {
        if (entry.value) {
          entry.element.style.setProperty("visibility", entry.value, entry.priority);
        } else {
          entry.element.style.removeProperty("visibility");
        }
      }
    };
  }

  // Waits until the container has actually stopped moving, rather than assuming it
  // arrived the instant we set scrollTop.
  async function waitForStableScroll(container) {
    let previous = getScrollTop(container);
    for (let attempt = 0; attempt < 30; attempt++) {
      await nextFrame();
      const current = getScrollTop(container);
      if (Math.abs(current - previous) < 0.5) return current;
      previous = current;
    }
    return getScrollTop(container);
  }

  // A filename with a timestamp, so repeated captures never overwrite each other.
  function makeFilename() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      "capture-" +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds()) +
      ".png"
    );
  }

  // When the last screenshot was taken, so we can pace ourselves under Chrome's limit.
  let lastCaptureAt = 0;

  // Waits until enough time has passed since the previous screenshot. Called BEFORE we
  // read the scroll position, so that no time passes between reading where the page is
  // and photographing it.
  async function waitForCaptureSlot() {
    const remaining = CAPTURE_GAP - (Date.now() - lastCaptureAt);
    if (remaining > 0) await wait(remaining);
  }

  // The whole pass, from first screenshot to finished download.
  async function runCapture() {
    step = "capturing";
    stopAutoScroll();
    setVisible(handleEl, false);
    setVisible(labelEl, false);

    const dpr = window.devicePixelRatio || 1;
    // Where the page was before any of our scrolling happened. Restored at the end so
    // the user is left exactly where they were.
    const originalScrollTop = startScrollTop;
    const geometry = captureGeometry(dpr);
    const offsets = planOffsets(geometry.stride);

    // Stop the page fidgeting under us for the duration of the pass.
    const restoreScrolling = forceInstantScrolling();
    // Only worth hiding the bars when we are actually going to scroll; a single-strip
    // capture should look exactly like the screen did.
    const restoreSticky = offsets.length > 1 ? hideStickyElements() : function () {};

    // The tall canvas everything is drawn onto as we go. It is made generously taller
    // than the arithmetic says it needs to be, because seam alignment can push strips
    // down a little; the spare space is trimmed off at the end.
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * dpr);
    canvas.height =
      Math.round((endScrollTop - startScrollTop + box.height) * dpr) +
      Math.round(geometry.overlap * dpr) +
      ALIGN_SEARCH * Math.min(offsets.length, 12);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    // White rather than transparent: pages with no background of their own would
    // otherwise produce a PNG that looks black in some viewers.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    // How far the strips have drifted from what the scroll positions predicted. Each
    // alignment adds to this, so a correction found at one seam carries forward
    // instead of being rediscovered at every seam after it.
    let drift = 0;
    // The lowest row anything has been drawn on, which becomes the finished height.
    let filledTo = 0;

    console.log(
      "[scroll-region-capture] capture pass starting:",
      offsets.length,
      "strips, stride",
      geometry.stride,
      "px, overlap",
      geometry.overlap,
      "px, trim",
      geometry.trim,
      "px, dpr",
      dpr
    );

    try {
      for (let index = 0; index < offsets.length; index++) {
        if (cancelled) return;
        setHint("Capturing " + (index + 1) + " of " + offsets.length + "…");

        scrollContainerTo(scrollContainer, offsets[index]);
        // Let the page repaint and any lazy content load, then make sure it really has
        // come to rest before we trust a scroll reading.
        await settle();
        await waitForStableScroll(scrollContainer);
        if (cancelled) return;

        // Do the rate-limit waiting now, while the page is free to move, rather than
        // after we have measured it.
        await waitForCaptureSlot();
        if (cancelled) return;

        // Hide our own UI, or the selection border and dim get baked into the shot.
        // Two frames so the browser has definitely repainted without it.
        root.classList.add("src-capture-invisible");
        await nextFrame();
        await nextFrame();

        // Read where the container ACTUALLY is, as late as possible — the requested
        // position and the real one often differ, and the real one is what says where
        // this strip belongs.
        const actualTop = getScrollTop(scrollContainer);

        let dataUrl;
        try {
          dataUrl = await captureViewport();
        } finally {
          // Always put the overlay back, even if the capture failed.
          lastCaptureAt = Date.now();
          root.classList.remove("src-capture-invisible");
        }
        if (cancelled) return;

        const bitmap = await cropToBox(dataUrl, dpr);
        try {
          // Drop the rows a page's edge fades wash out — see MAX_TRIM. The first strip
          // keeps its top and the last keeps its bottom, because those two edges are
          // the ones the user chose when they drew and released the box.
          const room = Math.floor((bitmap.height - 1) / 2);
          const skipTop = index === 0 ? 0 : Math.min(geometry.trimPx, room);
          const skipBottom =
            index === offsets.length - 1 ? 0 : Math.min(geometry.trimPx, room);

          // Where the scroll numbers say the first DRAWN row of this strip goes, plus
          // any drift already found at earlier seams.
          const expectedY =
            Math.round((actualTop - originalScrollTop) * dpr) + skipTop + drift;

          // Then check that against the pixels themselves, matching on crisp rows we
          // are actually going to keep rather than on the faded ones we just dropped.
          let drawY = expectedY;
          if (index > 0) {
            drawY = alignStrip(context, canvas.height, bitmap, expectedY, skipTop);
            if (drawY !== expectedY) {
              console.log(
                "[scroll-region-capture] strip",
                index + 1,
                "nudged",
                drawY - expectedY,
                "device px to line up with the previous strip"
              );
            }
            drift += drawY - expectedY;
          }

          const drawHeight = Math.max(1, bitmap.height - skipTop - skipBottom);
          drawY = clamp(drawY, 0, Math.max(0, canvas.height - drawHeight));
          // Take the middle of the strip — from skipTop down, minus skipBottom — and
          // put it at drawY.
          context.drawImage(
            bitmap,
            0,
            skipTop,
            bitmap.width,
            drawHeight,
            0,
            drawY,
            bitmap.width,
            drawHeight
          );
          filledTo = Math.max(filledTo, drawY + drawHeight);
        } finally {
          bitmap.close(); // these are large; release each one as soon as it is drawn
        }
      }

      if (cancelled) return;

      // Put the page back before doing the remaining work, so the user sees it return
      // to normal as soon as the screenshots are done.
      restoreSticky();
      scrollContainerTo(scrollContainer, originalScrollTop);

      // Trim the spare canvas space off the bottom.
      const output = document.createElement("canvas");
      output.width = canvas.width;
      output.height = Math.max(1, filledTo);
      output.getContext("2d").drawImage(canvas, 0, 0);

      console.log(
        "[scroll-region-capture] stitched",
        offsets.length,
        "strips into",
        output.width + " x " + output.height,
        "device pixels (dpr " + dpr + ", total drift " + drift + " px)"
      );

      await downloadCanvas(output, makeFilename());
      console.log("[scroll-region-capture] download started");
    } catch (error) {
      console.error("[scroll-region-capture] capture failed:", error);
      // Leave the message up for a few seconds so it is readable, then tidy up.
      setHint("Capture failed — see the console for details");
      await wait(3000);
    } finally {
      // Whatever happened — success, failure or Esc — the page must be left exactly as
      // we found it.
      restoreSticky();
      restoreScrolling();
      if (!cancelled) cleanup();
    }
  }

  // --- Teardown ---------------------------------------------------------------

  // Removes every trace of the extension from the page: the DOM we added, the
  // listeners we registered, the animation loop, and the global we set.
  function cleanup() {
    // If a capture pass is mid-flight, tell it to stop and put the page back where it
    // was — otherwise Esc would leave the user stranded halfway down the article.
    cancelled = true;
    if (step === "capturing" && scrollContainer) {
      scrollContainerTo(scrollContainer, startScrollTop);
    }

    step = "idle";
    stopAutoScroll();
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mousemove", onSelectMove, true);
    document.removeEventListener("mouseup", onSelectUp, true);
    document.removeEventListener("mousemove", onExtendMove, true);
    document.removeEventListener("mouseup", onExtendUp, true);
    root.remove();
    delete window[CLEANUP_KEY];
    console.log("[scroll-region-capture] overlay removed");
  }

  // Esc cancels at any point. Captured at the document level with `true` so we see the
  // key before the page does, and stopPropagation keeps the page from also reacting
  // (many sites close menus or modals on Esc).
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  }

  // --- Wire everything up -----------------------------------------------------

  setHint("Drag to select a region");
  root.addEventListener("mousedown", onRootMouseDown, true);
  handleEl.addEventListener("mousedown", onHandleMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window[CLEANUP_KEY] = cleanup;

  console.log("[scroll-region-capture] overlay shown — drag to select, Esc to cancel");
})();
