// Iframe support for capture.js. Injected (MAIN world) into every frame of the tab.
// Each frame answers `h2d-frame-request` messages from its parent with its own
// serialized tree (which already contains its own nested iframes), and
// `window.__h2dMerge` (called by the patched capture.js) grafts those child trees
// into the parent payload at the iframe's position.
(() => {
  const REQ = 'h2d-frame-request';
  const RES = 'h2d-frame-response';
  const ACK = 'h2d-frame-ack';
  const ACK_TIMEOUT_MS = 1500;
  const ARMED_MS = 120000;
  const CHILD_TIMEOUT_MS = 20000;

  window.__h2dArmedUntil = Date.now() + ARMED_MS;
  // Re-injection replaces any previous copy so a stale version never keeps running.
  if (window.__h2dFramesCleanup) window.__h2dFramesCleanup();

  let frameCounter = 0;

  // Per-capture report: what each frame did. Shown in the preferences menu.
  const describeFrame = () => {
    const q = (sel) => document.querySelectorAll(sel).length;
    return {
      url: location.href.slice(0, 90),
      size: innerWidth + 'x' + innerHeight,
      visibility: document.visibilityState,
      elements: q('*'),
      canvas: q('canvas'),
      video: q('video'),
      iframes: q('iframe'),
      sandbox: Array.from(document.querySelectorAll('iframe')).map((i) => i.getAttribute('sandbox')).filter((v) => v != null).join('|') || undefined
    };
  };
  window.__h2dReport = [];
  const note = (line) => window.__h2dReport.push(line);

  // Child side: serialize this frame on request from the parent.
  const onRequest = async (event) => {
    const data = event.data;
    if (!data || data.type !== REQ || window.parent === window) return;
    if (event.source !== window.parent || Date.now() > window.__h2dArmedUntil) return;
    event.source.postMessage({ type: ACK, id: data.id }, '*');
    let payload = null;
    for (const skip of [false, true]) {
      window.__h2dSkipPrepare = skip;
      try {
        if (typeof window.__h2dSerialize === 'function') {
          payload = await window.__h2dSerialize('body');
        }
        break;
      } catch (error) {
        console.warn('[copy-to-figma] frame capture failed' + (skip ? '' : ', retrying without icon fixes'), error);
        window.__h2dRestore();
      }
    }
    window.__h2dSkipPrepare = false;
    const report = { frame: describeFrame(), ok: !!payload, kb: payload ? Math.round(payload.length / 1024) : 0, notes: window.__h2dReport.slice() };
    console.log('[copy-to-figma] frame', location.href.slice(0, 80), payload ? 'captured ' + Math.round(payload.length / 1024) + ' KB' : 'FAILED');
    event.source.postMessage({ type: RES, id: data.id, payload, report }, '*');
  };
  window.addEventListener('message', onRequest);
  window.__h2dFramesCleanup = () => window.removeEventListener('message', onRequest);

  function collectIframes(root, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'IFRAME') out.push(el);
      if (el.shadowRoot) collectIframes(el.shadowRoot, out);
    }
    return out;
  }

  function walk(node, fn) {
    if (!node) return;
    fn(node);
    if (node.childNodes) for (const child of node.childNodes) walk(child, fn);
  }

  // Two-stage wait: a frame that never acknowledges (no script injected, blocked,
  // still loading) is skipped after ACK_TIMEOUT_MS instead of stalling every level above it.
  function requestChild(iframe) {
    return new Promise((resolve) => {
      const win = iframe.contentWindow;
      if (!win) return resolve(null);
      const id = Math.random().toString(36).slice(2);
      let timer = setTimeout(() => {
        console.warn('[copy-to-figma] iframe did not acknowledge, skipping', iframe.src || '(srcdoc)');
        note('SKIPPED (no acknowledgement; script not injected or frame blocked): ' + (iframe.src || '(srcdoc)').slice(0, 90) + (iframe.getAttribute('sandbox') != null ? ' [sandbox=' + iframe.getAttribute('sandbox') + ']' : ''));
        finish(null);
      }, ACK_TIMEOUT_MS);
      const finish = (value) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        const d = event.data;
        if (event.source !== win || !d || d.id !== id) return;
        if (d.type === ACK) {
          clearTimeout(timer);
          timer = setTimeout(() => {
            console.warn('[copy-to-figma] iframe took too long', iframe.src || '(srcdoc)');
            note('SKIPPED (acknowledged but no result after ' + CHILD_TIMEOUT_MS / 1000 + 's): ' + (iframe.src || '(srcdoc)').slice(0, 90));
            finish(null);
          }, CHILD_TIMEOUT_MS);
        } else if (d.type === RES) {
          if (d.report) noteReport(d.report, iframe);
          finish(d.payload || null);
        }
      };
      window.addEventListener('message', onMessage);
      win.postMessage({ type: REQ, id }, '*');
    });
  }

  function noteReport(report, iframe) {
    const fr = report.frame || {};
    note((report.ok ? 'OK ' + report.kb + ' KB' : 'FAILED') + ' | ' + fr.url + ' | viewport ' + fr.size + ' (' + fr.visibility + ') | ' +
      fr.elements + ' elements, canvas ' + fr.canvas + ', video ' + fr.video + ', iframes ' + fr.iframes + (fr.sandbox ? ', sandbox ' + fr.sandbox : ''));
    for (const n of report.notes || []) note('   ' + n);
  }

  function sameRect(a, b) {
    return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
      Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  }

  function prepareChild(child, prefix, ox, oy, cw, ch, sx = 1, sy = 1) {
    const renamed = new Map();
    walk(child.root, (node) => {
      if (node.id) node.id = prefix + node.id;
      if (typeof node.placeholderUrl === 'string' && node.placeholderUrl.startsWith('rasterized:')) {
        const next = 'rasterized:' + prefix + node.placeholderUrl.slice('rasterized:'.length);
        renamed.set(node.placeholderUrl, next);
        node.placeholderUrl = next;
      }
      const rect = node.rect;
      if (rect) {
        // sx/sy: the iframe itself is scaled (CSS transform), so map child coordinates.
        rect.x = ox + rect.x * sx;
        rect.y = oy + rect.y * sy;
        rect.width *= sx;
        rect.height *= sy;
        if (rect.quad) {
          for (const p of ['p1', 'p2', 'p3', 'p4']) {
            rect.quad[p].x = ox + rect.quad[p].x * sx;
            rect.quad[p].y = oy + rect.quad[p].y * sy;
          }
        }
      }
    });
    // The canvas background of a frame fills the whole viewport, but the root
    // node only spans its content: stretch it and inherit the body background.
    const root = child.root;
    if (root.rect) {
      root.rect.width = Math.max(root.rect.width, cw * sx);
      root.rect.height = Math.max(root.rect.height, ch * sy);
      if (root.rect.cssWidth != null) root.rect.cssWidth = Math.max(root.rect.cssWidth, cw);
      if (root.rect.cssHeight != null) root.rect.cssHeight = Math.max(root.rect.cssHeight, ch);
    }
    const isClear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
    const body = (root.childNodes || []).find((n) => n.tag === 'BODY');
    if (body && body.styles && isClear(root.styles && root.styles.backgroundColor) &&
        !isClear(body.styles.backgroundColor)) {
      root.styles = Object.assign({}, root.styles, { backgroundColor: body.styles.backgroundColor });
    }
    const assets = {};
    for (const [key, entry] of Object.entries(child.assets || {})) {
      const next = renamed.get(key) || key;
      assets[next] = next === key ? entry : Object.assign({}, entry, { url: next });
    }
    return assets;
  }

  function mergeFonts(target, source) {
    for (const [key, family] of Object.entries(source || {})) {
      const existing = target[key];
      if (!existing) {
        target[key] = family;
        continue;
      }
      const seen = new Set((existing.faces || []).map((f) => JSON.stringify(f)));
      for (const face of family.faces || []) {
        if (!seen.has(JSON.stringify(face))) (existing.faces = existing.faces || []).push(face);
      }
      const usages = new Set((existing.usages || []).map((u) => JSON.stringify(u)));
      for (const usage of family.usages || []) {
        if (!usages.has(JSON.stringify(usage))) (existing.usages = existing.usages || []).push(usage);
      }
    }
  }



  // ---- Copy validation ------------------------------------------------------
  // Runs right after the clipboard write. The debug/emulation session is only released
  // once this passes (or the failure is shown), so we never end it on a bad copy.
  window.__h2dValidateCopy = async (payloadStr) => {
    const problems = [];
    const notes = [];
    try {
      if (typeof payloadStr !== 'string' || payloadStr.length < 50) problems.push('payload is empty');
      const payload = JSON.parse(payloadStr);
      if (!payload.root || !payload.root.rect) problems.push('no root node in payload');
      let nodes = 0;
      (function count(n) { if (!n) return; nodes++; (n.childNodes || []).forEach(count); })(payload.root);
      notes.push(nodes + ' nodes, ' + Math.round(payloadStr.length / 1024) + ' KB');
      if (nodes < 2) problems.push('captured tree has ' + nodes + ' node(s)');

      const res = prefs().resolution;
      if (res && res.preset !== 'auto' && res.width >= 200 && res.height >= 200) {
        const W = Math.round(res.width), H = Math.round(res.height);
        const r = payload.root && payload.root.rect;
        if (r && (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1)) {
          problems.push('frame is ' + Math.round(r.width) + 'x' + Math.round(r.height) + ', expected ' + W + 'x' + H);
        }
        // The page must really have been laid out at the chosen width, not just the frame resized.
        const [vw, vh] = (window.__h2dVpStart || '').split('x').map(Number);
        if (vw && (Math.abs(vw - W) > 1 || Math.abs(vh - H) > 1)) {
          problems.push('page was ' + window.__h2dVpStart + ' while capturing (not ' + W + 'x' + H + '), layout is not at the chosen size');
        } else if (vw) {
          notes.push('layout ' + vw + 'x' + vh + ' matches');
        }
      }
    } catch (error) {
      problems.push('payload is not valid: ' + error.message);
    }

    // Read the clipboard back when the page already has permission (never prompts).
    try {
      const perm = await Promise.race([navigator.permissions.query({ name: 'clipboard-read' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 500))]);
      if (perm.state === 'granted') {
        const items = await Promise.race([navigator.clipboard.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))]);
        let html = '';
        for (const item of items) if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (!html.includes('figh2d')) problems.push('clipboard does not contain the Figma payload');
        else notes.push('clipboard read-back OK');
      } else {
        notes.push('clipboard read-back skipped (no permission)');
      }
    } catch (error) {
      notes.push('clipboard read-back skipped');
    }

    notes.push('timing: setup ' + (prefs().t0 || 0) + 'ms before page script, copy finished ' + Math.round(performance.now() - (window.__h2dPageT0 || performance.now())) + 'ms after capture start');
    const ok = problems.length === 0;
    window.__h2dValidation = (ok ? 'OK' : 'FAILED') + ' | ' + notes.join('; ') + (ok ? '' : ' | ' + problems.join('; '));
    console.log('[copy-to-figma] copy validation: ' + window.__h2dValidation);
    return { ok, message: 'Copied, but check failed: ' + problems.join('; ') };
  };

  // ---- Preferences menu (three dots next to the toolbar's close button) -----
  const PREF_DEFAULTS = { includeHeader: true, resolution: { preset: 'auto', width: 1440, height: 900 } };
  const PRESETS = [
    ['auto', 'Current window', 0, 0], ['1920x1080', 'Desktop 1920 × 1080', 1920, 1080], ['1440x900', 'Laptop 1440 × 900', 1440, 900],
    ['1280x800', 'Laptop 1280 × 800', 1280, 800], ['1024x768', 'Small 1024 × 768', 1024, 768], ['768x1024', 'Tablet 768 × 1024', 768, 1024],
    ['390x844', 'Mobile 390 × 844', 390, 844], ['custom', 'Custom…', 0, 0]
  ];
  const prefs = () => Object.assign({}, PREF_DEFAULTS, window.__h2dPrefs || {});

  function savePref(key, value) {
    window.__h2dPrefs = Object.assign(prefs(), { [key]: value });
    // shortcut.js (isolated world) persists it to chrome.storage.
    window.postMessage({ type: 'h2d-set-pref', prefs: window.__h2dPrefs }, '*');
  }

  window.__h2dCloseWithMenu = (closeButton, theme, getShadow) => {
    const wrap = document.createElement('span');
    Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center' });

    const dots = document.createElement('button');
    dots.type = 'button';
    dots.setAttribute('aria-label', 'Preferences');
    dots.setAttribute('aria-haspopup', 'menu');
    dots.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">' +
      '<circle cx="6.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="17.5" cy="12" r="1.5"/></svg>';
    Object.assign(dots.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: theme.buttonHeight, height: theme.buttonHeight, padding: '0', border: 'none',
      borderRadius: theme.buttonBorderRadius, background: 'transparent', color: theme.text,
      cursor: 'pointer', transition: 'background .1s', marginLeft: '8px'
    });
    dots.onmouseenter = () => { dots.style.background = theme.secondaryHover; };
    dots.onmouseleave = () => { dots.style.background = 'transparent'; };

    let menu = null;
    // Anchor under (or above) the dots button, aligned to its right edge, and keep the
    // whole menu inside the visible viewport; scroll if it is taller than the space.
    const placeMenu = () => {
      if (!menu) return;
      const M = 8;
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const r = dots.getBoundingClientRect();
      const width = menu.offsetWidth;
      let left = r.right - width;
      left = Math.max(M, Math.min(left, vw - width - M));
      const spaceBelow = vh - r.bottom - M * 2;
      const spaceAbove = r.top - M * 2;
      const natural = menu.scrollHeight;
      const below = spaceBelow >= natural || spaceBelow >= spaceAbove;
      const avail = Math.max(120, below ? spaceBelow : spaceAbove);
      menu.style.maxHeight = avail + 'px';
      const height = Math.min(natural, avail);
      const top = below ? r.bottom + M : r.top - M - height;
      menu.style.left = left + 'px';
      menu.style.top = Math.max(M, top) + 'px';
      menu.style.visibility = 'visible';
    };
    const closeMenu = () => {
      if (!menu) return;
      window.removeEventListener('resize', placeMenu);
      menu.remove();
      menu = null;
      document.removeEventListener('pointerdown', onOutside, true);
    };
    const onOutside = (event) => {
      // The toolbar is a closed shadow root, so hit-test by position instead of composedPath.
      if (!menu) return;
      const inside = (el) => {
        const b = el.getBoundingClientRect();
        return event.clientX >= b.left && event.clientX <= b.right && event.clientY >= b.top && event.clientY <= b.bottom;
      };
      if (!inside(menu) && !inside(dots)) closeMenu();
    };

    dots.onclick = (event) => {
      event.stopPropagation();
      if (menu) return closeMenu();
      const shadow = getShadow();
      if (!shadow) return;
      menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      Object.assign(menu.style, {
        position: 'fixed', zIndex: '2147483647', width: '250px', maxWidth: 'calc(100vw - 16px)', padding: '10px 12px',
        borderRadius: '10px', background: theme.bg, color: theme.text, boxShadow: theme.shadow,
        fontFamily: theme.fontFamily, fontSize: theme.fontSize, lineHeight: theme.lineHeight,
        fontWeight: theme.fontWeight, boxSizing: 'border-box', overflowY: 'auto', left: '0px', top: '0px', visibility: 'hidden'
      });
      const title = document.createElement('div');
      title.textContent = 'Preferences';
      Object.assign(title.style, { opacity: '.6', marginBottom: '8px' });
      menu.appendChild(title);

      const row = document.createElement('label');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', justifyContent: 'space-between' });
      const label = document.createElement('span');
      label.textContent = 'Include Claude header';
      const sw = document.createElement('span');
      const knob = document.createElement('span');
      const paint = () => {
        const on = prefs().includeHeader;
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(on));
        Object.assign(sw.style, { position: 'relative', width: '30px', height: '18px', borderRadius: '9px', flexShrink: '0',
          background: on ? '#0d99ff' : 'rgba(255,255,255,.25)', transition: 'background .15s' });
        Object.assign(knob.style, { position: 'absolute', top: '2px', left: on ? '14px' : '2px', width: '14px', height: '14px',
          borderRadius: '50%', background: '#fff', transition: 'left .15s' });
      };
      sw.appendChild(knob);
      row.onclick = (e) => { e.preventDefault(); savePref('includeHeader', !prefs().includeHeader); paint(); };
      paint();
      row.append(label, sw);
      menu.appendChild(row);

      // ---- Resolution ----
      const resBox = document.createElement('div');
      Object.assign(resBox.style, { marginTop: '12px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.15)' });
      const resTitle = document.createElement('div');
      resTitle.textContent = 'Resolution';
      Object.assign(resTitle.style, { opacity: '.6', marginBottom: '6px' });
      const field = { font: 'inherit', color: theme.text, background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.2)',
        borderRadius: '5px', padding: '4px 6px', boxSizing: 'border-box' };
      const select = document.createElement('select');
      Object.assign(select.style, field, { width: '100%' });
      for (const [value, label] of PRESETS) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label; o.style.color = '#000';
        select.appendChild(o);
      }
      const sizeRow = document.createElement('div');
      Object.assign(sizeRow.style, { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' });
      const wIn = document.createElement('input');
      const hIn = document.createElement('input');
      for (const el of [wIn, hIn]) {
        el.type = 'number'; el.min = '200'; el.max = '8000';
        Object.assign(el.style, field, { width: '80px' });
        el.addEventListener('keydown', (e) => e.stopPropagation());
        el.addEventListener('keyup', (e) => e.stopPropagation());
      }
      const times = document.createElement('span');
      times.textContent = '×';
      const px = document.createElement('span');
      px.textContent = 'px';
      px.style.opacity = '.6';
      sizeRow.append(wIn, times, hIn, px);

      const resNote = document.createElement('div');
      resNote.textContent = 'Saved automatically and used for every copy (icon / Cmd+Option+O). The page is resized only while copying, then restored.';
      Object.assign(resNote.style, { opacity: '.55', marginTop: '6px', maxWidth: '230px', whiteSpace: 'normal' });

      const syncRes = () => {
        const r = prefs().resolution || PREF_DEFAULTS.resolution;
        select.value = PRESETS.some((p) => p[0] === r.preset) ? r.preset : 'auto';
        wIn.value = r.width; hIn.value = r.height;
        const custom = select.value === 'custom';
        wIn.disabled = hIn.disabled = !custom;
        sizeRow.style.opacity = custom ? '1' : '.5';
        sizeRow.style.display = select.value === 'auto' ? 'none' : 'flex';
      };
      const readRes = () => {
        const p = PRESETS.find((x) => x[0] === select.value);
        if (select.value === 'custom') return { preset: 'custom', width: Number(wIn.value) || 1440, height: Number(hIn.value) || 900 };
        if (select.value === 'auto') return { preset: 'auto', width: prefs().resolution.width, height: prefs().resolution.height };
        return { preset: select.value, width: p[2], height: p[3] };
      };
      select.onchange = () => { savePref('resolution', readRes()); syncRes(); };
      wIn.onchange = hIn.onchange = () => savePref('resolution', readRes());
      syncRes();
      resBox.append(resTitle, select, sizeRow, resNote);
      menu.appendChild(resBox);

      const hint = document.createElement('div');
      hint.textContent = 'Off: artifact pages paste only the artifact, without the Claude title bar. Applies to the next capture.';
      Object.assign(hint.style, { opacity: '.55', marginTop: '8px', maxWidth: '230px', whiteSpace: 'normal' });
      menu.insertBefore(hint, resBox);

      const rep = document.createElement('div');
      Object.assign(rep.style, { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.15)' });
      const lines = [].concat(
        window.__h2dValidation ? ['COPY VALIDATION: ' + window.__h2dValidation] : [],
        ['RELEASE (this copy): ' + (window.__h2dReleaseNote || 'not finished yet, reopen this menu in a few seconds')],
        window.__h2dTop ? ['TOP | ' + JSON.stringify(window.__h2dTop)] : [],
        window.__h2dReport && window.__h2dReport.length ? window.__h2dReport : ['(no iframes captured)']
      );
      const text = lines.join('\n');
      const summary = document.createElement('div');
      const bad = lines.filter((l) => /SKIPPED|FAILED|NOT MATCHED/.test(l)).length;
      summary.textContent = bad ? 'Last capture: ' + bad + ' frame problem' + (bad > 1 ? 's' : '') : 'Last capture: no frame problems';
      Object.assign(summary.style, { opacity: '.8', marginBottom: '6px' });
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy report';
      Object.assign(copy.style, { border: 'none', borderRadius: '5px', padding: '4px 8px', background: 'rgba(255,255,255,.12)',
        color: theme.text, cursor: 'pointer', font: 'inherit' });
      copy.onclick = async (e) => {
        e.stopPropagation();
        try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
        catch (err) { copy.textContent = 'Copy failed'; console.log('[copy-to-figma] report\n' + text); }
      };
      rep.append(summary, copy);
      menu.appendChild(rep);
      console.log('[copy-to-figma] capture report\n' + text);

      shadow.appendChild(menu);
      placeMenu();
      window.addEventListener('resize', placeMenu);
      document.addEventListener('pointerdown', onOutside, true);
    };

    closeButton.addEventListener('click', () => window.postMessage({ type: 'h2d-release', reason: 'close-button', at: Date.now() }, '*'));
    wrap.append(dots, closeButton);
    return wrap;
  };

  // ---- Pre-capture normalisation -------------------------------------------
  // capture.js clones <svg> markup, so icons that depend on page structure/CSS
  // vanish: <use href="#sprite"> loses its symbol, and CSS mask-image icons are
  // ignored. Resolve both into plain SVG / background images, then undo.
  let undo = [];

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const externalDocs = new Map();

  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  async function loadExternalSprites(roots) {
    const urls = new Set();
    for (const root of roots) {
      for (const use of root.querySelectorAll('svg use')) {
        const ref = use.getAttribute('href') || use.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (ref && ref[0] !== '#' && ref.includes('#')) urls.add(new URL(ref.split('#')[0], location.href).href);
      }
    }
    await Promise.all(Array.from(urls).filter((u) => !externalDocs.has(u)).map(async (u) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const text = await (await fetch(u, { signal: ctrl.signal })).text();
        clearTimeout(timer);
        externalDocs.set(u, new DOMParser().parseFromString(text, 'image/svg+xml'));
      } catch (error) {
        externalDocs.set(u, null);
      }
    }));
  }

  function resolveUseTarget(use, ref) {
    if (ref[0] === '#') {
      const root = use.getRootNode();
      return (root.getElementById ? root.getElementById(ref.slice(1)) : null) || document.getElementById(ref.slice(1));
    }
    const [file, id] = ref.split('#');
    const doc = externalDocs.get(new URL(file, location.href).href);
    return doc ? doc.getElementById(id) : null;
  }

  function inlineUseElements() {
    const uses = [];
    for (const root of allRoots()) uses.push(...root.querySelectorAll('svg use'));
    for (const use of uses) {
      if (use.closest('symbol, defs')) continue;
      try {
        inlineOneUse(use);
      } catch (error) {
        console.warn('[copy-to-figma] could not inline <use>', error);
      }
    }
  }

  function inlineOneUse(use) {
    {
      const ref = use.getAttribute('href') || use.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (!ref) return;
      const target = resolveUseTarget(use, ref);
      if (!target) return;
      let replacement;
      const outer = use.ownerSVGElement;
      const tag = target.tagName.toLowerCase();
      if (tag === 'symbol' || tag === 'svg') {
        const vb = target.getAttribute('viewBox');
        const plain = !use.getAttribute('x') && !use.getAttribute('y') &&
          !use.getAttribute('width') && !use.getAttribute('height');
        if (plain && outer && vb && !outer.hasAttribute('viewBox') && outer.querySelectorAll('use').length === 1 && use.parentNode === outer) {
          // Common icon-sprite case: <svg class="ico"><use href="#i"/></svg>.
          // Flatten: hoist the viewBox and symbol attributes onto the outer svg and
          // put the symbol's paths directly beneath it, like a hand-written inline icon.
          outer.setAttribute('viewBox', vb);
          undo.push(() => outer.removeAttribute('viewBox'));
          for (const attr of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
            'stroke-miterlimit', 'fill-rule', 'clip-rule']) {
            const v = target.getAttribute(attr);
            if (v == null) continue;
            const prev = outer.getAttribute(attr);
            outer.setAttribute(attr, v);
            undo.push(() => (prev == null ? outer.removeAttribute(attr) : outer.setAttribute(attr, prev)));
          }
          const nodes = Array.from(target.childNodes).map((child) => child.cloneNode(true));
          const anchor = use;
          for (const node of nodes) outer.insertBefore(node, anchor);
          outer.removeChild(anchor);
          undo.push(() => {
            nodes.forEach((n) => n.remove());
            outer.appendChild(anchor);
          });
          return;
        } else {
          const box = outer ? outer.getBoundingClientRect() : { width: 24, height: 24 };
          replacement = document.createElementNS(SVG_NS, 'svg');
          if (vb) replacement.setAttribute('viewBox', vb);
          replacement.setAttribute('width', use.getAttribute('width') || String(box.width || 24));
          replacement.setAttribute('height', use.getAttribute('height') || String(box.height || 24));
          replacement.setAttribute('x', use.getAttribute('x') || '0');
          replacement.setAttribute('y', use.getAttribute('y') || '0');
        }
        for (const child of Array.from(target.childNodes)) replacement.appendChild(child.cloneNode(true));
      } else {
        replacement = document.createElementNS(SVG_NS, 'g');
        const x = use.getAttribute('x'), y = use.getAttribute('y');
        if (x || y) replacement.setAttribute('transform', `translate(${x || 0} ${y || 0})`);
        replacement.appendChild(target.cloneNode(true));
      }
      // Presentation attributes live on the <symbol> (e.g. fill="none"); carry them over.
      for (const attr of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
        'stroke-miterlimit', 'fill-rule', 'clip-rule', 'opacity', 'color']) {
        const v = target.getAttribute(attr);
        if (v != null && !replacement.hasAttribute(attr)) replacement.setAttribute(attr, v);
      }
      for (const attr of ['fill', 'stroke', 'stroke-width', 'class', 'style', 'transform']) {
        const v = use.getAttribute(attr);
        if (v != null && !replacement.hasAttribute(attr)) replacement.setAttribute(attr, v);
      }
      const parent = use.parentNode;
      parent.replaceChild(replacement, use);
      undo.push(() => parent.replaceChild(use, replacement));
    }
  }

  async function maskToBackground(el, cs) {
    const match = /url\((["']?)(.*?)\1\)/.exec(cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage);
    if (!match) return;
    let text;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      try {
        const res = await fetch(match[2], { signal: ctrl.signal });
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return;
    }
    if (!/<svg[\s>]/i.test(text)) return;
    const color = cs.backgroundColor;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return;
    svg.querySelectorAll('*').forEach((n) => {
      for (const attr of ['fill', 'stroke']) {
        if (n.getAttribute(attr) === 'currentColor') n.setAttribute(attr, color);
      }
    });
    if (!svg.getAttribute('fill')) svg.setAttribute('fill', color);
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', SVG_NS);
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    const before = el.getAttribute('style');
    el.style.backgroundImage = `url("${uri}")`;
    el.style.backgroundColor = 'transparent';
    el.style.backgroundSize = cs.maskSize !== 'auto' ? cs.maskSize : cs.webkitMaskSize;
    el.style.backgroundRepeat = cs.maskRepeat || cs.webkitMaskRepeat;
    el.style.backgroundPosition = cs.maskPosition || cs.webkitMaskPosition;
    el.style.maskImage = 'none';
    el.style.webkitMaskImage = 'none';
    undo.push(() => (before == null ? el.removeAttribute('style') : el.setAttribute('style', before)));
  }

  window.__h2dRestore = () => {
    for (const fn of undo.reverse()) {
      try { fn(); } catch (error) { /* node may be gone */ }
    }
    undo = [];
  };

  window.__h2dPrepare = async () => {
    if (window === window.top) { window.__h2dVpStart = innerWidth + 'x' + innerHeight; window.__h2dPageT0 = performance.now(); }
    window.__h2dRestore();
    if (window.__h2dSkipPrepare) return;
    const started = Date.now();
    try {
      await Promise.race([prepareDom(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch (error) {
      console.warn('[copy-to-figma] prepare failed', error);
    }
    console.log('[copy-to-figma] prepare took', Date.now() - started, 'ms');
  };


  // ::before/::after are invisible to capture.js. Turn the ones that draw
  // something (text/icon-font glyph, sized box, background) into real spans.
  function materializePseudoElements() {
    const PSEUDOS = ['::before', '::after'];
    const targets = [];
    for (const root of allRoots()) {
      for (const el of root.querySelectorAll('*')) {
        if (el instanceof SVGElement || el.tagName === 'IMG' || el.tagName === 'INPUT' || el.tagName === 'BR') continue;
        targets.push(el);
      }
    }
    for (const el of targets) {
      for (const pseudo of PSEUDOS) {
        const cs = getComputedStyle(el, pseudo);
        const content = cs.content;
        if (!content || content === 'none' || content === 'normal' || cs.display === 'none') continue;
        const m = /^(["'])([\s\S]*)\1$/.exec(content);
        const text = m ? m[2].replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1') : '';
        const w = parseFloat(cs.width) || 0;
        const h = parseFloat(cs.height) || 0;
        const hasBg = (cs.backgroundColor && !/rgba\(.*,\s*0\)$|transparent/.test(cs.backgroundColor)) ||
          cs.backgroundImage !== 'none' || (cs.maskImage && cs.maskImage !== 'none') ||
          (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') || parseFloat(cs.borderTopWidth) > 0 ||
          parseFloat(cs.borderLeftWidth) > 0;
        if (!text.trim() && !(w > 0 && h > 0 && hasBg)) continue;
        const span = document.createElement('span');
        span.setAttribute('data-h2d-pseudo', pseudo);
        for (const prop of cs) span.style.setProperty(prop, cs.getPropertyValue(prop), cs.getPropertyPriority(prop));
        span.style.setProperty('content', 'none');
        span.textContent = text;
        if (pseudo === '::before') el.insertBefore(span, el.firstChild);
        else el.appendChild(span);
        undo.push(() => span.remove());
      }
    }
  }

  function diagnose() {
    try {
      const all = Array.from(document.querySelectorAll('*'));
      const count = (fn) => all.filter((el) => { try { return fn(el); } catch (e) { return false; } }).length;
      const svgs = Array.from(document.querySelectorAll('svg'));
      const info = {
        url: location.href.slice(0, 60),
        elements: all.length,
        svg: svgs.length,
        svgUse: document.querySelectorAll('svg use').length,
        svgUseExternal: Array.from(document.querySelectorAll('svg use')).filter((u) => !(u.getAttribute('href') || '').startsWith('#')).length,
        img: document.querySelectorAll('img').length,
        imgSvg: document.querySelectorAll('img[src*=".svg"], img[src^="data:image/svg"]').length,
        mask: count((el) => { const c = getComputedStyle(el); return (c.maskImage !== 'none' && c.maskImage) || (c.webkitMaskImage !== 'none' && c.webkitMaskImage); }),
        bgImage: count((el) => getComputedStyle(el).backgroundImage.includes('url(')),
        pseudoContent: count((el) => ['::before', '::after'].some((p) => { const c = getComputedStyle(el, p).content; return c && c !== 'none' && c !== 'normal' && c !== '""'; })),
        sampleSvg: svgs.slice(0, 2).map((s) => s.outerHTML.slice(0, 220)),
        sampleSidebarIcon: (() => {
          const row = document.querySelector('aside a, aside button, nav a, nav button, [role=navigation] a');
          return row ? row.outerHTML.slice(0, 500) : null;
        })()
      };
      console.log('[copy-to-figma] diagnostics', JSON.stringify(info, null, 1));
    } catch (error) {
      console.warn('[copy-to-figma] diagnostics failed', error);
    }
  }

  async function prepareDom() {
    diagnose();
    {
      await loadExternalSprites(allRoots());
      for (let pass = 0; pass < 3; pass++) {
        if (!document.querySelector('svg use') && !allRoots().some((r) => r.querySelector('svg use'))) break;
        inlineUseElements();
      }
      materializePseudoElements();
      const jobs = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        const mask = cs.maskImage !== 'none' ? cs.maskImage : cs.webkitMaskImage;
        if (mask && mask !== 'none' && mask.includes('url(')) jobs.push(maskToBackground(el, cs));
      }
      await Promise.all(jobs.map((job) => job.catch(() => {})));
    }
  }

  // Called by capture.js with the JSON payload for this frame; returns JSON with
  // each iframe's content attached under its IFRAME node.
  const mergeFrames = async (json) => {
    window.__h2dReport = [];
    const iframes = collectIframes(document);
    if (!iframes.length) return json;

    const payload = JSON.parse(json);
    const iframeNodes = [];
    walk(payload.root, (node) => {
      if (node.tag === 'IFRAME' && node.rect) iframeNodes.push(node);
    });
    if (!iframeNodes.length) return json;

    const pairs = [];
    const used = new Set();
    for (const iframe of iframes) {
      const r = iframe.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { note('ignored (zero size): ' + (iframe.src || '(srcdoc)').slice(0, 90)); continue; }
      const node = iframeNodes.find((n) => !used.has(n) && sameRect(n.rect, r));
      if (!node) { note('NOT MATCHED to a captured node: ' + (iframe.src || '(srcdoc)').slice(0, 90)); continue; }
      used.add(node);
      pairs.push({ iframe, node, r });
    }
    if (!pairs.length) return json;

    const results = await Promise.all(pairs.map((p) => requestChild(p.iframe)));
    if (window === window.top) window.__h2dTop = describeFrame();

    // "Include Claude header" off: on a top-level page whose main content is one big
    // iframe (e.g. a Claude artifact), keep only that iframe's content.
    let soloIndex = -1;
    if (window === window.top && !prefs().includeHeader && payload.root && payload.root.tag === 'HTML') {
      const area = (p) => p.r.width * p.r.height;
      const big = pairs.reduce((best, p, i) => (best < 0 || area(p) > area(pairs[best]) ? i : best), -1);
      if (big >= 0 && results[big] && area(pairs[big]) >= 0.4 * window.innerWidth * window.innerHeight) soloIndex = big;
    }
    let soloRoot = null;
    let soloChild = null;

    pairs.forEach(({ iframe, node, r }, index) => {
      if (!results[index]) return;
      let child;
      try {
        child = JSON.parse(results[index]);
      } catch (error) {
        return;
      }
      if (!child || !child.root) return;

      const cs = getComputedStyle(iframe);
      const ox = r.x + iframe.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const oy = r.y + iframe.clientTop + (parseFloat(cs.paddingTop) || 0);
      const prefix = 'f' + (++frameCounter) + '-' + Math.random().toString(36).slice(2, 6) + '-';
      const isSolo = index === soloIndex;
      const layoutW = iframe.offsetWidth || r.width;
      const layoutH = iframe.offsetHeight || r.height;
      let sx = r.width / layoutW;
      let sy = r.height / layoutH;
      if (Math.abs(sx - 1) < 0.01) sx = 1;
      if (Math.abs(sy - 1) < 0.01) sy = 1;
      const assets = prepareChild(child, prefix, isSolo ? 0 : ox, isSolo ? 0 : oy, iframe.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0), iframe.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0), sx, sy);

      const kids = (child.root.childNodes || []).length;
      const rr = child.root.rect || {};
      note('ATTACHED ' + (iframe.src || '(srcdoc)').slice(0, 60) + ' | iframe ' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' +
        Math.round(r.width) + 'x' + Math.round(r.height) + ' layout ' + layoutW + 'x' + layoutH + ' scale ' + sx.toFixed(3) + ',' + sy.toFixed(3) +
        ' | child root ' + Math.round(rr.x) + ',' + Math.round(rr.y) + ' ' + Math.round(rr.width) + 'x' + Math.round(rr.height) +
        ' children ' + kids + ' bg ' + ((child.root.styles || {}).backgroundColor || '-') +
        ' | iframe style: opacity ' + getComputedStyle(iframe).opacity + ', visibility ' + getComputedStyle(iframe).visibility +
        ', transform ' + getComputedStyle(iframe).transform.slice(0, 40));
      if (window !== window.top) {
        // Nested below the first level: present as plain containers so Figma's importer
        // doesn't have to handle IFRAME/HTML nodes inside another frame's content.
        node.tag = 'DIV';
        child.root.tag = 'DIV';
      }
      if (isSolo) { soloRoot = child.root; soloChild = child; }
      node.styles = Object.assign({}, node.styles, {
        overflow: 'hidden',
        overflowX: 'hidden',
        overflowY: 'hidden'
      });
      node.childNodes = (node.childNodes || []).concat([child.root]);

      payload.assets = payload.assets || {};
      for (const [key, entry] of Object.entries(assets)) {
        const current = payload.assets[key];
        if (!current || (!current.blob && entry.blob)) payload.assets[key] = entry;
      }
      payload.fonts = payload.fonts || {};
      mergeFonts(payload.fonts, child.fonts);
    });

    if (window === window.top) {
      const lines = [];
      const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
      const dump = (n, d) => {
        if (lines.length > 80 || d > 7) return;
        if (n.nodeType === 3) return;
        const st = n.styles || {};
        const r = n.rect || {};
        const texts = (n.childNodes || []).filter((c) => c.nodeType === 3 && c.text.trim()).length;
        lines.push(' '.repeat(d) + n.tag + ' ' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
          (clear(st.backgroundColor) ? '' : ' bg=' + st.backgroundColor) + (st.opacity && st.opacity !== '1' ? ' op=' + st.opacity : '') +
          (st.display && st.display !== 'block' ? ' d=' + st.display : '') + (st.position && st.position !== 'static' ? ' pos=' + st.position : '') +
          (st.overflow && st.overflow !== 'visible' ? ' ov=' + st.overflow : '') + (texts ? ' texts=' + texts : '') +
          ' kids=' + (n.childNodes || []).length);
        for (const c of n.childNodes || []) dump(c, d + 1);
      };
      dump(payload.root, 0);
      let total = 0, maxDepth = 0;
      const iframeInfo = [];
      (function count(n, d) {
        if (n.nodeType === 3) { total++; return; }
        total++;
        if (d > maxDepth) maxDepth = d;
        if (n.tag === 'IFRAME') iframeInfo.push('depth ' + d + ' kids ' + (n.childNodes || []).length);
        for (const c of n.childNodes || []) count(c, d + 1);
      })(payload.root, 0);
      lines.unshift('nodes ' + total + ', max depth ' + maxDepth + ', IFRAME nodes: ' + (iframeInfo.join('; ') || 'none'));
      console.log('[copy-to-figma] tree dump\n' + lines.join('\n'));
    }
    console.log('[copy-to-figma] merge report (' + location.host.slice(0, 40) + ')\n' + window.__h2dReport.join('\n'));
    if (soloRoot) {
      payload.root = soloRoot;
      if (soloChild.documentRect) payload.documentRect = soloChild.documentRect;
      if (soloChild.viewportRect) payload.viewportRect = soloChild.viewportRect;
      if (soloChild.documentTitle) payload.documentTitle = soloChild.documentTitle;
    }
    return JSON.stringify(payload);
  };

  // Entry point used by capture.js: merge iframe content, then, when a custom resolution is
  // active, make the pasted root frame exactly that size (Figma otherwise sizes it from the
  // page's content, which is rarely the viewport size).
  window.__h2dMerge = async (json) => {
    const merged = await mergeFrames(json);
    if (window !== window.top) return merged;
    const res = prefs().resolution;
    const custom = res && res.preset !== 'auto' && res.width >= 200 && res.height >= 200;
    window.__h2dReport.push('VIEWPORT at serialize start ' + (window.__h2dVpStart || '?'));
    window.__h2dReport.push('EMULATION: ' + (prefs().emulation || 'n/a'));
    window.__h2dReport.push('VIEWPORT at capture ' + innerWidth + 'x' + innerHeight + ' (dpr ' + devicePixelRatio + ')' + (custom ? ', target ' + res.width + 'x' + res.height : ', no custom size'));
    console.log('[copy-to-figma] viewport at capture: ' + innerWidth + 'x' + innerHeight + (custom ? ' | target ' + res.width + 'x' + res.height : ' | no custom size'));
    if (!custom) return merged;
    try {
      const payload = JSON.parse(merged);
      const root = payload.root;
      if (!root || !root.rect) return merged;
      const W = Math.round(res.width);
      const H = Math.round(res.height);
      root.rect.width = W;
      root.rect.height = H;
      if (root.rect.cssWidth != null) root.rect.cssWidth = W;
      if (root.rect.cssHeight != null) root.rect.cssHeight = H;
      root.styles = Object.assign({}, root.styles, { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' });
      payload.documentRect = { x: 0, y: 0, width: W, height: H };
      payload.viewportRect = { x: 0, y: 0, width: W, height: H };
      return JSON.stringify(payload);
    } catch (error) {
      console.warn('[copy-to-figma] could not apply resolution', error);
      return merged;
    }
  };
})();
