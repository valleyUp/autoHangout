// Offscreen document to keep service worker alive
// This document runs in the background and helps maintain persistent connections

console.log('[AutoHangout Offscreen] Document loaded');

// Periodic ping to keep alive
setInterval(() => {
  console.log('[AutoHangout Offscreen] Keepalive ping', new Date().toISOString());
  
  // Send message to service worker to keep it alive
  chrome.runtime.sendMessage({ action: 'offscreenPing' }).catch(() => {});
}, 20000);

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'ping') {
    sendResponse({ alive: true, timestamp: Date.now() });
  }
  return true;
});
