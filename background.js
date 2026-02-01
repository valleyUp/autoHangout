// Background Service Worker for AutoHangout
// Supports background running when tab is inactive or window minimized

let isRunning = false;
let settings = {
  scrollSpeed: 3,
  backProbability: 30
};
let activeTabId = null;

console.log('[AutoHangout BG] Service worker started');

// Initialize from storage
chrome.storage.local.get(['isRunning', 'settings', 'activeTabId'], (data) => {
  console.log('[AutoHangout BG] Loaded state:', data);
  isRunning = data.isRunning || false;
  activeTabId = data.activeTabId || null;
  if (data.settings) {
    settings = data.settings;
  }
  
  if (isRunning) {
    startAutomation();
  }
});

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoHangout BG] Message:', message.action);
  
  switch (message.action) {
    case 'start':
      isRunning = true;
      if (message.settings) {
        settings = message.settings;
      }
      // Remember the tab we're working with
      if (sender.tab) {
        activeTabId = sender.tab.id;
        chrome.storage.local.set({ activeTabId });
      }
      startAutomation();
      sendResponse({ success: true });
      break;
      
    case 'stop':
      isRunning = false;
      stopAutomation();
      sendResponse({ success: true });
      break;
      
    case 'updateSettings':
      if (message.settings) {
        settings = message.settings;
        broadcastToContentScripts({ action: 'updateSettings', settings });
      }
      sendResponse({ success: true });
      break;
      
    case 'getState':
      sendResponse({ isRunning, settings });
      break;
      
    case 'tabReady':
      // Content script is ready
      if (isRunning) {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'start', settings }).catch(() => {});
      }
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// Start automation with multiple alarms for reliability
function startAutomation() {
  console.log('[AutoHangout BG] Starting automation');
  
  // Clear any existing alarms first
  chrome.alarms.clearAll();
  
  // Main heartbeat alarm - every 20 seconds (0.33 minutes)
  chrome.alarms.create('autoHangout-heartbeat', { 
    delayInMinutes: 0.33,
    periodInMinutes: 0.33 
  });
  
  // Backup scroll trigger - every 10 seconds
  chrome.alarms.create('autoHangout-scroll', { 
    delayInMinutes: 0.17,
    periodInMinutes: 0.17 
  });
  
  // Keep alive ping - every 25 seconds
  chrome.alarms.create('autoHangout-keepalive', { 
    delayInMinutes: 0.42,
    periodInMinutes: 0.42 
  });
  
  // Initial broadcast
  broadcastToContentScripts({ action: 'start', settings });
}

// Stop automation
function stopAutomation() {
  console.log('[AutoHangout BG] Stopping automation');
  chrome.alarms.clearAll();
  broadcastToContentScripts({ action: 'stop' });
}

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!isRunning) return;
  
  console.log('[AutoHangout BG] Alarm:', alarm.name);
  
  if (alarm.name === 'autoHangout-heartbeat') {
    // Send heartbeat to keep content scripts alive
    await broadcastToContentScripts({ action: 'heartbeat', settings });
  }
  
  if (alarm.name === 'autoHangout-scroll') {
    // Trigger scroll action for inactive tabs
    await triggerScrollOnTabs();
  }
  
  if (alarm.name === 'autoHangout-keepalive') {
    // Just log to keep service worker alive
    console.log('[AutoHangout BG] Keep alive ping, isRunning:', isRunning);
    
    // Re-check state from storage in case of service worker restart
    const data = await chrome.storage.local.get(['isRunning']);
    if (data.isRunning && !isRunning) {
      isRunning = true;
      startAutomation();
    }
  }
});

// Trigger scroll on all linux.do tabs (for inactive tabs)
async function triggerScrollOnTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    
    for (const tab of tabs) {
      try {
        // Use scripting API to execute scroll directly (works on inactive tabs)
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Check if AutoHangout is running
            if (window.__autoHangoutRunning) {
              // Trigger a scroll event
              window.dispatchEvent(new CustomEvent('autoHangout-triggerScroll'));
            }
          }
        });
      } catch (e) {
        // Tab might be on a restricted page
      }
    }
  } catch (e) {
    console.error('[AutoHangout BG] Error triggering scroll:', e);
  }
}

// Broadcast to all matching tabs
async function broadcastToContentScripts(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    console.log('[AutoHangout BG] Broadcasting to', tabs.length, 'tabs');
    
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (e) {
        console.log(`[AutoHangout BG] Tab ${tab.id} not ready`);
        
        // Try to inject content script if not loaded
        if (isRunning && message.action === 'start') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            // Retry sending message
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            }, 500);
          } catch (e2) {
            // Script might already be injected
          }
        }
      }
    }
  } catch (e) {
    console.error('[AutoHangout BG] Error broadcasting:', e);
  }
}

// Handle tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && 
      tab.url && 
      tab.url.startsWith('https://linux.do/') && 
      isRunning) {
    console.log('[AutoHangout BG] Tab updated:', tabId);
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { action: 'start', settings }).catch(() => {});
    }, 2000);
  }
});

// Handle tab activation (when user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isRunning) return;
  
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] linux.do tab activated:', activeInfo.tabId);
      activeTabId = activeInfo.tabId;
      chrome.storage.local.set({ activeTabId });
    }
  } catch (e) {
    // Tab might not exist
  }
});

// Handle window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!isRunning) return;
  
  console.log('[AutoHangout BG] Window focus changed:', windowId);
  
  // Continue running regardless of focus
  // Just ensure alarms are still active
  chrome.alarms.get('autoHangout-heartbeat', (alarm) => {
    if (!alarm && isRunning) {
      console.log('[AutoHangout BG] Re-creating alarms');
      startAutomation();
    }
  });
});

// Service worker might restart, so we need to re-initialize
self.addEventListener('activate', (event) => {
  console.log('[AutoHangout BG] Service worker activated');
  
  chrome.storage.local.get(['isRunning', 'settings'], (data) => {
    if (data.isRunning) {
      isRunning = true;
      if (data.settings) settings = data.settings;
      startAutomation();
    }
  });
});
