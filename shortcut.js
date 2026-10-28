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
  const { type, prefs, reason, at } = event.data;
  if (type === 'h2d-set-pref' && prefs) {
    // Persist only the user settings (the page object also carries diagnostics).
    const { includeHeader, resolution } = prefs;
    chrome.storage.local.set({ includeHeader, resolution });
  } else if (type === 'h2d-release') {
    chrome.runtime.sendMessage({ type: 'h2d-release', reason, at, relayedAt: Date.now() });
  }
});

// In-page validation toast (top frame only): background.js sends 'clause-toast' while Clause pastes the copy into Figma.
if (window.parent === window && !window.__clauseToastReady) {
  window.__clauseToastReady = true;
  let host, hideT;
  const ICON = {
    working: '<svg viewBox="0 0 16 16" class="spin"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-opacity=".25"/><path d="M8 2a6 6 0 016 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    ok: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 3v6M8 12.2v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    err: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
  };
  const COLOR = { working: '#4da3ff', ok: '#2fbf71', warn: '#f5a623', err: '#f24822' };
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const show = (m) => {
    if (m.state === 'hide') { clearTimeout(hideT); if (host) host.shadowRoot.innerHTML = ''; return; }
    if (!host) {
      host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;inset:auto 20px 20px auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647;pointer-events:none';
      host.attachShadow({ mode: 'open' });
      (document.documentElement || document.body).appendChild(host);
      // the top layer: stays above pages that use <dialog>, modals or fullscreen
      try { host.setAttribute('popover', 'manual'); host.showPopover(); } catch (e) { /* older Chrome: z-index only */ }
    }
    clearTimeout(hideT);
    const c = COLOR[m.state] || COLOR.working;
    host.shadowRoot.innerHTML = '<style>@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes sp{to{transform:rotate(360deg)}}' +
      '.t{display:flex;gap:10px;align-items:flex-start;max-width:340px;padding:12px 14px;border-radius:12px;background:#1c1c1e;color:#f2f2f3;border:1px solid #3a3a3d;box-shadow:0 8px 28px rgba(0,0,0,.35);font:13px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;animation:in .18s ease-out}' +
      '.i{flex:none;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:' + c + ';background:' + c + '22;margin-top:1px}.i svg{width:14px;height:14px}.spin{animation:sp .9s linear infinite}' +
      'b{display:block;font-weight:600}.s{display:block;color:#a1a1a6;font-size:12px;line-height:16px;margin-top:2px}</style>' +
      '<div class="t"><span class="i">' + (ICON[m.state] || ICON.working) + '</span><span><b>' + esc(m.title) + '</b>' + (m.sub ? '<span class="s">' + esc(m.sub) + '</span>' : '') + '</span></div>';
    if (m.state !== 'working') hideT = setTimeout(() => { if (host) host.shadowRoot.innerHTML = ''; }, m.state === 'ok' ? 5000 : 9000);
  };
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === 'clause-toast') show(m); });
}
