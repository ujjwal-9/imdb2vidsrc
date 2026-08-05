const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackground } = require('./helpers');

const asMovie = (id) => ({ imdbId: id, type: 'Movie', title: 'Heat' });
const asSeries = (id) => ({ imdbId: id, type: 'TVSeries', title: 'Breaking Bad' });

test('movie opens directly on the configured provider', async () => {
  const { api, createdTabs, local } = loadBackground({});
  api.getContentDetails = async (id) => asMovie(id);

  const result = await api.handleWatchRequest('tt0113277');

  assert.equal(result.opened, 'movie');
  assert.deepEqual(createdTabs, ['https://vidsrc.icu/embed/movie/tt0113277']);
  assert.equal(local.progress['tt0113277'].title, 'Heat');
  assert.equal(local.progress['tt0113277'].type, 'movie');
});

test('movie honours a non-default provider', async () => {
  const local = {
    settings: { baseUrl: 'vidsrc.icu', defaultProviderId: 'multiembed', enabledProviderIds: ['multiembed'] }
  };
  const { api, createdTabs } = loadBackground({ local });
  api.getContentDetails = async (id) => asMovie(id);

  await api.handleWatchRequest('tt0113277');
  assert.deepEqual(createdTabs, ['https://multiembed.mov/?video_id=tt0113277']);
});

test('series hands off to the popup when openPopup() succeeds', async () => {
  const { api, createdTabs, local } = loadBackground({ openPopupWorks: true });
  api.getContentDetails = async (id) => asSeries(id);

  const result = await api.handleWatchRequest('tt0903747');

  assert.equal(result.opened, 'popup');
  assert.deepEqual(createdTabs, [], 'no tab opened; the popup takes over');
  assert.equal(local.lastClicked.imdbId, 'tt0903747');
  assert.equal(typeof local.lastClicked.at, 'number', 'handoff is timestamped');
});

test('series falls back to the player when openPopup() rejects', async () => {
  const { api, createdTabs, local } = loadBackground({ openPopupWorks: false });
  api.getContentDetails = async (id) => asSeries(id);

  const result = await api.handleWatchRequest('tt0903747');

  assert.equal(result.opened, 'tv');
  assert.deepEqual(createdTabs, ['https://vidsrc.icu/embed/tv/tt0903747/1/1']);
  assert.ok(!('lastClicked' in local), 'stale handoff cleared so it cannot hijack the next popup');
  assert.equal(local.progress['tt0903747'].season, 1);
  assert.equal(local.progress['tt0903747'].episode, 1);
});

test('series fallback resumes the last watched episode', async () => {
  const local = {
    progress: {
      tt0903747: { imdbId: 'tt0903747', type: 'tv', title: 'Breaking Bad', season: 4, episode: 9, timestamp: Date.now() }
    }
  };
  const { api, createdTabs } = loadBackground({ local, openPopupWorks: false });
  api.getContentDetails = async (id) => asSeries(id);

  await api.handleWatchRequest('tt0903747');
  assert.deepEqual(createdTabs, ['https://vidsrc.icu/embed/tv/tt0903747/4/9']);
});

test('an episode id resolves to the parent series at that episode', async () => {
  const { api, createdTabs } = loadBackground({ openPopupWorks: false });
  api.getContentDetails = async () => ({
    imdbId: 'tt0903747', type: 'TVSeries', title: 'Breaking Bad',
    episodeContext: { season: 3, episode: 7, episodeTitle: 'One Minute', episodeId: 'tt1615186' }
  });

  await api.handleWatchRequest('tt1615186');
  assert.deepEqual(createdTabs, ['https://vidsrc.icu/embed/tv/tt0903747/3/7']);
});

test('JSON-LD @type arrays are handled', () => {
  const { api } = loadBackground({});
  assert.equal(api.normalizeJsonLdType(['CreativeWork', 'TVSeries']), 'TVSeries');
  assert.equal(api.normalizeJsonLdType(['CreativeWork', 'Movie']), 'Movie');
  assert.equal(api.normalizeJsonLdType('Movie'), 'Movie');
  assert.equal(api.normalizeJsonLdType(undefined), 'Movie');
  assert.equal(api.isTitleType(['Thing', 'TVEpisode']), true);
  assert.equal(api.isTitleType(['Thing']), false);
  assert.equal(api.isTitleType('Movie'), true);
});

test('an array @type still routes a series down the TV path', async () => {
  const { api } = loadBackground({ openPopupWorks: false });
  api.getContentDetails = async (id) => ({
    imdbId: id, title: 'X', type: api.normalizeJsonLdType(['CreativeWork', 'TVSeries'])
  });
  assert.equal((await api.handleWatchRequest('tt1')).opened, 'tv');
});

test('decodeHtmlEntities preserves astral-plane characters', () => {
  const { api } = loadBackground({});
  assert.equal(api.decodeHtmlEntities('Smile &#128512; here'), 'Smile 😀 here');
  assert.equal(api.decodeHtmlEntities('Smile &#x1F600; here'), 'Smile 😀 here');
  assert.equal(api.decodeHtmlEntities('caf&#233;'), 'café');
  assert.equal(api.decodeHtmlEntities('A &amp; B &quot;C&quot; &#39;D&#39;'), 'A & B "C" \'D\'');
  // Out of range: left as-is rather than throwing or emitting garbage.
  assert.equal(api.decodeHtmlEntities('&#1114112;'), '&#1114112;');
  assert.equal(api.decodeHtmlEntities(null), null);
});

test('contentCache prunes expired entries on write', () => {
  const { api } = loadBackground({});
  const cache = vm.runInContext('contentCache', api);

  cache.data = { old: { details: { title: 'A' }, timestamp: Date.now() - 25 * 3600 * 1000 } };
  cache.set('fresh', { title: 'B' });

  assert.ok(!('old' in cache.data), 'expired entry dropped');
  assert.equal(cache.get('fresh').title, 'B');
});

test('contentCache treats "Unknown Title" as a miss', () => {
  const { api } = loadBackground({});
  const cache = vm.runInContext('contentCache', api);
  cache.set('u', { title: 'Unknown Title' });
  assert.equal(cache.get('u'), null);
});

test('contentCache enforces a hard cap', () => {
  const { api } = loadBackground({});
  const cache = vm.runInContext('contentCache', api);
  for (let i = 0; i < 350; i++) cache.set('tt' + i, { title: 'T' + i });
  assert.ok(Object.keys(cache.data).length <= 300, 'cache stays bounded');
  assert.equal(cache.get('tt349').title, 'T349', 'most recent retained');
});

test('watchlist entries do not carry poster URLs', async () => {
  const { api, sync } = loadBackground({});
  api.getContentDetails = async (id) => ({
    imdbId: id, type: 'Movie', title: 'Heat', year: 1995,
    poster: 'https://m.media-amazon.com/images/M/' + 'x'.repeat(150) + '.jpg'
  });

  const result = await api.toggleWatchlist('tt0113277');

  assert.equal(result.saved, true);
  assert.ok(!('poster' in result.entry), 'poster is not synced');
  assert.deepEqual(Object.keys(sync.watchlist[0]).sort(), ['addedAt', 'imdbId', 'title', 'type', 'year']);
});

test('legacy poster fields are stripped on the next write', async () => {
  const sync = {
    watchlist: [{ imdbId: 'tt1', title: 'Old', type: 'movie', year: 2000, poster: 'https://x/'.padEnd(200, 'y'), addedAt: 1 }]
  };
  const { api } = loadBackground({ sync });
  api.getContentDetails = async (id) => ({ imdbId: id, type: 'Movie', title: 'New' });

  await api.toggleWatchlist('tt2');

  assert.ok(sync.watchlist.every(e => !('poster' in e)), 'migrated existing entries');
  assert.equal(sync.watchlist.length, 2);
});

test('a full 50-item watchlist fits inside the sync per-item quota', async () => {
  const { api, sync } = loadBackground({});
  api.getContentDetails = async (id) => ({
    imdbId: id, type: 'TVSeries', year: 2008,
    title: 'A Reasonably Long Television Series Title ' + id
  });

  for (let i = 0; i < 50; i++) {
    const result = await api.toggleWatchlist('tt' + String(1000000 + i));
    assert.equal(result.saved, true, `entry ${i} saved`);
  }

  assert.equal(sync.watchlist.length, 50);
  // Chrome's QUOTA_BYTES_PER_ITEM is 8192; with posters this used to blow past it.
  assert.ok(api.watchlistBytes(sync.watchlist) < 8192,
    `serialised size ${api.watchlistBytes(sync.watchlist)} must stay under 8192`);
});

test('an oversized watchlist is refused with a readable message', async () => {
  const { api } = loadBackground({});
  api.getContentDetails = async (id) => ({ imdbId: id, type: 'Movie', title: 'T'.repeat(4000) });

  assert.equal((await api.toggleWatchlist('tt1')).saved, true);
  const second = await api.toggleWatchlist('tt2');

  assert.equal(second.saved, false);
  assert.match(second.error, /full|limit/i);
  assert.equal(second.count, 1, 'count reflects the list that is actually stored');
});

test('toggling an existing entry removes it', async () => {
  const { api, sync } = loadBackground({});
  api.getContentDetails = async (id) => asMovie(id);

  await api.toggleWatchlist('tt0113277');
  assert.equal(sync.watchlist.length, 1);

  const result = await api.toggleWatchlist('tt0113277');
  assert.equal(result.saved, false);
  assert.equal(sync.watchlist.length, 0);
});

test('the entry-count limit is enforced', async () => {
  const sync = {
    watchlist: Array.from({ length: 50 }, (_, i) => ({
      imdbId: 'tt' + i, title: 'T' + i, type: 'movie', year: 2000, addedAt: i
    }))
  };
  const { api } = loadBackground({ sync });
  api.getContentDetails = async (id) => asMovie(id);

  const result = await api.toggleWatchlist('tt-new');
  assert.equal(result.saved, false);
  assert.match(result.error, /limit/i);
});
