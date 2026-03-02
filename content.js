// AutoHangout Content Script
// Human-like browsing for linux.do (Discourse)
// v2.3.2 - Scroll-based progress + context-safe messaging

(function() {
  'use strict';

  if (window.__autoHangoutInjected) return;
  window.__autoHangoutInjected = true;

  // Expose running state for background script to check
  window.__autoHangoutRunning = false;

  let isRunning = false;
  let scrollTimeout = null;
  let actionTimeout = null;
  let scrollCount = 0;
  let topicInfo = null;
  let lastProgress = 0;
  let stuckCount = 0;
  let lastActivityTime = Date.now();
  let isBackgroundMode = false;  // True when tab is not visible
  let listTickCount = 0;
  let nextListNavigateTick = 0;
  let lastListNavigateAt = 0;
  let maxReadPercent = 0;
  
  let settings = {
    scrollSpeed: 3
  };

  const TOPIC_HISTORY_KEY = 'topicHistory';
  const VISITED_CACHE_TTL_MS = 15000;
  let visitedTopicIds = new Set();
  let visitedCacheLoadedAt = 0;
  let visitedCacheLoading = false;
  let visitedCacheWaiters = [];

  const DEBUG = true;
  
  function log(...args) {
    if (DEBUG) console.log('[AutoHangout]', ...args);
  }

  log('=== Script loaded (Debugger API version) ===', window.location.pathname);

  const ext = typeof chrome !== 'undefined' ? chrome : null;
  let extensionOk = true;

  function safeSendMessage(message) {
    if (!extensionOk) return false;
    if (!ext?.runtime?.sendMessage) return false;

    try {
      const result = ext.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') {
        result.catch((e) => {
          if (String(e).includes('Extension context invalidated')) {
            extensionOk = false;
          }
        });
      }
      return true;
    } catch (e) {
      if (String(e).includes('Extension context invalidated')) {
        extensionOk = false;
      }
      return false;
    }
  }

  function safeStorageGet(keys, cb) {
    if (typeof cb !== 'function') return;
    if (!extensionOk) {
      cb({});
      return;
    }
    if (!ext?.storage?.local?.get) {
      cb({});
      return;
    }

    try {
      ext.storage.local.get(keys, cb);
    } catch (e) {
      if (String(e).includes('Extension context invalidated')) {
        extensionOk = false;
      }
      cb({});
    }
  }

  // Notify background that we're ready
  safeSendMessage({ action: 'tabReady' });

  function parseTopicIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/https:\/\/linux\.do\/t\/[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  function currentTopicId() {
    return parseTopicIdFromUrl(window.location.href);
  }

  function refreshVisitedCache(cb, force = false) {
    const now = Date.now();
    if (!force && visitedTopicIds.size > 0 && now - visitedCacheLoadedAt < VISITED_CACHE_TTL_MS) {
      cb?.();
      return;
    }

    if (cb) visitedCacheWaiters.push(cb);
    if (visitedCacheLoading) return;
    visitedCacheLoading = true;

    safeStorageGet([TOPIC_HISTORY_KEY], (data) => {
      visitedCacheLoading = false;
      visitedCacheLoadedAt = Date.now();

      visitedTopicIds = new Set();
      const raw = data?.[TOPIC_HISTORY_KEY];
      const topics = raw?.topics;
      if (topics && typeof topics === 'object') {
        for (const id of Object.keys(topics)) {
          if (id) visitedTopicIds.add(String(id));
        }
      }

      const waiters = visitedCacheWaiters;
      visitedCacheWaiters = [];
      for (const fn of waiters) {
        try { fn(); } catch (_) {}
      }
    });
  }

  function reportTopicVisited() {
    const topicId = currentTopicId();
    if (!topicId) return;
    const url = window.location.href;

    visitedTopicIds.add(String(topicId));
    safeSendMessage({ action: 'topicVisited', topicId, url });
  }

  function reportTopicCompleted(readPercent) {
    const topicId = currentTopicId();
    if (!topicId) return;
    const url = window.location.href;
    safeSendMessage({ action: 'topicCompleted', topicId, url, readPercent });
  }

  function reportVisibility() {
    safeSendMessage({
      action: 'tabVisibility',
      visibilityState: document.visibilityState
    });
  }

  reportVisibility();

  // ============ MESSAGE HANDLING ============
  ext?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    log('Message:', message.action);
    
    if (message.action === 'start') {
      if (message.settings) settings = message.settings;
      start();
    } else if (message.action === 'stop') {
      stop();
    } else if (message.action === 'doScroll') {
      if (!isRunning) {
        sendResponse({ success: false, error: 'not_running' });
        return true;
      }

      if (message.settings) settings = { ...settings, ...message.settings };

      const amount = typeof message.scrollAmount === 'number'
        ? message.scrollAmount
        : Math.floor((80 + settings.scrollSpeed * 30) * (0.7 + Math.random() * 0.6));

      scrollCount++;
      lastActivityTime = Date.now();

      log(`[Tick Scroll] #${scrollCount}: ${amount}px (${message.trigger || 'tick'})`);
      window.scrollBy({ top: amount, behavior: 'auto' });

      const pageType = getPageType();
      if (pageType === 'topic') {
        checkTopicProgress(message.trigger);
      } else {
        maybeNavigateFromList(message.trigger);
      }
    } else if (message.action === 'updateSettings') {
      if (message.settings) settings = { ...settings, ...message.settings };
    } else if (message.action === 'heartbeat') {
      if (message.settings) settings = { ...settings, ...message.settings };
      if (!isRunning) {
        // Background decides which tab should run; don't auto-start on heartbeat.
        sendResponse({ success: true });
        return true;
      }

      // Check if we've been idle too long (stuck)
      const idleTime = Date.now() - lastActivityTime;
      if (idleTime > 30000) {
        log('Idle for too long, restarting behavior');
        restartBehavior();
      }
    } else if (message.action === 'scrollPerformed') {
      // Background performed a scroll via debugger
      if (isRunning) {
        scrollCount++;
        lastActivityTime = Date.now();
        log(`[BG Scroll] #${scrollCount}: ${message.scrollAmount}px (${message.method || 'unknown'})`);
        if (message.settings) settings = { ...settings, ...message.settings };
        
        const pageType = getPageType();
        if (pageType === 'topic') {
          checkTopicProgress('debugger');
        } else if (pageType === 'list') {
          maybeNavigateFromList('debugger');
        }
      }
    } else if (message.action === 'scrollError') {
      log(`[BG Scroll ERROR] ${message.trigger || 'unknown'}: ${message.error || 'unknown'}`);
    }
    
    sendResponse({ success: true });
    return true;
  });

  // Handle visibility change (when tab becomes hidden/visible)
  document.addEventListener('visibilitychange', () => {
    log('Visibility:', document.visibilityState);
    isBackgroundMode = document.visibilityState === 'hidden';
    reportVisibility();
    
    if (document.visibilityState === 'visible' && isRunning) {
      // Tab became visible again - can use normal scrolling
      isBackgroundMode = false;
      restartBehavior();
    } else if (document.visibilityState === 'hidden' && isRunning) {
      // Tab hidden - switch to background mode (debugger will handle scrolling)
      isBackgroundMode = true;
      log('Switched to background mode - debugger will handle scrolling');
      // Clear local timers, let background handle it
      clearTimeout(scrollTimeout);
      clearTimeout(actionTimeout);
      resetListPlan();
    }
  });

  // Load settings (start/stop is driven by background to enforce single-target-tab behavior)
  safeStorageGet(['settings'], (data) => {
    if (data.settings) settings = { ...settings, ...data.settings };
  });

  // Per-topic exit plan (derived automatically; no UI probability knob)
  let topicExitTargetPercent = null;
  let topicMinScrolls = 0;
  let topicStartedAt = 0;

  function computeExitTargetPercent(totalPosts) {
    const roll = Math.random();
    if (totalPosts >= 50) return 90 + Math.floor(roll * 8); // 90-97
    if (totalPosts >= 20) return 80 + Math.floor(roll * 15); // 80-94
    // Short topics: bias towards reading more, but still variable.
    const skew = Math.pow(roll, 0.55);
    return 60 + Math.floor(skew * 35); // 60-95
  }

  function initTopicPlan(totalPosts) {
    topicStartedAt = Date.now();
    topicExitTargetPercent = computeExitTargetPercent(totalPosts || 0);
    // Ensure we don't bounce instantly on very short pages.
    topicMinScrolls = 8 + Math.floor(Math.random() * 7); // 8-14
    log(`[Plan] target=${topicExitTargetPercent}% minScrolls=${topicMinScrolls}`);
  }

  function start() {
    if (isRunning) return;
    
    isRunning = true;
    window.__autoHangoutRunning = true;
    scrollCount = 0;
    stuckCount = 0;
    lastProgress = 0;
    maxReadPercent = 0;
    lastActivityTime = Date.now();
    topicInfo = null;
    isBackgroundMode = document.visibilityState === 'hidden';
    reportVisibility();
    
    const pageType = getPageType();
    log('Starting, page:', pageType, 'background:', isBackgroundMode);
    
    setTimeout(() => {
      if (!isRunning) return;
      
      if (pageType === 'topic') {
        topicInfo = getTopicProgress();
        log('Topic info:', topicInfo);
        reportTopicVisited();
        initTopicPlan(topicInfo?.total || 0);
        
        // Only start local scrolling if visible
        if (!isBackgroundMode) {
          doTopicBehavior();
        } else {
          log('Background mode - waiting for debugger scrolls');
        }
      } else {
        resetListPlan();
        if (!isBackgroundMode) {
          doListBehavior();
        } else {
          log('Background mode - waiting for debugger scrolls (list)');
        }
      }
    }, 2000);
  }

  function stop() {
    isRunning = false;
    window.__autoHangoutRunning = false;
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    reportVisibility();
    log('Stopped');
  }

  function restartBehavior() {
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    lastActivityTime = Date.now();
    
    const pageType = getPageType();
    log('Restarting behavior for:', pageType);
    
    if (pageType === 'topic') {
      if (!isBackgroundMode) {
        doTopicBehavior();
      }
    } else {
      doListBehavior();
    }
  }

  function getPageType() {
    const path = window.location.pathname;
    if (/^\/t\/[^/]+\/\d+/.test(path)) return 'topic';
    return 'list';
  }

  function isBackgroundDrive(trigger) {
    return (
      isBackgroundMode ||
      trigger === 'offscreen' ||
      trigger === 'alarm' ||
      trigger === 'debugger'
    );
  }

  function resetListPlan() {
    listTickCount = 0;
    nextListNavigateTick = 3 + Math.floor(Math.random() * 6); // 3-8 ticks
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, window.location.origin).href;
    } catch {
      return null;
    }
  }

  function requestNavigation(url) {
    const targetUrl = toAbsoluteUrl(url);
    if (!targetUrl) return;

    // Use service worker to navigate via tabs.update (more reliable in background/frozen tabs).
    if (!extensionOk || !ext?.runtime?.sendMessage) {
      window.location.href = targetUrl;
      return;
    }

    try {
      const result = ext.runtime.sendMessage({ action: 'requestNavigation', url: targetUrl });
      if (!result || typeof result.then !== 'function') {
        window.location.href = targetUrl;
        return;
      }

      result.then((response) => {
        if (response?.success) return;
        if (response?.error === 'not_target_tab') return;
        window.location.href = targetUrl;
      }).catch((e) => {
        if (String(e).includes('Extension context invalidated')) {
          extensionOk = false;
        }
        window.location.href = targetUrl;
      });
    } catch (e) {
      if (String(e).includes('Extension context invalidated')) {
        extensionOk = false;
      }
      window.location.href = targetUrl;
    }
  }

  function maybeNavigateFromList(trigger) {
    if (!isRunning) return;
    if (!isBackgroundDrive(trigger)) return;

    listTickCount++;
    if (!nextListNavigateTick) resetListPlan();
    if (listTickCount < nextListNavigateTick) return;

    const now = Date.now();
    if (now - lastListNavigateAt < 15000) return;

    const topics = findTopics();
    log(`[BG List] ticks=${listTickCount}/${nextListNavigateTick}, topics=${topics.length}`);
    if (topics.length === 0) {
      resetListPlan();
      return;
    }

    refreshVisitedCache(() => {
      if (!isRunning || !isBackgroundMode) return;

      const unvisited = topics.filter((a) => {
        const id = parseTopicIdFromUrl(a.href);
        return id && !visitedTopicIds.has(String(id));
      });
      const pool = unvisited.length > 0 ? unvisited : topics;

      const topic = pool[Math.floor(Math.random() * pool.length)];
      if (!topic?.href) {
        resetListPlan();
        return;
      }

      lastListNavigateAt = Date.now();
      resetListPlan();
      log(`[BG List] Navigating to topic (unvisited=${unvisited.length > 0})`);
      requestNavigation(topic.href);
    });
  }

  function getReadPercentByScroll() {
    const doc = document.documentElement;
    const scrollTop = window.scrollY || doc.scrollTop || 0;
    const viewportBottom = scrollTop + window.innerHeight;
    const scrollHeight = Math.max(
      doc.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      1
    );

    if (scrollHeight - viewportBottom < 120) {
      maxReadPercent = 100;
      return maxReadPercent;
    }

    const percent = Math.max(0, Math.min(100, (viewportBottom / scrollHeight) * 100));
    if (percent > maxReadPercent) maxReadPercent = percent;
    return maxReadPercent;
  }

  // ============ TOPIC PROGRESS ============
  function getTopicProgress() {
    const timeline = document.querySelector('.timeline-replies');
    if (timeline) {
      const match = timeline.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        return { current: parseInt(match[1]), total: parseInt(match[2]), source: 'timeline' };
      }
    }
    
    const urlMatch = window.location.pathname.match(/\/t\/[^/]+\/\d+\/(\d+)/);
    if (urlMatch) {
      const postNum = parseInt(urlMatch[1]);
      const posts = document.querySelectorAll('.topic-post, article[data-post-number]');
      return { current: postNum, total: Math.max(postNum, posts.length, 20), source: 'url' };
    }
    
    const posts = document.querySelectorAll('.topic-post, article[data-post-number]');
    return { current: 1, total: Math.max(posts.length, 20), source: 'estimated' };
  }

  function updateProgress() {
    const newInfo = getTopicProgress();

    const readPercentByScroll = getReadPercentByScroll();
    const totalPosts = Math.max(
      newInfo.total || 0,
      topicInfo?.total || 0
    );

    // Discourse 在 hidden 状态下经常不更新 timeline/url post number；
    // 用滚动百分比估算 current，保证进度可推进并触发退出。
    if (totalPosts > 0) {
      const estimatedCurrent = Math.max(1, Math.min(
        totalPosts,
        Math.round((totalPosts * readPercentByScroll) / 100)
      ));
      if (estimatedCurrent > newInfo.current) {
        newInfo.current = estimatedCurrent;
        newInfo.total = totalPosts;
        newInfo.source = `${newInfo.source}+scroll`;
      }
    } else {
      newInfo.current = Math.max(newInfo.current, Math.round(readPercentByScroll));
      newInfo.total = 100;
      newInfo.source = `${newInfo.source}+scroll`;
    }
    
    if (newInfo.current > lastProgress) {
      stuckCount = 0;
      lastProgress = newInfo.current;
    } else {
      stuckCount++;
    }
    
    if (newInfo.current > (topicInfo?.current || 0)) {
      topicInfo = newInfo;
    }
    return topicInfo || newInfo;
  }

  // ============ EXIT STRATEGY ============
  function shouldExitTopic() {
    const progress = updateProgress();
    const total = progress.total;
    const current = progress.current;
    const readPercent = total > 0 ? (current / total) * 100 : 0;
    
    log(`Progress: ${current}/${total} (${readPercent.toFixed(0)}%), scrolls: ${scrollCount}, stuck: ${stuckCount}`);

    if (topicExitTargetPercent === null) {
      initTopicPlan(total || 0);
    }
    
    // Long topic (>= 50): read most of it
    if (total >= 50) {
      const target = Math.max(90, topicExitTargetPercent ?? 90);
      if (readPercent >= target && scrollCount >= topicMinScrolls) {
        log(`Long topic: read ${target}%+, exiting`);
        return true;
      }
      if (stuckCount >= 20 && readPercent >= 70) {
        log('Long topic: stuck, seems finished');
        return true;
      }
      return false;
    }
    
    // Medium topic (20-49): read most of it
    if (total >= 20) {
      const target = Math.max(80, topicExitTargetPercent ?? 80);
      if (readPercent >= target && scrollCount >= topicMinScrolls) {
        log(`Medium topic: read ${target}%+, exiting`);
        return true;
      }
      if (stuckCount >= 15 && readPercent >= 60) {
        log('Medium topic: stuck, seems finished');
        return true;
      }
      return false;
    }
    
    // Short topic (< 20): auto-derived threshold + minimum engagement
    if (readPercent >= (topicExitTargetPercent ?? 80) && scrollCount >= topicMinScrolls) {
      log(`Short topic: read ${topicExitTargetPercent}%+, exiting`);
      return true;
    }
    
    if (stuckCount >= 10 && scrollCount >= 15) {
      log('Short topic: stuck, exiting');
      return true;
    }
    
    // Safety: if we have been reading for a long time and reached a decent point, allow exit.
    if (Date.now() - topicStartedAt > 4 * 60 * 1000 && readPercent >= 70) {
      log('Short topic: time limit reached, exiting');
      return true;
    }

    return false;
  }

  // Check progress and potentially leave topic (called by background scroll notifications)
  function checkTopicProgress(trigger) {
    if (shouldExitTopic()) {
      leaveCurrentTopic(trigger);
    }
  }

  // ============ TOPIC BEHAVIOR ============
  function doTopicBehavior() {
    if (!isRunning) return;
    
    // In background mode, scrolling is handled by debugger
    if (isBackgroundMode) {
      log('Background mode active - debugger handling scrolls');
      return;
    }
    
    lastActivityTime = Date.now();
    
    if (shouldExitTopic()) {
      leaveCurrentTopic();
      return;
    }
    
    doSingleScroll();
    
    // Schedule next action
    let delay;
    if (Math.random() < 0.12) {
      delay = 4000 + Math.random() * 6000;
      log(`Reading pause: ${(delay/1000).toFixed(1)}s`);
    } else {
      const baseDelay = 2500 - settings.scrollSpeed * 150;
      delay = Math.max(800, baseDelay + Math.random() * 1200);
    }
    
    scrollTimeout = setTimeout(() => doTopicBehavior(), delay);
  }

  // Single scroll action (for foreground mode)
  function doSingleScroll() {
    scrollCount++;
    lastActivityTime = Date.now();
    
    const basePixels = 50 + settings.scrollSpeed * 25;
    const scrollAmount = Math.floor(basePixels * (0.5 + Math.random() * 1.0));
    
    log(`Scroll #${scrollCount}: ${scrollAmount}px`);
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  }

  // ============ LIST BEHAVIOR ============
  function doListBehavior() {
    if (!isRunning) return;
    if (isBackgroundMode) return;
    
    lastActivityTime = Date.now();
    log('On list, looking for topics...');
    
    actionTimeout = setTimeout(() => {
      if (!isRunning) return;
      
      const topics = findTopics();
      log(`Found ${topics.length} topics`);
      
      if (topics.length > 0) {
        window.scrollBy({ top: 80 + Math.random() * 120, behavior: 'smooth' });
        
        const delay = 4000 + Math.random() * 5000;
        log(`Will click in ${(delay/1000).toFixed(1)}s`);
        
        actionTimeout = setTimeout(() => {
          if (!isRunning) return;
          clickTopic(topics);
        }, delay);
      } else {
        window.scrollBy({ top: 400, behavior: 'smooth' });
        scrollTimeout = setTimeout(doListBehavior, 4000);
      }
    }, 3000);
  }

  // ============ NAVIGATION ============
  function leaveCurrentTopic(trigger) {
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    
    const progress = topicInfo || { current: 0, total: 0 };
    log(`Leaving topic (read ${progress.current}/${progress.total})`);

    const readPercent = progress.total > 0
      ? Math.max(0, Math.min(100, (progress.current / progress.total) * 100))
      : getReadPercentByScroll();
    reportTopicCompleted(readPercent);
    
    // Always return to list after finishing a topic, then pick a new one from list.
    const targetUrl = window.location.origin + '/latest';

    if (isBackgroundDrive(trigger)) {
      log('Background exit navigation');
      requestNavigation(targetUrl);
      return;
    }

    actionTimeout = setTimeout(() => {
      if (!isRunning) return;
      requestNavigation(targetUrl);
    }, 3000 + Math.random() * 3000);
  }

  function clickTopic(topics) {
    if (!isRunning || topics.length === 0) return;
    
    const visible = topics.filter(t => {
      const rect = t.getBoundingClientRect();
      return rect.top > 80 && rect.bottom < window.innerHeight - 80;
    });
    const candidates = visible.length > 0 ? visible : topics;

    refreshVisitedCache(() => {
      if (!isRunning) return;

      const unvisited = candidates.filter((a) => {
        const id = parseTopicIdFromUrl(a.href);
        return id && !visitedTopicIds.has(String(id));
      });

      const pool = unvisited.length > 0 ? unvisited : candidates;
      const topic = pool[Math.floor(Math.random() * pool.length)];
      if (!topic?.href) return;

      log('Clicking:', topic.textContent.trim().substring(0, 50), `(unvisited=${unvisited.length > 0})`);

      if (isBackgroundMode) {
        requestNavigation(topic.href);
        return;
      }

      topic.scrollIntoView({ behavior: 'smooth', block: 'center' });

      actionTimeout = setTimeout(() => {
        if (!isRunning) return;
        if (topic.href) window.location.href = topic.href;
      }, 1000 + Math.random() * 1000);
    });
  }

  // ============ ELEMENT FINDING ============
  function findTopics() {
    const selectors = [
      'a.title.raw-link.raw-topic-link',
      'tr.topic-list-item a.title',
      '.topic-list-item a.title',
      'a.title[data-topic-id]'
    ];
    
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      const valid = Array.from(els).filter(a => a.href?.includes('/t/'));
      if (valid.length > 0) return valid;
    }
    
    return Array.from(document.querySelectorAll('a[href*="/t/"]')).filter(a => {
      const rect = a.getBoundingClientRect();
      return rect.width > 50 && a.textContent.trim().length > 5;
    });
  }

  function findSuggestedTopics() {
    const els = document.querySelectorAll('.suggested-topics a[href*="/t/"]');
    return Array.from(els).filter(a => a.href?.includes('/t/'));
  }

})();
