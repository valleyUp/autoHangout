// Background Service Worker for AutoHangout
// Uses Chrome Debugger API to enable true background scrolling
// v2.0 - Debugger API implementation

let isRunning = false;
let settings = {
  scrollSpeed: 3,
  backProbability: 30
};
let activeTabId = null;
let debuggerAttached = false;

console.log('[AutoHangout BG] Service worker started (Debugger API version)');

// Initialize from storage
chrome.storage.local.get(['isRunning', 'settings', 'activeTabId'], (data) => {
  console.log('[AutoHangout BG] Loaded state:', data);
  isRunning = data.isRunning || false;
  activeTabId = data.activeTabId || null;
  if (data.settings) {
    settings = data.settings;
  }
  
  if (isRunning && activeTabId) {
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
      if (sender.tab) {
        activeTabId = sender.tab.id;
        chrome.storage.local.set({ activeTabId });
      }
      if (isRunning) {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'start', settings }).catch(() => {});
        // Attach debugger if not already attached
        attachDebugger(sender.tab.id);
      }
      sendResponse({ success: true });
      break;
      
    case 'requestScroll':
      // Content script requests a scroll action (for background tabs)
      if (sender.tab && debuggerAttached) {
        performDebuggerScroll(sender.tab.id, message.scrollAmount || 100);
      }
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// Attach Chrome Debugger to a tab
async function attachDebugger(tabId) {
  if (debuggerAttached) {
    console.log('[AutoHangout BG] Debugger already attached');
    return;
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    console.log('[AutoHangout BG] Debugger attached to tab:', tabId);
    
    // Enable Input domain for simulating events
    await chrome.debugger.sendCommand({ tabId }, 'Input.enable', {});
    console.log('[AutoHangout BG] Input domain enabled');
  } catch (e) {
    console.error('[AutoHangout BG] Failed to attach debugger:', e);
    debuggerAttached = false;
  }
}

// Detach Chrome Debugger
async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  
  try {
    await chrome.debugger.detach({ tabId });
    debuggerAttached = false;
    console.log('[AutoHangout BG] Debugger detached from tab:', tabId);
  } catch (e) {
    console.error('[AutoHangout BG] Failed to detach debugger:', e);
  }
}

// Perform scroll using Debugger API
async function performDebuggerScroll(tabId, scrollAmount) {
  if (!debuggerAttached) {
    await attachDebugger(tabId);
  }
  
  try {
    // Use Input.dispatchMouseEvent to simulate a mouse wheel scroll
    // This bypasses the browser's throttling for background tabs
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 400,  // Center of typical viewport
      y: 300,
      deltaX: 0,
      deltaY: scrollAmount,  // Positive = scroll down
      modifiers: 0,
      pointerType: 'mouse'
    });
    
    console.log('[AutoHangout BG] Debugger scroll performed:', scrollAmount, 'px');
  } catch (e) {
    console.error('[AutoHangout BG] Debugger scroll failed:', e);
    // Try to re-attach if the connection was lost
    debuggerAttached = false;
    await attachDebugger(tabId);
  }
}

// Start automation with alarms for background triggering
function startAutomation() {
  console.log('[AutoHangout BG] Starting automation');
  
  // Clear any existing alarms first
  chrome.alarms.clearAll();
  
  // Main scroll trigger - every 3 seconds (0.05 minutes)
  chrome.alarms.create('autoHangout-scroll', { 
    delayInMinutes: 0.05,
    periodInMinutes: 0.05 
  });
  
  // Heartbeat for content script - every 20 seconds
  chrome.alarms.create('autoHangout-heartbeat', { 
    delayInMinutes: 0.33,
    periodInMinutes: 0.33 
  });
  
  // Keep alive ping - every 25 seconds
  chrome.alarms.create('autoHangout-keepalive', { 
    delayInMinutes: 0.42,
    periodInMinutes: 0.42 
  });
  
  // Initial broadcast and attach debugger
  broadcastToContentScripts({ action: 'start', settings });
  
  if (activeTabId) {
    attachDebugger(activeTabId);
  }
}

// Stop automation
function stopAutomation() {
  console.log('[AutoHangout BG] Stopping automation');
  chrome.alarms.clearAll();
  broadcastToContentScripts({ action: 'stop' });
  
  if (activeTabId) {
    detachDebugger(activeTabId);
  }
}

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!isRunning) return;
  
  console.log('[AutoHangout BG] Alarm:', alarm.name);
  
  if (alarm.name === 'autoHangout-scroll') {
    // Perform scroll via debugger (works in background!)
    if (activeTabId && debuggerAttached) {
      // Calculate scroll amount based on settings
      const basePixels = 50 + settings.scrollSpeed * 25;
      const scrollAmount = Math.floor(basePixels * (0.5 + Math.random() * 1.0));
      
      await performDebuggerScroll(activeTabId, scrollAmount);
      
      // Notify content script about the scroll
      try {
        await chrome.tabs.sendMessage(activeTabId, { 
          action: 'scrollPerformed', 
          scrollAmount 
        });
      } catch (e) {
        // Content script might not be ready
      }
    }
  }
  
  if (alarm.name === 'autoHangout-heartbeat') {
    // Send heartbeat to keep content scripts alive
    await broadcastToContentScripts({ action: 'heartbeat', settings });
  }
  
  if (alarm.name === 'autoHangout-keepalive') {
    // Just log to keep service worker alive
    console.log('[AutoHangout BG] Keep alive ping, isRunning:', isRunning, 'debugger:', debuggerAttached);
    
    // Re-check state from storage in case of service worker restart
    const data = await chrome.storage.local.get(['isRunning']);
    if (data.isRunning && !isRunning) {
      isRunning = true;
      startAutomation();
    }
    
    // Ensure debugger is still attached
    if (isRunning && activeTabId && !debuggerAttached) {
      await attachDebugger(activeTabId);
    }
  }
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[AutoHangout BG] Debugger detached:', reason);
  debuggerAttached = false;
  
  // Try to reattach if still running
  if (isRunning && activeTabId && reason !== 'canceled_by_user') {
    setTimeout(() => {
      if (isRunning) {
        attachDebugger(activeTabId);
      }
    }, 1000);
  }
});

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
    
    // Update active tab and reattach debugger
    if (tabId === activeTabId || !activeTabId) {
      activeTabId = tabId;
      chrome.storage.local.set({ activeTabId });
      
      setTimeout(async () => {
        // Detach from old tab if any, attach to new
        debuggerAttached = false;
        await attachDebugger(tabId);
        chrome.tabs.sendMessage(tabId, { action: 'start', settings }).catch(() => {});
      }, 2000);
    }
  }
});

// Handle tab activation (when user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isRunning) return;
  
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] linux.do tab activated:', activeInfo.tabId);
      
      // Switch debugger to the new active tab
      if (activeTabId && activeTabId !== activeInfo.tabId) {
        await detachDebugger(activeTabId);
      }
      
      activeTabId = activeInfo.tabId;
      chrome.storage.local.set({ activeTabId });
      await attachDebugger(activeTabId);
    }
  } catch (e) {
    // Tab might not exist
  }
});

// Handle tab close
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === activeTabId) {
    console.log('[AutoHangout BG] Active tab closed');
    debuggerAttached = false;
    activeTabId = null;
    chrome.storage.local.set({ activeTabId: null });
  }
});

// Handle window focus changes
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!isRunning) return;
  
  console.log('[AutoHangout BG] Window focus changed:', windowId);
  
  // Continue running regardless of focus
  // Debugger API will handle background scrolling
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
  
  chrome.storage.local.get(['isRunning', 'settings', 'activeTabId'], (data) => {
    if (data.isRunning) {
      isRunning = true;
      activeTabId = data.activeTabId;
      if (data.settings) settings = data.settings;
      startAutomation();
    }
  });
});
