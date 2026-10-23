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

async function applyPreferences(tabId) {
  const prefs = await chrome.storage.local.get({ includeHeader: true });
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
