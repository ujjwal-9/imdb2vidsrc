// Injects a "▶ Watch" button and a watchlist star next to every IMDb title
// link on the page. Runs on all sites so links on Reddit/blogs/etc. are
// covered, which means the idle-page cost has to stay near zero — see
// startObserver() for the bail-out rules.

const IMDB_LINK_SELECTOR = 'a[href*="imdb.com/title/"]';
const OBSERVER_GIVE_UP_MS = 30 * 1000;

// Watchlist state, fetched once per page instead of once per link.
const watchlistIds = new Set();
let watchlistLoaded = false;
// imdbId -> Set of star elements, so duplicate links to the same title all
// update together.
const starsById = new Map();

let foundAnyLink = false;

// chrome.* calls throw once the extension is reloaded/updated underneath us.
function extensionAlive() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// Wrapper that swallows the "Unchecked runtime.lastError" console noise that
// otherwise appears on every page after an extension reload.
function sendMessage(message, callback) {
  if (!extensionAlive()) {
    if (callback) callback(null);
    return;
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (callback) callback(err ? null : response);
    });
  } catch {
    if (callback) callback(null);
  }
}

// ---- Watchlist ----

// Fetched at most once per page, and only once a title link actually exists —
// links can appear dynamically, so this is called from the observer too.
let watchlistRequested = false;

function ensureWatchlistLoaded() {
  if (watchlistRequested || !foundAnyLink) return;
  watchlistRequested = true;
  loadWatchlistIds();
}

function loadWatchlistIds() {
  sendMessage({ action: 'getWatchlistIds' }, (resp) => {
    if (!resp || !Array.isArray(resp.ids)) return;
    watchlistIds.clear();
    resp.ids.forEach(id => watchlistIds.add(id));
    watchlistLoaded = true;
    refreshAllStars();
  });
}

function refreshAllStars() {
  for (const [imdbId, stars] of starsById) {
    stars.forEach(star => renderStar(star, watchlistIds.has(imdbId)));
  }
}

function registerStar(imdbId, star) {
  let set = starsById.get(imdbId);
  if (!set) {
    set = new Set();
    starsById.set(imdbId, set);
  }
  set.add(star);
}

function renderStar(star, saved) {
  star.textContent = saved ? '★' : '☆';
  star.style.background = saved ? '#f50' : '#fff';
  star.style.color = saved ? '#fff' : '#f50';
  star.title = saved ? 'Remove from watchlist' : 'Save to watchlist';
  star.setAttribute('aria-pressed', saved ? 'true' : 'false');
}

// Keep in sync when the popup toggles something while the page is open.
if (extensionAlive()) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.watchlist) return;
    const list = Array.isArray(changes.watchlist.newValue) ? changes.watchlist.newValue : [];
    watchlistIds.clear();
    list.forEach(e => e && e.imdbId && watchlistIds.add(e.imdbId));
    watchlistLoaded = true;
    refreshAllStars();
  });
}

// ---- Button injection ----

// Shared styling so the injected controls survive hostile page CSS.
const BASE_BUTTON_CSS = `
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  font-size: 12px;
  line-height: 1.2;
  border-radius: 3px;
  text-decoration: none;
  cursor: pointer;
  display: inline-block;
  vertical-align: middle;
  box-sizing: border-box;
`;

function flashError(el, message) {
  const previousTitle = el.title;
  el.title = message;
  el.style.opacity = '0.5';
  setTimeout(() => {
    el.style.opacity = '';
    el.title = previousTitle;
  }, 2000);
}

function addVidsrcButton(link) {
  // One button per link. (Deliberately not checking the parent's subtree —
  // several IMDb links commonly share a parent and each needs its own button.)
  if (link.dataset.vidsrcButton === '1') return;

  if (!link.href || !link.href.includes('imdb.com/title/')) return;

  const imdbId = link.href.match(/\/title\/(tt\d+)/)?.[1];
  if (!imdbId) return;

  link.dataset.vidsrcButton = '1';
  foundAnyLink = true;

  // Watch button (orange). A real <button> so it is keyboard reachable.
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '▶ Watch';
  button.className = 'vidsrc-watch-button';
  button.style.cssText = BASE_BUTTON_CSS + `
    margin-left: 5px;
    padding: 2px 6px;
    background: #f50;
    color: white;
    border: 1px solid #f50;
  `;

  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!extensionAlive()) {
      flashError(button, 'Extension was reloaded — refresh this page.');
      return;
    }
    button.disabled = true;
    // The service worker resolves movie vs. TV, honours the configured
    // provider, and opens the tab itself. Doing it here would mean guessing
    // the type and losing the user gesture across the async hop.
    sendMessage({ action: 'watch', imdbId }, (resp) => {
      button.disabled = false;
      if (!resp || !resp.ok) flashError(button, (resp && resp.error) || 'Could not open — try the toolbar icon.');
    });
  });

  // Star toggle for watchlist.
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'vidsrc-star-button';
  star.style.cssText = BASE_BUTTON_CSS + `
    margin-left: 4px;
    padding: 2px 5px;
    border: 1px solid #f50;
    line-height: 1;
  `;
  renderStar(star, watchlistLoaded && watchlistIds.has(imdbId));
  registerStar(imdbId, star);

  star.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!extensionAlive()) {
      flashError(star, 'Extension was reloaded — refresh this page.');
      return;
    }
    sendMessage({ action: 'toggleWatchlist', imdbId }, (resp) => {
      if (!resp) return flashError(star, 'Could not update watchlist.');
      if (resp.error) return flashError(star, resp.error);
      if (resp.saved) watchlistIds.add(imdbId);
      else watchlistIds.delete(imdbId);
      const stars = starsById.get(imdbId);
      if (stars) stars.forEach(s => renderStar(s, resp.saved));
    });
  });

  link.parentNode.insertBefore(button, link.nextSibling);
  link.parentNode.insertBefore(star, button.nextSibling);
}

function scanRoot(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(IMDB_LINK_SELECTOR).forEach(addVidsrcButton);
}

// ---- Page processing ----

let pendingNodes = [];
let scanScheduled = false;

function scheduleScan(nodes) {
  pendingNodes.push(...nodes);
  if (scanScheduled) return;
  scanScheduled = true;
  // Batch bursts of mutations — SPA route changes fire hundreds at once.
  setTimeout(() => {
    scanScheduled = false;
    const batch = pendingNodes;
    pendingNodes = [];
    for (const node of batch) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(IMDB_LINK_SELECTOR)) addVidsrcButton(node);
      scanRoot(node);
    }
    // The page's first IMDb link may only have shown up just now.
    ensureWatchlistLoaded();
  }, 150);
}

function startObserver() {
  if (window.vidsrcObserver || !document.body) return;

  window.vidsrcObserver = new MutationObserver((mutations) => {
    const added = [];
    for (const mutation of mutations) {
      if (mutation.addedNodes.length) added.push(...mutation.addedNodes);
    }
    if (added.length) scheduleScan(added);
  });

  window.vidsrcObserver.observe(document.body, { childList: true, subtree: true });

  // On the overwhelming majority of pages there will never be an IMDb link.
  // Give late-loading SPAs a window to produce one, then stop watching so we
  // aren't running a subtree observer on every tab for the whole session.
  if (!foundAnyLink && location.hostname !== 'www.imdb.com' && location.hostname !== 'imdb.com') {
    setTimeout(() => {
      if (!foundAnyLink) stopObserver();
    }, OBSERVER_GIVE_UP_MS);
  }
}

function stopObserver() {
  if (!window.vidsrcObserver) return;
  window.vidsrcObserver.disconnect();
  window.vidsrcObserver = null;
}

function processPage() {
  try {
    scanRoot(document);
    // Only fetch the watchlist if this page actually has titles on it.
    ensureWatchlistLoaded();
    startObserver();
  } catch (error) {
    console.log('Error in processPage:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', processPage);
} else {
  processPage();
}

// Handle extension context invalidation
window.addEventListener('error', (event) => {
  if (event.error && event.error.message &&
      event.error.message.includes('Extension context invalidated')) {
    console.log('Extension context was invalidated. Some functionality may be limited.');
    stopObserver();
  }
});

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'getImdbInfo') {
    const imdbId = window.location.href.match(/\/title\/(tt\d+)/)?.[1];
    sendResponse({
      imdbId: imdbId,
      success: !!imdbId,
      message: imdbId ? undefined : 'Not on an IMDb page'
    });
  }
  // No async responses from this listener, so don't hold the channel open.
});
