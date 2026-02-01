// Popup Script for AutoHangout

const toggleBtn = document.getElementById('toggleBtn');
const btnIcon = document.getElementById('btnIcon');
const btnText = document.getElementById('btnText');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const scrollSpeedInput = document.getElementById('scrollSpeed');
const scrollSpeedValue = document.getElementById('scrollSpeedValue');
const backProbabilityInput = document.getElementById('backProbability');
const backProbabilityValue = document.getElementById('backProbabilityValue');

let isRunning = false;

// Load saved state
chrome.storage.local.get(['isRunning', 'settings'], (data) => {
  isRunning = data.isRunning || false;
  updateUI();
  
  if (data.settings) {
    scrollSpeedInput.value = data.settings.scrollSpeed || 3;
    scrollSpeedValue.textContent = scrollSpeedInput.value;
    backProbabilityInput.value = data.settings.backProbability || 30;
    backProbabilityValue.textContent = backProbabilityInput.value;
  }
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
}

function getSettings() {
  return {
    scrollSpeed: parseInt(scrollSpeedInput.value),
    backProbability: parseInt(backProbabilityInput.value)
  };
}

function saveSettings() {
  const settings = getSettings();
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
  
  await chrome.storage.local.set({ isRunning, settings: getSettings() });
  updateUI();
  
  // Send message to content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, {
      action: isRunning ? 'start' : 'stop',
      settings: getSettings()
    }).catch(() => {});
  }
  
  // Notify background
  chrome.runtime.sendMessage({
    action: isRunning ? 'start' : 'stop',
    settings: getSettings()
  });
});

// Settings listeners
scrollSpeedInput.addEventListener('input', () => {
  scrollSpeedValue.textContent = scrollSpeedInput.value;
  saveSettings();
});

backProbabilityInput.addEventListener('input', () => {
  backProbabilityValue.textContent = backProbabilityInput.value;
  saveSettings();
});
