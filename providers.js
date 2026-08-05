// Shared provider registry and storage helpers. Loaded by popup.js (via
// <script>) and by background.js (via importScripts in the service worker).
//
// Each provider has a movie template and a tv template. Templates use
// {imdb}, {season}, and {episode} placeholders.

const PRESET_PROVIDERS = [
  {
    id: 'vidsrc-icu',
    name: 'vidsrc.icu',
    movie: 'https://vidsrc.icu/embed/movie/{imdb}',
    tv: 'https://vidsrc.icu/embed/tv/{imdb}/{season}/{episode}'
  },
  {
    id: 'vidsrc-to',
    name: 'vidsrc.to',
    movie: 'https://vidsrc.to/embed/movie/{imdb}',
    tv: 'https://vidsrc.to/embed/tv/{imdb}/{season}/{episode}'
  },
  {
    id: 'vidsrc-xyz',
    name: 'vidsrc.xyz',
    movie: 'https://vidsrc.xyz/embed/movie?imdb={imdb}',
    tv: 'https://vidsrc.xyz/embed/tv?imdb={imdb}&season={season}&episode={episode}'
  },
  {
    id: 'embed-su',
    name: 'embed.su',
    movie: 'https://embed.su/embed/movie/{imdb}',
    tv: 'https://embed.su/embed/tv/{imdb}/{season}/{episode}'
  },
  {
    id: '2embed',
    name: '2embed.cc',
    movie: 'https://www.2embed.cc/embed/{imdb}',
    tv: 'https://www.2embed.cc/embedtv/{imdb}&s={season}&e={episode}'
  },
  {
    id: 'autoembed',
    name: 'autoembed',
    movie: 'https://player.autoembed.cc/embed/movie/{imdb}',
    tv: 'https://player.autoembed.cc/embed/tv/{imdb}/{season}/{episode}'
  },
  {
    id: 'multiembed',
    name: 'multiembed',
    movie: 'https://multiembed.mov/?video_id={imdb}',
    tv: 'https://multiembed.mov/?video_id={imdb}&s={season}&e={episode}'
  }
];

const DEFAULT_SETTINGS = {
  baseUrl: 'vidsrc.icu',
  defaultProviderId: 'vidsrc-icu',
  enabledProviderIds: ['vidsrc-icu', 'vidsrc-to', 'embed-su', '2embed', 'multiembed']
};

// Keep watch history bounded; the History tab renders every entry.
const PROGRESS_LIMIT = 100;

// schema.org @type values that mean "this has seasons and episodes". Shared so
// the popup and the service worker can never disagree about what a TV title is
// — they used to, and mini-series were classified as movies in the popup.
const TV_TYPES = new Set(['TVSeries', 'TVEpisode', 'TVMiniSeries', 'Series']);

function isTvType(type) {
  return typeof type === 'string' && TV_TYPES.has(type);
}

// IMDb's own title-type ids. These appear both as `qid` in the suggestion API
// and as titleType.id in a title page's embedded payload, so the mapping is
// shared rather than duplicated per call site.
const IMDB_TITLE_TYPE_TO_SCHEMA = {
  movie: 'Movie',
  short: 'Movie',
  tvMovie: 'Movie',
  tvSpecial: 'Movie',
  tvShort: 'Movie',
  video: 'Movie',
  musicVideo: 'Movie',
  documentary: 'Movie',
  videoGame: 'Movie',
  tvSeries: 'TVSeries',
  tvMiniSeries: 'TVMiniSeries',
  tvEpisode: 'TVEpisode'
};

// Note tvMovie/tvSpecial/tvShort are films despite the "tv" prefix — a
// startsWith('tv') test gets those wrong.
function schemaTypeFromImdbTypeId(id) {
  if (typeof id !== 'string') return null;
  return IMDB_TITLE_TYPE_TO_SCHEMA[id] || null;
}

// Human-readable form for the popup, so the detected type is visible.
function titleTypeLabel(type) {
  switch (type) {
    case 'TVSeries': return 'TV Series';
    case 'TVMiniSeries': return 'TV Mini-Series';
    case 'TVEpisode': return 'TV Episode';
    case 'Series': return 'Series';
    case 'Movie': return 'Movie';
    default: return type || 'Unknown';
  }
}

// Accept "https://vidsrc.icu/foo?x=1" and hand back "vidsrc.icu". Returns null
// for anything that isn't a plausible hostname, so callers can reject it
// instead of silently building broken player URLs.
function normalizeBaseUrl(input) {
  if (typeof input !== 'string') return null;
  const host = input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')  // scheme
    .replace(/^[^/@]*@/, '')                   // userinfo
    .replace(/[/?#].*$/, '')                   // path, query, fragment
    .toLowerCase();
  if (!host) return null;
  // label(.label)+ with an optional :port — no spaces, no bare single labels.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(host)) {
    return null;
  }
  return host;
}

// Build the full provider list visible to the user, including a
// "custom" entry derived from settings.baseUrl so legacy users keep
// their saved host.
function buildProviderList(settings) {
  const baseUrl = normalizeBaseUrl(settings && settings.baseUrl) || DEFAULT_SETTINGS.baseUrl;
  const customProvider = {
    id: 'custom',
    name: `Custom (${baseUrl})`,
    movie: `https://${baseUrl}/embed/movie/{imdb}`,
    tv: `https://${baseUrl}/embed/tv/{imdb}/{season}/{episode}`
  };
  return [...PRESET_PROVIDERS, customProvider];
}

function getProviderById(providers, id) {
  return providers.find(p => p.id === id) || providers[0];
}

function buildVidsrcUrl(provider, type, imdbId, season, episode) {
  const template = type === 'tv' ? provider.tv : provider.movie;
  return template
    .replaceAll('{imdb}', imdbId)
    .replaceAll('{season}', season != null ? String(season) : '')
    .replaceAll('{episode}', episode != null ? String(episode) : '');
}

// Recognise a provider's player URL. Used by both popup (for "you are
// already on a vidsrc tab" handling) and background (for keyboard
// shortcuts that operate on the current player tab).
function parseProviderUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let m;

  m = url.match(/\/embed\/movie\/(tt\d+)/);
  if (m) return { imdbId: m[1], type: 'movie', season: null, episode: null };

  m = url.match(/\/embed\/tv\/(tt\d+)\/(\d+)\/(\d+)/);
  if (m) return { imdbId: m[1], type: 'tv', season: +m[2], episode: +m[3] };

  m = url.match(/\/embedtv\/(tt\d+)&s=(\d+)&e=(\d+)/);
  if (m) return { imdbId: m[1], type: 'tv', season: +m[2], episode: +m[3] };

  m = url.match(/[?&]imdb=(tt\d+)/);
  if (m) {
    const s = url.match(/[?&]season=(\d+)/);
    const e = url.match(/[?&]episode=(\d+)/);
    if (s && e) return { imdbId: m[1], type: 'tv', season: +s[1], episode: +e[1] };
    return { imdbId: m[1], type: 'movie', season: null, episode: null };
  }

  m = url.match(/[?&]video_id=(tt\d+)/);
  if (m) {
    const s = url.match(/[?&]s=(\d+)/);
    const e = url.match(/[?&]e=(\d+)/);
    if (s && e) return { imdbId: m[1], type: 'tv', season: +s[1], episode: +e[1] };
    return { imdbId: m[1], type: 'movie', season: null, episode: null };
  }

  m = url.match(/\/embed\/(tt\d+)/);
  if (m) return { imdbId: m[1], type: 'movie', season: null, episode: null };

  return null;
}

// Match a player URL to one of the configured providers by host.
function findProviderByUrl(providers, url) {
  if (!url) return null;
  let host;
  try { host = new URL(url).host; } catch { return null; }
  return providers.find(p => {
    try {
      const tplHost = new URL(p.movie.replace('{imdb}', 'tt0000000')).host;
      return host === tplHost;
    } catch { return false; }
  }) || null;
}

// "Is the user looking at a player tab?" Host match against the configured
// providers (which includes the user's custom host) OR a recognisable embed
// URL shape, so unknown mirrors still resolve.
function isProviderUrl(providers, url) {
  if (!url) return false;
  if (findProviderByUrl(providers, url)) return true;
  return parseProviderUrl(url) !== null;
}

// Read settings, falling back to defaults. Returns the merged object
// plus the resolved provider list.
function loadSettingsAndProviders() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => {
      const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      if (!Array.isArray(settings.enabledProviderIds) || settings.enabledProviderIds.length === 0) {
        settings.enabledProviderIds = [...DEFAULT_SETTINGS.enabledProviderIds];
      }
      resolve({ settings, providers: buildProviderList(settings) });
    });
  });
}

// ---- Watch history (chrome.storage.local) ----

function loadProgress() {
  return new Promise(r => chrome.storage.local.get('progress', d => r(d.progress || {})));
}

// Record what was opened, keeping only the PROGRESS_LIMIT most recent titles.
async function recordProgress(imdbId, type, title, season, episode) {
  let progress = await loadProgress();
  progress[imdbId] = {
    imdbId,
    type,
    title: title || `IMDb ${imdbId}`,
    season: season || null,
    episode: episode || null,
    timestamp: Date.now()
  };

  const entries = Object.values(progress).map((entry, index) => ({ entry, index }));
  if (entries.length > PROGRESS_LIMIT) {
    entries.sort((a, b) => {
      // Whatever was just written always survives the trim.
      if (a.entry.imdbId === imdbId) return -1;
      if (b.entry.imdbId === imdbId) return 1;
      const byTime = (b.entry.timestamp || 0) - (a.entry.timestamp || 0);
      // Several writes can land in the same millisecond; without an explicit
      // tiebreak a stable sort leaves them oldest-first and the trim keeps
      // exactly the wrong ones. Fall back to insertion order, newest first.
      return byTime !== 0 ? byTime : b.index - a.index;
    });
    progress = {};
    for (const { entry } of entries.slice(0, PROGRESS_LIMIT)) progress[entry.imdbId] = entry;
  }

  return new Promise(r => chrome.storage.local.set({ progress }, r));
}

// Service-worker exports (importScripts gives us the global scope).
if (typeof self !== 'undefined') {
  self.PRESET_PROVIDERS = PRESET_PROVIDERS;
  self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  self.PROGRESS_LIMIT = PROGRESS_LIMIT;
  self.TV_TYPES = TV_TYPES;
  self.IMDB_TITLE_TYPE_TO_SCHEMA = IMDB_TITLE_TYPE_TO_SCHEMA;
  self.schemaTypeFromImdbTypeId = schemaTypeFromImdbTypeId;
  self.isTvType = isTvType;
  self.titleTypeLabel = titleTypeLabel;
  self.normalizeBaseUrl = normalizeBaseUrl;
  self.buildProviderList = buildProviderList;
  self.getProviderById = getProviderById;
  self.buildVidsrcUrl = buildVidsrcUrl;
  self.loadSettingsAndProviders = loadSettingsAndProviders;
  self.parseProviderUrl = parseProviderUrl;
  self.findProviderByUrl = findProviderByUrl;
  self.isProviderUrl = isProviderUrl;
  self.loadProgress = loadProgress;
  self.recordProgress = recordProgress;
}
