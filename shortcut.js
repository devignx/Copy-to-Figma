// Chrome rejects Cmd+Option / Ctrl+Alt combos as manifest shortcuts, so the
// Cmd+Option+O (Mac) / Ctrl+Alt+O (Windows, Linux) trigger is handled here.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyO' || !event.altKey || event.shiftKey || event.repeat) {
    return;
  }
  if (!event.metaKey && !event.ctrlKey) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  chrome.runtime.sendMessage({ type: 'copy-to-figma' });
}, true);

// Messages from the capture toolbar (MAIN world): persist preferences and release the resolution emulation when the toolbar closes.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || window.parent !== window) return;
  const { type, prefs, reason } = event.data;
  if (type === 'h2d-set-pref' && prefs) {
    chrome.storage.local.set(prefs);
  } else if (type === 'h2d-release') {
    chrome.runtime.sendMessage({ type: 'h2d-release', reason });
  }
});
