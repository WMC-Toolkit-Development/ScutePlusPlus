(function () {
  'use strict';

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'scute-page') return;

    if (e.data.type === 'SET_ICE_HIGHWAYS')
      chrome.storage.local.set({ iceHighwaysEnabled: e.data.enabled });
    if (e.data.type === 'SET_DARK_MODE')
      chrome.storage.local.set({ darkModeEnabled: e.data.enabled });

if (e.data.type === 'PAGE_READY') {
  chrome.storage.local.get(['iceHighwaysEnabled', 'darkModeEnabled'], (result) => {
    const darkOn = result.darkModeEnabled === undefined ? true : !!result.darkModeEnabled;
    window.postMessage({
      source: 'scute-ext', type: 'INIT',
      iceHighwaysEnabled: !!result.iceHighwaysEnabled,
      darkModeEnabled: darkOn,
      capitalUrl: chrome.runtime.getURL('capital.webp'),  // ← this line
    }, '*');
  });
}
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_ICE_HIGHWAYS')
      window.postMessage({ source: 'scute-ext', type: 'TOGGLE_ICE_HIGHWAYS', enabled: msg.enabled }, '*');
    if (msg.type === 'TOGGLE_DARK_MODE')
      window.postMessage({ source: 'scute-ext', type: 'TOGGLE_DARK_MODE', enabled: msg.enabled }, '*');
  });
})();