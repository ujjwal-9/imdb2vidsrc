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

// Decode the small set of HTML entities IMDB titles tend to use.
function decodeHtmlEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// Convert ISO 8601 duration ("PT2H13M") into a friendly "2h 13m".
function formatRuntime(iso) {
  if (typeof iso !== 'string') return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  const h = +m[1] || 0;
  const min = +m[2] || 0;
  if (!h && !min) return null;
  return h ? `${h}h${min ? ` ${min}m` : ''}` : `${min}m`;
}

function extractYear(jsonData) {
  if (jsonData.datePublished && typeof jsonData.datePublished === 'string') {
    const m = jsonData.datePublished.match(/(\d{4})/);
    if (m) return +m[1];
  }
  return null;
}

// Map nested IMDB JSON-LD into our flat content shape.
function mapJsonLdToResult(jsonData, imdbId) {
  const out = { imdbId, type: 'Movie', title: 'Unknown Title' };
  if (jsonData['@type']) out.type = jsonData['@type'];
  const nameField = jsonData.name;
  if (typeof nameField === 'string' && nameField.trim()) {
    out.title = decodeHtmlEntities(nameField).trim();
  } else if (nameField && typeof nameField === 'object' && typeof nameField.name === 'string') {
    out.title = decodeHtmlEntities(nameField.name).trim();
  }
  if (typeof jsonData.image === 'string') out.poster = jsonData.image;
  const year = extractYear(jsonData);
  if (year) out.year = year;
  if (jsonData.aggregateRating && jsonData.aggregateRating.ratingValue != null) {
    out.rating = +jsonData.aggregateRating.ratingValue;
    if (jsonData.aggregateRating.ratingCount != null) out.ratingCount = +jsonData.aggregateRating.ratingCount;
  }
  const runtime = formatRuntime(jsonData.duration);
  if (runtime) out.runtime = runtime;
  if (Array.isArray(jsonData.genre)) out.genres = jsonData.genre.slice(0, 4);
  else if (typeof jsonData.genre === 'string') out.genres = [jsonData.genre];

  // Episode-level fields (used when @type === 'TVEpisode').
  if (jsonData.partOfSeries && typeof jsonData.partOfSeries.url === 'string') {
    const seriesIdMatch = jsonData.partOfSeries.url.match(/(tt\d+)/);
    if (seriesIdMatch) out.partOfSeriesId = seriesIdMatch[1];
    if (typeof jsonData.partOfSeries.name === 'string') out.partOfSeriesName = decodeHtmlEntities(jsonData.partOfSeries.name);
  }
  if (jsonData.partOfSeason && jsonData.partOfSeason.seasonNumber != null) {
    out.season = +jsonData.partOfSeason.seasonNumber;
  }
  if (jsonData.episodeNumber != null) {
    out.episode = +jsonData.episodeNumber;
  }
  return out;
}

// Fetch IMDb content details. For TVEpisode IDs, follow the parent series so
// callers get a single canonical "thing to watch" with episode context.
async function getContentDetails(imdbId, depth = 0) {
  try {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const html = await response.text();

    let result = { imdbId, type: 'Movie', title: 'Unknown Title' };

    // IMDB pages contain multiple JSON-LD blocks (BreadcrumbList, the title
    // itself, sometimes ItemList). Iterate them all and prefer the one whose
    // @type is a recognised title. Allow extra attributes on the script tag.
    const ldRegex = /<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
    const TITLE_TYPES = new Set(['Movie', 'TVSeries', 'TVEpisode', 'TVMiniSeries', 'Series']);
    let primary = null;
    let firstParsed = null;
    let m;
    while ((m = ldRegex.exec(html))) {
      let data;
      try { data = JSON.parse(m[1].trim()); } catch { continue; }
      if (!firstParsed) firstParsed = data;
      if (data && TITLE_TYPES.has(data['@type'])) { primary = data; break; }
    }
    const chosen = primary || firstParsed;
    if (chosen) result = mapJsonLdToResult(chosen, imdbId);

    // Title tag fallback (allow attributes on <title>, e.g. data-rh="true").
    if (result.title === 'Unknown Title') {
      const tagMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      if (tagMatch && tagMatch[1]) {
        result.title = decodeHtmlEntities(tagMatch[1])
          .replace(/\s*[-|–—]\s*IMDb\s*$/i, '')
          .trim() || 'Unknown Title';
      }
    }

    // og:title fallback for the rare case both above miss.
    if (result.title === 'Unknown Title') {
      const og = /<meta\s+(?:property|name)=['"]og:title['"]\s+content=['"]([^'"]*)['"]/i.exec(html);
      if (og && og[1]) {
        result.title = decodeHtmlEntities(og[1])
          .replace(/\s*[-|–—]\s*IMDb\s*$/i, '')
          .trim() || 'Unknown Title';
      }
    }

    // If the requested id is an episode, hand back the parent series with the
    // episode pre-filled. Bounded recursion: a series can't itself be an episode.
    if (depth < 1 && result.type === 'TVEpisode' && result.partOfSeriesId) {
      const series = await getContentDetails(result.partOfSeriesId, depth + 1);
      return {
        ...series,
        episodeContext: {
          season: result.season || null,
          episode: result.episode || null,
          episodeTitle: result.title,
          episodeId: imdbId
        }
      };
    }

    return result;
  } catch (error) {
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
  // Get if not expired (24 hours). Treat entries with a missing title as a
  // miss so users with stale "Unknown Title" cache get refreshed automatically.
  get(imdbId) {
    const entry = this.data[imdbId];
    if (!entry) return null;
    const expired = Date.now() - entry.timestamp > 24 * 60 * 60 * 1000;
    if (expired) return null;
    if (entry.details && entry.details.title === 'Unknown Title') return null;
    return entry.details;
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

// ---- Watchlist (chrome.storage.sync) ----
const WATCHLIST_LIMIT = 50;

async function loadWatchlist() {
  const data = await new Promise(r => chrome.storage.sync.get('watchlist', r));
  return Array.isArray(data.watchlist) ? data.watchlist : [];
}

async function saveWatchlist(list) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ watchlist: list }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

async function toggleWatchlist(imdbId) {
  const list = await loadWatchlist();
  const idx = list.findIndex(e => e.imdbId === imdbId);
  if (idx >= 0) {
    list.splice(idx, 1);
    await saveWatchlist(list);
    return { saved: false, count: list.length };
  }
  if (list.length >= WATCHLIST_LIMIT) {
    return {
      saved: false,
      error: `Watchlist limit (${WATCHLIST_LIMIT}) reached. Remove an item first.`,
      count: list.length
    };
  }

  let details = contentCache.get(imdbId);
  if (!details) {
    try {
      details = await getContentDetails(imdbId);
      contentCache.set(imdbId, details);
    } catch {
      details = { imdbId, type: 'Movie', title: `IMDb ${imdbId}` };
    }
  }

  const entry = {
    imdbId,
    title: details.title || `IMDb ${imdbId}`,
    type: (details.type === 'TVSeries' || details.type === 'TVEpisode') ? 'tv' : 'movie',
    year: details.year || null,
    poster: details.poster || null,
    addedAt: Date.now()
  };
  list.unshift(entry);
  try {
    await saveWatchlist(list);
    return { saved: true, count: list.length, entry };
  } catch (e) {
    return { saved: false, error: e.message, count: list.length - 1 };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'toggleWatchlist' && message.imdbId) {
    toggleWatchlist(message.imdbId).then(sendResponse);
    return true;
  }
  if (message.action === 'getWatchlist') {
    loadWatchlist().then(list => sendResponse({ list }));
    return true;
  }
  if (message.action === 'inWatchlist' && message.imdbId) {
    loadWatchlist().then(list =>
      sendResponse({ saved: list.some(e => e.imdbId === message.imdbId) })
    );
    return true;
  }
});

// ---- Keyboard shortcuts ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'next-episode' || command === 'prev-episode') {
    const [tab] = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tab || !tab.url) return;
    const parsed = parseProviderUrl(tab.url);
    if (!parsed || parsed.type !== 'tv') return;

    const delta = command === 'next-episode' ? 1 : -1;
    const newEpisode = Math.max(1, parsed.episode + delta);
    if (newEpisode === parsed.episode) return;

    const { settings, providers } = await loadSettingsAndProviders();
    const current = findProviderByUrl(providers, tab.url) || getProviderById(providers, settings.defaultProviderId);
    const url = buildVidsrcUrl(current, 'tv', parsed.imdbId, parsed.season, newEpisode);
    chrome.tabs.update(tab.id, { url });

    const cached = contentCache.get(parsed.imdbId);
    recordProgress(parsed.imdbId, 'tv', (cached && cached.title) || `IMDb ${parsed.imdbId}`, parsed.season, newEpisode);
    return;
  }

  if (command === 'switch-provider') {
    const [tab] = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
    if (!tab || !tab.url) return;
    const parsed = parseProviderUrl(tab.url);
    if (!parsed) return;

    const { settings, providers } = await loadSettingsAndProviders();
    const enabled = providers.filter(p => settings.enabledProviderIds.includes(p.id));
    if (enabled.length === 0) return;

    const current = findProviderByUrl(providers, tab.url);
    let nextIdx = 0;
    if (current) {
      const i = enabled.findIndex(p => p.id === current.id);
      nextIdx = (i + 1) % enabled.length;
    }
    const next = enabled[nextIdx];
    const url = buildVidsrcUrl(next, parsed.type, parsed.imdbId, parsed.season, parsed.episode);
    chrome.tabs.update(tab.id, { url });
  }
}); 