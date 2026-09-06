// background.js — the extension's service worker.
//
// This file stays deliberately tiny. Its only two jobs are:
//   1. Inject the overlay into the current tab when the toolbar icon is clicked.
//   2. Answer CAPTURE_VIEWPORT messages with a screenshot of the visible tab.
//
// Everything else — the UI, the dragging, the cropping, the stitching — lives in
// src/overlay.js, because that code needs the page's DOM and a service worker has none.
// Taking the screenshot has to happen here, though: chrome.tabs.captureVisibleTab is
// not available to content scripts.

// --- Job 1: injection -------------------------------------------------------

// Runs when the user clicks the extension's toolbar icon — and also when they press
// the Alt+Shift+S shortcut from the manifest's "_execute_action" command, which
// Chrome delivers here exactly as if the icon had been clicked. No extra code needed.
// We only get permission to touch the page at this exact moment, thanks to "activeTab",
// which is why injection happens here instead of via a declared content script.
chrome.action.onClicked.addListener(async (tab) => {
  console.log("[scroll-region-capture] icon clicked on tab", tab.id, tab.url);

  // Chrome refuses to inject into its own pages (chrome://, the Web Store, etc.).
  // Bail out early with a clear message instead of throwing a confusing error.
  if (!tab.id || !tab.url || !/^https?:|^file:/.test(tab.url)) {
    console.warn(
      "[scroll-region-capture] cannot run on this page:",
      tab.url,
      "— try a normal http(s) website."
    );
    return;
  }

  try {
    // The stylesheet has to land before the script, so the overlay is styled
    // the instant it is added to the page (no flash of unstyled dimming).
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["src/overlay.css"],
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/overlay.js"],
    });

    console.log("[scroll-region-capture] overlay injected");
  } catch (error) {
    console.error("[scroll-region-capture] injection failed:", error);
  }
});

// --- Job 2: taking screenshots ----------------------------------------------

// Chrome rate-limits captureVisibleTab to about two calls per second, and rejects
// anything faster with a "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND" error. So we keep
// our own minimum gap between shots, comfortably under the limit.
const MIN_GAP_BETWEEN_CAPTURES = 600; // milliseconds

// When the previous capture happened, so we know how long to wait before the next.
let lastCaptureTime = 0;

// Requests are chained onto this promise, one after another. Without it two overlapping
// requests could both check the clock at the same moment and both fire immediately.
let captureQueue = Promise.resolve();

// A plain sleep, since there is no built-in one.
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Takes one screenshot of the visible area of the tab that asked for it, waiting first
// if the last shot was too recent. Retries once, because the rate limit is shared with
// anything else on the machine that might be capturing.
async function captureVisibleTab(windowId) {
  const waitFor = MIN_GAP_BETWEEN_CAPTURES - (Date.now() - lastCaptureTime);
  if (waitFor > 0) await sleep(waitFor);

  try {
    lastCaptureTime = Date.now();
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    console.warn("[scroll-region-capture] capture failed, retrying once:", error);
    await sleep(MIN_GAP_BETWEEN_CAPTURES);
    lastCaptureTime = Date.now();
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

// The content script sends { type: "CAPTURE_VIEWPORT" } once per strip and waits for
// the resulting data URL. Replies are always shaped { ok: true, dataUrl } or
// { ok: false, error }, so the content script never has to guess what went wrong.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "CAPTURE_VIEWPORT") return;

  const windowId = sender.tab ? sender.tab.windowId : undefined;

  captureQueue = captureQueue
    .then(() => captureVisibleTab(windowId))
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((error) => {
      console.error("[scroll-region-capture] capture error:", error);
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });

  // Returning true tells Chrome we will call sendResponse later, and to keep the
  // message channel open until we do.
  return true;
});
