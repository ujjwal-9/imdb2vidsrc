// Pull in shared provider helpers (PRESET_PROVIDERS, DEFAULT_SETTINGS,
// buildProviderList, getProviderById, buildVidsrcUrl, loadSettingsAndProviders).
importScripts('providers.js');

// Function to extract IMDB ID from URL
function extractImdbId(url) {
  const match = url.match(/\/title\/(tt\d+)/);
  return match ? match[1] : null;
}

// Persist watch history when a title is opened via the context menu.
async function recordProgress(imdbId, type, title, season, episode) {
  const data = await new Promise(r => chrome.storage.local.get('progress', r));
  const progress = data.progress || {};
  progress[imdbId] = {
    imdbId, type, title: title || `IMDb ${imdbId}`,
    season: season || null,
    episode: episode || null,
    timestamp: Date.now()
  };
  return new Promise(r => chrome.storage.local.set({ progress }, r));
}

// Build a movie URL using the user's currently configured default provider.
async function buildMovieUrlFromSettings(imdbId) {
  const { settings, providers } = await loadSettingsAndProviders();
  const provider = getProviderById(providers, settings.defaultProviderId);
  return buildVidsrcUrl(provider, 'movie', imdbId);
}

// Function to fetch IMDb content details (type and title) in a single request
async function getContentDetails(imdbId) {
  try {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    
    const html = await response.text();
    
    // Extract data from HTML
    const result = {
      imdbId,
      type: 'Movie', // Default
      title: 'Unknown Title'
    };
    
    // Extract title
    const titleMatch = html.match(/<title>(.*?) - IMDb<\/title>/);
    if (titleMatch && titleMatch[1]) {
      result.title = titleMatch[1];
    }
    
    // Extract content type from JSON-LD
    const ldJsonRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/;
    const match = ldJsonRegex.exec(html);
    
    if (match) {
      try {
        const jsonData = JSON.parse(match[1].trim());
        result.type = jsonData['@type'] || 'Movie';
      } catch (parseError) {
        // JSON parse error, keep default type
      }
    }
    
    return result;
  } catch (error) {
    // Return default values on error
    return {
      imdbId,
      type: 'Movie',
      title: 'Unknown Title',
      error: error.message
    };
  }
}

// Cache for content details with expiration
const contentCache = {
  data: {},
  // Store with 24-hour expiration
  set(imdbId, details) {
    this.data[imdbId] = {
      details,
      timestamp: Date.now()
    };
    // Persist cache to storage for use across sessions
    chrome.storage.local.set({ contentCache: this.data });
  },
  // Get if not expired (24 hours)
  get(imdbId) {
    const entry = this.data[imdbId];
    if (!entry) return null;
    
    // Check if cache entry is older than 24 hours
    const expired = Date.now() - entry.timestamp > 24 * 60 * 60 * 1000;
    return expired ? null : entry.details;
  },
  // Initialize cache from storage
  init() {
    chrome.storage.local.get('contentCache', (result) => {
      if (result.contentCache) {
        this.data = result.contentCache;
        
        // Clean expired entries
        const now = Date.now();
        for (const [imdbId, entry] of Object.entries(this.data)) {
          if (now - entry.timestamp > 24 * 60 * 60 * 1000) {
            delete this.data[imdbId];
          }
        }
      }
    });
  }
};

// Initialize the cache
contentCache.init();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle content type check request
  if (message.action === 'checkContentType' && message.imdbId) {
    const cachedDetails = contentCache.get(message.imdbId);
    
    if (cachedDetails) {
      sendResponse({ type: cachedDetails.type });
      return true;
    }
    
    getContentDetails(message.imdbId)
      .then(details => {
        contentCache.set(message.imdbId, details);
        sendResponse({ type: details.type });
      })
      .catch(() => {
        sendResponse({ type: 'Movie' });
      });
    
    return true; // Required to use sendResponse asynchronously
  }
  
  // Handle popup open request
  if (message.action === 'openPopup') {
    chrome.action.openPopup();
    return true;
  }
  
  // Handle content details request
  if (message.action === 'getContentDetails' && message.imdbId) {
    const imdbId = message.imdbId;
    const cachedDetails = contentCache.get(imdbId);
    
    if (cachedDetails) {
      sendResponse(cachedDetails);
      return true;
    }
    
    getContentDetails(imdbId)
      .then(details => {
        contentCache.set(imdbId, details);
        sendResponse(details);
      })
      .catch(error => {
        const defaultDetails = {
          imdbId,
          type: 'Movie',
          title: 'Unknown Title',
          error: error.message
        };
        sendResponse(defaultDetails);
      });
    
    return true;
  }
});

// Create context menu when extension is installed
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "openInVidsrc",
    title: "Open in Vidsrc",
    contexts: ["link"],
    targetUrlPatterns: ["*://*.imdb.com/title/*"]
  });
});

// Open a movie directly using the user's configured default provider, and
// log it to history so it appears in the popup's "Continue watching" list.
async function openMovieDirect(imdbId, title) {
  try {
    const url = await buildMovieUrlFromSettings(imdbId);
    recordProgress(imdbId, 'movie', title, null, null);
    chrome.tabs.create({ url });
  } catch (e) {
    // Last-resort fallback if settings can't be read.
    chrome.tabs.create({ url: `https://vidsrc.icu/embed/movie/${imdbId}` });
  }
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "openInVidsrc") return;

  const imdbId = extractImdbId(info.linkUrl);
  if (!imdbId) return;

  const handle = (details) => {
    if (details && (details.type === 'TVSeries' || details.type === 'TVEpisode')) {
      // TV: open popup for season/episode selection.
      chrome.storage.local.set({ lastClickedImdbId: imdbId }, () => {
        chrome.action.openPopup();
      });
    } else {
      openMovieDirect(imdbId, details && details.title);
    }
  };

  const cached = contentCache.get(imdbId);
  if (cached) return handle(cached);

  getContentDetails(imdbId)
    .then(details => { contentCache.set(imdbId, details); handle(details); })
    .catch(() => openMovieDirect(imdbId, null));
}); 