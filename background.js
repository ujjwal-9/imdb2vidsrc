// Pull in shared provider helpers (PRESET_PROVIDERS, DEFAULT_SETTINGS,
// buildProviderList, getProviderById, buildVidsrcUrl, loadSettingsAndProviders,
// loadProgress, recordProgress).
importScripts('providers.js');

// How long the popup will honour a "user clicked Watch on this title" handoff.
const LAST_CLICK_TTL_MS = 10 * 1000;

// JSON-LD @type values that identify an actual title (vs. BreadcrumbList etc.).
// TV_TYPES/isTvType live in providers.js so the popup shares them.
const TITLE_TYPES = new Set(['Movie', 'TVSeries', 'TVEpisode', 'TVMiniSeries', 'Series']);

// IMDB_TITLE_TYPE_TO_SCHEMA / schemaTypeFromImdbTypeId live in providers.js.

// Function to extract IMDB ID from URL
function extractImdbId(url) {
  const match = url.match(/\/title\/(tt\d+)/);
  return match ? match[1] : null;
}

// fromCharCode truncates anything above U+FFFF, mangling emoji and other
// astral-plane characters that show up in international titles.
function codePointToString(cp, original) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10FFFF) return original;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return original;
  }
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
    .replace(/&#(\d+);/g, (m, n) => codePointToString(parseInt(n, 10), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => codePointToString(parseInt(n, 16), m));
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

// JSON-LD allows @type to be an array ("@type": ["Movie", "CreativeWork"]).
// Collapse it to the most specific title type we recognise.
function normalizeJsonLdType(raw) {
  if (Array.isArray(raw)) {
    return raw.find(t => TITLE_TYPES.has(t)) || (typeof raw[0] === 'string' ? raw[0] : 'Movie');
  }
  return typeof raw === 'string' ? raw : 'Movie';
}

function isTitleType(raw) {
  if (Array.isArray(raw)) return raw.some(t => TITLE_TYPES.has(t));
  return typeof raw === 'string' && TITLE_TYPES.has(raw);
}

// JSON-LD is the primary signal, but it is markup IMDb has changed before, and
// when it goes missing every title silently falls back to "Movie". These are
// independent signals from the same page so one template change can't turn the
// whole extension into a movie-only tool.
function detectTypeFromHtml(html) {
  const og = /<meta[^>]+property=['"]og:type['"][^>]+content=['"]([^'"]+)['"]/i.exec(html)
    || /<meta[^>]+content=['"]([^'"]+)['"][^>]+property=['"]og:type['"]/i.exec(html);
  if (og) {
    const value = og[1].toLowerCase();
    if (value === 'video.tv_show') return 'TVSeries';
    if (value === 'video.episode') return 'TVEpisode';
    if (value === 'video.movie') return 'Movie';
  }

  const titleType = /"titleType":\s*\{[\s\S]{0,400}?"id":"([A-Za-z]+)"/.exec(html);
  const mapped = titleType && schemaTypeFromImdbTypeId(titleType[1]);
  if (mapped) return mapped;

  // Last resort: only series carry these.
  if (/"canHaveEpisodes":\s*true/.test(html)) return 'TVSeries';
  if (/"numberOfEpisodes"\s*:/.test(html)) return 'TVSeries';

  return null;
}

// Parent series for an episode page, when JSON-LD didn't supply partOfSeries.
function detectSeriesIdFromHtml(html) {
  const m = /"series":\s*\{[\s\S]{0,400}?"id":"(tt\d+)"/.exec(html);
  return m ? m[1] : null;
}

// Map nested IMDB JSON-LD into our flat content shape.
function mapJsonLdToResult(jsonData, imdbId) {
  const out = { imdbId, type: 'Movie', title: 'Unknown Title' };
  if (jsonData['@type']) out.type = normalizeJsonLdType(jsonData['@type']);
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

// Parse a fetched title page into our flat shape. `typeKnown` records whether
// the page actually stated a type, so callers can tell a genuine "Movie" apart
// from the default we fall back to when the page tells us nothing.
function parseTitlePage(html, imdbId) {
  let result = { imdbId, type: 'Movie', title: 'Unknown Title' };

  // IMDB pages contain multiple JSON-LD blocks (BreadcrumbList, the title
  // itself, sometimes ItemList). Iterate them all and prefer the one whose
  // @type is a recognised title. Allow extra attributes on the script tag.
  const ldRegex = /<script[^>]*type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi;
  let primary = null;
  let firstParsed = null;
  let m;
  while ((m = ldRegex.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    if (!firstParsed) firstParsed = data;
    if (data && isTitleType(data['@type'])) { primary = data; break; }
  }
  const chosen = primary || firstParsed;
  if (chosen) result = mapJsonLdToResult(chosen, imdbId);

  // Cross-check the type against signals that don't depend on JSON-LD.
  const htmlType = detectTypeFromHtml(html);
  if (htmlType) {
    if (!primary) {
      // No recognised JSON-LD title block at all — the page is all we have.
      result.type = htmlType;
    } else if (result.type === 'Movie' && isTvType(htmlType)) {
      // JSON-LD defaulted to Movie while the page says series. Trust the page,
      // otherwise the user gets no season/episode controls at all.
      result.type = htmlType;
    }
  }

  // An episode we only identified from the page still needs its parent series,
  // or the player URL would be built from the episode's own id.
  if (result.type === 'TVEpisode' && !result.partOfSeriesId) {
    const seriesId = detectSeriesIdFromHtml(html);
    if (seriesId && seriesId !== imdbId) result.partOfSeriesId = seriesId;
  }

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

  return { result, typeKnown: !!primary || !!htmlType };
}

async function fetchTitlePage(imdbId) {
  const response = await fetch(`https://www.imdb.com/title/${imdbId}/`);
  if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
  return parseTitlePage(await response.text(), imdbId);
}

// IMDb's suggestion endpoint accepts a title id and answers with the canonical
// type in a few hundred bytes. It is served from media-imdb.com, which keeps
// answering extension requests when www.imdb.com refuses them outright. That
// refusal is not hypothetical: when it happens the page scrape yields nothing
// and every single title would otherwise fall back to "Movie".
async function fetchSuggestion(imdbId) {
  try {
    const bucket = imdbId.charAt(0).toLowerCase();
    const url = `https://v2.sg.media-imdb.com/suggestion/${bucket}/${encodeURIComponent(imdbId)}.json`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const rows = data && Array.isArray(data.d) ? data.d : [];
    const match = rows.find(item => item && item.id === imdbId);
    if (!match) return null;
    return {
      type: schemaTypeFromImdbTypeId(match.qid),
      title: typeof match.l === 'string' && match.l.trim() ? decodeHtmlEntities(match.l).trim() : null,
      year: typeof match.y === 'number' ? match.y : null,
      poster: (match.i && typeof match.i.imageUrl === 'string') ? match.i.imageUrl : null
    };
  } catch {
    return null;
  }
}

// Fetch IMDb content details. For TVEpisode IDs, follow the parent series so
// callers get a single canonical "thing to watch" with episode context.
async function getContentDetails(imdbId, depth = 0) {
  // Two independent sources, in parallel so the extra call costs no latency.
  // The page is richer (rating, runtime, genres, episode context); the
  // suggestion endpoint is far more reliable about what the title actually is.
  const [page, suggestion] = await Promise.all([
    fetchTitlePage(imdbId).then(value => value, (e) => ({ error: e.message })),
    fetchSuggestion(imdbId)
  ]);

  const parsed = page && page.result ? page.result : null;

  if (!parsed && !suggestion) {
    return {
      imdbId,
      type: 'Movie',
      title: 'Unknown Title',
      error: (page && page.error) || 'Could not load title details'
    };
  }

  const result = parsed || { imdbId, type: 'Movie', title: 'Unknown Title' };

  if (suggestion) {
    // The suggestion endpoint is IMDb's own type index, so it settles the type.
    // The page is a regex parse of a large document that IMDb reshapes without
    // notice, which makes it the weaker source even when it does state a type.
    // The exception is an episode the page fully resolved: that carries a
    // parent series and season/episode numbers the suggestion has no way to
    // express, so it must not be flattened back to a bare type.
    const pageResolvedEpisode = result.type === 'TVEpisode' && !!result.partOfSeriesId;
    if (suggestion.type && !pageResolvedEpisode) result.type = suggestion.type;
    if (result.title === 'Unknown Title' && suggestion.title) result.title = suggestion.title;
    if (!result.year && suggestion.year) result.year = suggestion.year;
    if (!result.poster && suggestion.poster) result.poster = suggestion.poster;
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
}

// Cache for content details with expiration
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 300;
// Bump when a change alters the shape or correctness of cached details, so
// existing users aren't served stale results for up to a day. v2: titles
// misclassified as "Movie" before type detection stopped relying solely on
// JSON-LD. v3: types resolved via the suggestion endpoint, which fixes every
// title cached as "Movie" while www.imdb.com was refusing our fetches.
const CACHE_VERSION = 3;

const contentCache = {
  data: {},
  set(imdbId, details) {
    this.data[imdbId] = {
      details,
      timestamp: Date.now()
    };
    // Drop expired/overflow entries on every write so the persisted copy can't
    // grow without bound between service-worker starts.
    this.prune();
    chrome.storage.local.set({ contentCache: this.data, contentCacheVersion: CACHE_VERSION });
  },
  // Get if not expired (24 hours). Treat entries with a missing title as a
  // miss so users with stale "Unknown Title" cache get refreshed automatically.
  get(imdbId) {
    const entry = this.data[imdbId];
    if (!entry) return null;
    const expired = Date.now() - entry.timestamp > CACHE_TTL_MS;
    if (expired) return null;
    if (entry.details && entry.details.title === 'Unknown Title') return null;
    return entry.details;
  },
  prune() {
    const now = Date.now();
    for (const [imdbId, entry] of Object.entries(this.data)) {
      if (!entry || !entry.timestamp || now - entry.timestamp > CACHE_TTL_MS) {
        delete this.data[imdbId];
      }
    }
    const entries = Object.entries(this.data);
    if (entries.length > CACHE_LIMIT) {
      entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      this.data = Object.fromEntries(entries.slice(0, CACHE_LIMIT));
    }
  },
  // Initialize cache from storage, writing back the pruned copy.
  init() {
    chrome.storage.local.get(['contentCache', 'contentCacheVersion'], (result) => {
      if (result.contentCacheVersion !== CACHE_VERSION) {
        // Entries were written by an older, less accurate parser — drop them
        // rather than serving stale types for the next 24 hours.
        this.data = {};
        chrome.storage.local.set({ contentCache: {}, contentCacheVersion: CACHE_VERSION });
        return;
      }
      if (!result.contentCache) return;
      this.data = result.contentCache;
      const before = Object.keys(this.data).length;
      this.prune();
      if (Object.keys(this.data).length !== before) {
        chrome.storage.local.set({ contentCache: this.data, contentCacheVersion: CACHE_VERSION });
      }
    });
  }
};

// Initialize the cache
contentCache.init();

// Resolve details for an id, using the cache when possible.
async function resolveDetails(imdbId) {
  const cached = contentCache.get(imdbId);
  if (cached) return cached;
  const details = await getContentDetails(imdbId);
  contentCache.set(imdbId, details);
  return details;
}

// ---- Opening titles ----

// Build a URL using the user's currently configured default provider.
async function buildUrlFromSettings(type, imdbId, season, episode) {
  const { settings, providers } = await loadSettingsAndProviders();
  const provider = getProviderById(providers, settings.defaultProviderId);
  return buildVidsrcUrl(provider, type, imdbId, season, episode);
}

// Open a movie directly, and log it to history so it appears in the popup's
// "Continue watching" list.
async function openMovieDirect(imdbId, title) {
  try {
    const url = await buildUrlFromSettings('movie', imdbId);
    await recordProgress(imdbId, 'movie', title, null, null);
    chrome.tabs.create({ url });
  } catch (e) {
    // Last-resort fallback if settings can't be read.
    chrome.tabs.create({ url: `https://vidsrc.icu/embed/movie/${imdbId}` });
  }
}

// Open a series without the popup. Prefers the episode the user actually
// clicked, then their last watched episode, then S1E1.
async function openTvDirect(imdbId, title, episodeContext) {
  const progress = (await loadProgress())[imdbId];
  const season = (episodeContext && episodeContext.season) || (progress && progress.season) || 1;
  const episode = (episodeContext && episodeContext.episode) || (progress && progress.episode) || 1;
  try {
    const url = await buildUrlFromSettings('tv', imdbId, season, episode);
    await recordProgress(imdbId, 'tv', title, season, episode);
    chrome.tabs.create({ url });
  } catch (e) {
    chrome.tabs.create({ url: `https://vidsrc.icu/embed/tv/${imdbId}/${season}/${episode}` });
  }
}

// Hand the title off to the popup for season/episode selection. The stamp lets
// the popup ignore a stale handoff if openPopup() never actually took.
function stashLastClicked(imdbId) {
  return new Promise(r => chrome.storage.local.set({ lastClicked: { imdbId, at: Date.now() } }, r));
}

// chrome.action.openPopup() rejects when there is no gesture/active window.
// Surface that as a boolean instead of an unhandled rejection.
async function tryOpenPopup(imdbId) {
  await stashLastClicked(imdbId);
  try {
    await chrome.action.openPopup();
    return true;
  } catch (e) {
    // The handoff would otherwise linger and hijack the next popup open.
    await new Promise(r => chrome.storage.local.remove('lastClicked', r));
    return false;
  }
}

// Single entry point for "user asked to watch this IMDb id" — used by the
// content-script button and the context menu. TV opens the popup so the user
// can pick an episode; if that isn't possible we open the player directly
// rather than leaving the click dead.
async function handleWatchRequest(imdbId) {
  const details = await resolveDetails(imdbId);
  // For an episode id, getContentDetails resolves to the parent series.
  const targetId = (details && details.imdbId) || imdbId;
  const title = details && details.title;
  const episodeContext = (details && details.episodeContext) || null;

  if (!isTvType(details && details.type) && !episodeContext) {
    await openMovieDirect(targetId, title);
    return { ok: true, opened: 'movie' };
  }

  if (await tryOpenPopup(imdbId)) return { ok: true, opened: 'popup' };

  await openTvDirect(targetId, title, episodeContext);
  return { ok: true, opened: 'tv' };
}

// ---- Watchlist (chrome.storage.sync) ----
const WATCHLIST_LIMIT = 50;
// chrome.storage.sync rejects any single item larger than QUOTA_BYTES_PER_ITEM
// (8192 bytes, key included). Keep headroom so one long title can't tip a save
// over the edge mid-write.
const WATCHLIST_MAX_BYTES = 7500;

function watchlistBytes(list) {
  return new TextEncoder().encode('watchlist' + JSON.stringify(list)).length;
}

// Synced entries stay minimal. Poster URLs are long, were never rendered in
// the Saved list, and used to consume most of the per-item quota — which made
// the real ceiling roughly half the advertised WATCHLIST_LIMIT. Mapping the
// existing list through this on every write migrates old entries lazily.
function sanitizeEntry(entry) {
  return {
    imdbId: entry.imdbId,
    title: entry.title,
    type: entry.type,
    year: entry.year || null,
    addedAt: entry.addedAt || Date.now()
  };
}

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
  const list = (await loadWatchlist()).map(sanitizeEntry);
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

  const entry = sanitizeEntry({
    imdbId,
    title: details.title || `IMDb ${imdbId}`,
    type: isTvType(details.type) ? 'tv' : 'movie',
    year: details.year || null,
    addedAt: Date.now()
  });

  // Check before writing so the user gets a clear message instead of an
  // opaque QUOTA_BYTES_PER_ITEM failure from Chrome.
  const candidate = [entry, ...list];
  if (watchlistBytes(candidate) > WATCHLIST_MAX_BYTES) {
    return {
      saved: false,
      error: 'Watchlist is full (sync storage limit). Remove an item first.',
      count: list.length
    };
  }

  try {
    await saveWatchlist(candidate);
    return { saved: true, count: candidate.length, entry };
  } catch (e) {
    return { saved: false, error: e.message, count: list.length };
  }
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return;

  switch (message.action) {
    case 'watch':
      if (!message.imdbId) return;
      handleWatchRequest(message.imdbId)
        .then(sendResponse)
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'checkContentType':
      if (!message.imdbId) return;
      resolveDetails(message.imdbId)
        .then(details => sendResponse({ type: details.type }))
        .catch(() => sendResponse({ type: 'Movie' }));
      return true;

    case 'getContentDetails':
      if (!message.imdbId) return;
      resolveDetails(message.imdbId)
        .then(sendResponse)
        .catch(error => sendResponse({
          imdbId: message.imdbId,
          type: 'Movie',
          title: 'Unknown Title',
          error: error.message
        }));
      return true;

    case 'toggleWatchlist':
      if (!message.imdbId) return;
      toggleWatchlist(message.imdbId)
        .then(sendResponse)
        .catch(e => sendResponse({ saved: false, error: e.message }));
      return true;

    case 'getWatchlist':
      loadWatchlist()
        .then(list => sendResponse({ list }))
        .catch(() => sendResponse({ list: [] }));
      return true;

    // Batched form for content scripts: one round trip per page instead of
    // one per IMDb link.
    case 'getWatchlistIds':
      loadWatchlist()
        .then(list => sendResponse({ ids: list.map(e => e.imdbId) }))
        .catch(() => sendResponse({ ids: [] }));
      return true;

    case 'inWatchlist':
      if (!message.imdbId) return;
      loadWatchlist()
        .then(list => sendResponse({ saved: list.some(e => e.imdbId === message.imdbId) }))
        .catch(() => sendResponse({ saved: false }));
      return true;

    default:
      return;
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

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "openInVidsrc") return;
  const imdbId = extractImdbId(info.linkUrl);
  if (!imdbId) return;
  handleWatchRequest(imdbId).catch(() => openMovieDirect(imdbId, null));
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
