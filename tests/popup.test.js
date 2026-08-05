const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPopup, tick } = require('./helpers');

const CUSTOM_HOST_SETTINGS = {
  settings: { baseUrl: 'mymirror.example', defaultProviderId: 'custom', enabledProviderIds: ['custom'] }
};

test('initialises cleanly on a page with no title', async () => {
  const { doc, errors, local } = loadPopup();
  await tick();

  assert.deepEqual(errors, []);
  assert.equal(doc.querySelectorAll('#provider-toggles input').length, 8);
  assert.equal(doc.querySelectorAll('#default-provider option').length, 8);
  assert.equal(doc.getElementById('base-url').value, 'vidsrc.icu');
  assert.equal(doc.getElementById('empty-state').classList.contains('hidden'), false);
  assert.ok(!('contentType' in local), 'legacy key cleaned up');
});

test('a stale watch handoff is ignored', async () => {
  const local = { lastClicked: { imdbId: 'tt0111161', at: Date.now() - 60_000 } };
  const { doc } = loadPopup({ local });
  await tick();

  assert.ok(!('lastClicked' in local), 'cleared from storage either way');
  assert.equal(doc.getElementById('title').textContent, '', 'did not load the stale title');
});

test('a fresh watch handoff is honoured', async () => {
  const local = { lastClicked: { imdbId: 'tt0111161', at: Date.now() } };
  const { doc } = loadPopup({ local });
  await tick();

  assert.ok(!('lastClicked' in local), 'consumed');
  assert.equal(doc.getElementById('title').textContent, 'Test Movie');
  assert.equal(doc.getElementById('watch-button').classList.contains('hidden'), false);
});

test('a custom provider host is detected as a player tab', async () => {
  const { doc } = loadPopup({
    local: CUSTOM_HOST_SETTINGS,
    tabUrl: 'https://mymirror.example/embed/movie/tt0111161'
  });
  await tick();

  assert.equal(doc.getElementById('title').textContent, 'Test Movie');
  assert.equal(doc.getElementById('error-message').classList.contains('hidden'), true);
});

test('watching from a player tab reuses that tab', async () => {
  const { doc, window, createdTabs, updatedTabs } = loadPopup({
    local: CUSTOM_HOST_SETTINGS,
    tabUrl: 'https://mymirror.example/embed/movie/tt0111161'
  });
  await tick();

  doc.getElementById('watch-button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();

  assert.deepEqual(updatedTabs, ['https://mymirror.example/embed/movie/tt0111161']);
  assert.deepEqual(createdTabs, []);
});

test('tabs expose ARIA state and respond to arrow keys', async () => {
  const { doc, window } = loadPopup();
  await tick();

  const tabs = [...doc.querySelectorAll('.tab')];
  assert.ok(tabs.every(t => t.getAttribute('role') === 'tab'));
  assert.ok([...doc.querySelectorAll('.tab-content')].every(p => p.getAttribute('role') === 'tabpanel'));
  assert.equal(tabs.filter(t => t.getAttribute('aria-selected') === 'true').length, 1);

  tabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

  assert.equal(doc.querySelector('.tab[data-tab="search"]').getAttribute('aria-selected'), 'true');
  assert.equal(doc.querySelector('.tab[data-tab="search"]').tabIndex, 0);
  assert.equal(doc.querySelector('.tab[data-tab="watch"]').tabIndex, -1);
  assert.equal(doc.getElementById('search-tab').classList.contains('active'), true);
});

test('an invalid custom host is rejected and nothing is persisted', async () => {
  const { doc, window, local } = loadPopup();
  await tick();

  doc.getElementById('base-url').value = 'not a host!!';
  doc.getElementById('save-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.match(doc.querySelector('.settings-saved').textContent, /valid host/i);
  assert.equal(local.settings, undefined);
});

test('a custom host is normalised before being stored', async () => {
  const { doc, window, local } = loadPopup();
  await tick();

  doc.getElementById('base-url').value = 'https://Mirror.Example/embed/';
  doc.getElementById('save-settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();

  assert.equal(local.settings.baseUrl, 'mirror.example');
  assert.equal(doc.getElementById('base-url').value, 'mirror.example');
});

test('provider chips are keyboard-reachable buttons', async () => {
  const { doc } = loadPopup({ local: { lastClicked: { imdbId: 'tt0111161', at: Date.now() } } });
  await tick();

  const chips = [...doc.querySelectorAll('#provider-chips .chip')];
  assert.ok(chips.length > 0);
  assert.ok(chips.every(c => c.tagName === 'BUTTON'));
  assert.equal(chips.filter(c => c.getAttribute('aria-pressed') === 'true').length, 1);
});

test('season and episode inputs allow long-running series', async () => {
  const { doc, window } = loadPopup();
  await tick();

  const season = doc.getElementById('season');
  const episode = doc.getElementById('episode');
  assert.equal(season.max, '200');
  assert.equal(episode.max, '2000');

  // An anime season with hundreds of episodes must be enterable.
  episode.value = '500';
  episode.dispatchEvent(new window.Event('input'));
  assert.equal(episode.value, '500');

  // Beyond the ceiling still clamps.
  episode.value = '5000';
  episode.dispatchEvent(new window.Event('input'));
  assert.equal(episode.value, '2000');
});

test('a cleared number field can be retyped, and normalises on blur', async () => {
  const { doc, window } = loadPopup();
  await tick();
  const episode = doc.getElementById('episode');

  episode.value = '';
  episode.dispatchEvent(new window.Event('input'));
  assert.equal(episode.value, '', 'not force-rewritten to 1 mid-edit');

  episode.dispatchEvent(new window.Event('blur'));
  assert.equal(episode.value, '1');
});

test('a slow season fetch cannot overwrite a newer one', async () => {
  const { doc, api } = loadPopup();
  await tick();

  api.fetchEpisodes = async (imdbId, season) => {
    await new Promise(r => setTimeout(r, season === 2 ? 150 : 10));
    return [{ number: 1, title: `S${season}E1`, airDate: null }];
  };

  // Season 2 is requested first but resolves last.
  const slow = api.loadEpisodeList('tt0903747', 2);
  const fast = api.loadEpisodeList('tt0903747', 3);
  await Promise.all([slow, fast]);
  await tick(200);

  const titles = [...doc.querySelectorAll('#episode-list .title')].map(el => el.textContent);
  assert.deepEqual(titles, ['S3E1'], 'the season the user actually selected wins');
});

test('a previous error is cleared when the next title loads', async () => {
  const details = (id) => (id === 'tt-bad'
    ? { imdbId: id, error: 'Failed to fetch content details.' }
    : { imdbId: id, type: 'Movie', title: 'Good Movie' });

  const { doc, api } = loadPopup({ details });
  await tick();

  api.fetchContent('tt-bad', 'movie', null);
  await tick();
  assert.equal(doc.getElementById('error-message').classList.contains('hidden'), false);

  api.fetchContent('tt-good', 'movie', null);
  await tick();
  assert.equal(doc.getElementById('error-message').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('title').textContent, 'Good Movie');
});

test('metadata is rendered as text, never as markup', async () => {
  const details = (id) => ({
    imdbId: id, type: 'Movie', title: 'Injected',
    year: 1994, rating: 9.3, ratingCount: 2500000,
    genres: ['<img src=x onerror="window.__pwned=1">', 'Drama']
  });

  const { doc, window } = loadPopup({
    details,
    local: { lastClicked: { imdbId: 'tt0111161', at: Date.now() } }
  });
  await tick();

  const infoRow = doc.getElementById('info-row');
  assert.equal(infoRow.querySelectorAll('img').length, 0, 'no element created from the payload');
  assert.equal(window.__pwned, undefined);
  assert.match(infoRow.textContent, /<img src=x/, 'shown literally as text');
  assert.match(infoRow.textContent, /★ 9\.3 \(2\.5M\)/);
});
