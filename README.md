# Copy to Figma

Capture any web page and paste it into Figma using Figma's HTML-to-design capture script. Two ways to run it:

- **Chrome extension** — click an icon. Also strips `Content-Security-Policy` so capture works on locked-down sites.
- **Bookmarklet** — no install. Loads `capture.js` from GitHub Pages. Won't work on sites with a strict CSP that blocks external scripts.

Pick the extension for reliability, the bookmarklet for zero-install / other browsers.

---

## Option 1 — Chrome Extension

### Install

1. Open `chrome://extensions/`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (`Copy to Figma`).

### Use

1. Go to the page you want to capture.
2. Click the **Copy to Figma** icon, or press **Cmd+Option+O** (Mac) / **Ctrl+Alt+O** (Windows, Linux).
3. Switch to Figma and paste.

The shortcut only works in tabs loaded (or refreshed) after the extension was installed or reloaded.

The extension injects `capture.js` into the page and its frames, then starts the capture by calling `window.figma.captureForDesign()` directly, so the page is not reloaded and the URL is never touched.

### After editing extension code

1. Open `chrome://extensions/`.
2. Click **reload** on the `Copy to Figma` card.
3. Reload the target website.

### Security note

The extension removes CSP from all pages while enabled. Disable it in `chrome://extensions/` when done capturing.

### Iframes

The extension also captures content inside iframes, including cross-origin ones (e.g. Claude artifacts, embeds). `background.js` injects `capture.js` and `frames.js` into every frame; each child frame serializes itself on request over `postMessage` and the parent grafts that tree under its `<iframe>` node, offset by the iframe's position. Not supported by the bookmarklet (it can't reach into cross-origin frames).

Before each capture, `frames.js` makes the page self-contained for Figma, then restores it: it inlines `<svg><use>` icons (same-document, shadow DOM, external sprite files, nested), converts CSS `mask-image` icons to background images, and turns `::before`/`::after` that draw something (icon-font glyphs, boxes) into real elements. Each fix is isolated, so one failure can't block the others. Diagnostics print to the console as `[copy-to-figma]`.

`capture.js` carries small patches so this works (`window.__h2dSerialize`, `__h2dMerge`, `__h2dPrepare`, `__h2dRestore`). If you replace it with a fresh copy from Figma, re-apply them: search the old file for `window.figma.captureForDesign=lr,`, `let n=yield Be(r),o=Math.round(n.length/1024)`, `h.log("Serializing DOM...");` and `h.log("Converting to JSON...");`.

### Preferences

The toolbar has a **⋯** button next to the close button. **Include Claude header** (on by default): turn it off and, on a page whose content is one big iframe (like a Claude artifact), only the artifact is pasted, without the Claude title bar. The setting is saved in `chrome.storage` and applies to the next capture (press *Entire screen* to re-capture right away).

**Resolution** (also in the ⋯ menu): pick a preset (1920×1080, 1440×900, 1280×800, 1024×768, tablet, mobile) or enter a custom width × height, The choice saves automatically, and the pasted root frame is set to exactly that width × height (content beyond it is clipped). The extension resizes the page's viewport with Chrome's device emulation (the `debugger` permission), so media queries and layouts reflow, captures, and restores the original size as soon as the capture is copied. The debug session (and the browser's debugging bar) exists only for the duration of each copy: it is released only after the copy is validated (payload has content, the frame and page layout match the chosen size, and the clipboard is read back when permitted), or when an error is shown, with a 30-second safety timeout. A failed check shows an error toast and `COPY VALIDATION` in the ⋯ report. The chosen size also applies to every normal copy (icon / Cmd+Option+O) until you set it back to *Current window*.

**Set preferences without capturing first:** right-click the extension icon → *Options* (or `chrome://extensions` → Details → Extension options). Header and resolution live there too. Chrome shows a "started debugging this browser" bar while it's active, and it won't work while DevTools is open on the same tab.

---

## Toolbar

Both the extension and the bookmarklet show the same toolbar:

- **Entire screen** — copy the full page.
- **Select element** — hover and click an element to copy just that element. Keyboard:
  - **↑ / ↓** — move to the parent / back down to the child
  - **← / →** — move to the previous / next sibling
  - **Enter** — copy the highlighted element
  - **Esc** — cancel
- **Copy in 2s** — copy the full page after a 2 second countdown, so there's time to open a menu or hover state first.

---

## Option 2 — Bookmarklet

Loads the capture script from GitHub Pages — no extension needed.

### Install

1. Create a new bookmark in your browser.
2. Set the name to anything (e.g. `Copy to Figma`).
3. Paste this as the URL:

```
javascript:(function(){var b=location.href.split('#')[0];var u='https://devignx.github.io/Copy-to-Figma/capture.js';var s=document.createElement('script');s.src=u;document.head.appendChild(s);setTimeout(function(){history.replaceState(null,'',b+'#figmacapture&figmadelay=1000');var s2=document.createElement('script');s2.src=u;document.head.appendChild(s2);},500);})();
```

### Use

1. Go to the page you want to capture.
2. Click the bookmark.
3. Switch to Figma and paste.

### Limitations

- **HTTPS pages only** for the script host — GitHub Pages is HTTPS, so this is fine.
- **Strict CSP sites** (that block third-party scripts) will refuse to load `capture.js`. Use the extension there — it strips CSP.

---

## Hosting `capture.js` yourself

The bookmarklet points at `https://devignx.github.io/Copy-to-Figma/capture.js` (GitHub Pages, `main` branch, root). To host elsewhere:

- Serve `capture.js` over **HTTPS** with header `Access-Control-Allow-Origin: *`.
- `server.js` in this repo is a minimal local Node server for that (`node server.js` → `http://localhost:3000/capture.js`). Note: `http://localhost` is blocked on HTTPS pages (mixed content) — use it only for local `http://` testing.
- Swap the `u='...'` URL in the bookmarklet for your host.
