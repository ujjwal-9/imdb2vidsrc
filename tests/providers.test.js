const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders, plain } = require('./helpers');

test('normalizeBaseUrl', async (t) => {
  const { api } = loadProviders();
  const cases = [
    ['vidsrc.icu', 'vidsrc.icu'],
    ['https://vidsrc.to', 'vidsrc.to'],
    ['https://vidsrc.to/', 'vidsrc.to'],
    ['http://a.example/embed/movie?x=1', 'a.example'],
    ['  VidSrc.ICU  ', 'vidsrc.icu'],
    ['user:pw@host.example', 'host.example'],
    ['localhost.dev:8080', 'localhost.dev:8080'],
    ['', null],
    ['localhost', null],
    ['bad host.com', null],
    ['!!!', null],
    [null, null],
    [undefined, null]
  ];
  for (const [input, want] of cases) {
    await t.test(`${JSON.stringify(input)} -> ${want}`, () => {
      assert.equal(api.normalizeBaseUrl(input), want);
    });
  }
});

test('build/parse round trip for every provider', async (t) => {
  const { api } = loadProviders();
  const providers = api.buildProviderList({ ...api.DEFAULT_SETTINGS, baseUrl: 'mymirror.example' });

  for (const provider of providers) {
    await t.test(provider.id, () => {
      const movieUrl = api.buildVidsrcUrl(provider, 'movie', 'tt0111161');
      assert.deepEqual(plain(api.parseProviderUrl(movieUrl)), {
        imdbId: 'tt0111161', type: 'movie', season: null, episode: null
      });

      const tvUrl = api.buildVidsrcUrl(provider, 'tv', 'tt0903747', 2, 5);
      assert.deepEqual(plain(api.parseProviderUrl(tvUrl)), {
        imdbId: 'tt0903747', type: 'tv', season: 2, episode: 5
      });

      assert.equal(api.findProviderByUrl(providers, movieUrl).id, provider.id);
    });
  }
});

test('isProviderUrl recognises the user\'s custom host', () => {
  const { api } = loadProviders();
  const providers = api.buildProviderList({ ...api.DEFAULT_SETTINGS, baseUrl: 'mymirror.example' });

  assert.equal(api.isProviderUrl(providers, 'https://mymirror.example/embed/tv/tt0903747/2/5'), true);
  assert.equal(api.isProviderUrl(providers, 'https://mymirror.example/embed/movie/tt0111161'), true);
  assert.equal(api.isProviderUrl(providers, 'https://vidsrc.icu/embed/movie/tt0111161'), true);

  assert.equal(api.isProviderUrl(providers, 'https://www.imdb.com/title/tt0111161/'), false);
  assert.equal(api.isProviderUrl(providers, 'https://news.example/article'), false);
  assert.equal(api.isProviderUrl(providers, ''), false);

  // The hardcoded regex this replaced could not see a custom host.
  const oldRegex = /vidsrc\.|embed\.su|2embed\.cc|autoembed\.cc|multiembed\.mov/;
  assert.equal(oldRegex.test('https://mymirror.example/embed/tv/tt1/2/5'), false);
});

test('buildProviderList custom entry', () => {
  const { api } = loadProviders();
  const providers = api.buildProviderList({ baseUrl: 'mymirror.example' });
  assert.equal(providers.find(p => p.id === 'custom').name, 'Custom (mymirror.example)');

  const fallback = api.buildProviderList({ baseUrl: '!!!' });
  assert.equal(fallback.find(p => p.id === 'custom').name, 'Custom (vidsrc.icu)');
});

test('getProviderById falls back to the first provider', () => {
  const { api } = loadProviders();
  const providers = api.buildProviderList(api.DEFAULT_SETTINGS);
  assert.equal(api.getProviderById(providers, 'vidsrc-to').id, 'vidsrc-to');
  assert.equal(api.getProviderById(providers, 'does-not-exist').id, providers[0].id);
});

test('loadSettingsAndProviders repairs a corrupt enabled list', async () => {
  const { api } = loadProviders({ local: { settings: { baseUrl: 'x.example', enabledProviderIds: 'nope' } } });
  const { settings } = await api.loadSettingsAndProviders();
  assert.deepEqual(settings.enabledProviderIds, api.DEFAULT_SETTINGS.enabledProviderIds);
});

test('recordProgress caps history and never evicts the entry just written', async () => {
  const { api, local } = loadProviders();

  // Writes land within the same millisecond here, which is exactly the case
  // that used to make the trim keep the oldest entries.
  for (let i = 0; i < 130; i++) {
    await api.recordProgress('tt' + String(i).padStart(7, '0'), 'movie', 'Title ' + i, null, null);
  }

  const progress = await api.loadProgress();
  assert.equal(Object.keys(progress).length, api.PROGRESS_LIMIT);
  assert.ok('tt0000129' in progress, 'newest entry retained');
  assert.ok(!('tt0000000' in progress), 'oldest entry evicted');
  assert.equal(local.progress['tt0000129'].title, 'Title 129');
});

test('recordProgress updates in place without growing the store', async () => {
  const { api } = loadProviders();
  for (let i = 0; i < 130; i++) {
    await api.recordProgress('tt' + String(i).padStart(7, '0'), 'movie', 'T' + i, null, null);
  }
  await api.recordProgress('tt0000129', 'tv', 'Title 129', 3, 7);

  const progress = await api.loadProgress();
  assert.equal(Object.keys(progress).length, api.PROGRESS_LIMIT);
  assert.equal(progress['tt0000129'].season, 3);
  assert.equal(progress['tt0000129'].episode, 7);
});

test('recordProgress falls back to a readable title', async () => {
  const { api } = loadProviders();
  await api.recordProgress('tt9', 'movie', null, null, null);
  assert.equal((await api.loadProgress())['tt9'].title, 'IMDb tt9');
});

test('schemaTypeFromImdbTypeId maps IMDb type ids', () => {
  const { api } = loadProviders();
  assert.equal(api.schemaTypeFromImdbTypeId('tvSeries'), 'TVSeries');
  assert.equal(api.schemaTypeFromImdbTypeId('tvMiniSeries'), 'TVMiniSeries');
  assert.equal(api.schemaTypeFromImdbTypeId('tvEpisode'), 'TVEpisode');
  assert.equal(api.schemaTypeFromImdbTypeId('movie'), 'Movie');
  // The "tv" prefix does not mean episodic.
  assert.equal(api.schemaTypeFromImdbTypeId('tvMovie'), 'Movie');
  assert.equal(api.schemaTypeFromImdbTypeId('tvSpecial'), 'Movie');
  assert.equal(api.schemaTypeFromImdbTypeId('tvShort'), 'Movie');
  assert.equal(api.schemaTypeFromImdbTypeId('unknownThing'), null);
  assert.equal(api.schemaTypeFromImdbTypeId(undefined), null);
});

test('isTvType covers every episodic type', () => {
  const { api } = loadProviders();
  for (const t of ['TVSeries', 'TVMiniSeries', 'TVEpisode', 'Series']) {
    assert.equal(api.isTvType(t), true, t);
  }
  for (const t of ['Movie', '', null, undefined, 'Book']) {
    assert.equal(api.isTvType(t), false, String(t));
  }
});
