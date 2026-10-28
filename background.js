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
  clausePing(); // tell Clause the extension is alive (the plugin shows it as connected)

  try {
    const { resolution } = await chrome.storage.local.get(DEFAULT_PREFS);
    // Injecting the scripts does not depend on the viewport, so do it while the size is applied.
    await Promise.all([applyResolution(tab, resolution), injectFrameSupport(tab.id)]);
    await applyPreferences(tab.id);
    const stageIt = (await clauseMode()) === 'stage';
    stageTabs.set(tab.id, stageIt);

    // The page was already settled by the size check, so it needs less time before reading.
    const delay = emulated.has(tab.id) || savedWindows.has(tab.id) ? 150 : 400;
    // Start the capture directly (capture.js is already loaded in every frame).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [delay, stageIt],
      func: (d, stage) => {
        window.__h2dDone = 0;
        window.__h2dLastHtml = '';
        // Staging: keep a copy of what goes onto the clipboard so Clause can queue it (the clipboard itself is still written as usual)
        if (stage && !window.__h2dClipWrapped && navigator.clipboard && navigator.clipboard.write) {
          window.__h2dClipWrapped = true;
          const orig = navigator.clipboard.write.bind(navigator.clipboard);
          navigator.clipboard.write = async (items) => {
            try {
              for (const it of items) if (it.types && it.types.includes('text/html')) window.__h2dLastHtml = await (await it.getType('text/html')).text();
            } catch (e) { /* the normal copy still goes ahead */ }
            return orig(items);
          };
        }
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
// ---- Hand the copy to Figma through the Clause server (see Clause: scripts/webpaste.mjs) ----
const CLAUSE_DEFAULTS = { sendToClause: true, clauseUrl: 'http://localhost:8787' };

function flashBadge(tabId, text, color, title) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text, tabId });
  if (title) chrome.action.setTitle({ title, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: 'Copy to Figma', tabId }).catch(() => {});
  }, 4000);
}

// ---- In-page validation: toasts in the captured page itself, driven by Clause's live status ----
const clauseBase = async () => (await chrome.storage.local.get(CLAUSE_DEFAULTS)).clauseUrl.replace(/\/$/, '');

function clauseToast(tabId, payload) {
  const msg = Object.assign({ type: 'clause-toast' }, payload);
  chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(async () => {
    // No toast script in this tab: it was open before the extension was loaded or reloaded. Put it there and try once more.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['shortcut.js'] });
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    } catch (e) { /* a page we may not script (chrome://, the Web Store): nothing to show */ }
  });
}

let lastPing = 0;
async function clausePing() {
  if (Date.now() - lastPing < 20000) return;
  lastPing = Date.now();
  try {
    const { sendToClause } = await chrome.storage.local.get(CLAUSE_DEFAULTS);
    if (!sendToClause) return;
    await fetch((await clauseBase()) + '/capture/ping', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clause': '1' }, body: '{}' });
  } catch (e) { /* Clause is not running: nothing to say */ }
}
chrome.tabs.onActivated.addListener(() => { clausePing(); });
chrome.runtime.onStartup.addListener(() => { clausePing(); });
clausePing();

// Paste switched off in Clause Assist: stay completely quiet (no toast, no badge): the copy is on the clipboard as usual.
async function clauseOff() {
  try { const st = await fetch((await clauseBase()) + '/capture/status').then((r) => r.json()); return !!st && st.enabled === false; } catch (e) { return false; }
}

// Staging: when Clause Assist is in "Stage, paste all" mode the copy is queued in Clause instead of pasted right away.
const stageTabs = new Map();
async function clauseMode() {
  try {
    const { sendToClause } = await chrome.storage.local.get(CLAUSE_DEFAULTS);
    if (!sendToClause) return 'now';
    const st = await fetch((await clauseBase()) + '/capture/status').then((r) => r.json());
    return st && st.enabled && st.mode === 'stage' ? 'stage' : 'now';
  } catch (e) { return 'now'; }
}

async function stageClause(tabId) {
  const base = await clauseBase();
  clauseToast(tabId, { state: 'working', title: 'Adding to the queue…', sub: 'Saving this page in Clause' });
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => window.__h2dLastHtml || '' });
    const html = (r && r.result) || '';
    if (!html) return clauseToast(tabId, { state: 'warn', title: 'Could not queue this page', sub: 'The capture was copied to your clipboard (⌘V in Figma).' });
    const tab = await chrome.tabs.get(tabId);
    const res = await fetch(base + '/capture/stage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clause': '1' },
      body: JSON.stringify({ title: tab.title || tab.url, url: tab.url, html })
    });
    const info = await res.json().catch(() => ({}));
    if (res.ok) {
      flashBadge(tabId, String(info.queued), '#1f6feb', info.queued + ' page' + (info.queued === 1 ? '' : 's') + ' queued in Clause');
      return clauseToast(tabId, { state: 'ok', title: 'Added to the queue · ' + info.queued + ' ready', sub: 'Copy more pages, then press Paste all in Clause Assist.' });
    }
    if (res.status === 409) return clauseToast(tabId, { state: 'hide' });
    flashBadge(tabId, '!', '#bf6a02', info.hint || 'Clause did not queue (' + res.status + ')');
    clauseToast(tabId, { state: 'warn', title: 'Could not queue this page', sub: info.hint || 'Error ' + res.status + '. The capture is on your clipboard (⌘V in Figma).' });
  } catch (e) {
    clauseToast(tabId, { state: 'warn', title: 'Copied — Clause isn’t running', sub: 'Press ⌘V in Figma, or start Clause (npm run live).' });
  }
}

async function notifyClause(tabId) {
  const { sendToClause } = await chrome.storage.local.get(CLAUSE_DEFAULTS);
  if (!sendToClause) return;
  if (await clauseOff()) { stageTabs.delete(tabId); return; }
  if (stageTabs.get(tabId)) { stageTabs.delete(tabId); return stageClause(tabId); }
  const base = await clauseBase();
  const started = Date.now();
  clauseToast(tabId, { state: 'working', title: 'Sending to Figma…', sub: 'Clause is pasting the page into your open file' });
  try {
    // The page is already on the clipboard; this only says "paste it now".
    const res = await fetch(base + '/capture/paste', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clause': '1' },
      body: '{}'
    });
    const info = await res.json().catch(() => ({}));
    if (res.status === 409) return clauseToast(tabId, { state: 'hide' }); // switched off in the plugin: say nothing
    if (!res.ok) {
      flashBadge(tabId, '!', '#bf6a02', info.hint || 'Clause did not paste (' + res.status + ')');
      return clauseToast(tabId, { state: 'err', title: 'Clause could not paste', sub: info.hint || 'Error ' + res.status + '. The page is on your clipboard (⌘V in Figma).' });
    }
    if (info.skipped) return clauseToast(tabId, { state: 'working', title: 'Already pasting…', sub: 'One capture at a time' });
    // wait for the verdict: Clause reports busy → pasted → how many layers landed
    let st = null, doneAt = 0, told = false, cancelled = false;
    for (let i = 0; i < 330; i++) { // up to ~2 min: Clause may be waiting for a click on the Figma canvas
      await sleep(400);
      st = await fetch(base + '/capture/status').then((r) => r.json()).catch(() => null);
      if (st && st.awaiting && !told) { told = true; clauseToast(tabId, { state: 'working', title: 'Click on the canvas in Figma', sub: 'The page is pasted as soon as you click the canvas.' }); }
      if (st && !st.awaiting && told && !st.busy && (!st.last || st.last.at < started)) { cancelled = true; break; } // the paste was cancelled in the plugin
      const l = st && st.last;
      if (st && !st.busy && l && l.at >= started) {
        if (l.ok === false) break;
        if (typeof l.count === 'number') break;
        if (!doneAt) doneAt = Date.now();
        if (Date.now() - doneAt > 5000) break; // the plugin did not report a count: the paste itself went through
      }
    }
    if (cancelled) return clauseToast(tabId, { state: 'hide' });
    const l = st && st.last;
    if (l && l.ok === false) {
      flashBadge(tabId, '!', '#bf6a02', l.error);
      return clauseToast(tabId, { state: 'err', title: 'The paste did not land', sub: l.error || 'Check the Clause Assist pane in Figma.' });
    }
    const total = st && st.totals ? st.totals.frames : 0;
    if (l && l.ok && typeof l.count === 'number' && l.count > 0) {
      flashBadge(tabId, '✓', '#1a7f37', l.count + ' frame' + (l.count === 1 ? '' : 's') + ' pasted to Figma');
      return clauseToast(tabId, { state: 'ok', title: l.count + ' frame' + (l.count === 1 ? '' : 's') + ' pasted to Figma', sub: total > l.count ? total + ' pasted so far' : 'Selected and zoomed to in your file' });
    }
    if (l && l.ok && typeof l.count === 'number') {
      flashBadge(tabId, '!', '#bf6a02', 'Pasted, but nothing new appeared');
      return clauseToast(tabId, { state: 'warn', title: 'Pasted, but nothing new appeared', sub: 'Check that the right Figma file and page is open.' });
    }
    flashBadge(tabId, '✓', '#1a7f37', 'Sent to Figma through Clause');
    clauseToast(tabId, { state: 'ok', title: 'Pasted into Figma', sub: 'Clause did not report the frame count.' });
  } catch (e) {
    // Clause server not running: the copy is on the clipboard as usual.
    clauseToast(tabId, { state: 'warn', title: 'Copied — Clause isn’t running', sub: 'Press ⌘V in Figma, or start Clause (npm run live) for automatic paste.' });
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === 'h2d-release' && sender.tab) {
    const tabId = sender.tab.id;
    if (message.reason === 'copied') notifyClause(tabId); // validated copy: let Figma take it
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
