// Offscreen document to keep service worker alive
// This document runs in the background and helps maintain persistent connections

console.log('[AutoHangout Offscreen] Document loaded');

const TICK_MS = 3000;
const PING_MS = 20000;
let lastPingAt = 0;

function safeSendMessage(message) {
  try {
    const result = chrome?.runtime?.sendMessage?.(message);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (_) {}
}

setInterval(() => {
  const now = Date.now();
  
  // High-frequency tick used to drive automation even when the tab is in background.
  safeSendMessage({ action: 'offscreenTick', now });
  
  // Lower-frequency ping used as a simple keepalive signal.
  if (now - lastPingAt >= PING_MS) {
    lastPingAt = now;
    safeSendMessage({ action: 'offscreenPing', now });
  }
}, TICK_MS);

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ alive: true, timestamp: Date.now() });
  }
  return true;
});
