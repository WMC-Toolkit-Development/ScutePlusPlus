/**
 * Scute++ — content.js  (isolated world)
 * Cannot access window.dynmap or window.L — injects page.js into page world.
 */
(function () {
  'use strict';

  // ── Inject page.js into the page world ──────────────────────────────────
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // ── Relay chrome.storage state to page script on load ───────────────────
  chrome.storage.local.get(['iceHighwaysEnabled', 'darkModeEnabled'], (result) => {
    // darkModeEnabled defaults to true if never set
    const darkOn = result.darkModeEnabled === undefined ? true : !!result.darkModeEnabled;
    window.postMessage({
      source: 'scute-ext',
      type: 'INIT',
      iceHighwaysEnabled: !!result.iceHighwaysEnabled,
      darkModeEnabled:    darkOn,
    }, '*');
  });

  // ── Listen for state changes from page script, save to storage ───────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'scute-page') return;

    if (e.data.type === 'SET_ICE_HIGHWAYS') {
      chrome.storage.local.set({ iceHighwaysEnabled: e.data.enabled });
    }
    if (e.data.type === 'SET_DARK_MODE') {
      chrome.storage.local.set({ darkModeEnabled: e.data.enabled });
    }
    // page.js ready — re-send saved state
    if (e.data.type === 'PAGE_READY') {
      chrome.storage.local.get(['iceHighwaysEnabled', 'darkModeEnabled'], (result) => {
        const darkOn = result.darkModeEnabled === undefined ? true : !!result.darkModeEnabled;
        window.postMessage({
          source: 'scute-ext',
          type: 'INIT',
          iceHighwaysEnabled: !!result.iceHighwaysEnabled,
          darkModeEnabled:    darkOn,
        }, '*');
      });
    }
  });

  // ── Relay toggle messages from the popup → page script ───────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOGGLE_ICE_HIGHWAYS') {
      window.postMessage({ source: 'scute-ext', type: 'TOGGLE_ICE_HIGHWAYS', enabled: msg.enabled }, '*');
    }
    if (msg.type === 'TOGGLE_DARK_MODE') {
      window.postMessage({ source: 'scute-ext', type: 'TOGGLE_DARK_MODE', enabled: msg.enabled }, '*');
    }
  });

})();