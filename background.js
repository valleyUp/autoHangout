// Background Service Worker for AutoHangout
// Uses Chrome Debugger API with keyboard simulation for true background scrolling
// v2.1 - Added Offscreen Document + keyboard events for better reliability

let isRunning = false;
let settings = {
  scrollSpeed: 3,
  backProbability: 30
};
let activeTabId = null;
let debuggerAttached = false;
let offscreenCreated = false;

console.log('[AutoHangout BG] Service worker started (v2.1 - Keyboard + Offscreen)');

// ============ OFFSCREEN DOCUMENT ============
async function setupOffscreen() {
  if (offscreenCreated) return;
  
  try {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length > 0) {
      offscreenCreated = true;
      console.log('[AutoHangout BG] Offscreen document already exists');
      return;
    }
    
    // Create offscreen document
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],  // Use a valid reason
      justification: 'Keep service worker alive for background automation'
    });
    
    offscreenCreated = true;
    console.log('[AutoHangout BG] Offscreen document created');
  } catch (e) {
    console.error('[AutoHangout BG] Failed to create offscreen document:', e);
  }
}

// ============ INITIALIZATION ============
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

// ============ MESSAGE HANDLING ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoHangout BG] Message:', message.action);
  
  switch (message.action) {
    case 'start':
      isRunning = true;
      if (message.settings) {
        settings = message.settings;
      }
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
      if (sender.tab) {
        activeTabId = sender.tab.id;
        chrome.storage.local.set({ activeTabId });
      }
      if (isRunning) {
        chrome.tabs.sendMessage(sender.tab.id, { action: 'start', settings }).catch(() => {});
        attachDebugger(sender.tab.id);
      }
      sendResponse({ success: true });
      break;
      
    case 'offscreenPing':
      // Ping from offscreen document - keeps service worker alive
      console.log('[AutoHangout BG] Offscreen ping received');
      sendResponse({ alive: true });
      break;
      
    case 'requestNavigation':
      // Content script requests navigation
      if (sender.tab && message.url) {
        performNavigation(sender.tab.id, message.url);
      }
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// ============ DEBUGGER FUNCTIONS ============
async function attachDebugger(tabId) {
  if (debuggerAttached) {
    console.log('[AutoHangout BG] Debugger already attached');
    return true;
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    console.log('[AutoHangout BG] Debugger attached to tab:', tabId);
    
    // Enable required domains
    await chrome.debugger.sendCommand({ tabId }, 'Input.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    console.log('[AutoHangout BG] Debugger domains enabled');
    return true;
  } catch (e) {
    console.error('[AutoHangout BG] Failed to attach debugger:', e);
    debuggerAttached = false;
    return false;
  }
}

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

// Perform scroll using keyboard simulation (more reliable than mouse wheel)
async function performDebuggerScroll(tabId, scrollAmount) {
  if (!debuggerAttached) {
    const attached = await attachDebugger(tabId);
    if (!attached) return false;
  }
  
  try {
    // Method 1: Use Runtime.evaluate to execute scrollBy directly
    // This is more reliable than simulating input events
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `window.scrollBy({ top: ${scrollAmount}, behavior: 'auto' })`,
      userGesture: true
    });
    
    console.log('[AutoHangout BG] Runtime.evaluate scroll:', scrollAmount, 'px');
    return true;
  } catch (e) {
    console.error('[AutoHangout BG] Runtime.evaluate scroll failed:', e);
    
    // Method 2: Try keyboard simulation (Page Down)
    try {
      // Calculate how many Page Down presses based on scroll amount
      const presses = Math.max(1, Math.floor(scrollAmount / 100));
      
      for (let i = 0; i < presses; i++) {
        // Key down
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'PageDown',
          code: 'PageDown',
          windowsVirtualKeyCode: 34,
          nativeVirtualKeyCode: 34
        });
        
        // Key up
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'PageDown',
          code: 'PageDown',
          windowsVirtualKeyCode: 34,
          nativeVirtualKeyCode: 34
        });
        
        // Small delay between presses
        await new Promise(r => setTimeout(r, 50));
      }
      
      console.log('[AutoHangout BG] Keyboard scroll (PageDown x', presses, ')');
      return true;
    } catch (e2) {
      console.error('[AutoHangout BG] Keyboard scroll failed:', e2);
      debuggerAttached = false;
      return false;
    }
  }
}

// Perform navigation using debugger
async function performNavigation(tabId, url) {
  if (!debuggerAttached) {
    await attachDebugger(tabId);
  }
  
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url });
    console.log('[AutoHangout BG] Navigated to:', url);
  } catch (e) {
    console.error('[AutoHangout BG] Navigation failed:', e);
    // Fallback to tabs API
    chrome.tabs.update(tabId, { url });
  }
}

// ============ AUTOMATION CONTROL ============
async function startAutomation() {
  console.log('[AutoHangout BG] Starting automation');
  
  // Setup offscreen document first
  await setupOffscreen();
  
  // Clear any existing alarms
  await chrome.alarms.clearAll();
  
  // Main scroll trigger - every 3 seconds
  chrome.alarms.create('autoHangout-scroll', { 
    delayInMinutes: 0.05,
    periodInMinutes: 0.05 
  });
  
  // Heartbeat for content script - every 15 seconds
  chrome.alarms.create('autoHangout-heartbeat', { 
    delayInMinutes: 0.25,
    periodInMinutes: 0.25 
  });
  
  // Keep alive ping - every 20 seconds
  chrome.alarms.create('autoHangout-keepalive', { 
    delayInMinutes: 0.33,
    periodInMinutes: 0.33 
  });
  
  // Debugger check - every 30 seconds
  chrome.alarms.create('autoHangout-debugger-check', { 
    delayInMinutes: 0.5,
    periodInMinutes: 0.5 
  });
  
  // Initial broadcast and attach debugger
  broadcastToContentScripts({ action: 'start', settings });
  
  if (activeTabId) {
    await attachDebugger(activeTabId);
  }
  
  console.log('[AutoHangout BG] Automation started, alarms set');
}

async function stopAutomation() {
  console.log('[AutoHangout BG] Stopping automation');
  await chrome.alarms.clearAll();
  broadcastToContentScripts({ action: 'stop' });
  
  if (activeTabId) {
    await detachDebugger(activeTabId);
  }
}

// ============ ALARM HANDLERS ============
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Log all alarms for debugging
  const now = new Date().toISOString();
  console.log(`[AutoHangout BG] [${now}] Alarm: ${alarm.name}, isRunning: ${isRunning}`);
  
  if (!isRunning) return;
  
  if (alarm.name === 'autoHangout-scroll') {
    // Perform scroll via debugger
    if (activeTabId) {
      // Check if tab still exists
      try {
        const tab = await chrome.tabs.get(activeTabId);
        if (!tab || !tab.url?.startsWith('https://linux.do/')) {
          console.log('[AutoHangout BG] Tab no longer valid');
          return;
        }
        
        // Calculate scroll amount
        const basePixels = 80 + settings.scrollSpeed * 30;
        const scrollAmount = Math.floor(basePixels * (0.7 + Math.random() * 0.6));
        
        const success = await performDebuggerScroll(activeTabId, scrollAmount);
        
        if (success) {
          // Notify content script
          try {
            await chrome.tabs.sendMessage(activeTabId, { 
              action: 'scrollPerformed', 
              scrollAmount 
            });
          } catch (e) {
            // Content script might not be ready
          }
        }
      } catch (e) {
        console.error('[AutoHangout BG] Error during scroll:', e);
      }
    }
  }
  
  if (alarm.name === 'autoHangout-heartbeat') {
    await broadcastToContentScripts({ action: 'heartbeat', settings });
  }
  
  if (alarm.name === 'autoHangout-keepalive') {
    console.log('[AutoHangout BG] Keepalive - debugger attached:', debuggerAttached);
    
    // Re-check state from storage
    const data = await chrome.storage.local.get(['isRunning']);
    if (data.isRunning && !isRunning) {
      isRunning = true;
      await startAutomation();
    }
  }
  
  if (alarm.name === 'autoHangout-debugger-check') {
    // Ensure debugger is still attached
    if (activeTabId && !debuggerAttached) {
      console.log('[AutoHangout BG] Re-attaching debugger');
      await attachDebugger(activeTabId);
    }
  }
});

// ============ DEBUGGER EVENTS ============
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[AutoHangout BG] Debugger detached:', reason);
  debuggerAttached = false;
  
  // Try to reattach if still running (unless user cancelled)
  if (isRunning && activeTabId && reason !== 'canceled_by_user') {
    setTimeout(async () => {
      if (isRunning) {
        console.log('[AutoHangout BG] Attempting to reattach debugger');
        await attachDebugger(activeTabId);
      }
    }, 2000);
  }
});

// ============ TAB EVENTS ============
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && 
      tab.url?.startsWith('https://linux.do/') && 
      isRunning) {
    console.log('[AutoHangout BG] Tab updated:', tabId);
    
    if (tabId === activeTabId || !activeTabId) {
      activeTabId = tabId;
      chrome.storage.local.set({ activeTabId });
      
      // Wait a bit then attach debugger
      setTimeout(async () => {
        debuggerAttached = false;
        await attachDebugger(tabId);
        chrome.tabs.sendMessage(tabId, { action: 'start', settings }).catch(() => {});
      }, 2000);
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isRunning) return;
  
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] linux.do tab activated:', activeInfo.tabId);
      
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    console.log('[AutoHangout BG] Active tab closed');
    debuggerAttached = false;
    activeTabId = null;
    chrome.storage.local.set({ activeTabId: null });
  }
});

// ============ WINDOW EVENTS ============
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!isRunning) return;
  
  console.log('[AutoHangout BG] Window focus changed:', windowId);
  
  // Ensure alarms are still running
  chrome.alarms.get('autoHangout-scroll', async (alarm) => {
    if (!alarm && isRunning) {
      console.log('[AutoHangout BG] Re-creating alarms after focus change');
      await startAutomation();
    }
  });
});

// ============ BROADCAST ============
async function broadcastToContentScripts(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    console.log('[AutoHangout BG] Broadcasting to', tabs.length, 'tabs');
    
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (e) {
        if (isRunning && message.action === 'start') {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            });
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, message).catch(() => {});
            }, 500);
          } catch (e2) {}
        }
      }
    }
  } catch (e) {
    console.error('[AutoHangout BG] Error broadcasting:', e);
  }
}

// ============ SERVICE WORKER LIFECYCLE ============
self.addEventListener('activate', (event) => {
  console.log('[AutoHangout BG] Service worker activated');
  
  chrome.storage.local.get(['isRunning', 'settings', 'activeTabId'], async (data) => {
    if (data.isRunning) {
      isRunning = true;
      activeTabId = data.activeTabId;
      if (data.settings) settings = data.settings;
      await startAutomation();
    }
  });
});

// Keep service worker alive by setting up offscreen on install
self.addEventListener('install', async (event) => {
  console.log('[AutoHangout BG] Service worker installed');
  self.skipWaiting();
});
