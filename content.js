// AutoHangout Content Script
// Human-like browsing for linux.do (Discourse)
// v5.0 - Background running support

(function() {
  'use strict';

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
  
  let settings = {
    scrollSpeed: 3,
    backProbability: 30
  };

  const DEBUG = true;
  
  function log(...args) {
    if (DEBUG) console.log('[AutoHangout]', ...args);
  }

  log('=== Script loaded ===', window.location.pathname);

  // Notify background that we're ready
  chrome.runtime.sendMessage({ action: 'tabReady' }).catch(() => {});

  // ============ MESSAGE HANDLING ============
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    log('Message:', message.action);
    
    if (message.action === 'start') {
      if (message.settings) settings = message.settings;
      start();
    } else if (message.action === 'stop') {
      stop();
    } else if (message.action === 'updateSettings') {
      if (message.settings) settings = message.settings;
    } else if (message.action === 'heartbeat') {
      if (message.settings) settings = message.settings;
      // Heartbeat from background - ensure we're still running
      if (!isRunning) {
        start();
      } else {
        // Check if we've been idle too long (stuck)
        const idleTime = Date.now() - lastActivityTime;
        if (idleTime > 30000) {
          log('Idle for too long, restarting behavior');
          restartBehavior();
        }
      }
    }
    
    sendResponse({ success: true });
    return true;
  });

  // Listen for background scroll trigger (for inactive tabs)
  window.addEventListener('autoHangout-triggerScroll', () => {
    if (isRunning) {
      log('Background trigger received');
      doSingleScroll();
    }
  });

  // Handle visibility change (when tab becomes hidden/visible)
  document.addEventListener('visibilitychange', () => {
    log('Visibility:', document.visibilityState);
    if (document.visibilityState === 'visible' && isRunning) {
      // Tab became visible again, ensure we're running
      restartBehavior();
    }
  });

  // Auto-start from storage
  chrome.storage.local.get(['isRunning', 'settings'], (data) => {
    if (data.settings) settings = data.settings;
    if (data.isRunning) start();
  });

  function start() {
    if (isRunning) return;
    
    isRunning = true;
    window.__autoHangoutRunning = true;
    scrollCount = 0;
    stuckCount = 0;
    lastProgress = 0;
    lastActivityTime = Date.now();
    topicInfo = null;
    
    const pageType = getPageType();
    log('Starting, page:', pageType);
    
    setTimeout(() => {
      if (!isRunning) return;
      
      if (pageType === 'topic') {
        topicInfo = getTopicProgress();
        log('Topic info:', topicInfo);
        doTopicBehavior();
      } else {
        doListBehavior();
      }
    }, 2000);
  }

  function stop() {
    isRunning = false;
    window.__autoHangoutRunning = false;
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    log('Stopped');
  }

  function restartBehavior() {
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    lastActivityTime = Date.now();
    
    const pageType = getPageType();
    log('Restarting behavior for:', pageType);
    
    if (pageType === 'topic') {
      doTopicBehavior();
    } else {
      doListBehavior();
    }
  }

  function getPageType() {
    const path = window.location.pathname;
    if (/^\/t\/[^/]+\/\d+/.test(path)) return 'topic';
    return 'list';
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
    
    // Long topic (>= 50): must read 90%
    if (total >= 50) {
      if (readPercent >= 90) {
        log('Long topic: read 90%+, exiting');
        return true;
      }
      if (stuckCount >= 20 && readPercent >= 70) {
        log('Long topic: stuck, seems finished');
        return true;
      }
      return false;
    }
    
    // Medium topic (20-49): must read 80%
    if (total >= 20) {
      if (readPercent >= 80) {
        log('Medium topic: read 80%+, exiting');
        return true;
      }
      if (stuckCount >= 15 && readPercent >= 60) {
        log('Medium topic: stuck, seems finished');
        return true;
      }
      return false;
    }
    
    // Short topic (< 20): after 50%, probability exit
    if (readPercent >= 50) {
      const roll = Math.random() * 100;
      const shouldExit = roll < settings.backProbability;
      log(`Short topic: roll=${roll.toFixed(0)}, exit=${shouldExit}`);
      return shouldExit;
    }
    
    if (stuckCount >= 10 && scrollCount >= 15) {
      log('Short topic: stuck, exiting');
      return true;
    }
    
    return false;
  }

  // ============ TOPIC BEHAVIOR ============
  function doTopicBehavior() {
    if (!isRunning) return;
    
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

  // Single scroll action (can be triggered by background)
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
    
    lastActivityTime = Date.now();
    log('On list, looking for topics...');
    
    setTimeout(() => {
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
  function leaveCurrentTopic() {
    clearTimeout(scrollTimeout);
    clearTimeout(actionTimeout);
    
    const progress = topicInfo || { current: 0, total: 0 };
    log(`Leaving topic (read ${progress.current}/${progress.total})`);
    
    setTimeout(() => {
      if (!isRunning) return;
      
      const roll = Math.random() * 100;
      
      if (roll < settings.backProbability) {
        log('Going home');
        window.location.href = window.location.origin + '/';
      } else {
        const suggested = findSuggestedTopics();
        if (suggested.length > 0) {
          const idx = Math.floor(Math.random() * Math.min(suggested.length, 5));
          log('Going to suggested topic');
          window.location.href = suggested[idx].href;
        } else {
          log('No suggested, going home');
          window.location.href = window.location.origin + '/';
        }
      }
    }, 3000 + Math.random() * 3000);
  }

  function clickTopic(topics) {
    if (!isRunning || topics.length === 0) return;
    
    const visible = topics.filter(t => {
      const rect = t.getBoundingClientRect();
      return rect.top > 80 && rect.bottom < window.innerHeight - 80;
    });
    
    const pool = visible.length > 0 ? visible : topics;
    const topic = pool[Math.floor(Math.random() * pool.length)];
    
    log('Clicking:', topic.textContent.trim().substring(0, 50));
    
    topic.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    setTimeout(() => {
      if (!isRunning) return;
      if (topic.href) window.location.href = topic.href;
    }, 1000 + Math.random() * 1000);
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
