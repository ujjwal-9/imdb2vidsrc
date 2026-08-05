const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadContent, tick } = require('./helpers');

const counts = (doc) => ({
  buttons: doc.querySelectorAll('.vidsrc-watch-button').length,
  stars: doc.querySelectorAll('.vidsrc-star-button').length
});

test('every IMDb link gets its own button, even sharing one parent', () => {
  const { doc } = loadContent(`<body><p>
    <a href="https://www.imdb.com/title/tt0111161/">Shawshank</a> and
    <a href="https://www.imdb.com/title/tt0068646/">Godfather</a> and
    <a href="https://www.imdb.com/title/tt0071562/">Godfather II</a>
  </p></body>`);

  // The old parent-subtree guard meant only the first link was decorated.
  assert.equal(counts(doc).buttons, 3);
  assert.equal(counts(doc).stars, 3);
});

test('rescanning does not duplicate buttons', () => {
  const { doc, api } = loadContent('<body><p><a href="https://www.imdb.com/title/tt0111161/">A</a></p></body>');
  vm.runInContext('processPage(); processPage();', api);
  assert.equal(counts(doc).buttons, 1);
});

test('non-title links are ignored', () => {
  const { doc } = loadContent(`<body>
    <a href="https://www.imdb.com/name/nm0000151/">Actor</a>
    <a href="https://example.com/title/tt0111161">Not imdb</a>
  </body>`);
  assert.equal(counts(doc).buttons, 0);
});

test('injected controls are keyboard-reachable buttons', () => {
  const { doc } = loadContent('<body><a href="https://www.imdb.com/title/tt0111161/">A</a></body>');
  const watch = doc.querySelector('.vidsrc-watch-button');
  const star = doc.querySelector('.vidsrc-star-button');

  assert.equal(watch.tagName, 'BUTTON');
  assert.equal(watch.getAttribute('type'), 'button');
  assert.equal(star.tagName, 'BUTTON');
  assert.equal(star.getAttribute('aria-pressed'), 'false');
});

test('the watchlist is fetched once per page, not once per link', () => {
  const links = Array.from({ length: 25 },
    (_, i) => `<a href="https://www.imdb.com/title/tt${1000000 + i}/">L${i}</a>`).join('');
  const { sent } = loadContent(`<body><p>${links}</p></body>`);

  assert.equal(sent.filter(m => m.action === 'getWatchlistIds').length, 1);
  assert.equal(sent.filter(m => m.action === 'inWatchlist').length, 0, 'no per-link round trips');
});

test('pages with no IMDb links do no messaging at all', () => {
  const { sent } = loadContent('<body><p>Nothing here</p></body>');
  assert.deepEqual(sent, []);
});

test('saved titles render as filled stars', () => {
  const { doc } = loadContent(
    `<body>
      <a href="https://www.imdb.com/title/tt0111161/">A</a>
      <a href="https://www.imdb.com/title/tt0068646/">B</a>
    </body>`,
    { watchlist: ['tt0111161'] }
  );
  const stars = doc.querySelectorAll('.vidsrc-star-button');

  assert.equal(stars[0].textContent, '★');
  assert.equal(stars[0].getAttribute('aria-pressed'), 'true');
  assert.equal(stars[1].textContent, '☆');
});

test('clicking Watch delegates to the background instead of window.open', () => {
  const { doc, window, sent } = loadContent('<body><a href="https://www.imdb.com/title/tt0111161/">A</a></body>');
  let opened = 0;
  window.open = () => { opened++; };

  doc.querySelector('.vidsrc-watch-button')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(sent.filter(m => m.action === 'watch').map(m => m.imdbId), ['tt0111161']);
  assert.equal(opened, 0, 'no guessed URL opened from the page');
});

test('toggling one star updates every star for the same title', () => {
  const { doc, window } = loadContent(`<body>
    <a href="https://www.imdb.com/title/tt0111161/">A</a>
    <a href="https://www.imdb.com/title/tt0111161/">A again</a>
  </body>`);
  const stars = doc.querySelectorAll('.vidsrc-star-button');
  assert.equal(stars.length, 2);

  stars[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(stars[0].textContent, '★');
  assert.equal(stars[1].textContent, '★');
});

test('a watchlist change from the popup propagates into the page', () => {
  const { doc, storageListeners } = loadContent('<body><a href="https://www.imdb.com/title/tt0111161/">A</a></body>');
  assert.equal(storageListeners.length, 1);

  storageListeners[0]({ watchlist: { newValue: [{ imdbId: 'tt0111161' }] } }, 'sync');

  assert.equal(doc.querySelector('.vidsrc-star-button').textContent, '★');
});

test('links added later get buttons and trigger the watchlist fetch', async () => {
  const { doc, sent } = loadContent('<body><div id="host"></div></body>');
  assert.equal(sent.filter(m => m.action === 'getWatchlistIds').length, 0);

  doc.getElementById('host').innerHTML = '<a href="https://www.imdb.com/title/tt0903747/">BB</a>';
  await tick(400);

  assert.equal(counts(doc).buttons, 1);
  assert.equal(sent.filter(m => m.action === 'getWatchlistIds').length, 1);
});

test('the observer stops watching pages that never show an IMDb link', () => {
  const { api } = loadContent('<body><p>Nothing</p></body>');
  assert.notEqual(vm.runInContext('window.vidsrcObserver', api), null, 'observing initially');

  vm.runInContext('stopObserver()', api);
  assert.equal(vm.runInContext('window.vidsrcObserver', api), null);
});
