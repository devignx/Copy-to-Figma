async function injectCaptureFile(tabId, allFrames = false) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    files: ['capture.js'],
    world: 'MAIN'
  });
}

// Sub-frames only need capture.js loaded (no hash, so they don't start their own
// capture) plus frames.js, which lets the top frame pull their DOM into its payload.
async function injectFrameSupport(tabId) {
  await injectCaptureFile(tabId, true);
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['frames.js'],
    world: 'MAIN'
  });
}

// Set the capture fragment WITHOUT firing `hashchange`, so SPA hash-routers
// don't re-navigate and drop the URL query params. Stash the original URL so
// we can restore it after capture.js has read the hash.
function setFigmaCaptureHash() {
  window.__figmaOriginalHref = window.location.href;
  const base = window.location.href.split('#')[0];
  history.replaceState(null, '', base + '#figmacapture&figmadelay=1000');
}

function restoreOriginalHref() {
  if (window.__figmaOriginalHref) {
    history.replaceState(null, '', window.__figmaOriginalHref);
    delete window.__figmaOriginalHref;
  }
}

const DEFAULT_PREFS = { includeHeader: true, resolution: { preset: 'auto', width: 1440, height: 900 } };

// ---- Resolution: emulate the viewport size via the debugger protocol ----
// Chrome/Brave's "started debugging this browser" infobar takes this much height off
// the viewport once attached, so emulate that much extra to land on the requested size.
const INFOBAR_BUFFER = 45;
const emulated = new Set();
const releaseTimers = new Map();
const MAX_EMULATION_MS = 30000; // safety net if the page never reports completion
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearResolution(tabId) {
  clearTimeout(releaseTimers.get(tabId));
  releaseTimers.delete(tabId);
  if (!emulated.has(tabId)) return;
  emulated.delete(tabId);
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* tab gone */ }
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already detached */ }
}

async function applyResolution(tabId, resolution) {
  const width = Math.round(Number(resolution && resolution.width));
  const height = Math.round(Number(resolution && resolution.height));
  if (!resolution || resolution.preset === 'auto' || !(width >= 200 && height >= 200)) {
    return clearResolution(tabId);
  }
  try {
    if (!emulated.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      emulated.add(tabId);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
      width, height: height + INFOBAR_BUFFER, deviceScaleFactor: 0, mobile: width <= 500,
      screenWidth: width, screenHeight: height + INFOBAR_BUFFER
    });
    clearTimeout(releaseTimers.get(tabId));
    releaseTimers.set(tabId, setTimeout(() => clearResolution(tabId), MAX_EMULATION_MS));
    await sleep(800); // let the page and its frames reflow
  } catch (error) {
    // e.g. DevTools is already open on this tab
    console.warn('Could not set resolution:', error);
  }
}

chrome.debugger.onDetach.addListener((source) => emulated.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => emulated.delete(tabId));

async function applyPreferences(tabId) {
  const prefs = await chrome.storage.local.get(DEFAULT_PREFS);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => { window.__h2dPrefs = p; },
    args: [prefs],
    world: 'MAIN'
  });
}

async function captureTab(tab) {
  if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return;
  }

  try {
    const { resolution } = await chrome.storage.local.get(DEFAULT_PREFS);
    await applyResolution(tab.id, resolution);
    await injectFrameSupport(tab.id);
    await applyPreferences(tab.id);

    await new Promise((resolve) => setTimeout(resolve, 500));

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: setFigmaCaptureHash,
      world: 'MAIN'
    });

    // capture.js reads location.hash synchronously at load, then awaits its
    // own delay — so the URL can be restored right after this inject.
    await injectCaptureFile(tab.id);

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: restoreOriginalHref,
      world: 'MAIN'
    });
  } catch (error) {
    console.error('Failed to run Figma capture script:', error);
  }
}

chrome.action.onClicked.addListener(captureTab);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'copy-to-figma') {
    captureTab(tab);
  }
});

// Cmd/Ctrl+Option+O, sent from shortcut.js.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'copy-to-figma' && sender.tab) {
    captureTab(sender.tab);
  }
});

// The capture toolbar tells us when the copy is finished (or failed) so the debug
// session, and its infobar, only exists while a capture is running.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'h2d-release' && sender.tab) clearResolution(sender.tab.id);
});
