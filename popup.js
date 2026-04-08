// Popup Script for AutoHangout

const toggleBtn = document.getElementById('toggleBtn');
const btnIcon = document.getElementById('btnIcon');
const btnText = document.getElementById('btnText');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const scrollSpeedInput = document.getElementById('scrollSpeed');
const scrollSpeedValue = document.getElementById('scrollSpeedValue');
const readModeInput = document.getElementById('readMode');
const currentTopicAfterFinishGroup = document.getElementById('currentTopicAfterFinishGroup');
const currentTopicAfterFinishInput = document.getElementById('currentTopicAfterFinish');

let isRunning = false;
let currentSettings = {
  scrollSpeed: 3,
  readMode: 'random',
  currentTopicAfterFinish: 'continueRandom'
};

// Load saved state
chrome.storage.local.get(['isRunning', 'settings'], (data) => {
  isRunning = data.isRunning || false;
  
  if (data.settings) {
    currentSettings = { ...currentSettings, ...data.settings };
  }

  scrollSpeedInput.value = currentSettings.scrollSpeed || 3;
  scrollSpeedValue.textContent = scrollSpeedInput.value;
  readModeInput.value = currentSettings.readMode || 'random';
  currentTopicAfterFinishInput.value = currentSettings.currentTopicAfterFinish || 'continueRandom';
  updateUI();
});

function updateUI() {
  if (isRunning) {
    toggleBtn.classList.add('running');
    btnIcon.textContent = '⏸';
    btnText.textContent = '停止浏览';
    statusIndicator.classList.add('active');
    statusText.textContent = '运行中';
  } else {
    toggleBtn.classList.remove('running');
    btnIcon.textContent = '▶';
    btnText.textContent = '开始浏览';
    statusIndicator.classList.remove('active');
    statusText.textContent = '已停止';
  }

  currentTopicAfterFinishGroup.hidden = readModeInput.value !== 'currentTopic';
}

function getSettings() {
  return {
    scrollSpeed: parseInt(scrollSpeedInput.value, 10),
    readMode: readModeInput.value,
    currentTopicAfterFinish: currentTopicAfterFinishInput.value
  };
}

function saveSettings() {
  const settings = getSettings();
  currentSettings = settings;
  chrome.storage.local.set({ settings });
  
  // Notify content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'updateSettings',
        settings: settings
      }).catch(() => {});
    }
  });
}

// Toggle button
toggleBtn.addEventListener('click', async () => {
  isRunning = !isRunning;
  currentSettings = getSettings();
  
  await chrome.storage.local.set({ isRunning, settings: currentSettings });
  updateUI();
  
  // Send message to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, {
      action: isRunning ? 'start' : 'stop',
      settings: currentSettings
    }).catch(() => {});
  }
  
  // Notify background
  chrome.runtime.sendMessage({
    action: isRunning ? 'start' : 'stop',
    settings: currentSettings,
    tabId: tab?.id,
    tabUrl: tab?.url
  });
});

// Settings listeners
scrollSpeedInput.addEventListener('input', () => {
  scrollSpeedValue.textContent = scrollSpeedInput.value;
  saveSettings();
});

readModeInput.addEventListener('change', () => {
  updateUI();
  saveSettings();
});

currentTopicAfterFinishInput.addEventListener('change', () => {
  saveSettings();
});
