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
2. Click the **Copy to Figma** icon.
3. Switch to Figma and paste.

The extension injects `capture.js`, sets the capture fragment via `history.replaceState` (so the page does **not** reload and URL query params are kept), then restores the original URL.

### After editing extension code

1. Open `chrome://extensions/`.
2. Click **reload** on the `Copy to Figma` card.
3. Reload the target website.

### Security note

The extension removes CSP from all pages while enabled. Disable it in `chrome://extensions/` when done capturing.

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
