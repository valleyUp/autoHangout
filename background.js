// Background Service Worker for AutoHangout
// Uses Chrome Debugger API (CDP) with wheel-event scrolling for true background automation
// v2.3.2 - Scroll-based progress + context-safe messaging

let isRunning = false;
let settings = {
  scrollSpeed: 3
};
let activeTabId = null;
let debuggerAttached = false;
let debuggerTabId = null;
let offscreenCreated = false;
let scrollInProgress = false;
let tabVisibilityStateById = {};
let lastScrollAt = 0;

const MIN_SCROLL_INTERVAL_MS = 2500;

console.log('[AutoHangout BG] Service worker started (v2.3.2)');

// ============ TOPIC HISTORY ============
const TOPIC_HISTORY_KEY = 'topicHistory';
const TOPIC_HISTORY_VERSION = 1;
const MAX_TOPIC_HISTORY_ENTRIES = 2000;

let topicHistory = { v: TOPIC_HISTORY_VERSION, topics: {}, order: [] };
let historySaveTimer = null;

function ensureTopicHistoryShape(raw) {
  if (!raw || typeof raw !== 'object') return { v: TOPIC_HISTORY_VERSION, topics: {}, order: [] };
  if (raw.v !== TOPIC_HISTORY_VERSION) return { v: TOPIC_HISTORY_VERSION, topics: {}, order: [] };
  if (!raw.topics || typeof raw.topics !== 'object') raw.topics = {};
  if (!Array.isArray(raw.order)) raw.order = [];
  return raw;
}

function parseTopicIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/https:\/\/linux\.do\/t\/[^/]+\/(\d+)/);
  return m ? m[1] : null;
}

function touchHistoryOrder(topicId) {
  const id = String(topicId);
  const idx = topicHistory.order.indexOf(id);
  if (idx !== -1) topicHistory.order.splice(idx, 1);
  topicHistory.order.push(id);

  while (topicHistory.order.length > MAX_TOPIC_HISTORY_ENTRIES) {
    const oldest = topicHistory.order.shift();
    if (oldest) delete topicHistory.topics[oldest];
  }
}

function recordTopicSeen(url) {
  const topicId = parseTopicIdFromUrl(url);
  if (!topicId) return;

  const now = Date.now();
  const existing = topicHistory.topics[topicId];
  const entry = existing && typeof existing === 'object'
    ? existing
    : { id: topicId, firstSeenAt: now, visits: 0 };

  entry.url = url;
  entry.lastSeenAt = now;
  entry.visits = (entry.visits || 0) + 1;
  topicHistory.topics[topicId] = entry;
  touchHistoryOrder(topicId);
  scheduleHistorySave();
}

function recordTopicCompleted(payload) {
  const url = typeof payload?.url === 'string' ? payload.url : null;
  const topicId = payload?.topicId || (url ? parseTopicIdFromUrl(url) : null);
  if (!topicId) return;

  const now = Date.now();
  const existing = topicHistory.topics[String(topicId)];
  const entry = existing && typeof existing === 'object'
    ? existing
    : { id: String(topicId), firstSeenAt: now, visits: 0 };

  if (url) entry.url = url;
  entry.lastSeenAt = now;
  entry.completedAt = now;
  if (typeof payload?.readPercent === 'number') entry.lastReadPercent = payload.readPercent;
  topicHistory.topics[String(topicId)] = entry;
  touchHistoryOrder(String(topicId));
  scheduleHistorySave();
}

function scheduleHistorySave() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    chrome.storage.local.set({ [TOPIC_HISTORY_KEY]: topicHistory }).catch(() => {});
  }, 500);
}

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
      reasons: ['DOM_PARSER'],
      justification: 'Drive periodic background automation ticks'
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
chrome.storage.local.get(['isRunning', 'settings', 'activeTabId', TOPIC_HISTORY_KEY], (data) => {
  console.log('[AutoHangout BG] Loaded state:', data);
  isRunning = data.isRunning || false;
  activeTabId = data.activeTabId || null;
  if (data.settings) {
    settings = { ...settings, ...data.settings };
  }
  if (data[TOPIC_HISTORY_KEY]) {
    topicHistory = ensureTopicHistoryShape(data[TOPIC_HISTORY_KEY]);
  }
  
  if (isRunning && activeTabId) {
    startAutomation();
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  // For first-time install, auto-start browsing when a linux.do tab exists.
  // For updates, preserve the user's previous running state.
  (async () => {
    try {
      const stored = await chrome.storage.local.get(['isRunning', 'activeTabId', 'settings']);
      if (typeof stored.isRunning === 'boolean') return;

      const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
      const active = tabs.find((t) => t.active) || tabs[0];

      isRunning = true;
      if (stored.settings) settings = { ...settings, ...stored.settings };
      if (active?.id) activeTabId = active.id;

      await chrome.storage.local.set({ isRunning, settings, activeTabId });
      await startAutomation();
      console.log('[AutoHangout BG] Auto-started on install:', details?.reason);
    } catch (e) {
      console.warn('[AutoHangout BG] Auto-start failed:', e?.message || String(e));
    }
  })();
});

function normalizeLinuxDoUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;

  try {
    const url = rawUrl.startsWith('/')
      ? new URL(rawUrl, 'https://linux.do')
      : new URL(rawUrl);

    if (url.origin !== 'https://linux.do') return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

// ============ MESSAGE HANDLING ============
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoHangout BG] Message:', message.action);
  
  switch (message.action) {
    case 'start':
      isRunning = true;
      if (message.settings) {
        settings = message.settings;
      }
      if (typeof message.tabId === 'number') {
        activeTabId = message.tabId;
        chrome.storage.local.set({ activeTabId });
      } else if (sender.tab) {
        activeTabId = sender.tab.id;
        chrome.storage.local.set({ activeTabId });
      }
      chrome.storage.local.set({ isRunning, settings, activeTabId });
      startAutomation();
      sendResponse({ success: true });
      break;
      
    case 'stop':
      isRunning = false;
      chrome.storage.local.set({ isRunning: false });
      stopAutomation();
      sendResponse({ success: true });
      break;
      
    case 'updateSettings':
      if (message.settings) {
        settings = { ...settings, ...message.settings };
        broadcastToContentScripts({ action: 'updateSettings', settings });
      }
      sendResponse({ success: true });
      break;

    case 'topicVisited':
      if (typeof message.url === 'string') recordTopicSeen(message.url);
      sendResponse({ success: true });
      break;

    case 'topicCompleted':
      recordTopicCompleted(message);
      sendResponse({ success: true });
      break;
      
    case 'getState':
      sendResponse({ isRunning, settings });
      break;
      
    case 'tabReady':
      if (sender.tab) {
        const tabId = sender.tab.id;
        const shouldAdoptTab =
          !isRunning ||
          !activeTabId ||
          activeTabId === tabId;

        if (shouldAdoptTab) {
          activeTabId = tabId;
          chrome.storage.local.set({ activeTabId });
        }

        if (isRunning && activeTabId === tabId) {
          chrome.tabs.sendMessage(tabId, { action: 'start', settings }).catch(() => {});
          attachDebugger(tabId);
        }
      }
      sendResponse({ success: true });
      break;

    case 'tabVisibility':
      if (sender.tab && typeof message.visibilityState === 'string') {
        tabVisibilityStateById[sender.tab.id] = {
          visibilityState: message.visibilityState,
          at: Date.now()
        };
      }
      sendResponse({ success: true });
      break;
      
    case 'offscreenPing':
      sendResponse({ alive: true });
      break;

    case 'offscreenTick':
      runScrollStep('offscreen').catch(() => {});
      sendResponse({ success: true });
      break;
      
    case 'requestNavigation':
      if (!sender.tab) {
        sendResponse({ success: false, error: 'no_sender_tab' });
        break;
      }

      if (!message.url) {
        sendResponse({ success: false, error: 'missing_url' });
        break;
      }

      if (isRunning && activeTabId && sender.tab.id !== activeTabId) {
        sendResponse({ success: false, error: 'not_target_tab' });
        break;
      }

      if (!activeTabId) {
        activeTabId = sender.tab.id;
        chrome.storage.local.set({ activeTabId });
      }

      {
        const url = normalizeLinuxDoUrl(message.url);
        if (!url) {
          sendResponse({ success: false, error: 'invalid_url' });
          break;
        }
        chrome.tabs.update(sender.tab.id, { url });
      }

      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// ============ DEBUGGER FUNCTIONS ============
async function attachDebugger(tabId) {
  // Already attached? Just return true
  if (debuggerAttached && debuggerTabId === tabId) {
    return true;
  }

  // Attached to a different tab? Move the attachment.
  if (debuggerAttached && debuggerTabId && debuggerTabId !== tabId) {
    await detachDebugger(debuggerTabId);
  }
  
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debuggerAttached = true;
    debuggerTabId = tabId;
    console.log('[AutoHangout BG] Debugger attached to tab:', tabId);
    return true;
  } catch (e) {
    // If already attached, that's fine
    if (e.message?.includes('Another debugger is already attached')) {
      debuggerAttached = true;
      debuggerTabId = tabId;
      console.log('[AutoHangout BG] Debugger was already attached');
      return true;
    }
    console.error('[AutoHangout BG] Failed to attach debugger:', e.message);
    debuggerAttached = false;
    debuggerTabId = null;
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  
  try {
    const detachTabId = tabId ?? debuggerTabId;
    if (typeof detachTabId !== 'number') {
      debuggerAttached = false;
      debuggerTabId = null;
      return;
    }

    await chrome.debugger.detach({ tabId: detachTabId });
    debuggerAttached = false;
    debuggerTabId = null;
    console.log('[AutoHangout BG] Debugger detached');
  } catch (e) {
    console.log('[AutoHangout BG] Detach error (may be already detached):', e.message);
    debuggerAttached = false;
    debuggerTabId = null;
  }
}

async function getScrollPoint(tabId) {
  // Prefer CDP layout metrics (works without page JS).
  try {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const clientWidth =
      metrics?.layoutViewport?.clientWidth ??
      metrics?.visualViewport?.clientWidth;
    const clientHeight =
      metrics?.layoutViewport?.clientHeight ??
      metrics?.visualViewport?.clientHeight;

    if (clientWidth && clientHeight) {
      return {
        x: Math.floor(clientWidth * (0.45 + Math.random() * 0.1)),
        y: Math.floor(clientHeight * (0.65 + Math.random() * 0.2))
      };
    }
  } catch (_) {}

  // Fallback to evaluating in page context.
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: '({ w: window.innerWidth, h: window.innerHeight })',
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    const w = result?.result?.value?.w;
    const h = result?.result?.value?.h;
    if (w && h) {
      return {
        x: Math.floor(w * (0.45 + Math.random() * 0.1)),
        y: Math.floor(h * (0.65 + Math.random() * 0.2))
      };
    }
  } catch (_) {}

  return { x: 200, y: 200 };
}

async function getPageY(tabId) {
  try {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics');
    const pageY = metrics?.layoutViewport?.pageY;
    return typeof pageY === 'number' ? pageY : null;
  } catch (_) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Perform scroll using CDP input (fallback to Runtime.evaluate)
async function performDebuggerScroll(tabId, scrollAmount) {
  // Ensure debugger is attached
  if (!debuggerAttached || debuggerTabId !== tabId) {
    const attached = await attachDebugger(tabId);
    if (!attached) {
      console.log('[AutoHangout BG] Cannot scroll - debugger not attached');
      return false;
    }
  }
  
  try {
    const { x, y } = await getScrollPoint(tabId);
    const beforePageY = await getPageY(tabId);

    // Prefer compositor-level wheel events for true background scrolling.
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: scrollAmount,
      modifiers: 0,
      pointerType: 'mouse'
    });

    await sleep(50);
    const afterPageY = await getPageY(tabId);

    if (beforePageY !== null && afterPageY !== null && afterPageY === beforePageY) {
      throw new Error('wheel_no_scroll');
    }

    console.log('[AutoHangout BG] Wheel scroll executed:', scrollAmount, 'px', {
      beforePageY,
      afterPageY
    });
    return { success: true, method: 'wheel' };
  } catch (e) {
    console.warn('[AutoHangout BG] Wheel scroll failed, falling back:', e.message);

    try {
      const beforePageY = await getPageY(tabId);
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            window.scrollBy({ top: ${scrollAmount}, behavior: 'auto' });
            return { scrollY: window.scrollY, scrolled: ${scrollAmount} };
          })()
        `,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      });

      await sleep(50);
      const afterPageY = await getPageY(tabId);

      console.log('[AutoHangout BG] Eval scroll executed:', scrollAmount, 'px', {
        beforePageY,
        afterPageY,
        result: result?.result?.value
      });
      return { success: true, method: 'eval' };
    } catch (e2) {
      console.error('[AutoHangout BG] Eval scroll failed:', e2.message);
    }
    
    // If debugger was detached, mark it and try to reattach next time
    if (
      e.message?.includes('not attached') ||
      e.message?.includes('No tab') ||
      e.message?.includes('Cannot access a chrome://')
    ) {
      debuggerAttached = false;
      debuggerTabId = null;
    }
    return { success: false, method: 'none', error: e?.message };
  }
}

async function runScrollStep(trigger) {
  if (!isRunning) return;
  if (!activeTabId) return;
  if (scrollInProgress) return;

  const now = Date.now();
  if (now - lastScrollAt < MIN_SCROLL_INTERVAL_MS) return;

  scrollInProgress = true;
  try {
    const tab = await chrome.tabs.get(activeTabId);
    if (!tab || !tab.url?.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] Tab invalid, skipping scroll');
      return;
    }

    try {
      const win = await chrome.windows.get(tab.windowId);
      const isForeground =
        tab.active &&
        win?.focused &&
        win?.state !== 'minimized';

      // If the user is actively viewing the target tab, don't fight them.
      if (isForeground) return;
    } catch (_) {
      // If we can't determine window state, prefer scrolling (better than getting stuck).
    }

    const basePixels = 80 + settings.scrollSpeed * 30;
    const scrollAmount = Math.floor(basePixels * (0.7 + Math.random() * 0.6));

    // Primary path: ask the content script to scroll in isolated world.
    const delivered = await sendMessageToTab(activeTabId, {
      action: 'doScroll',
      scrollAmount,
      trigger
    });
    if (delivered) {
      lastScrollAt = now;
      return;
    }

    // Fallback: attempt CDP scroll if messaging fails.
    const result = await performDebuggerScroll(activeTabId, scrollAmount);
    if (result.success) {
      lastScrollAt = now;
      return;
    }

    chrome.tabs.sendMessage(activeTabId, {
      action: 'scrollError',
      trigger,
      error: result.error ?? 'unknown'
    }).catch(() => {});
  } catch (e) {
    console.error(`[AutoHangout BG] Scroll tick error (${trigger}):`, e.message);
  } finally {
    scrollInProgress = false;
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
  
  // Enforce single-target-tab behavior: stop other linux.do tabs, then start the target tab.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    for (const tab of tabs) {
      if (!tab?.id) continue;
      if (activeTabId && tab.id !== activeTabId) {
        await sendMessageToTab(tab.id, { action: 'stop' });
      }
    }
  } catch (_) {}
  if (activeTabId) {
    await sendMessageToTab(activeTabId, { action: 'start', settings });
  }
  
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

  // Offscreen should only exist while running; close it to avoid unnecessary wakeups.
  try {
    if (offscreenCreated) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
  offscreenCreated = false;
  
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
    await runScrollStep('alarm');
  }
  
  if (alarm.name === 'autoHangout-heartbeat') {
    console.log(`[AutoHangout BG] [${now}] Heartbeat`);
    await broadcastToContentScripts({ action: 'heartbeat', settings });
  }
  
  if (alarm.name === 'autoHangout-keepalive') {
    console.log(`[AutoHangout BG] [${now}] Keepalive - debugger: ${debuggerAttached} (${debuggerTabId ?? 'none'})`);
    
    // Re-check state
    const data = await chrome.storage.local.get(['isRunning']);
    if (data.isRunning && !isRunning) {
      isRunning = true;
      await startAutomation();
    }
    
    // Ensure debugger attached
    if (activeTabId && (!debuggerAttached || debuggerTabId !== activeTabId)) {
      await attachDebugger(activeTabId);
    }
  }
});

// ============ DEBUGGER EVENTS ============
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log('[AutoHangout BG] Debugger detached:', reason);
  if (source?.tabId === debuggerTabId || !source?.tabId) {
    debuggerAttached = false;
    debuggerTabId = null;
  }
  
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

    if (tabId === activeTabId && typeof tab.url === 'string') {
      recordTopicSeen(tab.url);
    }
    
    if (tabId === activeTabId || !activeTabId) {
      activeTabId = tabId;
      chrome.storage.local.set({ activeTabId });
      
      // Ensure debugger is attached to the active tab and start content script.
      await attachDebugger(tabId);
      await sendMessageToTab(tabId, { action: 'start', settings });
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!isRunning) return;
  
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.startsWith('https://linux.do/')) {
      console.log('[AutoHangout BG] Tab activated:', activeInfo.tabId);

      // Don't switch target tab just because the user activated another linux.do tab.
      // Only adopt if we don't have a target (e.g. after restart).
      if (!activeTabId) {
        activeTabId = activeInfo.tabId;
        chrome.storage.local.set({ activeTabId });
        await attachDebugger(activeTabId);
      }
    }
  } catch (e) {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    console.log('[AutoHangout BG] Active tab closed');
    debuggerAttached = false;
    debuggerTabId = null;
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
async function sendMessageToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (e) {
    const needsContentScript = new Set([
      'start',
      'stop',
      'heartbeat',
      'updateSettings',
      'doScroll',
      'scrollError'
    ]);

    if (!needsContentScript.has(message.action)) return false;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sleep(200 + attempt * 200);
          await chrome.tabs.sendMessage(tabId, message);
          return true;
        } catch (_) {}
      }
      return false;
    } catch (_) {
      return false;
    }
  }
}

async function broadcastToContentScripts(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://linux.do/*' });
    
    for (const tab of tabs) {
      await sendMessageToTab(tab.id, message);
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
