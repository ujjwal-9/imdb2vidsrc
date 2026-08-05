// In-memory state for the popup session.
let settings = { ...DEFAULT_SETTINGS };
let providers = buildProviderList(settings);
let activeProviderId = settings.defaultProviderId;
let currentImdbId = null;
let currentTitle = null;
let currentType = 'movie';
let searchDebounce = null;

// A "watch this title" handoff from the content script / context menu is only
// trusted briefly. Without this, a handoff left behind by a failed
// openPopup() would hijack the next unrelated popup open.
const LAST_CLICK_TTL_MS = 10 * 1000;

// Episode lists are expensive to fetch (full IMDb page + __NEXT_DATA__ parse),
// so they outlive the popup session.
const EPISODE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const EPISODE_CACHE_LIMIT = 40;
const episodeCache = new Map();

// Generous enough for long-running soaps and anime, which routinely list
// hundreds of episodes in a single IMDb season.
const SEASON_MAX = 200;
const EPISODE_MAX = 2000;

// Season switches race: a slow fetch for season 2 must not overwrite the list
// for season 3 that the user has since selected.
let episodeRequestSeq = 0;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupTabs();
  setupUI();
  await Promise.all([loadSettings(), initEpisodeCache()]);
  // Legacy keys from earlier versions; harmless but no longer read.
  chrome.storage.local.remove(['contentType', 'lastClickedImdbId']);
  await processCurrentTab();
}

// ---- Tabs ----
function setupTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchTab(tab.dataset.tab);
        return;
      }
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        switchTab(next.dataset.tab);
        next.focus();
      }
    });
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `${name}-tab`));
  if (name === 'history') renderHistory();
  if (name === 'saved') renderSaved();
  if (name === 'search') document.getElementById('search-input').focus();
}

// ---- UI wiring ----
function setupUI() {
  document.getElementById('watch-button').addEventListener('click', handleWatchClick);
  document.getElementById('imdb-button').addEventListener('click', handleImdbClick);
  document.getElementById('content-type').addEventListener('change', handleContentTypeChange);
  document.getElementById('resume-button').addEventListener('click', handleResumeClick);
  document.getElementById('next-episode-button').addEventListener('click', handleNextEpisodeClick);

  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('reset-settings').addEventListener('click', resetSettings);

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(searchInput.value.trim()), 250);
  });

  document.getElementById('clear-history').addEventListener('click', clearAllHistory);
  document.getElementById('star-toggle').addEventListener('click', handleStarToggle);
  document.getElementById('star-toggle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleStarToggle();
    }
  });

  document.getElementById('season').addEventListener('change', () => {
    if (currentImdbId && currentType === 'tv') {
      const s = parseInt(document.getElementById('season').value) || 1;
      loadEpisodeList(currentImdbId, s);
    }
  });

  setupNumberInputs();
}

function setupNumberInputs() {
  Object.entries({ season: SEASON_MAX, episode: EPISODE_MAX }).forEach(([id, max]) => {
    const input = document.getElementById(id);
    input.min = 1;
    input.max = max;
    input.addEventListener('input', () => {
      // Clamp out-of-range numbers only. Rewriting an empty field to "1" while
      // typing makes it impossible to clear and retype.
      const v = parseInt(input.value);
      if (isNaN(v)) return;
      if (v > max) input.value = max;
      else if (v < 1) input.value = 1;
    });
    input.addEventListener('blur', () => {
      const v = parseInt(input.value);
      input.value = isNaN(v) ? 1 : Math.min(max, Math.max(1, v));
    });
  });
}

// ---- Settings ----
async function loadSettings() {
  const resolved = await loadSettingsAndProviders();
  settings = resolved.settings;
  providers = resolved.providers;
  activeProviderId = settings.defaultProviderId;
  document.getElementById('base-url').value = settings.baseUrl;
  renderSettings();
}

function renderSettings() {
  const defaultSel = document.getElementById('default-provider');
  defaultSel.innerHTML = '';
  providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === settings.defaultProviderId) opt.selected = true;
    defaultSel.appendChild(opt);
  });

  const togglesEl = document.getElementById('provider-toggles');
  togglesEl.innerHTML = '';
  providers.forEach(p => {
    const wrap = document.createElement('label');
    wrap.className = 'provider-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = settings.enabledProviderIds.includes(p.id);
    wrap.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = p.name;
    wrap.appendChild(txt);
    togglesEl.appendChild(wrap);
  });
}

function saveSettings() {
  const baseUrlInput = document.getElementById('base-url');
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  if (!baseUrl) {
    return showSettingsMsg('Enter a valid host, e.g. vidsrc.icu', 'red');
  }
  // Show the user what actually got stored (scheme/path stripped).
  baseUrlInput.value = baseUrl;

  const defaultId = document.getElementById('default-provider').value;
  const enabledIds = Array.from(document.querySelectorAll('#provider-toggles input:checked'))
    .map(cb => cb.value);
  if (enabledIds.length === 0) return showSettingsMsg('Enable at least one provider', 'red');
  if (!enabledIds.includes(defaultId)) enabledIds.push(defaultId);

  settings = { baseUrl, defaultProviderId: defaultId, enabledProviderIds: enabledIds };
  providers = buildProviderList(settings);
  activeProviderId = defaultId;

  chrome.storage.local.set({ settings }, () => {
    showSettingsMsg('Settings saved!', 'green');
    renderSettings();
    renderProviderChips();
  });
}

function resetSettings() {
  settings = { ...DEFAULT_SETTINGS };
  providers = buildProviderList(settings);
  activeProviderId = settings.defaultProviderId;
  document.getElementById('base-url').value = settings.baseUrl;
  chrome.storage.local.set({ settings }, () => {
    showSettingsMsg('Settings reset', 'green');
    renderSettings();
    renderProviderChips();
  });
}

function showSettingsMsg(msg, color) {
  const el = document.querySelector('.settings-saved');
  el.textContent = msg;
  el.style.color = color === 'red' ? '#c00' : '#2a7';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2500);
}

// ---- Provider chips ----
function renderProviderChips() {
  const container = document.getElementById('provider-chips');
  container.innerHTML = '';
  const enabled = providers.filter(p => settings.enabledProviderIds.includes(p.id));
  if (!enabled.find(p => p.id === activeProviderId)) {
    activeProviderId = enabled[0]?.id || providers[0].id;
  }
  enabled.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (p.id === activeProviderId ? ' active' : '');
    chip.textContent = p.name;
    chip.setAttribute('aria-pressed', p.id === activeProviderId ? 'true' : 'false');
    chip.addEventListener('click', () => {
      activeProviderId = p.id;
      renderProviderChips();
    });
    container.appendChild(chip);
  });
}

// ---- Watch flow ----
async function processCurrentTab() {
  showLoading(true);

  const stored = await new Promise(r => chrome.storage.local.get('lastClicked', r));
  const handoff = stored.lastClicked;
  if (handoff && handoff.imdbId) {
    chrome.storage.local.remove('lastClicked');
    if (Date.now() - (handoff.at || 0) < LAST_CLICK_TTL_MS) {
      return processImdbId(handoff.imdbId);
    }
  }

  const tabs = await new Promise(r => chrome.tabs.query({ active: true, currentWindow: true }, r));
  const url = tabs[0]?.url || '';

  if (isProviderUrl(providers, url)) {
    return processProviderPage(url);
  }
  const imdbId = (url.match(/imdb\.com\/title\/(tt\d+)/) || [])[1];
  if (imdbId) {
    // Auto-fill season from /episodes/?season=N URL context.
    const seasonMatch = url.match(/[?&]season=(\d+)/);
    const ctx = seasonMatch ? { season: +seasonMatch[1] } : null;
    return processImdbId(imdbId, ctx);
  }

  showEmptyState();
}

function processProviderPage(url) {
  const parsed = parseProviderUrl(url);
  if (!parsed) {
    showLoading(false);
    showError('Could not identify content from the current page.');
    return;
  }
  // Pass season/episode forward so applyTvInputs uses them
  // (this is the most authoritative source — user is actively watching).
  const ctx = parsed.type === 'tv'
    ? { season: parsed.season || 1, episode: parsed.episode || 1 }
    : null;
  fetchContent(parsed.imdbId, parsed.type, ctx);
}

function processImdbId(imdbId, context) {
  fetchContent(imdbId, null, context || null);
}

function fetchContent(imdbId, forcedType, context) {
  currentImdbId = imdbId;
  // Clear any error/empty state left over from a previous title, otherwise a
  // stale red message sits above the title that loaded fine.
  hideAllStates();
  chrome.runtime.sendMessage({ action: 'getContentDetails', imdbId }, async (response) => {
    showLoading(false);

    if (!response || response.error) {
      showError(response?.error || 'Failed to fetch content details.');
      currentTitle = `IMDb ${imdbId}`;
      renderContentInfo({ imdbId, title: currentTitle, type: 'Unknown' });
      const fallbackType = forcedType || 'movie';
      const progress = await getProgress(imdbId);
      applyTvInputs(progress, fallbackType, context, null);
      applyContentType(fallbackType);
      revealWatchControls();
      refreshStarToggle(imdbId);
      showResumeBanner(progress);
      return;
    }

    // If the requested id was a TVEpisode, the background returned series
    // details with `episodeContext` attached. Swap currentImdbId to the
    // series so subsequent watch URLs use the right id.
    const epCtx = response.episodeContext || null;
    currentImdbId = response.imdbId || imdbId;
    currentTitle = response.title || `IMDb ${currentImdbId}`;
    renderContentInfo(response);

    // isTvType covers TVSeries, TVMiniSeries, TVEpisode and Series. Matching on
    // 'TVSeries' alone used to classify every mini-series as a movie.
    const detectedType = (isTvType(response.type) || epCtx) ? 'tv' : 'movie';
    const type = forcedType || detectedType;

    const progress = await getProgress(currentImdbId);
    applyTvInputs(progress, type, context, epCtx);
    applyContentType(type);
    revealWatchControls();
    refreshStarToggle(currentImdbId);
    showResumeBanner(progress);
  });
}

// Prefill season/episode using precedence:
//   provider-URL context (full S/E) > stored progress > episodeContext >
//   /episodes/?season=N URL > defaults.
function applyTvInputs(progress, type, urlContext, epContext) {
  if (type !== 'tv') return;
  const seasonEl = document.getElementById('season');
  const episodeEl = document.getElementById('episode');

  if (urlContext && urlContext.season && urlContext.episode) {
    seasonEl.value = urlContext.season;
    episodeEl.value = urlContext.episode;
    return;
  }
  if (progress && progress.season && progress.episode) {
    seasonEl.value = progress.season;
    episodeEl.value = progress.episode;
    return;
  }
  if (epContext && epContext.season) {
    seasonEl.value = epContext.season;
    episodeEl.value = epContext.episode || 1;
    return;
  }
  if (urlContext && urlContext.season) {
    seasonEl.value = urlContext.season;
  }
}

function revealWatchControls() {
  document.getElementById('content-type-selector').classList.remove('hidden');
  document.getElementById('provider-switcher').classList.remove('hidden');
  document.getElementById('watch-button').classList.remove('hidden');
  renderProviderChips();
}

function renderContentInfo(details) {
  const { title, type, imdbId, poster, year, rating, ratingCount, runtime, genres, episodeContext } = details;
  const el = document.getElementById('content-info');
  el.classList.remove('hidden');

  document.getElementById('title').textContent = title || `IMDb ${imdbId}`;

  const posterEl = document.getElementById('poster');
  if (poster) {
    posterEl.src = poster;
    posterEl.style.display = '';
  } else {
    posterEl.removeAttribute('src');
    posterEl.style.display = 'none';
  }
  posterEl.onerror = () => { posterEl.style.display = 'none'; };

  // Built as DOM nodes rather than an HTML string: genres come straight from
  // the fetched page's JSON-LD, and this runs in the extension's popup.
  const infoRow = document.getElementById('info-row');
  infoRow.textContent = '';
  const parts = [];
  if (year) parts.push({ text: String(year) });
  if (runtime) parts.push({ text: String(runtime) });
  if (rating) {
    const count = ratingCount ? ` (${formatCount(ratingCount)})` : '';
    parts.push({ text: `★ ${rating}${count}`, className: 'rating' });
  }
  if (Array.isArray(genres) && genres.length) {
    const genreText = genres.filter(g => typeof g === 'string' && g.trim()).slice(0, 3).join(', ');
    if (genreText) parts.push({ text: genreText });
  }
  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      infoRow.appendChild(sep);
    }
    const span = document.createElement('span');
    if (part.className) span.className = part.className;
    span.textContent = part.text;
    infoRow.appendChild(span);
  });

  const epEl = document.getElementById('episode-info');
  if (episodeContext && episodeContext.season && episodeContext.episode) {
    const epTitle = episodeContext.episodeTitle ? `: ${episodeContext.episodeTitle}` : '';
    epEl.textContent = `Episode S${episodeContext.season}E${episodeContext.episode}${epTitle}`;
    epEl.classList.remove('hidden');
  } else {
    epEl.classList.add('hidden');
  }

  document.getElementById('id-row').textContent =
    `IMDb ${details.imdbId || imdbId} · ${titleTypeLabel(type)}`;
}

function formatCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function showEmptyState() {
  showLoading(false);
  document.getElementById('empty-state').classList.remove('hidden');
  loadHistory().then(history => {
    if (history.length > 0) switchTab('history');
    else switchTab('search');
  });
}

function applyContentType(type) {
  currentType = type;
  document.getElementById('content-type').value = type;
  const tvControls = document.getElementById('tv-controls');
  const movieControls = document.getElementById('movie-controls');
  const watchButton = document.getElementById('watch-button');
  if (type === 'tv') {
    tvControls.classList.remove('hidden');
    movieControls.classList.add('hidden');
    watchButton.textContent = 'Watch episode';
    if (currentImdbId) {
      const seasonNum = parseInt(document.getElementById('season').value) || 1;
      loadEpisodeList(currentImdbId, seasonNum);
    }
  } else {
    tvControls.classList.add('hidden');
    movieControls.classList.remove('hidden');
    watchButton.textContent = 'Watch';
  }
}

function handleContentTypeChange() {
  applyContentType(document.getElementById('content-type').value);
}

function showLoading(show) {
  document.getElementById('loading').classList.toggle('hidden', !show);
}

function showError(msg) {
  const el = document.getElementById('error-message');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideAllStates() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('error-message').classList.add('hidden');
}

// ---- Watch button ----
function handleWatchClick() {
  if (!currentImdbId) return showError('No title selected.');
  const provider = getProviderById(providers, activeProviderId);
  let url, season = null, episode = null;
  if (currentType === 'tv') {
    season = parseInt(document.getElementById('season').value) || 1;
    episode = parseInt(document.getElementById('episode').value) || 1;
    url = buildVidsrcUrl(provider, 'tv', currentImdbId, season, episode);
  } else {
    url = buildVidsrcUrl(provider, 'movie', currentImdbId);
  }

  recordProgress(currentImdbId, currentType, currentTitle, season, episode);

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url && isProviderUrl(providers, tab.url)) {
      chrome.tabs.update(tab.id, { url });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

function handleImdbClick() {
  if (!currentImdbId) return;
  chrome.tabs.create({ url: `https://www.imdb.com/title/${currentImdbId}/` });
}

// ---- Resume banner ----
function showResumeBanner(progress) {
  const banner = document.getElementById('resume-banner');
  if (!progress) { banner.classList.add('hidden'); return; }

  const info = document.getElementById('resume-info');
  const nextBtn = document.getElementById('next-episode-button');
  const ago = formatRelativeTime(progress.timestamp);
  if (progress.type === 'tv' && progress.season && progress.episode) {
    info.textContent = `S${progress.season}E${progress.episode} · ${ago}`;
    nextBtn.classList.remove('hidden');
  } else {
    info.textContent = `Watched ${ago}`;
    nextBtn.classList.add('hidden');
  }
  banner.classList.remove('hidden');
}

function handleResumeClick() {
  handleWatchClick();
}

function handleNextEpisodeClick() {
  const epInput = document.getElementById('episode');
  epInput.value = (parseInt(epInput.value) || 1) + 1;
  handleWatchClick();
}

// ---- Progress / history ----
async function getProgress(imdbId) {
  const progress = await loadProgress();
  return progress[imdbId] || null;
}

async function loadHistory() {
  const progress = await loadProgress();
  return Object.values(progress).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

async function renderHistory() {
  const list = await loadHistory();
  const container = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const clearBtn = document.getElementById('clear-history');
  container.innerHTML = '';
  if (list.length === 0) {
    empty.classList.remove('hidden');
    clearBtn.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  clearBtn.classList.remove('hidden');
  list.forEach(entry => container.appendChild(renderHistoryRow(entry)));
}

function renderHistoryRow(entry) {
  const row = document.createElement('div');
  row.className = 'history-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = entry.title || `IMDb ${entry.imdbId}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const epInfo = entry.type === 'tv' && entry.season && entry.episode
    ? `S${entry.season}E${entry.episode} · ` : '';
  sub.textContent = `${epInfo}${formatRelativeTime(entry.timestamp)}`;
  info.appendChild(title);
  info.appendChild(sub);
  row.appendChild(info);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Remove';
  del.setAttribute('aria-label', `Remove ${entry.title || entry.imdbId} from history`);
  del.addEventListener('click', (e) => { e.stopPropagation(); removeProgress(entry.imdbId); });
  row.appendChild(del);

  const open = () => {
    switchTab('watch');
    hideAllStates();
    showLoading(true);
    if (entry.type === 'tv' && entry.season && entry.episode) {
      document.getElementById('season').value = entry.season;
      document.getElementById('episode').value = entry.episode;
    }
    fetchContent(entry.imdbId, entry.type === 'tv' ? 'tv' : 'movie');
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}

async function removeProgress(imdbId) {
  const progress = await loadProgress();
  delete progress[imdbId];
  await new Promise(r => chrome.storage.local.set({ progress }, r));
  renderHistory();
}

async function clearAllHistory() {
  await new Promise(r => chrome.storage.local.set({ progress: {} }, r));
  renderHistory();
}

function formatRelativeTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---- Search ----
async function runSearch(query) {
  const status = document.getElementById('search-status');
  const results = document.getElementById('search-results');
  results.innerHTML = '';
  if (!query || query.length < 2) {
    status.textContent = 'Type at least 2 characters';
    status.classList.remove('hidden');
    return;
  }
  status.textContent = 'Searching...';
  status.classList.remove('hidden');

  const firstChar = query.charAt(0).toLowerCase();
  const url = `https://v2.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(query)}.json`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    const items = (data.d || []).filter(it => typeof it.id === 'string' && it.id.startsWith('tt'));
    if (items.length === 0) {
      status.textContent = 'No results';
      return;
    }
    status.classList.add('hidden');
    items.slice(0, 12).forEach(it => results.appendChild(renderSearchRow(it)));
  } catch (e) {
    status.textContent = 'Search failed: ' + e.message;
  }
}

function renderSearchRow(item) {
  const row = document.createElement('div');
  row.className = 'result-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const img = document.createElement('img');
  img.src = item.i?.imageUrl || '';
  img.alt = '';
  img.onerror = () => { img.style.visibility = 'hidden'; };
  row.appendChild(img);
  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.l;
  info.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'sub';
  const yearText = item.y || '';
  const typeText = item.q || (item.qid || '');
  sub.textContent = [yearText, typeText].filter(Boolean).join(' · ');
  info.appendChild(sub);
  row.appendChild(info);

  const open = () => {
    switchTab('watch');
    hideAllStates();
    showLoading(true);
    // qid is IMDb's own type id. A startsWith('tv') test misreads tvMovie,
    // tvSpecial and tvShort as series; an unknown id defers to detection.
    const mapped = schemaTypeFromImdbTypeId(item.qid);
    const forcedType = mapped ? (isTvType(mapped) ? 'tv' : 'movie') : null;
    fetchContent(item.id, forcedType);
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}

// ---- Episode picker ----
async function initEpisodeCache() {
  const data = await new Promise(r => chrome.storage.local.get('episodeCache', r));
  const raw = data.episodeCache || {};
  const now = Date.now();
  for (const [key, entry] of Object.entries(raw)) {
    if (entry && Array.isArray(entry.episodes) && entry.timestamp &&
        now - entry.timestamp < EPISODE_CACHE_TTL_MS) {
      episodeCache.set(key, entry);
    }
  }
}

function getCachedEpisodes(key) {
  const entry = episodeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > EPISODE_CACHE_TTL_MS) {
    episodeCache.delete(key);
    return null;
  }
  return entry.episodes;
}

function setCachedEpisodes(key, episodes) {
  // Re-insert so Map iteration order stays least-recently-used first.
  episodeCache.delete(key);
  episodeCache.set(key, { episodes, timestamp: Date.now() });
  while (episodeCache.size > EPISODE_CACHE_LIMIT) {
    episodeCache.delete(episodeCache.keys().next().value);
  }
  chrome.storage.local.set({ episodeCache: Object.fromEntries(episodeCache) });
}

async function loadEpisodeList(imdbId, season) {
  const requestId = ++episodeRequestSeq;
  const status = document.getElementById('episode-status');
  const list = document.getElementById('episode-list');
  list.innerHTML = '';
  status.textContent = 'Loading episodes...';
  status.classList.remove('hidden');

  const cacheKey = `${imdbId}/${season}`;
  let episodes = getCachedEpisodes(cacheKey);
  if (!episodes) {
    try {
      episodes = await fetchEpisodes(imdbId, season);
      if (episodes && episodes.length > 0) setCachedEpisodes(cacheKey, episodes);
    } catch (e) {
      episodes = null;
    }
  }

  // The user moved on to another season while this was in flight; whichever
  // request started last owns the list.
  if (requestId !== episodeRequestSeq) return;

  if (!episodes || episodes.length === 0) {
    status.textContent = 'Episode list unavailable — use the inputs above.';
    return;
  }
  status.classList.add('hidden');

  const currentEp = parseInt(document.getElementById('episode').value) || 1;
  episodes.forEach(ep => {
    const row = document.createElement('div');
    row.className = 'episode-row' + (ep.number === currentEp ? ' active' : '');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `E${ep.number}`;
    row.appendChild(num);
    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = ep.title || `Episode ${ep.number}`;
    row.appendChild(titleEl);
    if (ep.airDate) {
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = ep.airDate;
      row.appendChild(date);
    }
    const select = () => {
      document.getElementById('episode').value = ep.number;
      document.querySelectorAll('.episode-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    list.appendChild(row);
  });
}

async function fetchEpisodes(imdbId, season) {
  const url = `https://www.imdb.com/title/${imdbId}/episodes/?season=${season}`;
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }
  const arr = findEpisodeArray(data);
  if (!arr) return null;
  return arr.map(normalizeEpisode).filter(e => e && e.number != null);
}

function findEpisodeArray(node, depth = 0) {
  if (depth > 14 || node == null) return null;
  if (Array.isArray(node)) {
    if (node.length > 0 && looksLikeEpisode(node[0])) return node;
    for (const item of node) {
      const found = findEpisodeArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) {
      const found = findEpisodeArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function looksLikeEpisode(o) {
  if (!o || typeof o !== 'object') return false;
  const hasNum = o.episode != null || o.episodeNumber != null;
  const hasTitle = typeof o.title === 'string' || o.titleText != null;
  return hasNum && hasTitle;
}

function normalizeEpisode(ep) {
  const numRaw = ep.episode ?? ep.episodeNumber;
  const number = typeof numRaw === 'string' ? parseInt(numRaw) : numRaw;
  let title = '';
  if (typeof ep.title === 'string') title = ep.title;
  else if (ep.titleText) title = (typeof ep.titleText === 'string') ? ep.titleText : (ep.titleText.text || '');
  let airDate = null;
  if (ep.releaseDate && typeof ep.releaseDate === 'object' && ep.releaseDate.year) {
    const { year, month, day } = ep.releaseDate;
    airDate = [year, month, day].filter(Boolean).join('-');
  } else if (typeof ep.releaseDate === 'string') {
    airDate = ep.releaseDate;
  }
  return { number, title, airDate };
}

// ---- Watchlist (storage.sync via background) ----
function refreshStarToggle(imdbId) {
  const star = document.getElementById('star-toggle');
  if (!imdbId) { star.style.display = 'none'; return; }
  star.style.display = '';
  star.dataset.imdbId = imdbId;
  chrome.runtime.sendMessage({ action: 'inWatchlist', imdbId }, (resp) => {
    if (chrome.runtime.lastError) return;
    setStar(resp && resp.saved);
  });
}

function setStar(saved) {
  const star = document.getElementById('star-toggle');
  star.textContent = saved ? '★' : '☆';
  star.title = saved ? 'Remove from watchlist' : 'Save to watchlist';
  star.setAttribute('aria-pressed', saved ? 'true' : 'false');
}

function handleStarToggle() {
  const star = document.getElementById('star-toggle');
  const id = star.dataset.imdbId;
  if (!id) return;
  chrome.runtime.sendMessage({ action: 'toggleWatchlist', imdbId: id }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    if (resp.error) {
      star.title = resp.error;
      // Brief visual nudge
      star.style.color = '#c00';
      setTimeout(() => { star.style.color = ''; }, 1200);
      return;
    }
    setStar(!!resp.saved);
  });
}

async function renderSaved() {
  const container = document.getElementById('saved-list');
  const empty = document.getElementById('saved-empty');
  container.innerHTML = '';
  const list = await new Promise(r => chrome.runtime.sendMessage({ action: 'getWatchlist' }, r));
  const entries = (list && list.list) || [];
  if (entries.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  entries.forEach(entry => container.appendChild(renderSavedRow(entry)));
}

function renderSavedRow(entry) {
  const row = document.createElement('div');
  row.className = 'history-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = entry.title || `IMDb ${entry.imdbId}`;
  const sub = document.createElement('div');
  sub.className = 'sub';
  const parts = [];
  if (entry.year) parts.push(entry.year);
  parts.push(entry.type === 'tv' ? 'TV Series' : 'Movie');
  parts.push(`saved ${formatRelativeTime(entry.addedAt)}`);
  sub.textContent = parts.join(' · ');
  info.appendChild(title);
  info.appendChild(sub);
  row.appendChild(info);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '×';
  del.title = 'Remove';
  del.setAttribute('aria-label', `Remove ${entry.title || entry.imdbId} from watchlist`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'toggleWatchlist', imdbId: entry.imdbId }, () => {
      if (chrome.runtime.lastError) return;
      renderSaved();
    });
  });
  row.appendChild(del);

  const open = () => {
    switchTab('watch');
    hideAllStates();
    showLoading(true);
    fetchContent(entry.imdbId, entry.type, null);
  };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}
