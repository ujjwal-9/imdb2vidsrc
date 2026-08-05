const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadBackground, loadPopup, tick } = require('./helpers');
const fx = require('./fixtures');

// CACHE_VERSION is a const, so it isn't on the sandbox global. Reading it keeps
// these tests from needing an edit every time it is bumped.
const cacheVersion = (api) => vm.runInContext('CACHE_VERSION', api);

// Model the two endpoints separately: www.imdb.com (the HTML page, which can be
// refused) and media-imdb.com (the suggestion API).
function serving(pages, { suggestions = null, blockPage = false } = {}) {
  const { api, ...rest } = loadBackground({});
  const pageRequests = [];
  api.fetch = async (url) => {
    const id = (url.match(/(tt\d+)/) || [])[1];

    if (url.includes('media-imdb.com')) {
      const row = suggestions && suggestions[id];
      return { ok: true, status: 200, json: async () => ({ d: row ? [row] : [] }) };
    }

    pageRequests.push(url);
    if (blockPage) throw new Error('HTTP error! Status: 403');
    const html = typeof pages === 'string' ? pages : (pages && pages[id]);
    if (html == null) throw new Error('no fixture for ' + url);
    return { ok: true, status: 200, text: async () => html };
  };
  return { api, pageRequests, ...rest };
}

test('classifies a movie', async () => {
  const { api } = serving(fx.movie);
  const details = await api.getContentDetails('tt0111161');
  assert.equal(details.type, 'Movie');
  assert.equal(details.title, 'The Shawshank Redemption');
  assert.equal(details.year, 1994);
  assert.equal(api.isTvType(details.type), false);
});

test('classifies a TV series', async () => {
  const { api } = serving(fx.series);
  const details = await api.getContentDetails('tt0903747');
  assert.equal(details.type, 'TVSeries');
  assert.equal(api.isTvType(details.type), true);
});

test('classifies a mini-series as TV, not a movie', async () => {
  const { api } = serving(fx.miniSeries);
  const details = await api.getContentDetails('tt7366338');
  assert.equal(details.type, 'TVMiniSeries');
  assert.equal(api.isTvType(details.type), true, 'mini-series must get episode controls');
});

test('classifies an anime series as TV and an anime film as a movie', async () => {
  const seriesRun = serving(fx.animeSeries);
  assert.equal(api2Tv(await seriesRun.api.getContentDetails('tt2560140'), seriesRun.api), true);

  const filmRun = serving(fx.animeMovie);
  assert.equal(api2Tv(await filmRun.api.getContentDetails('tt5311514'), filmRun.api), false);
});

function api2Tv(details, api) {
  return api.isTvType(details.type);
}

test('an episode resolves to its parent series with episode context', async () => {
  const { api } = serving({ tt2301451: fx.episode, tt0903747: fx.series });
  const details = await api.getContentDetails('tt2301451');

  assert.equal(details.imdbId, 'tt0903747', 'swapped to the series id');
  assert.equal(details.type, 'TVSeries');
  assert.equal(details.episodeContext.season, 5);
  assert.equal(details.episodeContext.episode, 14);
  assert.equal(details.episodeContext.episodeTitle, 'Ozymandias');
});

test('a series is still detected when JSON-LD is missing entirely', async () => {
  const { api } = serving(fx.seriesNoJsonLd);
  const details = await api.getContentDetails('tt0903747');
  assert.equal(details.type, 'TVSeries', 'og:type carries it when JSON-LD is gone');
  assert.equal(api.isTvType(details.type), true);
});

test('a mini-series is detected from IMDb titleType alone', async () => {
  const { api } = serving(fx.miniSeriesOnlyTitleType);
  const details = await api.getContentDetails('tt7366338');
  assert.equal(details.type, 'TVMiniSeries');
});

test('canHaveEpisodes is a last-resort series signal', async () => {
  const { api } = serving(fx.seriesOnlyEpisodeHint);
  const details = await api.getContentDetails('tt1');
  assert.equal(details.type, 'TVSeries');
});

test('a page-level series signal overrides a JSON-LD Movie default', async () => {
  const { api } = serving(fx.seriesGenericJsonLd);
  const details = await api.getContentDetails('tt1');
  assert.equal(details.type, 'TVSeries', 'generic JSON-LD must not force Movie');
});

test('an array @type still resolves to TVSeries', async () => {
  const { api } = serving(fx.seriesArrayType);
  const details = await api.getContentDetails('tt1');
  assert.equal(details.type, 'TVSeries');
});

test('an episode without partOfSeries still finds its parent series', async () => {
  const { api } = serving({ tt2301451: fx.episodeNoParentInJsonLd, tt0903747: fx.series });
  const details = await api.getContentDetails('tt2301451');
  assert.equal(details.imdbId, 'tt0903747');
  assert.equal(details.episodeContext.episode, 14);
});

test('a movie page is never upgraded to TV', async () => {
  const { api } = serving(fx.movie);
  const details = await api.getContentDetails('tt0111161');
  assert.equal(details.type, 'Movie');
});

test('detectTypeFromHtml returns null when there is no signal', () => {
  const { api } = loadBackground({});
  assert.equal(api.detectTypeFromHtml('<html><body>nothing</body></html>'), null);
});

test('watch routing follows detection for each shape', async () => {
  for (const [fixture, expected] of [
    [fx.movie, 'movie'],
    [fx.series, 'tv'],
    [fx.miniSeries, 'tv'],
    [fx.animeSeries, 'tv'],
    [fx.animeMovie, 'movie'],
    [fx.seriesNoJsonLd, 'tv']
  ]) {
    const { api, createdTabs } = serving(fixture);
    // openPopup would swallow the TV case, so force the direct path.
    api.chrome.action.openPopup = async () => { throw new Error('no gesture'); };
    await api.handleWatchRequest('tt1');
    const url = createdTabs[0] || '';
    const got = url.includes('/embed/tv/') ? 'tv' : 'movie';
    assert.equal(got, expected, `expected ${expected} for ${url}`);
  }
});

// ---- Popup side ----

test('the popup shows episode controls for a mini-series', async () => {
  const { doc } = loadPopup({
    local: { lastClicked: { imdbId: 'tt7366338', at: Date.now() } },
    details: (id) => ({ imdbId: id, type: 'TVMiniSeries', title: 'Chernobyl', year: 2019 })
  });
  await tick();

  assert.equal(doc.getElementById('content-type').value, 'tv', 'detected as TV');
  assert.equal(doc.getElementById('tv-controls').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('movie-controls').classList.contains('hidden'), true);
  assert.match(doc.getElementById('id-row').textContent, /TV Mini-Series/);
});

test('the popup shows movie controls for a film', async () => {
  const { doc } = loadPopup({
    local: { lastClicked: { imdbId: 'tt0111161', at: Date.now() } },
    details: (id) => ({ imdbId: id, type: 'Movie', title: 'Shawshank', year: 1994 })
  });
  await tick();

  assert.equal(doc.getElementById('content-type').value, 'movie');
  assert.equal(doc.getElementById('tv-controls').classList.contains('hidden'), true);
  assert.match(doc.getElementById('id-row').textContent, /Movie/);
});

test('the popup treats every TV type as TV', async () => {
  for (const type of ['TVSeries', 'TVMiniSeries', 'TVEpisode', 'Series']) {
    const { doc } = loadPopup({
      local: { lastClicked: { imdbId: 'tt1', at: Date.now() } },
      details: (id) => ({ imdbId: id, type, title: 'X' })
    });
    await tick();
    assert.equal(doc.getElementById('content-type').value, 'tv', `${type} should be tv`);
  }
});

test('a cache written by the older parser is discarded on startup', async () => {
  // A title wrongly stored as Movie before detection was hardened.
  const local = {
    contentCache: {
      tt0903747: { details: { imdbId: 'tt0903747', type: 'Movie', title: 'Breaking Bad' }, timestamp: Date.now() }
    }
    // no contentCacheVersion -> written by an older build
  };
  const { api } = loadBackground({ local });
  await tick(10);

  api.fetch = async () => ({ ok: true, status: 200, text: async () => fx.series });
  const details = await api.resolveDetails('tt0903747');

  assert.equal(details.type, 'TVSeries', 'stale Movie entry must not be served');
  assert.equal(local.contentCacheVersion, cacheVersion(api));
});

test('a current-version cache is kept', async () => {
  // Read the version from a throwaway instance so this survives future bumps.
  const local = {
    contentCacheVersion: cacheVersion(loadBackground({}).api),
    contentCache: {
      tt1: { details: { imdbId: 'tt1', type: 'TVSeries', title: 'Cached Show' }, timestamp: Date.now() }
    }
  };
  const { api } = loadBackground({ local });
  await tick(10);

  api.fetch = async () => { throw new Error('should not refetch'); };
  const details = await api.resolveDetails('tt1');
  assert.equal(details.title, 'Cached Show');
});

// ---- www.imdb.com refusing extension fetches ----
// This is the real-world failure: the page 404s/403s/returns an empty body, the
// scrape yields nothing, and every title silently becomes a movie.

test('a series is still detected when the IMDb page is refused', async () => {
  const { api } = serving(null, {
    blockPage: true,
    suggestions: { tt0944947: fx.gotSuggestion }
  });

  const details = await api.getContentDetails('tt0944947');

  assert.equal(details.type, 'TVSeries', 'suggestion endpoint settles the type');
  assert.equal(api.isTvType(details.type), true);
  assert.equal(details.title, 'Game of Thrones');
  assert.equal(details.year, 2011);
  assert.ok(!details.error, 'a usable result is not an error');
});

test('Game of Thrones routes to a tv URL with the page blocked', async () => {
  const { api, createdTabs } = serving(null, {
    blockPage: true,
    suggestions: { tt0944947: fx.gotSuggestion }
  });
  api.chrome.action.openPopup = async () => { throw new Error('no gesture'); };

  await api.handleWatchRequest('tt0944947');

  assert.equal(createdTabs.length, 1);
  assert.match(createdTabs[0], /\/embed\/tv\/tt0944947\//, `got ${createdTabs[0]}`);
  assert.ok(!createdTabs[0].includes('/embed/movie/'), 'must not build a movie URL');
});

test('a film is still a film when the page is refused', async () => {
  const { api } = serving(null, {
    blockPage: true,
    suggestions: {
      tt0111161: fx.suggestionRow({ id: 'tt0111161', qid: 'movie', title: 'The Shawshank Redemption', year: 1994 })
    }
  });
  const details = await api.getContentDetails('tt0111161');
  assert.equal(details.type, 'Movie');
  assert.equal(api.isTvType(details.type), false);
});

test('a mini-series is detected when the page is refused', async () => {
  const { api } = serving(null, {
    blockPage: true,
    suggestions: { tt7366338: fx.suggestionRow({ id: 'tt7366338', qid: 'tvMiniSeries', title: 'Chernobyl', year: 2019 }) }
  });
  assert.equal((await api.getContentDetails('tt7366338')).type, 'TVMiniSeries');
});

test('tvMovie is a film despite the tv prefix', async () => {
  const { api } = serving(null, {
    blockPage: true,
    suggestions: { tt1: fx.suggestionRow({ id: 'tt1', qid: 'tvMovie', title: 'A TV Movie' }) }
  });
  const details = await api.getContentDetails('tt1');
  assert.equal(details.type, 'Movie', 'startsWith("tv") would get this wrong');
});

test('both sources failing still reports an error', async () => {
  const { api } = serving(null, { blockPage: true, suggestions: {} });
  const details = await api.getContentDetails('tt0944947');
  assert.equal(details.title, 'Unknown Title');
  assert.ok(details.error, 'no usable data must surface as an error');
});

test('the suggestion settles a disagreement with the scraped page', async () => {
  const { api } = serving(fx.movie, {
    // Deliberately contradictory: the page parsed as a film, IMDb says series.
    suggestions: { tt0111161: fx.suggestionRow({ id: 'tt0111161', qid: 'tvSeries', title: 'Actually A Series' }) }
  });
  const details = await api.getContentDetails('tt0111161');
  assert.equal(details.type, 'TVSeries', 'IMDb\'s own type index outranks the scrape');
});

test('a fully resolved episode is not flattened by the suggestion', async () => {
  const { api } = serving({ tt2301451: fx.episode, tt0903747: fx.series }, {
    suggestions: {
      tt2301451: fx.suggestionRow({ id: 'tt2301451', qid: 'tvEpisode', title: 'Ozymandias' }),
      tt0903747: fx.suggestionRow({ id: 'tt0903747', qid: 'tvSeries', title: 'Breaking Bad' })
    }
  });
  const details = await api.getContentDetails('tt2301451');

  assert.equal(details.imdbId, 'tt0903747', 'still resolved to the parent series');
  assert.equal(details.episodeContext.season, 5);
  assert.equal(details.episodeContext.episode, 14);
});

test('page-derived richness survives alongside the suggestion type', async () => {
  const { api } = serving(fx.series, {
    suggestions: { tt0903747: fx.suggestionRow({ id: 'tt0903747', qid: 'tvSeries', title: 'Breaking Bad' }) }
  });
  const details = await api.getContentDetails('tt0903747');
  assert.equal(details.type, 'TVSeries');
  assert.deepEqual([...(details.genres || [])], ['Crime', 'Drama'], 'genres still come from the page');
});

test('the suggestion fills gaps the blocked page left behind', async () => {
  const { api } = serving(null, {
    blockPage: true,
    suggestions: { tt0944947: fx.gotSuggestion }
  });
  const details = await api.getContentDetails('tt0944947');
  assert.equal(details.poster, 'https://m.media-amazon.com/images/M/got.jpg');
  assert.equal(details.title, 'Game of Thrones');
});
