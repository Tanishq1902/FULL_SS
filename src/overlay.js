// overlay.js — the content script. background.js injects this into the page every
// time the toolbar icon is clicked.
//
// WHAT IT DOES, IN ORDER:
//   * dims the page and shows a crosshair
//   * lets the user drag out a selection rectangle — or click once inside a
//     scrolling area to select the whole of it, top to bottom, with no dragging
//   * the box can then be moved, resized from its corners and sides, and extended
//     upward or downward through scrolling content using the two pills
//   * a "Full page" button in the bar captures the main scrolling area top to
//     bottom in one click, with no drawing and no Enter
//   * works out WHICH element actually scrolls (the window, or an inner div)
//   * on Enter (or the Capture button), photographs the region one screenful at a
//     time, crops each shot to the box, stitches them into one tall PNG, downloads it
//     and offers to copy it to the clipboard
//   * Esc cancels and cleans up at any point
//
// Captures taller than ~30,000 device px are split into numbered PNGs,
// which Chrome's canvas limit requires (see MAX_PAGE_HEIGHT).
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
  // CSS pixels unless a name ends in "Px", which means device pixels.

  const EDGE_ZONE = 120; // start auto-scrolling within this many px of the screen edge
  const SLOW_SPEED = 2; // px per frame at the inner edge of that zone
  const FAST_SPEED = 35; // px per frame with the cursor at the very edge
  const MIN_DRAG = 12; // a drag smaller than this counts as a stray click
  const MIN_BOX_WIDTH = 40; // the box can never be resized narrower than this
  const MIN_BOX_HEIGHT = 40; // ...or shorter than this

  // How much each captured strip repeats the one above it. The overlap does two jobs:
  // it absorbs sub-pixel scroll rounding (which would otherwise leave thin white lines
  // at the seams), and it gives us spare pixels to throw away — see the trim below.
  const MAX_OVERLAP = 180;

  // How much is discarded from the top and bottom of each strip rather than drawn.
  //
  // Many apps fade content out at the edges of their scrolling area — Claude's chat
  // does it at both ends, with a gradient mask under the header and another above the
  // message box. Those faded rows are real pixels in the screenshot, and drawing them
  // puts a washed-out, duplicated band at every seam. The neighbouring strip always
  // has a crisp copy of the same content, so the fix is to drop the faded rows and let
  // the neighbour's pixels stand.
  //
  // The pass STARTS with this much trim, then measures the real fade from the first
  // two strips and shrinks to fit — see measureFades. Most pages fade nothing at all,
  // and on those the trim drops to almost zero, the overlap shrinks with it, and the
  // whole capture needs noticeably fewer screenshots.
  const MAX_TRIM = 60;
  const TRIM_MARGIN = 6; // a few spare px on top of whatever fade we measure
  const MATCH_MARGIN = 60; // overlap kept beyond the trims, for the seam matcher to work in

  // After scrolling, how long to let the page settle before photographing it. Two
  // animation frames for the browser to repaint, then a pause for lazily-loaded
  // images and fade-in animations to finish.
  const SETTLE_DELAY = 350;

  // Chrome allows roughly two screenshots a second. We pace ourselves to this gap so
  // that the wait happens BEFORE we look at the scroll position, not between looking
  // and shooting — during which the page could have moved.
  const CAPTURE_GAP = 650;

  // Chrome canvases stop working somewhere above 32,767 pixels in either direction,
  // and a canvas past the limit comes back blank rather than throwing. So the image is
  // built in pages of at most this many rows, and a capture that needs more than one
  // page is saved as several PNGs.
  const MAX_PAGE_HEIGHT = 30000;

  // A runaway loop would hammer the page forever; stop long before that.
  const MAX_STRIPS = 400;

  // How long the "copy it?" panel stays up after a capture before tidying itself away.
  const RESULT_TIMEOUT = 20000;

  // --- Seam alignment (device pixels) -----------------------------------------
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

  // When comparing one row against another, how different they have to be before we
  // call them "not the same pixels". Used to measure how far a page's fade reaches.
  const FADE_ROW_DIFFERENCE = 10;

  // --- Mutable state ----------------------------------------------------------
  // "step" is a plain string describing what the user is doing right now. Keeping it
  // in one variable (instead of several booleans that can contradict each other)
  // makes the flow easy to follow.
  //   "idle"      – nothing drawn yet, waiting for the first drag
  //   "selecting" – the mouse is down, drawing the rectangle
  //   "ready"     – a box exists; it can be moved, resized, extended or captured
  //   "moving"    – the whole box is being dragged to a new place
  //   "resizing"  – one corner or side is being dragged
  //   "extending" – a pill is being dragged, possibly scrolling the page
  //   "capturing" – the screenshot pass is running; the mouse is ignored
  //   "done"      – the capture finished and the result panel is showing
  let step = "idle";

  // Set by cleanup(). The capture pass is a long chain of awaits, and after every one
  // of them it checks this flag so that Esc stops the work promptly instead of
  // carrying on against a page that has already been tidied up.
  let cancelled = false;

  // The selection rectangle, in CSS pixels relative to the viewport (not the page).
  // During a capture the box is a fixed window on the screen: content moves behind it.
  let box = { left: 0, top: 0, width: 0, height: 0 };

  let anchorX = 0; // where the selection drag started
  let anchorY = 0;
  let pointerY = 0; // latest cursor Y, read by the auto-scroll loop each frame

  let dragEdges = null; // which box edges the current resize drag moves
  let dragFrom = null; // the box rectangle as it was when the drag began
  let extendDirection = 0; // -1 while extending upward, +1 while extending downward

  let scrollContainer = null; // the element that actually scrolls behind the box
  let selectionScrollTop = 0; // where it was when the box was drawn; restored afterwards
  let rangeTop = 0; // the highest (smallest) scroll position the capture must cover
  let rangeBottom = 0; // the lowest (largest) scroll position the capture must cover

  // True after a whole-area click (see selectWholeContainer): the range covers the
  // container's full scroll height rather than whatever the pills marked out. Moving
  // or resizing such a box keeps the full height instead of resetting the range, so
  // the box can be narrowed to a column and still capture top-to-bottom.
  let wholeContainer = false;

  let animationFrame = null; // id of the running auto-scroll loop, or null
  let resultTimer = null; // id of the timer that dismisses the result panel
  let resultBlob = null; // the finished PNG, kept so the Copy button can use it

  // --- Build the overlay ------------------------------------------------------

  // The root: a fixed, full-screen sheet above all page content.
  const root = document.createElement("div");
  root.className = ROOT_CLASS;
  // tabindex lets us focus the overlay. Focusing matters: if the user's keyboard
  // focus is sitting inside a text box (or an iframe), our Esc listener might never
  // hear the key press. Taking focus ourselves makes Esc reliable.
  root.tabIndex = -1;

  // The instruction bar pinned to the top of the screen, with its buttons.
  const bar = document.createElement("div");
  bar.className = "src-capture-bar";

  const barText = document.createElement("span");
  barText.className = "src-capture-bar-text";

  const captureButton = document.createElement("button");
  captureButton.type = "button";
  captureButton.className = "src-capture-button src-capture-button--primary";
  captureButton.textContent = "Capture";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "src-capture-button";
  cancelButton.textContent = "Cancel";

  // One click captures the whole main scrolling area, with no drawing and no Enter.
  // It stays visible even before any box exists, so a full capture is a single click
  // from the moment the overlay opens. The bar itself is hidden while capturing, so
  // no visibility handling is needed for this button beyond that.
  const fullPageButton = document.createElement("button");
  fullPageButton.type = "button";
  fullPageButton.className = "src-capture-button";
  fullPageButton.textContent = "Full page";

  bar.append(barText, captureButton, fullPageButton, cancelButton);

  // The selection rectangle, hidden until the user starts dragging.
  const boxEl = document.createElement("div");
  boxEl.className = "src-capture-box src-capture-hidden";

  // The two extend pills, on the top and bottom edges.
  const topPill = document.createElement("div");
  topPill.className = "src-capture-pill src-capture-pill--top";

  const bottomPill = document.createElement("div");
  bottomPill.className = "src-capture-pill src-capture-pill--bottom";

  // The six resize grips. Each one says which edges of the box it moves; the corner
  // grips move two edges at once. The top and bottom edges have no grip of their own
  // because the pills already do that job.
  const GRIP_SPECS = [
    { name: "nw", edges: { left: true, top: true } },
    { name: "ne", edges: { right: true, top: true } },
    { name: "sw", edges: { left: true, bottom: true } },
    { name: "se", edges: { right: true, bottom: true } },
    { name: "w", edges: { left: true } },
    { name: "e", edges: { right: true } },
  ];

  const grips = GRIP_SPECS.map((spec) => {
    const grip = document.createElement("div");
    grip.className = "src-capture-grip src-capture-grip--" + spec.name;
    grip.addEventListener(
      "mousedown",
      (event) => onGripMouseDown(event, spec.edges),
      true
    );
    return grip;
  });

  boxEl.append(topPill, bottomPill, ...grips);

  // A small readout showing the box size and what the capture will cover.
  const labelEl = document.createElement("div");
  labelEl.className = "src-capture-label src-capture-hidden";

  root.append(bar, boxEl, labelEl);
  document.documentElement.append(root);
  // Focus after insertion, or there is nothing to focus yet.
  root.focus({ preventScroll: true });

  // --- Small helpers ----------------------------------------------------------

  // Keeps a number inside a range.
  function clamp(value, low, high) {
    return Math.min(Math.max(value, low), high);
  }

  // Shows or hides one of our elements. See .src-capture-hidden in the CSS for why
  // this is a class rather than the `hidden` attribute.
  function setVisible(element, visible) {
    element.classList.toggle("src-capture-hidden", !visible);
  }

  // Waits for a number of milliseconds.
  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  // Waits for the browser to paint one frame.
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

  // --- The instruction bar ----------------------------------------------------

  // Writes the bar's message. Built from text nodes rather than innerHTML — no HTML
  // parsing, nothing injectable. `keys` is a list of [key, what it does] pairs shown
  // as little keycaps at the end, e.g. [["Enter", "capture"], ["Esc", "cancel"]].
  //
  // The text is kept short on purpose: the bar shares the top of the screen with the
  // box and its pill, and a long sentence there is a sentence nobody can read.
  function setBarText(message, keys) {
    barText.textContent = "";
    barText.append(message);
    for (const pair of keys || []) {
      barText.append("  ·  ");
      const key = document.createElement("span");
      key.className = "src-capture-key";
      key.textContent = pair[0];
      barText.append(key, " " + pair[1]);
    }
  }

  // The bar sits at the top of the screen, which is exactly where a box drawn near the
  // top wants to be — along with its pill, which sticks out 11px above the border. When
  // they would collide, the bar moves to the bottom instead. If the box fills the
  // screen and there is no clear space either way, the top is used and the bar simply
  // sits over the box; nothing is lost, since the bar is not part of the capture.
  function positionBar() {
    const BAR_SPACE = 72; // roughly the room the bar needs, including its margin
    const PILL_OVERHANG = 14;

    let atBottom = false;
    if (step !== "idle" && step !== "selecting") {
      const roomAtTop = box.top - PILL_OVERHANG;
      const roomAtBottom =
        window.innerHeight - (box.top + box.height + PILL_OVERHANG);
      atBottom = roomAtTop < BAR_SPACE && roomAtBottom >= BAR_SPACE;
    }

    bar.classList.toggle("src-capture-bar--bottom", atBottom);
    return atBottom;
  }

  // Buttons only make sense once there is a box to capture.
  function setButtonsVisible(visible) {
    setVisible(captureButton, visible);
    setVisible(cancelButton, visible);
  }

  // Puts the bar into whichever state matches what the user can do right now.
  function updateBar() {
    if (step === "idle" || step === "selecting") {
      setBarText("Drag to select, or click a scrolling area to take it all", [
        ["Esc", "cancel"],
      ]);
      setButtonsVisible(false);
    } else if (wholeContainer) {
      setBarText("Whole area selected — resize it if you like", [
        ["Enter", "capture"],
        ["Esc", "cancel"],
      ]);
      setButtonsVisible(true);
    } else {
      setBarText("Drag the pills to extend", [
        ["Enter", "capture"],
        ["Esc", "cancel"],
      ]);
      setButtonsVisible(true);
    }
    positionBar();
  }

  // --- Drawing the box --------------------------------------------------------

  // Copies the current `box` numbers onto the rectangle element, and moves the readout
  // label just above it (or just below, if the box is at the very top of the screen).
  function drawBox() {
    boxEl.style.left = box.left + "px";
    boxEl.style.top = box.top + "px";
    boxEl.style.width = box.width + "px";
    boxEl.style.height = box.height + "px";

    // Work out where the bar is first, because the label has to dodge it.
    const barAtBottom = positionBar();

    // The label normally sits just above the box. If that would put it behind the bar,
    // tuck it inside the top-left corner of the box instead.
    const above = box.top - 22;
    const barFloor = barAtBottom ? 4 : 62;
    const top = above >= barFloor ? above : box.top + 6;

    labelEl.style.left = Math.max(4, box.left) + "px";
    labelEl.style.top = top + "px";
  }

  // Updates the readout: the box size, plus how tall the finished image will be once
  // the scrolling covered so far is taken into account.
  function drawLabel() {
    const size = Math.round(box.width) + " x " + Math.round(box.height) + " px";
    const covered = rangeBottom - rangeTop;
    if (scrollContainer && covered > 0) {
      labelEl.textContent =
        size + "  ·  captures " + Math.round(covered + box.height) + " px tall";
    } else {
      labelEl.textContent = size;
    }
  }

  // Shows or hides the handles as a group.
  function setHandlesVisible(visible) {
    setVisible(topPill, visible);
    setVisible(bottomPill, visible);
    for (const grip of grips) setVisible(grip, visible);
  }

  // Is this viewport point inside the current box? Used to decide whether a mouse
  // press starts a move or a brand new selection.
  function isInsideBox(x, y) {
    return (
      x >= box.left &&
      x <= box.left + box.width &&
      y >= box.top &&
      y <= box.top + box.height
    );
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

  // Re-reads which element scrolls behind the box, and resets the capture range to
  // wherever that container is now.
  //
  // This runs after the box is drawn, moved or resized. Moving the box can genuinely
  // change which element is behind it, and once the box has moved, any scrolling
  // recorded against the old position no longer describes a rectangle that exists —
  // so the range starts again from here. Extending is done after positioning, which is
  // the natural order anyway.
  function refreshContainer(reason) {
    wholeContainer = false; // a manually placed box covers only what the pills mark out
    scrollContainer = findScrollContainer(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    selectionScrollTop = getScrollTop(scrollContainer);
    rangeTop = selectionScrollTop;
    rangeBottom = selectionScrollTop;

    console.log(
      "[scroll-region-capture] " + reason + ":",
      {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      "| scroll container:",
      describe(scrollContainer),
      "| scrollTop:",
      Math.round(selectionScrollTop),
      "| max scroll:",
      Math.round(getMaxScrollTop(scrollContainer)),
      scrollContainer
    );
  }

  // Remembers that the capture has to cover this scroll position too.
  function recordRange(position) {
    rangeTop = Math.min(rangeTop, position);
    rangeBottom = Math.max(rangeBottom, position);
  }

  // Points the capture at a container's full scroll height, top to bottom, rather
  // than wherever it happens to sit right now. Used after a whole-area click and
  // after any edit of such a box, so narrowing the box keeps the full height.
  function coverWholeContainer(container, reason) {
    scrollContainer = container;
    selectionScrollTop = getScrollTop(container);
    rangeTop = 0;
    rangeBottom = getMaxScrollTop(container);
    wholeContainer = true;

    console.log(
      "[scroll-region-capture] " + reason + ":",
      {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      "| scroll container:",
      describe(scrollContainer),
      "| capturing its full height, scroll",
      Math.round(rangeTop),
      "to",
      Math.round(rangeBottom),
      scrollContainer
    );
  }

  // A single click (no drag) inside a scrolling area selects the whole of it: the
  // box becomes the container's visible rectangle and the range its full scroll
  // height, so the pill-dragging step is skipped entirely. The box stays editable
  // and Enter still starts the capture — a click alone never fires off screenshots
  // by itself. When the click lands somewhere too small to be useful, it counts as
  // a stray click and everything resets, exactly as before.
  function selectWholeContainer(x, y) {
    const container = findScrollContainer(x, y);

    let left = 0;
    let top = 0;
    let width = 0;
    let height = 0;
    if (isPageScroller(container)) {
      // The page itself scrolls: the visible rectangle is the whole viewport.
      width = window.innerWidth;
      height = window.innerHeight;
    } else {
      const rect = container.getBoundingClientRect();
      left = clamp(rect.left, 0, window.innerWidth);
      top = clamp(rect.top, 0, window.innerHeight);
      width = clamp(rect.right, 0, window.innerWidth) - left;
      height = clamp(rect.bottom, 0, window.innerHeight) - top;
    }

    if (width < MIN_DRAG || height < MIN_DRAG) {
      // Too small to be meaningful — go back to the empty state.
      step = "idle";
      setVisible(boxEl, false);
      setVisible(labelEl, false);
      root.classList.remove("src-capture-root--cutout");
      updateBar();
      return;
    }

    box = { left: left, top: top, width: width, height: height };
    coverWholeContainer(container, "whole area selected");

    step = "ready";
    setVisible(boxEl, true);
    setHandlesVisible(true);
    setVisible(labelEl, true);
    root.classList.add("src-capture-root--cutout");
    updateBar();
    drawBox();
    drawLabel();
  }

  // --- Drawing a new selection ------------------------------------------------

  // Mouse pressed on the sheet. Inside an existing box that means "move it"; anywhere
  // else it starts a fresh rectangle.
  function onRootMouseDown(event) {
    if (event.button !== 0) return; // left button only
    if (step === "capturing" || step === "done") return;
    // Presses that landed on a handle or a button have their own listeners; this one
    // only handles presses on the sheet itself.
    if (event.target !== root) return;

    event.preventDefault();

    if (step === "ready" && isInsideBox(event.clientX, event.clientY)) {
      startMove(event);
      return;
    }

    step = "selecting";
    anchorX = event.clientX;
    anchorY = event.clientY;
    box = { left: anchorX, top: anchorY, width: 0, height: 0 };
    rangeTop = 0;
    rangeBottom = 0;

    setVisible(boxEl, true);
    setHandlesVisible(false); // no handles until the drag is finished
    setVisible(labelEl, true);
    root.classList.add("src-capture-root--cutout");
    updateBar();
    drawBox();
    drawLabel();

    document.addEventListener("mousemove", onSelectMove, true);
    document.addEventListener("mouseup", onSelectUp, true);
  }

  // Hovering inside a finished box shows the "move" cursor, so it is discoverable
  // that the box can be picked up and dragged somewhere else.
  function onRootMouseMove(event) {
    if (step !== "ready") return;
    root.style.cursor = isInsideBox(event.clientX, event.clientY) ? "move" : "crosshair";
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

  // Mouse released: either accept the rectangle, or — when barely anything was
  // drawn — treat it as a click and select the whole scrolling area behind it.
  function onSelectUp() {
    document.removeEventListener("mousemove", onSelectMove, true);
    document.removeEventListener("mouseup", onSelectUp, true);

    if (box.width < MIN_DRAG || box.height < MIN_DRAG) {
      selectWholeContainer(anchorX, anchorY);
      return;
    }

    step = "ready";
    setHandlesVisible(true);
    refreshContainer("selection made");
    updateBar();
    // Draw once more now the bar knows where it is going, so the label lands clear of it.
    drawBox();
    drawLabel();
  }

  // --- Moving the whole box ---------------------------------------------------

  // Pressing inside the box picks it up. The offset between the cursor and the box's
  // corner is remembered so the box does not jump under the pointer.
  function startMove(event) {
    step = "moving";
    dragFrom = {
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
    };
    root.style.cursor = "move";
    document.addEventListener("mousemove", onMoveMove, true);
    document.addEventListener("mouseup", onEditUp, true);
  }

  // The box follows the cursor, but never off the edge of the screen.
  function onMoveMove(event) {
    box.left = clamp(
      event.clientX - dragFrom.offsetX,
      0,
      Math.max(0, window.innerWidth - box.width)
    );
    box.top = clamp(
      event.clientY - dragFrom.offsetY,
      0,
      Math.max(0, window.innerHeight - box.height)
    );
    drawBox();
    drawLabel();
  }

  // --- Resizing from a grip ---------------------------------------------------

  // A grip drag moves one or two edges. The others stay exactly where they were, so
  // the opposite corner acts as the anchor. stopPropagation keeps this press from
  // also being read as "move the box" or "draw a new one".
  function onGripMouseDown(event, edges) {
    if (event.button !== 0 || step !== "ready") return;
    event.preventDefault();
    event.stopPropagation();

    step = "resizing";
    dragEdges = edges;
    dragFrom = {
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
    };

    document.addEventListener("mousemove", onResizeMove, true);
    document.addEventListener("mouseup", onEditUp, true);
  }

  // Work in edge coordinates (left/top/right/bottom) rather than width/height: it
  // makes "this edge follows the cursor, that one stays put" obvious.
  function onResizeMove(event) {
    const x = clamp(event.clientX, 0, window.innerWidth);
    const y = clamp(event.clientY, 0, window.innerHeight);

    let left = dragFrom.left;
    let top = dragFrom.top;
    let right = dragFrom.right;
    let bottom = dragFrom.bottom;

    if (dragEdges.left) left = Math.min(x, right - MIN_BOX_WIDTH);
    if (dragEdges.right) right = Math.max(x, left + MIN_BOX_WIDTH);
    if (dragEdges.top) top = Math.min(y, bottom - MIN_BOX_HEIGHT);
    if (dragEdges.bottom) bottom = Math.max(y, top + MIN_BOX_HEIGHT);

    box = { left: left, top: top, width: right - left, height: bottom - top };
    drawBox();
    drawLabel();
  }

  // End of a move or a resize. Both change where the box sits, so both need the
  // scroll container looking up again. A whole-area box keeps its full height
  // through the edit; a manually drawn one starts its range over, as before.
  function onEditUp() {
    document.removeEventListener("mousemove", onMoveMove, true);
    document.removeEventListener("mousemove", onResizeMove, true);
    document.removeEventListener("mouseup", onEditUp, true);

    root.style.cursor = "";
    step = "ready";
    dragEdges = null;
    dragFrom = null;
    if (wholeContainer) {
      coverWholeContainer(
        findScrollContainer(box.left + box.width / 2, box.top + box.height / 2),
        "box edited"
      );
    } else {
      refreshContainer("box edited");
    }
    updateBar();
    drawLabel();
  }

  // --- Extending through scrolling content ------------------------------------

  // Pressing a pill begins extending in that direction: -1 for the top pill, +1 for
  // the bottom one.
  function onPillMouseDown(event, direction) {
    if (event.button !== 0 || step !== "ready") return;
    event.preventDefault();
    event.stopPropagation();

    step = "extending";
    extendDirection = direction;
    pointerY = event.clientY;

    document.addEventListener("mousemove", onExtendMove, true);
    document.addEventListener("mouseup", onExtendUp, true);

    // Start the loop that does the scrolling. It runs every frame until release, so
    // the page keeps scrolling even when the cursor is held perfectly still.
    animationFrame = requestAnimationFrame(autoScrollStep);
  }

  // While extending, only the edge being dragged moves. The opposite edge and both
  // sides stay put — the box is a fixed window on the screen and the content moves
  // behind it.
  function onExtendMove(event) {
    pointerY = event.clientY;

    if (extendDirection > 0) {
      const bottom = clamp(pointerY, box.top + MIN_BOX_HEIGHT, window.innerHeight);
      box.height = bottom - box.top;
    } else {
      const bottom = box.top + box.height;
      const top = clamp(pointerY, 0, bottom - MIN_BOX_HEIGHT);
      box.top = top;
      box.height = bottom - top;
    }

    drawBox();
    drawLabel();
  }

  // Runs once per frame while a pill is held down. If the cursor is inside the edge
  // zone, scroll the container — gently at the inner edge of the zone, fast at the
  // very edge of the screen.
  function autoScrollStep() {
    if (step !== "extending") return; // released or cancelled; stop looping

    // Distance to whichever edge of the screen we are heading towards.
    const distance =
      extendDirection > 0 ? window.innerHeight - pointerY : pointerY;

    if (distance < EDGE_ZONE) {
      // 0 at the inner edge of the zone, 1 with the cursor right at the screen edge.
      const ramp = clamp((EDGE_ZONE - distance) / EDGE_ZONE, 0, 1);
      const speed = (SLOW_SPEED + ramp * (FAST_SPEED - SLOW_SPEED)) * extendDirection;

      const current = getScrollTop(scrollContainer);
      const next = clamp(current + speed, 0, getMaxScrollTop(scrollContainer));
      if (Math.abs(next - current) > 0.01) {
        scrollContainerTo(scrollContainer, next);
        recordRange(getScrollTop(scrollContainer));
        drawLabel();
      }
    }

    animationFrame = requestAnimationFrame(autoScrollStep);
  }

  // Pill released: stop scrolling and note how far the capture now has to reach.
  // Nothing is captured yet — the user may still want to extend the other way, move
  // the box, or resize it. Capturing happens on Enter or the Capture button.
  function onExtendUp() {
    document.removeEventListener("mousemove", onExtendMove, true);
    document.removeEventListener("mouseup", onExtendUp, true);
    stopAutoScroll();

    step = "ready";
    recordRange(getScrollTop(scrollContainer));
    extendDirection = 0;

    console.log(
      "[scroll-region-capture] extend finished | box:",
      {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      "| covering scroll range",
      Math.round(rangeTop),
      "to",
      Math.round(rangeBottom),
      "| image will be about",
      Math.round(rangeBottom - rangeTop + box.height),
      "px tall"
    );

    updateBar();
    drawLabel();
  }

  // Cancels the per-frame loop, if one is running.
  function stopAutoScroll() {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  // --- Reading pixels ---------------------------------------------------------
  // Everything below works on raw pixel rows. Only the red channel is sampled, and
  // only every eighth pixel across: a fade or a mismatch shows up just as clearly in
  // one channel as in three, and this keeps the comparisons fast enough to run
  // between screenshots.

  // Copies `height` rows of a strip, starting `offset` rows down, into a plain pixel
  // array we can index into.
  function readRows(bitmap, offset, height) {
    const top = clamp(offset, 0, Math.max(0, bitmap.height - 1));
    const rows = clamp(height, 1, bitmap.height - top);

    const scratch = document.createElement("canvas");
    scratch.width = bitmap.width;
    scratch.height = rows;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    // Negative y shifts the strip up, so row `top` lands on row 0 of the scratch.
    context.drawImage(bitmap, 0, -top);

    const imageData = context.getImageData(0, 0, bitmap.width, rows);
    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
      // Which row of the original strip our row 0 came from.
      origin: top,
    };
  }

  // The same, but reading from the tall canvas instead of a strip.
  function readCanvasRows(context, top, height, width) {
    const imageData = context.getImageData(0, top, width, height);
    return {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
      origin: top,
    };
  }

  // How different two rows are, on average. Returns null if either row is out of
  // range, so callers can tell "no answer" from "identical".
  function rowDifference(a, aRow, b, bRow) {
    if (aRow < 0 || aRow >= a.height || bRow < 0 || bRow >= b.height) return null;

    const width = Math.min(a.width, b.width);
    let total = 0;
    let count = 0;
    for (let x = 0; x < width; x += 8) {
      const left = a.data[(aRow * a.width + x) * 4];
      const right = b.data[(bRow * b.width + x) * 4];
      total += left > right ? left - right : right - left;
      count++;
    }
    return count === 0 ? null : total / count;
  }

  // How much variation there is in a band of pixels. A band of plain background has
  // almost none, and would match anywhere — so we refuse to align on it.
  function bandDetail(band) {
    let minimum = 255;
    let maximum = 0;
    for (let y = 0; y < band.height; y += 2) {
      for (let x = 0; x < band.width; x += 8) {
        const value = band.data[(y * band.width + x) * 4];
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
    }
    return maximum - minimum;
  }

  // Average difference between a band and the tall canvas, if the band were placed at
  // `candidateY`. Lower is a better match; 0 would be identical.
  function bandError(band, region, candidateY) {
    let total = 0;
    let count = 0;
    for (let y = 0; y < band.height; y += 2) {
      const regionRow = candidateY + y - region.origin;
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

  // --- Seam alignment ---------------------------------------------------------

  // Works out where a strip really belongs on the tall canvas.
  //
  // `expectedY` is the position the scroll numbers predict for the strip's first drawn
  // row (the one `bandOffset` rows down from its top). This slides the strip within
  // ALIGN_SEARCH pixels of that and returns wherever its band matches the already-drawn
  // image best. If nothing matches well — or the band is featureless background with
  // nothing to match on — it gives back expectedY unchanged.
  //
  // Returns { y, matched }: `matched` says whether the answer came from the pixels or
  // was a fallback, which the fade measurement needs to know before trusting it.
  function alignStrip(context, canvasHeight, bitmap, expectedY, bandOffset) {
    const band = readRows(bitmap, bandOffset, ALIGN_BAND);
    if (bandDetail(band) < ALIGN_MIN_DETAIL) return { y: expectedY, matched: false };

    // Read one slice of the canvas covering every candidate position at once; reading
    // per candidate would be far slower.
    const regionTop = Math.max(0, expectedY - ALIGN_SEARCH);
    const regionBottom = Math.min(canvasHeight, expectedY + ALIGN_SEARCH + band.height);
    if (regionBottom - regionTop < band.height) return { y: expectedY, matched: false };

    const region = readCanvasRows(
      context,
      regionTop,
      regionBottom - regionTop,
      bitmap.width
    );

    let bestY = expectedY;
    let bestError = Infinity;
    for (let offset = -ALIGN_SEARCH; offset <= ALIGN_SEARCH; offset++) {
      const candidateY = expectedY + offset;
      if (candidateY < 0) continue;
      const error = bandError(band, region, candidateY);
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
      return { y: expectedY, matched: false };
    }

    return { y: bestY, matched: true };
  }

  // --- Working out the strip sizes --------------------------------------------

  // Turns "this page fades N pixels at each edge" into the four numbers the capture
  // pass runs on. All in CSS pixels.
  //
  // The overlap has to hold both trims and still leave room for the seam matcher, but
  // it also has to fit comfortably inside the box — an overlap as tall as the box
  // would mean scrolling almost nowhere between screenshots. When those two demands
  // collide the box wins and the trims are scaled down to fit.
  function geometryFor(fadeTop, fadeBottom, windowHeight) {
    const ceiling = Math.min(MAX_OVERLAP, Math.max(16, Math.floor(windowHeight * 0.6)));

    let trimTop = clamp(Math.ceil(fadeTop) + TRIM_MARGIN, 0, MAX_TRIM);
    let trimBottom = clamp(Math.ceil(fadeBottom) + TRIM_MARGIN, 0, MAX_TRIM);
    const overlap = Math.min(ceiling, trimTop + trimBottom + MATCH_MARGIN);

    // Never let the trims eat more than two thirds of the overlap; the last third is
    // what the matcher lines the strips up on.
    const allowance = Math.floor((overlap * 2) / 3);
    if (trimTop + trimBottom > allowance) {
      const scale = allowance / (trimTop + trimBottom);
      trimTop = Math.floor(trimTop * scale);
      trimBottom = Math.floor(trimBottom * scale);
    }

    return {
      trimTop: trimTop,
      trimBottom: trimBottom,
      overlap: overlap,
      stride: Math.max(1, windowHeight - overlap), // how far to scroll between shots
    };
  }

  // --- Measuring the fade -----------------------------------------------------

  // Works out how many rows at the top and bottom of a strip the page has faded out.
  //
  // The trick is that the overlap region holds the same content twice: once near the
  // bottom of the previous strip and once near the top of the new one. Wherever the
  // page faded one copy and not the other, the two disagree. So rows that disagree are
  // faded rows, and the deepest disagreement marks where the fade ends.
  //
  //   `tail`  – the bottom rows of the previous strip, as pixels
  //   `head`  – the top rows of the new strip, as pixels
  //   `shift` – how far down the page the new strip is, in device pixels; previous
  //             strip row (r + shift) shows the same content as new strip row r
  //
  // Only the outer half of the overlap is scanned from each side, so the top-fade scan
  // can never wander into the previous strip's own bottom fade, or vice versa.
  // Returns null when the readings cannot be trusted.
  function measureFades(tail, head, shift, previousHeight, overlapPx) {
    const probe = Math.floor(overlapPx / 2);
    if (probe < 8) return null;

    let topFade = 0;
    let bottomFade = 0;
    let comparisons = 0;

    // Top of the NEW strip: walk down from its first row.
    for (let row = 0; row < probe; row++) {
      const difference = rowDifference(head, row, tail, row + shift - tail.origin);
      if (difference === null) continue;
      comparisons++;
      // Take the deepest disagreement rather than the first agreement: a blank line
      // inside a fade agrees with the crisp copy, and would end the scan too early.
      if (difference > FADE_ROW_DIFFERENCE) topFade = row + 1;
    }

    // Bottom of the PREVIOUS strip: walk up from its last row.
    for (let row = previousHeight - 1; row >= previousHeight - probe; row--) {
      const difference = rowDifference(tail, row - tail.origin, head, row - shift);
      if (difference === null) continue;
      comparisons++;
      if (difference > FADE_ROW_DIFFERENCE) bottomFade = previousHeight - row;
    }

    // Too few usable comparisons, or a fade that fills the whole probe, means the two
    // strips do not really line up — the measurement would be a guess.
    if (comparisons < probe) return null;
    if (topFade >= probe || bottomFade >= probe) return null;

    return { top: topFade, bottom: bottomFade };
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

  // Waits long enough after a scroll for the page to have repainted and for any
  // lazily-loaded content to have appeared.
  async function settle() {
    await nextFrame();
    await nextFrame();
    await wait(SETTLE_DELAY);
  }

  // --- Taking and cropping screenshots ----------------------------------------

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
  async function cropColumn(dataUrl, dpr, cropTop, cropBottom) {
    // fetch() reads a data: URL happily, and gives us a blob without any string work.
    const blob = await (await fetch(dataUrl)).blob();
    // createImageBitmap is used rather than an <img> with an onload handler: it can be
    // awaited directly, and it can crop while decoding.
    const shot = await createImageBitmap(blob);

    // Round once, then clamp, so a half-pixel of rounding can never ask for a region
    // that falls outside the image (which would throw).
    const x = clamp(Math.round(box.left * dpr), 0, shot.width);
    const y = clamp(Math.round(cropTop * dpr), 0, shot.height);
    const width = clamp(Math.round(box.width * dpr), 1, shot.width - x);
    const height = clamp(Math.round((cropBottom - cropTop) * dpr), 1, shot.height - y);

    const piece = await createImageBitmap(shot, x, y, width, height);
    shot.close(); // free the full-screen copy straight away; these are large
    return piece;
  }

  // Which slice of the screen a screenshot is worth taking from.
  //
  // Each shot only advances the capture by as much CONTENT as it holds, so cropping
  // just the user's box would mean scrolling only a box-height between shots — a short
  // box would then need dozens of screenshots. Taking the whole visible height of the
  // scrolling area instead makes each shot worth a screenful, whatever size the box is.
  //
  // It stops at the scrolling area's edges, though. Anything outside those does not
  // move when we scroll, so including it would stamp the same static band down the
  // image again and again. When the window itself is what scrolls, that area is the
  // whole screen, which is the best case.
  function getColumnRect() {
    if (isPageScroller(scrollContainer)) {
      return { top: 0, bottom: window.innerHeight };
    }

    const rect = scrollContainer.getBoundingClientRect();
    const top = clamp(rect.top, 0, window.innerHeight);
    const bottom = clamp(rect.bottom, 0, window.innerHeight);

    // Something unexpected — too small to be useful, or barely overlapping the box at
    // all. Fall back to the box itself, which always works, just more slowly.
    const boxBottom = box.top + box.height;
    if (bottom - top < 80 || bottom <= box.top + 40 || top >= boxBottom - 40) {
      return { top: box.top, bottom: boxBottom };
    }
    return { top: top, bottom: bottom };
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

  // --- Saving the result ------------------------------------------------------

  // Turns a canvas into a PNG blob.
  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("the browser could not turn the canvas into a PNG"));
      }, "image/png");
    });
  }

  // Saves a blob to the downloads folder, using an object URL and a synthetic click.
  // Doing it this way means the extension does not need the "downloads" permission.
  function downloadBlob(blob, filename) {
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
  }

  // The stem of the filename, built from the page title and the time, so repeated
  // captures never overwrite each other and you can tell them apart in the downloads
  // folder. The ".png" and any "-part-2" are added when the file is actually saved.
  function makeBaseName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds());

    // Squash the title down to something safe for a filename.
    const title = (document.title || "capture")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

    return (title || "capture") + "-" + stamp;
  }

  // Puts a PNG on the clipboard. Returns true if it worked.
  //
  // The browser only allows this while the tab is focused, and Chrome additionally
  // wants the write to be traceable to something the user did. A capture that took a
  // while, or a window the user has clicked away from, can therefore be refused —
  // which is why nothing here treats failure as an error. The result panel's Copy
  // button is the fallback, and a click on it always satisfies the browser.
  async function copyToClipboard(blob) {
    try {
      // ClipboardItem takes the blob directly; PNG is the one image type every
      // browser accepts on the clipboard.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch (error) {
      console.warn(
        "[scroll-region-capture] could not copy to the clipboard:",
        (error && error.message) || error
      );
      return false;
    }
  }

  // Shows the little panel that appears once the images are ready. By this point they
  // have been saved and an automatic copy to the clipboard has been attempted;
  // `copied` says whether that worked. If it did not, the Copy button here always will.
  //
  // `saved` is one entry per file. There is more than one only when the capture was too
  // tall for a single canvas, in which case the first part is the one on the clipboard.
  function showResult(saved, width, height, copied) {
    step = "done";
    resultBlob = saved[0].blob;
    hideProgress();

    // Take everything else down and stop blocking the page.
    setVisible(boxEl, false);
    setVisible(labelEl, false);
    setVisible(bar, false);
    root.classList.add("src-capture-root--done");

    const toast = document.createElement("div");
    toast.className = "src-capture-toast";

    const text = document.createElement("span");
    text.className = "src-capture-toast-text";
    if (saved.length > 1) {
      text.textContent =
        "Saved " +
        saved.length +
        " images  ·  " +
        saved[0].filename +
        " and " +
        (saved.length - 1) +
        " more" +
        (copied ? "  ·  part 1 copied" : "");
    } else {
      text.textContent = copied
        ? "Saved " + saved[0].filename + "  ·  copied to the clipboard"
        : "Saved " + saved[0].filename + "  ·  " + width + " x " + height;
    }

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "src-capture-button src-capture-button--primary";
    copyButton.textContent =
      saved.length > 1 ? "Copy part 1" : copied ? "Copy again" : "Copy image";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "src-capture-button";
    closeButton.textContent = "Close";

    copyButton.addEventListener("click", async () => {
      if (await copyToClipboard(resultBlob)) {
        copyButton.textContent = "Copied";
        // Job done — clear up shortly after, so the panel does not linger.
        clearTimeout(resultTimer);
        resultTimer = setTimeout(cleanup, 1200);
      } else {
        copyButton.textContent = "Copy failed";
      }
    });

    closeButton.addEventListener("click", cleanup);

    toast.append(text, copyButton, closeButton);
    root.append(toast);

    // Tidy up on our own after a while if the user just walks away.
    resultTimer = setTimeout(cleanup, RESULT_TIMEOUT);
  }

  // --- The progress card ------------------------------------------------------
  // A capture takes about a second per screenful, which is long enough that a silent
  // screen looks broken. The card shows one dot per screenshot, filling in as they are
  // taken, with the one in progress swelling and shrinking so the row reads as movement
  // rather than a picture. Underneath is an exact progress bar and a count, and — when
  // the image will not fit in one PNG — a warning saying how many files it will become.

  let progressCard = null;
  let progressDots = [];
  let progressFill = null;
  let progressCount = null;

  // Builds the card. `total` is how many screenshots we expect; `parts` how many image
  // files the result will be split into.
  function showProgress(total, parts) {
    hideProgress();

    progressCard = document.createElement("div");
    progressCard.className = "src-capture-progress";

    const title = document.createElement("div");
    title.className = "src-capture-progress-title";
    title.textContent = "Screen capture in progress…";

    const dots = document.createElement("div");
    dots.className = "src-capture-dots";
    progressDots = [];
    // One dot per screenshot, within reason: past two dozen the row would be wider
    // than the card, so beyond that each dot stands for more than one shot.
    const dotCount = clamp(total, 3, 24);
    for (let i = 0; i < dotCount; i++) {
      const dot = document.createElement("span");
      dot.className = "src-capture-dot";
      dots.append(dot);
      progressDots.push(dot);
    }

    const meter = document.createElement("div");
    meter.className = "src-capture-meter";
    progressFill = document.createElement("div");
    progressFill.className = "src-capture-meter-fill";
    meter.append(progressFill);

    progressCount = document.createElement("div");
    progressCount.className = "src-capture-progress-count";

    progressCard.append(title, dots, meter, progressCount);

    if (parts > 1) {
      const note = document.createElement("div");
      note.className = "src-capture-progress-note";
      note.textContent =
        "This capture is too tall for the browser to save as one image. It will be " +
        "split into " + parts + " images.";
      progressCard.append(note);
    }

    root.append(progressCard);
    updateProgress(0, total);
  }

  // Moves the card along. `done` is how many screenshots are finished.
  function updateProgress(done, total) {
    if (!progressCard) return;

    const safeTotal = Math.max(1, total);
    const fraction = clamp(done / safeTotal, 0, 1);

    // Which dot the animation is sitting on right now.
    const active = Math.min(
      progressDots.length - 1,
      Math.floor(fraction * progressDots.length)
    );
    for (let i = 0; i < progressDots.length; i++) {
      progressDots[i].classList.toggle("src-capture-dot--done", i < active);
      progressDots[i].classList.toggle("src-capture-dot--active", i === active);
    }

    progressFill.style.width = Math.round(fraction * 100) + "%";
    progressCount.textContent =
      "Screenshot " + Math.min(done + 1, safeTotal) + " of about " + safeTotal;
  }

  function hideProgress() {
    if (progressCard) progressCard.remove();
    progressCard = null;
    progressDots = [];
    progressFill = null;
    progressCount = null;
  }

  // --- The capture pass -------------------------------------------------------
  // The plan: scroll the container through the range the user marked out, photograph
  // the screen at each stop, cut the box's column out of each photograph, and stack
  // those pieces into one tall image — or several, if it is too tall for one.

  // Starts the pass, if there is anything to capture.
  function startCapture() {
    if (step !== "ready") return;
    runCapture();
  }

  // The "Full page" button: captures the whole main scrolling area in one click, with
  // no drawing and no Enter. The container behind the middle of the screen is selected
  // at its natural width and full height — whatever box the user may have drawn is
  // replaced, so the button always means the same thing — and the pass starts at once.
  // Only from idle or ready: never mid-drag, and never while a capture is running.
  function onFullPageClick() {
    if (step !== "idle" && step !== "ready") return;
    selectWholeContainer(window.innerWidth / 2, window.innerHeight / 2);
    if (step !== "ready") return; // too small to be useful; already reset to idle
    startCapture();
  }

  // Makes a blank page to draw onto. `startY` is where its first row sits in the tall
  // image as a whole, so anything drawn on it is offset by that much.
  function createPage(startY, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    // White rather than transparent: pages with no background of their own would
    // otherwise produce a PNG that looks black in some viewers.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    return { canvas: canvas, context: context, start: startY };
  }

  // Cuts a page down to the rows that actually hold image, saves it, and lets the
  // memory go. A full page is 30,000 rows — well over a hundred megabytes — so it is
  // released as soon as it has been copied rather than kept until the end.
  async function savePage(page, endY, baseName, partNumber, multipart) {
    const height = clamp(Math.round(endY - page.start), 1, page.canvas.height);

    const trimmed = document.createElement("canvas");
    trimmed.width = page.canvas.width;
    trimmed.height = height;
    trimmed.getContext("2d").drawImage(page.canvas, 0, 0);

    page.canvas.width = 1;
    page.canvas.height = 1;

    const filename = multipart
      ? baseName + "-part-" + partNumber + ".png"
      : baseName + ".png";
    const blob = await canvasToBlob(trimmed);
    trimmed.width = 1;
    trimmed.height = 1;

    downloadBlob(blob, filename);
    console.log("[scroll-region-capture] saved", filename, "—", height, "rows");
    return { blob: blob, filename: filename, height: height };
  }

  async function runCapture() {
    step = "capturing";
    stopAutoScroll();
    setHandlesVisible(false);
    setVisible(labelEl, false);
    setVisible(boxEl, false);
    setVisible(bar, false);
    // Bring back the plain dim now the box is gone, so the page reads as busy.
    root.classList.remove("src-capture-root--cutout");
    root.style.cursor = "default";

    const dpr = window.devicePixelRatio || 1;
    // What the viewport looked like when the pass began. Every coordinate the pass
    // runs on derives from this, so each strip is checked against it: a window that
    // is resized, zoomed, or moved to a differently-scaled display mid-pass stops
    // the capture rather than stitching a broken image.
    const startViewport = {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: dpr,
    };
    const column = getColumnRect();
    const columnHeight = column.bottom - column.top;
    const boxBottom = box.top + box.height;
    const totalRange = Math.max(0, rangeBottom - rangeTop);
    const widthPx = Math.round(box.width * dpr);

    // The pass begins cautiously, assuming the page fades as much as any page we are
    // prepared to handle. After the first seam we measure what the fade really is and
    // loosen up — see measureFades.
    let geometry = geometryFor(MAX_TRIM, MAX_TRIM, columnHeight);
    let measured = false;

    // Stop the page fidgeting under us for the duration of the pass.
    const restoreScrolling = forceInstantScrolling();
    // Only worth hiding the bars when we are actually going to scroll; a single-shot
    // capture should look exactly like the screen did.
    const restoreSticky = totalRange > 0 ? hideStickyElements() : function () {};

    // Roughly how tall the finished image will be. Used to size the pages, and to say
    // up front how many files the capture will need.
    const estimatedHeight = Math.round((totalRange + box.height) * dpr);
    // Seam alignment can push strips down a little, so pages get some room to spare.
    const slack = Math.round(MAX_OVERLAP * dpr) + ALIGN_SEARCH * 12;
    const predictedParts = Math.max(1, Math.ceil(estimatedHeight / MAX_PAGE_HEIGHT));

    let estimate = Math.max(1, Math.ceil(totalRange / geometry.stride) + 1);
    showProgress(estimate, predictedParts);

    const baseName = makeBaseName();
    const saved = []; // one entry per image file, as each is finished and downloaded

    let page = createPage(
      0,
      widthPx,
      Math.min(MAX_PAGE_HEIGHT, estimatedHeight + slack)
    );

    // How far the strips have drifted from what the scroll positions predicted. Each
    // alignment adds to this, so a correction found at one seam carries forward
    // instead of being rediscovered at every seam after it.
    let drift = 0;
    let lastDrawnBottom = 0; // the lowest row anything has been drawn on
    let lastRow0Y = 0; // where the last strip's first row sits in the tall image
    let lastCropTop = box.top; // and which screen row that first row came from
    let previousRow0Y = 0; // the same, for the strip before this one
    let previousHeight = 0; // how tall the previous strip was
    let previousTail = null; // its bottom rows, kept only until the fade is measured

    let targetTop = rangeTop;
    let previousActual = null;
    let index = 0;

    console.log(
      "[scroll-region-capture] capture pass starting:",
      "range",
      Math.round(rangeTop),
      "to",
      Math.round(rangeBottom),
      "| column",
      Math.round(column.top) + "-" + Math.round(column.bottom),
      "(" + Math.round(columnHeight) + "px of scrolling area)",
      "| about",
      estimate,
      "screenshots | stride",
      Math.round(geometry.stride),
      "px | dpr",
      dpr,
      "| predicted image parts:",
      predictedParts
    );

    try {
      while (index < MAX_STRIPS) {
        if (cancelled) return;
        updateProgress(index, estimate);

        scrollContainerTo(scrollContainer, targetTop);
        // Let the page repaint and any lazy content load, then make sure it really has
        // come to rest before we trust a scroll reading.
        await settle();
        await waitForStableScroll(scrollContainer);
        if (cancelled) return;

        // The whole pass is computed from the viewport geometry at its start. If the
        // window has been resized, zoomed, or moved to a differently-scaled display
        // since, every coordinate is stale — stop now rather than stitching a broken
        // image. runCapture's catch shows the userMessage on the bar.
        if (
          window.innerWidth !== startViewport.width ||
          window.innerHeight !== startViewport.height ||
          (window.devicePixelRatio || 1) !== startViewport.dpr
        ) {
          const failure = new Error("viewport changed mid-capture");
          failure.userMessage =
            "Window resized or zoomed — capture stopped before the image could come out broken";
          throw failure;
        }

        // Do the rate-limit waiting now, while the page is free to move, rather than
        // after we have measured it.
        await waitForCaptureSlot();
        if (cancelled) return;

        // Hide our own UI, or the progress card and the dim get baked into the shot.
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

        // This is the last screenshot if we asked for the end of the range, or if the
        // page refused to scroll any further.
        const isLast =
          targetTop >= rangeBottom - 0.5 ||
          (previousActual !== null && actualTop <= previousActual + 0.5);

        // The first shot starts at the top edge the user drew, and the last runs down
        // to the bottom edge they released at. Everything in between is the full
        // visible height of the scrolling area — that is what makes the steps
        // screen-sized instead of box-sized.
        const cropTop = index === 0 ? box.top : column.top;
        const cropBottom = isLast
          ? clamp(Math.max(boxBottom, column.bottom), cropTop + 1, window.innerHeight)
          : column.bottom;

        const bitmap = await cropColumn(dataUrl, dpr, cropTop, cropBottom);
        try {
          // Drop the rows a page's edge fades wash out. The first strip keeps its top
          // and the last keeps its bottom, because those two edges are the ones the
          // user chose when they drew and released the box.
          const room = Math.floor((bitmap.height - 1) / 2);
          const skipTop =
            index === 0 ? 0 : Math.min(Math.round(geometry.trimTop * dpr), room);
          const skipBottom = isLast
            ? 0
            : Math.min(Math.round(geometry.trimBottom * dpr), room);

          // Where the scroll numbers say the first DRAWN row of this strip goes. Row 0
          // of the image is the content that sat at the box's top edge when the box was
          // drawn, which is why box.top comes into it.
          const expectedY =
            Math.round((actualTop + cropTop - rangeTop - box.top) * dpr) +
            skipTop +
            drift;

          // Then check that against the pixels themselves, matching on crisp rows we
          // are actually going to keep rather than on faded ones we have dropped.
          let drawY = expectedY;
          let matched = false;
          if (index > 0) {
            const aligned = alignStrip(
              page.context,
              page.canvas.height,
              bitmap,
              expectedY - page.start, // the matcher works in page-local rows
              skipTop
            );
            drawY = aligned.y + page.start;
            matched = aligned.matched;
            if (drawY !== expectedY) {
              console.log(
                "[scroll-region-capture] screenshot",
                index + 1,
                "nudged",
                drawY - expectedY,
                "device px to line up with the one before"
              );
            }
            drift += drawY - expectedY;
          }
          // ADAPTIVE TRIM: at the first seam, and only there, work out how far this
          // page's fades really reach and resize every later strip to suit. Pages that
          // fade nothing — most of them — get a much smaller overlap from here on, and
          // so need fewer screenshots for the same region.
          if (index === 1 && !measured && matched && previousTail) {
            const head = readRows(bitmap, 0, Math.round(geometry.overlap * dpr));
            const shift = drawY - skipTop - previousRow0Y;
            const fades = measureFades(
              previousTail,
              head,
              shift,
              previousHeight,
              Math.round(geometry.overlap * dpr)
            );

            if (fades) {
              geometry = geometryFor(fades.top / dpr, fades.bottom / dpr, columnHeight);
              console.log(
                "[scroll-region-capture] measured page fade:",
                Math.round(fades.top / dpr),
                "px at the top,",
                Math.round(fades.bottom / dpr),
                "px at the bottom — trimming",
                geometry.trimTop + "/" + geometry.trimBottom,
                "px, stride now",
                Math.round(geometry.stride),
                "px"
              );
            } else {
              console.log(
                "[scroll-region-capture] could not measure the fade; keeping the",
                "cautious trim of",
                geometry.trimTop + "/" + geometry.trimBottom,
                "px"
              );
            }
            measured = true;
          }

          const drawHeight = Math.max(1, bitmap.height - skipTop - skipBottom);

          // Start a new page when this strip would run off the bottom of the current
          // one. The cut lands exactly on the strip's first row, so the two files join
          // with nothing missing and nothing repeated.
          if (drawY + drawHeight > page.start + page.canvas.height) {
            saved.push(await savePage(page, drawY, baseName, saved.length + 1, true));
            page = createPage(
              drawY,
              widthPx,
              Math.min(
                MAX_PAGE_HEIGHT,
                Math.max(2000, estimatedHeight + slack - drawY)
              )
            );
            console.log(
              "[scroll-region-capture] starting image part",
              saved.length + 1
            );
          }

          const localY = clamp(
            drawY - page.start,
            0,
            Math.max(0, page.canvas.height - drawHeight)
          );
          page.context.drawImage(
            bitmap,
            0,
            skipTop,
            bitmap.width,
            drawHeight,
            0,
            localY,
            bitmap.width,
            drawHeight
          );

          drawY = page.start + localY; // in case the clamp moved it
          lastDrawnBottom = Math.max(lastDrawnBottom, drawY + drawHeight);

          // Remember what the next strip needs to know about this one.
          previousRow0Y = drawY - skipTop;
          previousHeight = bitmap.height;
          lastRow0Y = drawY - skipTop;
          lastCropTop = cropTop;

          if (index === 0 && !measured) {
            // Keep this strip's bottom rows so the fade can be measured at the first
            // seam. Only the overlap region is needed, not the whole strip.
            const tailHeight = Math.min(
              bitmap.height,
              Math.round(geometry.overlap * dpr)
            );
            previousTail = readRows(bitmap, bitmap.height - tailHeight, tailHeight);
          }
        } finally {
          bitmap.close(); // these are large; release each one as soon as it is drawn
        }

        // The first strip's tail is only ever needed at the first seam.
        if (index === 1) previousTail = null;

        previousActual = actualTop;
        index++;
        updateProgress(index, estimate);
        if (isLast) break;

        targetTop = Math.min(actualTop + geometry.stride, rangeBottom);
        // Keep the count honest as the stride changes.
        estimate =
          index + Math.max(1, Math.ceil((rangeBottom - actualTop) / geometry.stride));
      }

      if (cancelled) return;

      // Put the page back before doing the remaining work, so the user sees it return
      // to normal as soon as the screenshots are done.
      restoreSticky();
      scrollContainerTo(scrollContainer, selectionScrollTop);

      // The image ends at the bottom edge the user released at, which sits this far
      // below the last strip's first row.
      const endY = Math.min(
        lastDrawnBottom,
        lastRow0Y + Math.round((boxBottom - lastCropTop) * dpr)
      );
      saved.push(
        await savePage(page, endY, baseName, saved.length + 1, saved.length > 0)
      );

      let totalHeight = 0;
      for (const item of saved) totalHeight += item.height;

      console.log(
        "[scroll-region-capture] finished:",
        index,
        "screenshots into",
        saved.length,
        saved.length === 1 ? "image" : "images",
        "|",
        widthPx + " x " + totalHeight,
        "device px | total drift",
        drift,
        "px"
      );

      // Put it straight on the clipboard as well, so a capture can be pasted into a
      // chat or a document without going near the downloads folder. With a split
      // capture only the first part goes on the clipboard — it holds one image.
      const copied = await copyToClipboard(saved[0].blob);
      if (copied) console.log("[scroll-region-capture] copied to the clipboard");

      // Only the first part is kept in memory, for the Copy button.
      for (let i = 1; i < saved.length; i++) saved[i].blob = null;

      if (!cancelled) showResult(saved, widthPx, totalHeight, copied);
    } catch (error) {
      console.error("[scroll-region-capture] capture failed:", error);
      hideProgress();
      // Leave the message up for a few seconds so it is readable, then tidy up.
      // Errors carrying a userMessage (like the viewport guard) say what happened;
      // anything else points at the console for details.
      setVisible(bar, true);
      setBarText(
        (error && error.userMessage) || "Capture failed — see the console for details",
        []
      );
      await wait(3000);
      if (!cancelled) cleanup();
    } finally {
      // Whatever happened — success, failure or Esc — the page must be left exactly as
      // we found it.
      restoreSticky();
      restoreScrolling();
    }
  }

  // --- Teardown ---------------------------------------------------------------

  // Removes every trace of the extension from the page: the DOM we added, the
  // listeners we registered, the timers, the animation loop, and the global we set.
  function cleanup() {
    // If a capture pass is mid-flight, tell it to stop and put the page back where it
    // was — otherwise Esc would leave the user stranded halfway down the article.
    cancelled = true;
    if (step === "capturing" && scrollContainer) {
      scrollContainerTo(scrollContainer, selectionScrollTop);
    }

    step = "idle";
    stopAutoScroll();
    hideProgress();
    clearTimeout(resultTimer);
    resultTimer = null;
    resultBlob = null;

    root.removeEventListener("mousemove", onRootMouseMove, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("mousemove", onSelectMove, true);
    document.removeEventListener("mouseup", onSelectUp, true);
    document.removeEventListener("mousemove", onMoveMove, true);
    document.removeEventListener("mousemove", onResizeMove, true);
    document.removeEventListener("mouseup", onEditUp, true);
    document.removeEventListener("mousemove", onExtendMove, true);
    document.removeEventListener("mouseup", onExtendUp, true);

    root.remove();
    delete window[CLEANUP_KEY];
    console.log("[scroll-region-capture] overlay removed");
  }

  // Esc cancels at any point; Enter starts the capture once a box exists. Both are
  // captured at the document level with `true` so we see the key before the page does,
  // and stopPropagation keeps the page from also reacting (many sites close menus or
  // submit forms on these keys).
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      return;
    }

    if (event.key === "Enter" && step === "ready") {
      event.preventDefault();
      event.stopPropagation();
      startCapture();
    }
  }

  // --- Wire everything up -----------------------------------------------------

  topPill.addEventListener("mousedown", (event) => onPillMouseDown(event, -1), true);
  bottomPill.addEventListener("mousedown", (event) => onPillMouseDown(event, 1), true);
  captureButton.addEventListener("click", startCapture);
  fullPageButton.addEventListener("click", onFullPageClick);
  cancelButton.addEventListener("click", cleanup);
  root.addEventListener("mousedown", onRootMouseDown, true);
  root.addEventListener("mousemove", onRootMouseMove, true);
  document.addEventListener("keydown", onKeyDown, true);
  window[CLEANUP_KEY] = cleanup;

  setHandlesVisible(false);
  updateBar();

  console.log("[scroll-region-capture] overlay shown — drag to select, Esc to cancel");
})();
