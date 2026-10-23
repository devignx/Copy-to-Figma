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

// Preferences menu in the capture toolbar (MAIN world) asks us to persist settings.
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.type !== 'h2d-set-pref') return;
  const { includeHeader } = event.data.prefs || {};
  if (typeof includeHeader === 'boolean') chrome.storage.local.set({ includeHeader });
});
