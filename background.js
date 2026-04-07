async function injectCaptureFile(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['capture.js'],
    world: 'MAIN'
  });
}

function setFigmaCaptureHash() {
  window.location.hash = 'figmacapture&figmadelay=1000';
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    return;
  }

  try {
    await injectCaptureFile(tab.id);

    await new Promise((resolve) => setTimeout(resolve, 500));

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: setFigmaCaptureHash,
      world: 'MAIN'
    });

    await injectCaptureFile(tab.id);
  } catch (error) {
    console.error('Failed to run Figma capture script:', error);
  }
});
