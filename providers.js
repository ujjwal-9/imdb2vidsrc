// Shared provider registry. Loaded by popup.js (via <script>) and by
// background.js (via importScripts in the service worker).
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

// Build the full provider list visible to the user, including a
// "custom" entry derived from settings.baseUrl so legacy users keep
// their saved host.
function buildProviderList(settings) {
  const baseUrl = (settings && settings.baseUrl) || DEFAULT_SETTINGS.baseUrl;
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

// Read settings, falling back to defaults. Returns the merged object
// plus the resolved provider list.
function loadSettingsAndProviders() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (data) => {
      const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      resolve({ settings, providers: buildProviderList(settings) });
    });
  });
}

// Service-worker exports (importScripts gives us the global scope).
if (typeof self !== 'undefined') {
  self.PRESET_PROVIDERS = PRESET_PROVIDERS;
  self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  self.buildProviderList = buildProviderList;
  self.getProviderById = getProviderById;
  self.buildVidsrcUrl = buildVidsrcUrl;
  self.loadSettingsAndProviders = loadSettingsAndProviders;
}
