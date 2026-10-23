// Iframe support for capture.js. Injected (MAIN world) into every frame of the tab.
// Each frame answers `h2d-frame-request` messages from its parent with its own
// serialized tree (which already contains its own nested iframes), and
// `window.__h2dMerge` (called by the patched capture.js) grafts those child trees
// into the parent payload at the iframe's position.
(() => {
  const REQ = 'h2d-frame-request';
  const RES = 'h2d-frame-response';
  const ARMED_MS = 120000;
  const CHILD_TIMEOUT_MS = 20000;

  window.__h2dArmedUntil = Date.now() + ARMED_MS;
  // Re-injection replaces any previous copy so a stale version never keeps running.
  if (window.__h2dFramesCleanup) window.__h2dFramesCleanup();

  let frameCounter = 0;

  // Child side: serialize this frame on request from the parent.
  const onRequest = async (event) => {
    const data = event.data;
    if (!data || data.type !== REQ || window.parent === window) return;
    if (event.source !== window.parent || Date.now() > window.__h2dArmedUntil) return;
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
    console.log('[copy-to-figma] frame', location.href.slice(0, 80), payload ? 'captured ' + Math.round(payload.length / 1024) + ' KB' : 'FAILED');
    event.source.postMessage({ type: RES, id: data.id, payload }, '*');
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

  function requestChild(iframe) {
    return new Promise((resolve) => {
      const win = iframe.contentWindow;
      if (!win) return resolve(null);
      const id = Math.random().toString(36).slice(2);
      const finish = (value) => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        const d = event.data;
        if (event.source !== win || !d || d.type !== RES || d.id !== id) return;
        finish(d.payload || null);
      };
      const timer = setTimeout(() => {
        console.warn('[copy-to-figma] iframe did not respond', iframe.src);
        finish(null);
      }, CHILD_TIMEOUT_MS);
      window.addEventListener('message', onMessage);
      win.postMessage({ type: REQ, id }, '*');
    });
  }

  function sameRect(a, b) {
    return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 &&
      Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  }

  function prepareChild(child, prefix, ox, oy, cw, ch) {
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
        rect.x += ox;
        rect.y += oy;
        if (rect.quad) {
          for (const p of ['p1', 'p2', 'p3', 'p4']) {
            rect.quad[p].x += ox;
            rect.quad[p].y += oy;
          }
        }
      }
    });
    // The canvas background of a frame fills the whole viewport, but the root
    // node only spans its content: stretch it and inherit the body background.
    const root = child.root;
    if (root.rect) {
      root.rect.width = Math.max(root.rect.width, cw);
      root.rect.height = Math.max(root.rect.height, ch);
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


  // ---- Preferences menu (three dots next to the toolbar's close button) -----
  const PREF_DEFAULTS = { includeHeader: true };
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
    const closeMenu = () => {
      if (!menu) return;
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
      const r = dots.getBoundingClientRect();
      const below = r.top < window.innerHeight / 2;
      Object.assign(menu.style, {
        position: 'fixed', zIndex: '2147483647', minWidth: '230px', padding: '10px 12px',
        borderRadius: '10px', background: theme.bg, color: theme.text, boxShadow: theme.shadow,
        fontFamily: theme.fontFamily, fontSize: theme.fontSize, lineHeight: theme.lineHeight,
        fontWeight: theme.fontWeight, boxSizing: 'border-box',
        right: Math.max(8, window.innerWidth - r.right) + 'px',
        [below ? 'top' : 'bottom']: below ? r.bottom + 8 + 'px' : window.innerHeight - r.top + 8 + 'px'
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

      const hint = document.createElement('div');
      hint.textContent = 'Off: artifact pages paste only the artifact, without the Claude title bar. Applies to the next capture.';
      Object.assign(hint.style, { opacity: '.55', marginTop: '8px', maxWidth: '230px', whiteSpace: 'normal' });
      menu.appendChild(hint);

      shadow.appendChild(menu);
      document.addEventListener('pointerdown', onOutside, true);
    };

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
  window.__h2dMerge = async (json) => {
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
      if (r.width < 1 || r.height < 1) continue;
      const node = iframeNodes.find((n) => !used.has(n) && sameRect(n.rect, r));
      if (!node) continue;
      used.add(node);
      pairs.push({ iframe, node, r });
    }
    if (!pairs.length) return json;

    const results = await Promise.all(pairs.map((p) => requestChild(p.iframe)));

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
      const assets = prepareChild(child, prefix, isSolo ? 0 : ox, isSolo ? 0 : oy, iframe.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0), iframe.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0));

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

    if (soloRoot) {
      payload.root = soloRoot;
      if (soloChild.documentRect) payload.documentRect = soloChild.documentRect;
      if (soloChild.viewportRect) payload.viewportRect = soloChild.viewportRect;
      if (soloChild.documentTitle) payload.documentTitle = soloChild.documentTitle;
    }
    return JSON.stringify(payload);
  };
})();
