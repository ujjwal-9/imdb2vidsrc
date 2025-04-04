document.addEventListener('DOMContentLoaded', initializePopup);

// Default settings
const DEFAULT_SETTINGS = {
  baseUrl: 'vidsrc.icu'
};

// Global settings object
let settings = { ...DEFAULT_SETTINGS };

// Main initialization function
function initializePopup() {
  setupTabs();
  setupUI();
  loadSettings().then(() => {
    processCurrentTab();
  });
}

// Set up tab functionality
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs and content
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      // Add active class to clicked tab
      tab.classList.add('active');
      
      // Show corresponding content
      const tabName = tab.getAttribute('data-tab');
      document.getElementById(`${tabName}-tab`).classList.add('active');
    });
  });
}

// Set up the UI components
function setupUI() {
  // Main tab event listeners
  document.getElementById('watch-button').addEventListener('click', handleWatchClick);
  document.getElementById('imdb-button').addEventListener('click', handleImdbClick);
  
  // Settings tab event listeners
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('reset-settings').addEventListener('click', resetSettings);
  
  // Set up number input defaults and constraints
  setupNumberInputs();
}

// Load settings from storage
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => {
      if (data.settings) {
        settings = { ...DEFAULT_SETTINGS, ...data.settings };
      }
      
      // Update UI with loaded settings
      document.getElementById('base-url').value = settings.baseUrl;
      
      resolve();
    });
  });
}

// Save settings to storage
function saveSettings() {
  const baseUrl = document.getElementById('base-url').value.trim();
  
  // Validate URL (basic validation)
  if (!baseUrl) {
    showSettingsError('Base URL cannot be empty');
    return;
  }
  
  // Remove protocol if included
  const cleanUrl = baseUrl.replace(/^https?:\/\//, '');
  
  // Store settings
  settings.baseUrl = cleanUrl;
  chrome.storage.local.set({ settings }, () => {
    // Show success message
    const savedMsg = document.querySelector('.settings-saved');
    savedMsg.classList.add('show');
    
    // Hide after 2 seconds
    setTimeout(() => {
      savedMsg.classList.remove('show');
    }, 2000);
  });
}

// Reset settings to default
function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  document.getElementById('base-url').value = settings.baseUrl;
  
  chrome.storage.local.set({ settings }, () => {
    // Show success message
    const savedMsg = document.querySelector('.settings-saved');
    savedMsg.classList.add('show');
    savedMsg.textContent = 'Settings reset to default!';
    
    // Hide after 2 seconds
    setTimeout(() => {
      savedMsg.classList.remove('show');
      savedMsg.textContent = 'Settings saved!';
    }, 2000);
  });
}

// Show error in settings tab
function showSettingsError(message) {
  const savedMsg = document.querySelector('.settings-saved');
  savedMsg.textContent = message;
  savedMsg.style.color = 'red';
  savedMsg.classList.add('show');
  
  // Hide after 3 seconds
  setTimeout(() => {
    savedMsg.classList.remove('show');
    savedMsg.style.color = 'green';
    savedMsg.textContent = 'Settings saved!';
  }, 3000);
}

// Set up the number inputs with constraints
function setupNumberInputs() {
  // Season input
  const seasonInput = document.getElementById('season');
  seasonInput.min = 1;
  seasonInput.max = 100; // Reasonable upper limit
  seasonInput.value = 1;
  
  // Episode input
  const episodeInput = document.getElementById('episode');
  episodeInput.min = 1;
  episodeInput.max = 100; // Reasonable upper limit
  episodeInput.value = 1;
  
  // Add event listener to enforce integer values
  [seasonInput, episodeInput].forEach(input => {
    // Prevent non-numeric input
    input.addEventListener('input', function() {
      // Convert to integer and update value
      const intValue = parseInt(this.value) || 1;
      if (intValue < this.min) this.value = this.min;
      if (this.max && intValue > this.max) this.value = this.max;
    });
    
    // Prevent floating point values on blur
    input.addEventListener('blur', function() {
      this.value = parseInt(this.value) || 1;
    });
  });
}

// Process the current tab or stored IMDb ID
function processCurrentTab() {
  showLoading(true);
  
  // First check if we have a stored IMDb ID from a previous click
  chrome.storage.local.get(['lastClickedImdbId'], function(data) {
    if (data.lastClickedImdbId) {
      processImdbId(data.lastClickedImdbId);
      // Clear the stored ID after using it
      chrome.storage.local.remove('lastClickedImdbId');
    } else {
      // Check the current tab
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        const currentTab = tabs[0];
        
        // Check if we're on a vidsrc page
        if (currentTab.url.includes('vidsrc.')) {
          processVidsrcPage(currentTab.url);
        } else {
          // Check if we're on an IMDb page
          const imdbId = extractImdbId(currentTab.url);
          
          if (imdbId) {
            processImdbId(imdbId);
          } else {
            // Not on a recognized page
            showNotOnRecognizedPage();
          }
        }
      });
    }
  });
}

// Process a vidsrc.icu page
function processVidsrcPage(url) {
  // Try to extract content info from the vidsrc URL
  let imdbId, contentType, season, episode;
  
  // Extract data from URL
  if (url.includes('/embed/movie/')) {
    // It's a movie
    const match = url.match(/\/embed\/movie\/(tt\d+)/);
    if (match) {
      imdbId = match[1];
      contentType = 'movie';
    }
  } else if (url.includes('/embed/tv/')) {
    // It's a TV series
    const match = url.match(/\/embed\/tv\/(tt\d+)\/(\d+)\/(\d+)/);
    if (match) {
      imdbId = match[1];
      season = parseInt(match[2]);
      episode = parseInt(match[3]);
      contentType = 'tv';
    }
  }
  
  if (!imdbId) {
    showError('Could not identify content from the vidsrc URL.');
    showLoading(false);
    return;
  }
  
  // Store content details
  chrome.storage.local.set({ 
    currentImdbId: imdbId,
    contentType: contentType
  });
  
  // If it's a TV series, set the season and episode inputs
  if (contentType === 'tv' && season && episode) {
    document.getElementById('season').value = season;
    document.getElementById('episode').value = episode;
  }
  
  // Get more details about the content from IMDb
  chrome.runtime.sendMessage({ 
    action: 'getContentDetails', 
    imdbId: imdbId 
  }, (response) => {
    showLoading(false);
    
    if (!response || response.error) {
      showError('Could not fetch content details.');
      return;
    }
    
    // Update the content info
    updateContentInfo(response);
    
    // Show the appropriate controls
    if (contentType === 'tv') {
      const watchButton = document.getElementById('watch-button');
      watchButton.textContent = 'Change Episode';
      showTvControls();
    } else {
      showMovieControls();
    }
  });
}

// Extract IMDb ID from URL
function extractImdbId(url) {
  const match = url.match(/imdb\.com\/title\/(tt\d+)/);
  return match ? match[1] : null;
}

// Process a specific IMDb ID
function processImdbId(imdbId) {
  // Store the IMDb ID for the watch button
  chrome.storage.local.set({ currentImdbId: imdbId });
  
  // Get the content details from the background script
  chrome.runtime.sendMessage({ 
    action: 'getContentDetails', 
    imdbId: imdbId 
  }, (response) => {
    // For movies, open directly without showing the popup
    if (response && response.type && response.type !== 'TVSeries' && response.type !== 'TVEpisode') {
      const vidsrcUrl = getVidsrcUrl('movie', imdbId);
      chrome.tabs.create({ url: vidsrcUrl });
      // Close the popup
      window.close();
      return;
    }
    
    // For TV shows, show the TV controls
    handleContentDetailsResponse(response);
  });
}

// Get properly formatted vidsrc URL based on settings
function getVidsrcUrl(type, imdbId, season = null, episode = null) {
  const baseUrl = settings.baseUrl;
  
  if (type === 'tv' && season !== null && episode !== null) {
    return `https://${baseUrl}/embed/tv/${imdbId}/${season}/${episode}`;
  } else {
    return `https://${baseUrl}/embed/movie/${imdbId}`;
  }
}

// Handle the response from getContentDetails
function handleContentDetailsResponse(response) {
  showLoading(false);
  
  if (!response || response.error) {
    showError(response?.error || 'Failed to detect content type. Please try again.');
    return;
  }
  
  // Update the content info
  updateContentInfo(response);
  
  // Show appropriate controls based on content type
  if (response.type === 'TVSeries' || response.type === 'TVEpisode') {
    showTvControls();
  } else {
    showMovieControls();
  }
}

// Update content info in the UI
function updateContentInfo(details) {
  const contentInfo = document.getElementById('content-info');
  contentInfo.classList.remove('hidden');
  document.getElementById('title').textContent = details.title || `IMDb ID: ${details.imdbId}`;
  document.getElementById('type').textContent = `Content Type: ${details.type}`;
}

// Show TV-specific controls
function showTvControls() {
  document.getElementById('tv-controls').classList.remove('hidden');
  chrome.storage.local.set({ contentType: 'tv' });
}

// Show movie-specific controls
function showMovieControls() {
  document.getElementById('movie-controls').classList.remove('hidden');
  chrome.storage.local.set({ contentType: 'movie' });
}

// Show not on recognized page message
function showNotOnRecognizedPage() {
  showLoading(false);
  const contentInfo = document.getElementById('content-info');
  contentInfo.classList.remove('hidden');
  document.getElementById('title').textContent = 'Not on a recognized page';
  document.getElementById('type').textContent = 'Navigate to an IMDb or Vidsrc page, or click a Watch button';
}

// Show or hide loading indicator
function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

// Show error message
function showError(message) {
  const errorElement = document.getElementById('error-message');
  errorElement.textContent = message || 'An error occurred';
  errorElement.classList.remove('hidden');
}

// Handle watch button click
function handleWatchClick() {
  chrome.storage.local.get(['currentImdbId', 'contentType'], function(data) {
    const imdbId = data.currentImdbId;
    const contentType = data.contentType;
    
    if (!imdbId) {
      showError('No IMDb ID found. Please navigate to an IMDb page.');
      return;
    }
    
    let vidsrcUrl;
    
    if (contentType === 'tv') {
      // Get values from number inputs
      const season = document.getElementById('season').value || 1;
      const episode = document.getElementById('episode').value || 1;
      vidsrcUrl = getVidsrcUrl('tv', imdbId, season, episode);
    } else {
      vidsrcUrl = getVidsrcUrl('movie', imdbId);
    }
    
    // Open the Vidsrc URL in a new tab if we're not already on Vidsrc,
    // otherwise update the current tab
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        // No active tab found, open in new tab
        chrome.tabs.create({ url: vidsrcUrl });
        return;
      }
      
      const currentTab = tabs[0];
      
      if (currentTab && currentTab.url && currentTab.url.includes('vidsrc.')) {
        // Update the current tab
        chrome.tabs.update(currentTab.id, { url: vidsrcUrl });
      } else {
        // Open in a new tab
        chrome.tabs.create({ url: vidsrcUrl });
      }
    });
  });
}

// Handle IMDb button click
function handleImdbClick() {
  chrome.storage.local.get(['currentImdbId'], function(data) {
    const imdbId = data.currentImdbId;
    
    if (!imdbId) {
      showError('No IMDb ID found.');
      return;
    }
    
    // Open the IMDb URL in a new tab
    const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
    chrome.tabs.create({ url: imdbUrl });
  });
} 