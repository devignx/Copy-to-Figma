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

async function clearResolution(tabId, { keepTimer = false } = {}) {
  clearInterval(keepAlive.get(tabId));
  keepAlive.delete(tabId);
  if (!keepTimer) {
    clearTimeout(releaseTimers.get(tabId));
    releaseTimers.delete(tabId);
    await restoreWindow(tabId);
  }
  if (!emulated.has(tabId)) return;
  emulated.delete(tabId);
  try { await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* tab gone */ }
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already detached */ }
}

const emulationStatus = new Map();
const captureStartedAt = new Map(); // tabId -> ms, ignore re-triggers while a capture is running
const lastRelease = new Map(); // tabId -> text describing what ended the previous emulation
const CAPTURE_LOCK_MS = 25000;
const keepAlive = new Map(); // tabId -> interval id
const userCancelled = new Set(); // tabs where the user dismissed the debugging bar
const savedWindows = new Map(); // tabId -> { windowId, bounds } to restore after the copy

const pageMetrics = async (tabId) => {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight })
  });
  return r.result;
};

async function sendOverride(tabId, width, height) {
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width, height: height + INFOBAR_BUFFER, deviceScaleFactor: 0, mobile: width <= 500,
    screenWidth: width, screenHeight: height + INFOBAR_BUFFER
  });
}

// Preferred: device emulation. Checked by reading the size back from the page.
async function tryEmulation(tabId, width, height) {
  if (!emulated.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    emulated.add(tabId);
  }
  let metrics;
  for (let i = 0; i < 5; i++) {
    await sendOverride(tabId, width, height);
    await sleep(350);
    metrics = await pageMetrics(tabId);
    if (Math.abs(metrics.iw - width) <= 1) return { ok: true, metrics };
  }
  return { ok: false, metrics };
}

// Fallback: really resize the browser window so the page's viewport is width x height.
async function tryWindowResize(tab, width, height) {
  const win = await chrome.windows.get(tab.windowId);
  if (win.state === 'fullscreen') throw new Error('window is fullscreen');
  const m = await pageMetrics(tab.id);
  if (!savedWindows.has(tab.id)) {
    savedWindows.set(tab.id, {
      windowId: win.id,
      bounds: { state: win.state, left: win.left, top: win.top, width: win.width, height: win.height }
    });
  }
  const chromeW = m.ow - m.iw;
  const chromeH = m.oh - m.ih;
  await chrome.windows.update(win.id, { state: 'normal' });
  await sleep(200);
  await chrome.windows.update(win.id, { width: Math.round(width + chromeW), height: Math.round(height + chromeH) });
  let after;
  for (let i = 0; i < 8; i++) {
    await sleep(250);
    after = await pageMetrics(tab.id);
    if (Math.abs(after.iw - width) <= 1) break;
  }
  return after;
}

async function restoreWindow(tabId) {
  const saved = savedWindows.get(tabId);
  if (!saved) return;
  savedWindows.delete(tabId);
  try {
    const { state, left, top, width, height } = saved.bounds;
    await chrome.windows.update(saved.windowId, { state: 'normal' });
    if (state === 'normal') {
      await chrome.windows.update(saved.windowId, { left, top, width, height });
    } else {
      await chrome.windows.update(saved.windowId, { state });
    }
  } catch (e) { /* window closed */ }
}

async function applyResolution(tab, resolution) {
  const tabId = tab.id;
  emulationStatus.set(tabId, 'not used (Current window)');
  const width = Math.round(Number(resolution && resolution.width));
  const height = Math.round(Number(resolution && resolution.height));
  if (!resolution || resolution.preset === 'auto' || !(width >= 200 && height >= 200)) {
    return clearResolution(tabId);
  }
  try {
    clearTimeout(releaseTimers.get(tabId));
    releaseTimers.set(tabId, setTimeout(() => clearResolution(tabId), MAX_EMULATION_MS));
    const emu = await tryEmulation(tabId, width, height);
    if (emu.ok) {
      emulationStatus.set(tabId, 'device emulation OK, page reports ' + emu.metrics.iw + 'x' + emu.metrics.ih + ' (re-applied every 400ms during capture)');
      // Something (the browser or the page) can reset the override while the capture scripts
      // load, so keep re-asserting it until the copy finishes and we release.
      userCancelled.delete(tabId);
      clearInterval(keepAlive.get(tabId));
      keepAlive.set(tabId, setInterval(async () => {
        if (userCancelled.has(tabId)) return;
        try {
          if (!emulated.has(tabId)) {
            await chrome.debugger.attach({ tabId }, '1.3');
            emulated.add(tabId);
          }
          await sendOverride(tabId, width, height);
        } catch (e) { /* tab closed or debugger busy */ }
      }, 400));
      await sleep(400);
      return;
    }
    // Emulation did not change the page: drop the debug session and resize the window instead.
    const reported = emu.metrics ? emu.metrics.iw + 'x' + emu.metrics.ih : '?';
    await clearResolution(tabId, { keepTimer: true });
    const after = await tryWindowResize(tab, width, height);
    emulationStatus.set(tabId, 'device emulation had no effect (page stayed ' + reported + '); window resize -> page reports ' +
      after.iw + 'x' + after.ih);
    await sleep(400);
  } catch (error) {
    console.warn('Could not set resolution:', error);
    emulationStatus.set(tabId, 'FAILED: ' + (error && error.message ? error.message : String(error)));
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  emulated.delete(source.tabId);
  if (reason === 'canceled_by_user') {
    userCancelled.add(source.tabId);
    clearInterval(keepAlive.get(source.tabId));
    keepAlive.delete(source.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => emulated.delete(tabId));

async function applyPreferences(tabId) {
  const prefs = await chrome.storage.local.get(DEFAULT_PREFS);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => { window.__h2dPrefs = p; },
    args: [Object.assign({}, prefs, { emulation: (emulationStatus.get(tabId) || 'unknown') + ' | previous copy ended by: ' + (lastRelease.get(tabId) || 'n/a') })],
    world: 'MAIN'
  });
}

async function captureTab(tab) {
  if (!tab || !tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return;
  }
  // A second trigger (icon + shortcut, key repeat, ...) must not start a parallel capture:
  // the first one finishing would release the other's emulation mid-capture.
  const running = captureStartedAt.get(tab.id);
  if (running && Date.now() - running < CAPTURE_LOCK_MS) {
    console.warn('Copy to Figma: capture already running, ignoring extra trigger');
    return;
  }
  captureStartedAt.set(tab.id, Date.now());

  try {
    const { resolution } = await chrome.storage.local.get(DEFAULT_PREFS);
    await applyResolution(tab, resolution);
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
    captureStartedAt.delete(tab.id);
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
  if (message && message.type === 'h2d-release' && sender.tab) {
    const tabId = sender.tab.id;
    const started = captureStartedAt.get(tabId);
    lastRelease.set(tabId, (message.reason || 'unknown') + ' after ' + (started ? ((Date.now() - started) / 1000).toFixed(1) + 's' : '?'));
    captureStartedAt.delete(tabId);
    clearResolution(tabId);
  }
});
