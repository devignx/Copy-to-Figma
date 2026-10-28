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

const DEFAULT_PREFS = { includeHeader: true, resolution: { preset: 'auto', width: 1440, height: 900 } };

// ---- Resolution: emulate the viewport size via the debugger protocol ----
// Extra height added to the emulated viewport. 0: device emulation sets the page's viewport
// exactly (the page reports the override size), the debugging infobar does not take any of it.
const INFOBAR_BUFFER = 0;
const emulated = new Set();
const releaseTimers = new Map();
const MAX_EMULATION_MS = 30000; // safety net if the page never reports completion
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function clearResolution(tabId, { keepTimer = false } = {}) {
  if (closing.has(tabId)) return null; // a release is already running (duplicate triggers)
  const tStart = Date.now();
  closing.add(tabId); // also stops any in-flight re-apply from re-attaching
  clearInterval(keepAlive.get(tabId));
  keepAlive.delete(tabId);
  emulated.delete(tabId);
  // Detach first: it removes the debugging bar at once and Chrome resets the emulation by
  // itself. Waiting for an explicit "clear override" made the page re-layout before the
  // detach, which on a big page took seconds. Do not trust in-memory state (the service
  // worker may have restarted): always try, then confirm and retry.
  let detachResult = 'ok';
  const detach = async () => { try { await chrome.debugger.detach({ tabId }); detachResult = 'ok'; } catch (e) { detachResult = 'error: ' + (e && e.message ? e.message : e); } };
  await detach();
  const detachMs = Date.now() - tStart;
  if (!keepTimer) {
    clearTimeout(releaseTimers.get(tabId));
    releaseTimers.delete(tabId);
    restoreWindow(tabId); // only does anything after the window-resize fallback
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let stillAttached = false;
    try {
      const targets = await chrome.debugger.getTargets();
      stillAttached = targets.some((t) => t.tabId === tabId && t.attached);
    } catch (e) { /* ignore */ }
    if (!stillAttached) break;
    await sleep(100);
    await detach();
  }
  closing.delete(tabId);
  return { detachMs, totalMs: Date.now() - tStart, detachResult };
}

const emulationStatus = new Map();
const detachedAt = new Map(); // tabId -> time of Chrome's own "detached" event
const captureStartedAt = new Map(); // tabId -> ms, ignore re-triggers while a capture is running
const lastRelease = new Map(); // tabId -> text describing what ended the previous emulation
const saveReleaseNote = (tabId, text) => {
  lastRelease.set(tabId, text);
  chrome.storage.local.set({ lastReleaseNote: text });
  // Also hand it to the open page so this copy's own report (⋯ menu) shows it.
  chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [text], func: (t) => { window.__h2dReleaseNote = t; } }).catch(() => {});
};
const CAPTURE_LOCK_MS = 25000;
const keepAlive = new Map(); // tabId -> interval id
const closing = new Set(); // tabs being released right now
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
  for (let round = 0; round < 4; round++) {
    await sendOverride(tabId, width, height);
    for (let i = 0; i < 15; i++) { // up to ~600ms per round
      await sleep(40);
      metrics = await pageMetrics(tabId);
      if (Math.abs(metrics.iw - width) <= 1) return { ok: true, metrics };
    }
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
      emulationStatus.set(tabId, 'device emulation OK, page reports ' + emu.metrics.iw + 'x' + emu.metrics.ih + ' (re-applied only if the page drifts)');
      // Something (the browser or the page) can reset the override while the capture scripts
      // load, so keep re-asserting it until the copy finishes and we release.
      userCancelled.delete(tabId);
      clearInterval(keepAlive.get(tabId));
      keepAlive.set(tabId, setInterval(async () => {
        if (userCancelled.has(tabId) || closing.has(tabId) || !keepAlive.has(tabId)) return;
        try {
          if (!emulated.has(tabId)) {
            await chrome.debugger.attach({ tabId }, '1.3');
            emulated.add(tabId);
            if (closing.has(tabId) || !keepAlive.has(tabId)) { // released while attaching
              emulated.delete(tabId);
              await chrome.debugger.detach({ tabId });
              return;
            }
          }
          const m = await pageMetrics(tabId);
          if (Math.abs(m.iw - width) > 1 || Math.abs(m.ih - (height + INFOBAR_BUFFER)) > 1) {
            await sendOverride(tabId, width, height);
          }
        } catch (e) { /* tab closed or debugger busy */ }
      }, 400));
      await sleep(150);
      return;
    }
    // Emulation did not change the page: drop the debug session and resize the window instead.
    const reported = emu.metrics ? emu.metrics.iw + 'x' + emu.metrics.ih : '?';
    await clearResolution(tabId, { keepTimer: true });
    const after = await tryWindowResize(tab, width, height);
    emulationStatus.set(tabId, 'device emulation had no effect (page stayed ' + reported + '); window resize -> page reports ' +
      after.iw + 'x' + after.ih);
    await sleep(150);
  } catch (error) {
    console.warn('Could not set resolution:', error);
    emulationStatus.set(tabId, 'FAILED: ' + (error && error.message ? error.message : String(error)));
  }
}

chrome.debugger.onDetach.addListener((source, reason) => {
  detachedAt.set(source.tabId, Date.now());
  emulated.delete(source.tabId);
  if (reason === 'canceled_by_user') {
    userCancelled.add(source.tabId);
    clearInterval(keepAlive.get(source.tabId));
    keepAlive.delete(source.tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => emulated.delete(tabId));

async function applyPreferences(tabId) {
  const prefs = await chrome.storage.local.get(Object.assign({ lastReleaseNote: '' }, DEFAULT_PREFS));
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (p) => { window.__h2dPrefs = p; },
    args: [Object.assign({}, prefs, { t0: Date.now() - (captureStartedAt.get(tabId) || Date.now()), emulation: (emulationStatus.get(tabId) || 'unknown') + ' | previous copy ended by: ' + (lastRelease.get(tabId) || prefs.lastReleaseNote || 'n/a') })],
    world: 'MAIN'
  });
}

// Independent of the message relay: poll the page for "copy finished" and release at once.
async function watchForCopy(tabId) {
  const started = Date.now();
  while (Date.now() - started < MAX_EMULATION_MS) {
    await sleep(100);
    if (!emulated.has(tabId) && !savedWindows.has(tabId) && !keepAlive.has(tabId)) return; // already released
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => !!window.__h2dDone });
      if (r && r.result) {
        const seenAt = Date.now();
        captureStartedAt.delete(tabId);
        const t = await clearResolution(tabId);
        saveReleaseNote(tabId, 'watcher, copy seen ' + ((seenAt - started) / 1000).toFixed(2) + 's after capture start' +
          (t ? '; detach took ' + t.detachMs + 'ms, release total ' + t.totalMs + 'ms' : ''));
        return;
      }
    } catch (e) {
      return; // tab closed / not scriptable; the timeout path still releases
    }
  }
}

async function captureTab(tab) {
  const t0 = Date.now();
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
    // Injecting the scripts does not depend on the viewport, so do it while the size is applied.
    await Promise.all([applyResolution(tab, resolution), injectFrameSupport(tab.id)]);
    await applyPreferences(tab.id);

    // The page was already settled by the size check, so it needs less time before reading.
    const delay = emulated.has(tab.id) || savedWindows.has(tab.id) ? 150 : 400;
    // Start the capture directly (capture.js is already loaded in every frame).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [delay],
      func: (d) => {
        window.__h2dDone = 0;
        window.figma.captureForDesign({ delayMs: d });
      }
    });

    watchForCopy(tab.id); // not awaited: runs until the copy finishes
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
    const gotAt = Date.now();
    captureStartedAt.delete(tabId);
    detachedAt.delete(tabId);
    clearResolution(tabId).then((t) => {
      if (!t) return; // duplicate trigger, the first one is reporting
      const d = detachedAt.get(tabId);
      const ms = (x) => (typeof x === 'number' ? Math.round(x) + 'ms' : '?');
      saveReleaseNote(tabId, (message.reason || 'unknown') +
        ' | page signal -> content script ' + ms(message.relayedAt - message.at) +
        ' -> background ' + ms(gotAt - message.relayedAt) +
        ' | detach call ' + t.detachMs + 'ms (' + t.detachResult + '), Chrome detached event ' + (d ? ms(d - message.at) + ' after the signal' : 'not seen') +
        ' | release total ' + t.totalMs + 'ms' +
        (started ? ' | signal ' + ((message.at - started) / 1000).toFixed(2) + 's after capture start' : ''));
    });
  }
});
