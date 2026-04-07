# Figma Capture Bookmarklet Extension

This Chrome extension strips the `Content-Security-Policy` header while pages load, then injects the packaged Figma HTML-to-design capture script when you click the extension icon.

## Load It In Chrome

1. Open `chrome://extensions/`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `Copy to Figma`.

## Use It

1. Go to the page you want to capture.
2. Refresh the page so the extension can strip CSP during page load.
3. Click the extension icon to inject the Figma capture script.

## After Editing The Extension

1. Open `chrome://extensions/`.
2. Click the reload button on the `Copy to Figma` extension card.
3. Refresh the website you want to capture.

## Security Note

This extension removes CSP from all pages while it is enabled. Disable it in `chrome://extensions/` when you are done capturing.
