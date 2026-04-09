// Background Service Worker for AutoHangout
// Uses Chrome Debugger API (CDP) with wheel-event scrolling for true background automation
// v2.3.2 - Scroll-based progress + context-safe messaging

let isRunning = false;
let settings = {
  scrollSpeed: 3,
  readMode: 'random',
  currentTopicAfterFinish: 'continueRandom'
};
let activeTabId = null;
let debuggerAttached = false;
let debuggerTabId = null;
let offscreenCreated = false;
let scrollInProgress = false;
let tabVisibilityStateById = {};
let lastScrollAt = 0;
let topicProgressByTabId = {};
let backgroundListTickCount = 0;
let backgroundNextListNavigateTick = 0;
let lastBackgroundListNavigateAt = 0;
let lastBackgroundTopicAdvanceAt = 0;

const MIN_SCROLL_INTERVAL_MS = 2500;
const WATCHDOG_ALARM_PERIOD_MINUTES = 0.5;
const MIN_BACKGROUND_TOPIC_ADVANCE_MS = 12000;

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

function parseTopicContextFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/linux\.do\/t\/([^/]+)\/(\d+)(?:\/(\d+))?/);
  if (!m) return null;
  return {
    slug: m[1],
    topicId: m[2],
    postNumber: m[3] ? parseInt(m[3], 10) : 1
  };
}

function buildTopicUrl(slug, topicId, postNumber) {
  if (!topicId) return null;
  const safeSlug = slug || '-';
  if (!postNumber || postNumber <= 1) {
    return `https://linux.do/t/${safeSlug}/${topicId}`;
  }
  return `https://linux.do/t/${safeSlug}/${topicId}/${postNumber}`;
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

function resetBackgroundListPlan() {
  backgroundListTickCount = 0;
  backgroundNextListNavigateTick = 3 + Math.floor(Math.random() * 6);
}

async function ensureTabPersistence(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {}
}

async function fetchLatestTopicPool() {
  const response = await fetch('https://linux.do/latest.json', {
    credentials: 'include',
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`latest_fetch_failed:${response.status}`);
  }

  const data = await response.json();
  const topics = Array.isArray(data?.topic_list?.topics)
    ? data.topic_list.topics
    : [];

  return topics
    .filter((topic) => topic?.id && topic?.slug && (topic.archetype === undefined || topic.archetype === 'regular'))
    .map((topic) => ({
      id: String(topic.id),
      slug: topic.slug,
      url: buildTopicUrl(topic.slug, String(topic.id), 1)
    }))
    .filter((topic) => Boolean(topic.url));
}

async function fetchTopicState(urlOrContext) {
  const ctx = typeof urlOrContext === 'string'
    ? parseTopicContextFromUrl(urlOrContext)
    : urlOrContext;
  if (!ctx?.topicId) return null;

  const apiUrl = `https://linux.do/t/${ctx.slug || '-'}/${ctx.topicId}.json`;
  const response = await fetch(apiUrl, {
    credentials: 'include',
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`topic_fetch_failed:${response.status}`);
  }

  const data = await response.json();
  const slug = data?.slug || ctx.slug || '-';
  const topicId = String(data?.id || ctx.topicId);
  const highestPostNumber = Math.max(
    data?.highest_post_number || 0,
    data?.posts_count || 0,
    ctx.postNumber || 0
  );

  return {
    slug,
    topicId,
    total: highestPostNumber,
    current: Math.max(1, ctx.postNumber || 1),
    url: buildTopicUrl(slug, topicId, ctx.postNumber || 1),
    source: 'topic-json'
  };
}

async function navigateToRandomTopicFromFeed(now) {
  if (!activeTabId) return false;

  backgroundListTickCount++;
  if (!backgroundNextListNavigateTick) resetBackgroundListPlan();
  if (backgroundListTickCount < backgroundNextListNavigateTick) return false;
  if (now - lastBackgroundListNavigateAt < 15000) return false;

  try {
    const topics = await fetchLatestTopicPool();
    if (topics.length === 0) {
      resetBackgroundListPlan();
      return false;
    }

    const unvisited = topics.filter((topic) => !topicHistory.topics?.[topic.id]);
    const pool = unvisited.length > 0 ? unvisited : topics;
    const topic = pool[Math.floor(Math.random() * pool.length)];
    if (!topic?.url) {
      resetBackgroundListPlan();
      return false;
    }

    lastBackgroundListNavigateAt = now;
    resetBackgroundListPlan();
    recordTopicSeen(topic.url);
    await ensureTabPersistence(activeTabId);
    await chrome.tabs.update(activeTabId, { url: topic.url });
    console.log('[AutoHangout BG] Background feed selected topic:', topic.url);
    return true;
  } catch (e) {
    console.warn('[AutoHangout BG] Failed to fetch latest topics:', e?.message || String(e));
    resetBackgroundListPlan();
    return false;
  }
}

async function finishBackgroundTopic(url) {
  const topicId = parseTopicIdFromUrl(url);
  if (topicId) {
    recordTopicCompleted({ topicId, url, readPercent: 100 });
  }

  if (settings.readMode === 'currentTopic') {
    if (settings.currentTopicAfterFinish === 'stop') {
      isRunning = false;
      await chrome.storage.local.set({ isRunning: false });
      await stopAutomation();
      console.log('[AutoHangout BG] Current topic mode completed, stopped in background');
      return true;
    }

    settings = { ...settings, readMode: 'random' };
    await chrome.storage.local.set({ settings });
    await broadcastToContentScripts({ action: 'updateSettings', settings });
  }

  resetBackgroundListPlan();
  await ensureTabPersistence(activeTabId);
  await chrome.tabs.update(activeTabId, { url: 'https://linux.do/latest' });
  console.log('[AutoHangout BG] Background topic completed, returning to latest');
  return true;
}

async function advanceTopicInBackground(tab, now) {
  if (!tab?.id || !tab.url) return false;
  if (now - lastBackgroundTopicAdvanceAt < MIN_BACKGROUND_TOPIC_ADVANCE_MS) return false;

  const ctx = parseTopicContextFromUrl(tab.url);
  if (!ctx) return false;

  let fetched;
  try {
    fetched = await fetchTopicState(ctx);
  } catch (e) {
    console.warn('[AutoHangout BG] Failed to fetch topic state:', e?.message || String(e));
    fetched = null;
  }

  const cached = topicProgressByTabId[tab.id] || {};
  const total = Math.max(
    fetched?.total || 0,
    cached?.total || 0,
    ctx.postNumber || 0
  );
  const current = Math.max(
    fetched?.current || 0,
    cached?.current || 0,
    ctx.postNumber || 1
  );

  if (!total || total <= 1) return false;

  if (current >= Math.max(1, total - 1)) {
    lastBackgroundTopicAdvanceAt = now;
    return await finishBackgroundTopic(fetched?.url || cached?.url || tab.url);
  }

  const step =
    total >= 300 ? 25 :
    total >= 150 ? 18 :
    total >= 80 ? 12 :
    8;
  const nextPost = Math.min(total, Math.max(current + 1, current + step));
  const nextUrl = buildTopicUrl(ctx.slug, ctx.topicId, nextPost);
  if (!nextUrl || nextUrl === tab.url) return false;

  lastBackgroundTopicAdvanceAt = now;
  topicProgressByTabId[tab.id] = {
    ...cached,
    ...(fetched || {}),
    url: nextUrl,
    topicId: ctx.topicId,
    current: nextPost,
    total,
    at: now,
    source: 'background-json'
  };

  await ensureTabPersistence(tab.id);
  await chrome.tabs.update(tab.id, { url: nextUrl });
  console.log('[AutoHangout BG] Advanced topic in background:', nextUrl);
  return true;
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
        chrome.storage.local.set({ settings });
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

    case 'topicProgress':
      if (sender.tab?.id && typeof message.current === 'number' && typeof message.total === 'number') {
        topicProgressByTabId[sender.tab.id] = {
          url: typeof message.url === 'string' ? message.url : sender.tab.url,
          topicId: message.topicId || parseTopicIdFromUrl(message.url || sender.tab.url || ''),
          current: message.current,
          total: message.total,
          source: message.source || 'content',
          at: Date.now()
        };
      }
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
          chrome.tabs.sendMessage(tabId, {
            action: 'start',
            settings,
            startMode: 'navigation'
          }).catch(() => {});
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
      return { success: false, method: 'none', error: 'debugger_not_attached' };
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
            const beforeY = window.scrollY;
            const scroller = document.scrollingElement || document.documentElement || document.body;
            const maxY = Math.max(0, (scroller?.scrollHeight || 0) - window.innerHeight);
            if (scroller) {
              scroller.scrollTop = Math.min(maxY, beforeY + ${scrollAmount});
            } else {
              window.scrollBy({ top: ${scrollAmount}, behavior: 'auto' });
            }
            window.dispatchEvent(new Event('scroll'));
            const afterY = window.scrollY;
            return {
              beforeY,
              afterY,
              maxY,
              atBottom: afterY >= Math.max(0, maxY - 2)
            };
          })()
        `,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      });

      await sleep(50);
      const afterPageY = await getPageY(tabId);
      const evalValue = result?.result?.value || {};
      const effectiveBeforeY = beforePageY ?? evalValue.beforeY ?? null;
      const effectiveAfterY = afterPageY ?? evalValue.afterY ?? null;
      const atBottom = Boolean(evalValue.atBottom);

      if (
        effectiveBeforeY !== null &&
        effectiveAfterY !== null &&
        effectiveAfterY === effectiveBeforeY &&
        !atBottom
      ) {
        throw new Error('eval_no_scroll');
      }

      console.log('[AutoHangout BG] Eval scroll executed:', scrollAmount, 'px', {
        beforePageY,
        afterPageY,
        result: evalValue
      });
      return {
        success: true,
        method: atBottom ? 'eval-bottom' : 'eval',
        atBottom
      };
    } catch (e2) {
      console.error('[AutoHangout BG] Eval scroll failed:', e2.message);
      if (
        e2.message?.includes('not attached') ||
        e2.message?.includes('No tab') ||
        e2.message?.includes('Cannot access a chrome://')
      ) {
        debuggerAttached = false;
        debuggerTabId = null;
      }
      return { success: false, method: 'none', error: e2?.message };
    }
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
    await ensureTabPersistence(activeTabId);

    let isForeground = false;
    try {
      const win = await chrome.windows.get(tab.windowId);
      const visibility = tabVisibilityStateById[activeTabId]?.visibilityState;
      isForeground =
        tab.active &&
        win?.focused &&
        win?.state !== 'minimized' &&
        visibility !== 'hidden';

      if (isForeground) return;
    } catch (_) {
      isForeground = false;
    }

    const isTopicTab = /^https:\/\/linux\.do\/t\/[^/]+\/\d+/.test(tab.url);

    // Hidden or minimized tabs should be driven by the background state machine,
    // not by page JS. This keeps progress moving even when Chrome freezes the tab.
    if (!isForeground) {
      if (!isTopicTab) {
        const navigated = await navigateToRandomTopicFromFeed(now);
        if (navigated) {
          lastScrollAt = now;
        }
        return;
      }

      const advanced = await advanceTopicInBackground(tab, now);
      if (advanced) {
        lastScrollAt = now;
        return;
      }
    }

    const basePixels = 80 + settings.scrollSpeed * 30;
    const scrollAmount = Math.floor(basePixels * (0.7 + Math.random() * 0.6));

    // Foreground path: ask the content script to scroll in isolated world.
    const delivered = await sendMessageToTab(activeTabId, {
      action: 'doScroll',
      scrollAmount,
      trigger,
      settings
    }, {
      timeoutMs: 800
    });
    if (delivered) {
      lastScrollAt = now;
      return;
    }

    // Foreground fallback: attempt CDP scroll if messaging fails.
    const result = await performDebuggerScroll(activeTabId, scrollAmount);
    if (result.success) {
      lastScrollAt = now;
      void sendMessageToTab(activeTabId, {
        action: 'scrollPerformed',
        scrollAmount,
        method: result.method,
        trigger,
        settings
      }, {
        fireAndForget: true,
        timeoutMs: 250,
        injectIfMissing: false
      });
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
  resetBackgroundListPlan();
  lastBackgroundTopicAdvanceAt = 0;
  
  // Setup offscreen document
  await setupOffscreen();
  
  // Clear existing alarms
  await chrome.alarms.clearAll();
  
  // Watchdog alarm: Chrome only guarantees 30s minimum periods for alarms.
  // Fine-grained 3s ticks are driven by the offscreen document and active debugger session.
  chrome.alarms.create('autoHangout-scroll', { 
    delayInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES,
    periodInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES 
  });
  
  // Heartbeat watchdog
  chrome.alarms.create('autoHangout-heartbeat', { 
    delayInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES,
    periodInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES 
  });
  
  // Keepalive watchdog
  chrome.alarms.create('autoHangout-keepalive', { 
    delayInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES,
    periodInMinutes: WATCHDOG_ALARM_PERIOD_MINUTES 
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
    await ensureTabPersistence(activeTabId);
    await sendMessageToTab(activeTabId, {
      action: 'start',
      settings,
      startMode: 'manual'
    });
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
    const tab = activeTabId ? await chrome.tabs.get(activeTabId).catch(() => null) : null;
    if (tab?.frozen) {
      console.log('[AutoHangout BG] Active tab is frozen; skipping heartbeat message');
    } else {
      await broadcastToContentScripts({ action: 'heartbeat', settings });
    }
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
    if (activeTabId) {
      await ensureTabPersistence(activeTabId);
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
      await ensureTabPersistence(tabId);
      
      // Ensure debugger is attached to the active tab and start content script.
      await attachDebugger(tabId);
      await sendMessageToTab(tabId, {
        action: 'start',
        settings,
        startMode: 'navigation'
      });
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
  delete topicProgressByTabId[tabId];
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
async function sendMessageToTab(tabId, message, options = {}) {
  const {
    timeoutMs = 1200,
    fireAndForget = false,
    injectIfMissing = true
  } = options;

  const sendWithTimeout = async () => {
    const sendPromise = chrome.tabs.sendMessage(tabId, message);
    if (fireAndForget) {
      sendPromise.catch(() => {});
      return true;
    }

    await Promise.race([
      sendPromise,
      sleep(timeoutMs).then(() => {
        throw new Error('message_timeout');
      })
    ]);
    return true;
  };

  try {
    return await sendWithTimeout();
  } catch (e) {
    const needsContentScript = new Set([
      'start',
      'stop',
      'heartbeat',
      'updateSettings',
      'doScroll',
      'scrollPerformed',
      'scrollError'
    ]);

    if (!needsContentScript.has(message.action)) return false;
    if (!injectIfMissing) return false;

    const messageText = String(e?.message || e || '');
    const missingReceiver =
      messageText.includes('Receiving end does not exist') ||
      messageText.includes('Could not establish connection') ||
      messageText.includes('No tab with id');
    if (!missingReceiver) return false;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sleep(200 + attempt * 200);
          return await sendWithTimeout();
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
      await sendMessageToTab(tab.id, message, {
        fireAndForget: true,
        timeoutMs: 250
      });
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
