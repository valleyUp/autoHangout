// Background Service Worker for AutoHangout
// Uses Chrome Debugger API with Runtime.evaluate for true background scrolling
// v2.2 - Fixed debugger attachment and removed invalid commands

let isRunning = false;
let settings = {
  scrollSpeed: 3,
  backProbability: 30
};
let activeTabId = null;
let debuggerAttached = false;
let offscreenCreated = false;

console.log('[AutoHangout BG] Service worker started (v2.2 - Fixed)');

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
      reasons: ['BLOBS'],
      justification: 'Keep service worker alive for background automation'
    });
    
    offscreenCreated = true;
    console.log('[AutoHangout BG] Offscreen document created');
  } catch (e) {
    // Ignore "already exists" error
    if (e.message?.includes('single offscreen')) {
      offscreenCreated = true;
    } else {
      console.error('[AutoHangout BG] Offscreen error:', e.message);
    }
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
      sendResponse({ alive: true });
      break;
      
    case 'requestNavigation':
      if (sender.tab && message.url) {
        chrome.tabs.update(sender.tab.id, { url: message.url });
      }
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// ============ DEBUGGER FUNCTIONS ============
async function attachDebugger(tabId) {
  // Already attached? Just return true
  if (debuggerAttached) {
    return true;
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    console.log('[AutoHangout BG] Debugger attached to tab:', tabId);
    return true;
  } catch (e) {
    // If already attached, that's fine
    if (e.message?.includes('Another debugger is already attached')) {
      debuggerAttached = true;
      console.log('[AutoHangout BG] Debugger was already attached');
      return true;
    }
    console.error('[AutoHangout BG] Failed to attach debugger:', e.message);
    debuggerAttached = false;
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  
  try {
    await chrome.debugger.detach({ tabId });
    debuggerAttached = false;
    console.log('[AutoHangout BG] Debugger detached');
  } catch (e) {
    console.log('[AutoHangout BG] Detach error (may be already detached):', e.message);
    debuggerAttached = false;
  }
}

// Perform scroll using Runtime.evaluate
async function performDebuggerScroll(tabId, scrollAmount) {
  // Ensure debugger is attached
  if (!debuggerAttached) {
    const attached = await attachDebugger(tabId);
    if (!attached) {
      console.log('[AutoHangout BG] Cannot scroll - debugger not attached');
      return false;
    }
  }
  
  try {
    // Use Runtime.evaluate to execute scrollBy directly
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          window.scrollBy({ top: ${scrollAmount}, behavior: 'auto' });
          return { scrollY: window.scrollY, scrolled: ${scrollAmount} };
        })()
      `,
      returnByValue: true
    });
    
    console.log('[AutoHangout BG] Scroll executed:', scrollAmount, 'px, result:', result?.result?.value);
    return true;
  } catch (e) {
    console.error('[AutoHangout BG] Scroll failed:', e.message);
    
    // If debugger was detached, mark it and try to reattach next time
    if (e.message?.includes('not attached') || e.message?.includes('No tab')) {
      debuggerAttached = false;
    }
    return false;
  }
}

// ============ AUTOMATION CONTROL ============
async function startAutomation() {
  console.log('[AutoHangout BG] Starting automation');
  
  // Setup offscreen document
  await setupOffscreen();
  
  // Clear existing alarms
  await chrome.alarms.clearAll();
  
  // Main scroll trigger - every 3 seconds
  chrome.alarms.create('autoHangout-scroll', { 
    delayInMinutes: 0.05,
    periodInMinutes: 0.05 
  });
  
  // Heartbeat - every 15 seconds
  chrome.alarms.create('autoHangout-heartbeat', { 
    delayInMinutes: 0.25,
    periodInMinutes: 0.25 
  });
  
  // Keep alive - every 20 seconds
  chrome.alarms.create('autoHangout-keepalive', { 
    delayInMinutes: 0.33,
    periodInMinutes: 0.33 
  });
  
  // Broadcast start
  broadcastToContentScripts({ action: 'start', settings });
  
  // Attach debugger
  if (activeTabId) {
    await attachDebugger(activeTabId);
  }
  
  console.log('[AutoHangout BG] Automation started');
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
  if (!isRunning) return;
  
  const now = new Date().toLocaleTimeString();
  
  if (alarm.name === 'autoHangout-scroll') {
    console.log(`[AutoHangout BG] [${now}] Scroll alarm`);
    
    if (activeTabId) {
      try {
        // Verify tab exists
        const tab = await chrome.tabs.get(activeTabId);
        if (!tab || !tab.url?.startsWith('https://linux.do/')) {
          console.log('[AutoHangout BG] Tab invalid, skipping scroll');
          return;
        }
        
        // Calculate scroll amount
        const basePixels = 80 + settings.scrollSpeed * 30;
        const scrollAmount = Math.floor(basePixels * (0.7 + Math.random() * 0.6));
        
        const success = await performDebuggerScroll(activeTabId, scrollAmount);
        
        if (success) {
          // Notify content script
          chrome.tabs.sendMessage(activeTabId, { 
            action: 'scrollPerformed', 
            scrollAmount 
          }).catch(() => {});
        }
      } catch (e) {
        console.error('[AutoHangout BG] Scroll alarm error:', e.message);
      }
    }
  }
  
  if (alarm.name === 'autoHangout-heartbeat') {
    console.log(`[AutoHangout BG] [${now}] Heartbeat`);
    await broadcastToContentScripts({ action: 'heartbeat', settings });
  }
  
  if (alarm.name === 'autoHangout-keepalive') {
    console.log(`[AutoHangout BG] [${now}] Keepalive - debugger: ${debuggerAttached}`);
    
    // Re-check state
    const data = await chrome.storage.local.get(['isRunning']);
    if (data.isRunning && !isRunning) {
      isRunning = true;
      await startAutomation();
    }
    
    // Ensure debugger attached
    if (activeTabId && !debuggerAttached) {
      await attachDebugger(activeTabId);
    }
  }
});

// ============ DEBUGGER EVENTS ============
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[AutoHangout BG] Debugger detached:', reason);
  debuggerAttached = false;
  
  // Reattach if running (unless user cancelled)
  if (isRunning && activeTabId && reason !== 'canceled_by_user') {
    setTimeout(async () => {
      if (isRunning) {
        console.log('[AutoHangout BG] Reattaching debugger...');
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
      
      // Detach old, attach new
      debuggerAttached = false;
      setTimeout(async () => {
        await attachDebugger(tabId);
        chrome.tabs.sendMessage(tabId, { action: 'start', settings }).catch(() => {});
      }, 1500);
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isRunning) return;
  
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] Tab activated:', activeInfo.tabId);
      
      // Switch to new tab
      if (activeTabId && activeTabId !== activeInfo.tabId) {
        await detachDebugger(activeTabId);
      }
      
      activeTabId = activeInfo.tabId;
      chrome.storage.local.set({ activeTabId });
      await attachDebugger(activeTabId);
    }
  } catch (e) {}
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
  
  console.log('[AutoHangout BG] Window focus:', windowId);
  
  // Check alarms still running
  chrome.alarms.get('autoHangout-scroll', async (alarm) => {
    if (!alarm && isRunning) {
      console.log('[AutoHangout BG] Recreating alarms');
      await startAutomation();
    }
  });
});

// ============ BROADCAST ============
async function broadcastToContentScripts(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    
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
    console.error('[AutoHangout BG] Broadcast error:', e.message);
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

self.addEventListener('install', () => {
  console.log('[AutoHangout BG] Service worker installed');
  self.skipWaiting();
});
