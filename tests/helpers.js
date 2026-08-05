// Test harnesses for an extension with no build step.
//
// The source files are plain classic scripts that expect browser/service-worker
// globals (chrome.*, document, importScripts). Rather than restructure them
// into modules purely for testability, each helper below evaluates a file in a
// `vm` context seeded with the globals it would really get.
//
// Note: `function` declarations in a vm script land on the context's global
// object, so they can be reached as `sandbox.name`. `const`/`let` do not — use
// `vm.runInContext('name', sandbox)` for those.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Minimal in-memory chrome.storage area backed by a plain object.
function storageArea(bag) {
  return {
    get(key, cb) {
      const out = {};
      (Array.isArray(key) ? key : [key]).forEach(k => { if (k in bag) out[k] = bag[k]; });
      cb(out);
    },
    set(obj, cb) { Object.assign(bag, obj); if (cb) cb(); },
    remove(key, cb) {
      (Array.isArray(key) ? key : [key]).forEach(k => delete bag[k]);
      if (cb) cb();
    }
  };
}

// providers.js on its own, as the service worker sees it.
function loadProviders({ local = {}, sync = {} } = {}) {
  const sandbox = {
    console, URL,
    chrome: { storage: { local: storageArea(local), sync: storageArea(sync) }, runtime: {} }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('providers.js'), sandbox);
  return { api: sandbox, local, sync };
}

// background.js in a mocked MV3 service worker. `openPopupWorks: false`
// simulates chrome.action.openPopup() rejecting (no user gesture).
function loadBackground({ local = {}, sync = {}, openPopupWorks = true } = {}) {
  const createdTabs = [];
  const updatedTabs = [];
  const sandbox = {
    console, URL, TextEncoder,
    fetch: async () => { throw new Error('network disabled in tests'); },
    importScripts: (file) => vm.runInContext(read(file), sandbox),
    chrome: {
      storage: { local: storageArea(local), sync: storageArea(sync) },
      runtime: {
        lastError: null,
        onMessage: { addListener: () => {} },
        onInstalled: { addListener: () => {} }
      },
      contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
      commands: { onCommand: { addListener: () => {} } },
      action: {
        openPopup: async () => {
          if (!openPopupWorks) throw new Error('openPopup requires a user gesture');
        }
      },
      tabs: {
        create: (o) => createdTabs.push(o.url),
        update: (id, o) => updatedTabs.push(o.url),
        query: (q, cb) => cb([])
      }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('background.js'), sandbox);
  return { api: sandbox, local, sync, createdTabs, updatedTabs };
}

// content.js against a real DOM.
function loadContent(bodyHtml, { watchlist = [], url = 'https://news.example/thread' } = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(bodyHtml, { url });
  const { window } = dom;
  const sent = [];
  const storageListeners = [];

  const sandbox = {
    window, document: window.document, location: window.location,
    MutationObserver: window.MutationObserver, Node: window.Node, console,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    chrome: {
      runtime: {
        id: 'testextensionid',
        lastError: null,
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => {
          sent.push(msg);
          if (msg.action === 'getWatchlistIds') return cb && cb({ ids: [...watchlist] });
          if (msg.action === 'watch') return cb && cb({ ok: true, opened: 'movie' });
          if (msg.action === 'toggleWatchlist') {
            const saved = !watchlist.includes(msg.imdbId);
            if (saved) watchlist.push(msg.imdbId);
            else watchlist.splice(watchlist.indexOf(msg.imdbId), 1);
            return cb && cb({ saved });
          }
          if (cb) cb({});
        }
      },
      storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('content.js'), sandbox);
  // The manifest uses run_at: document_idle, so the script always sees a parsed
  // document. jsdom is still "loading" here, so fire the event it waits on.
  if (window.document.readyState === 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }
  return { window, doc: window.document, api: sandbox, sent, storageListeners };
}

// popup.html + providers.js + popup.js, as the popup page.
function loadPopup({ local = {}, tabUrl = 'https://news.example/', watchlist = [], details } = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(read('popup.html'), { url: 'chrome-extension://testid/popup.html' });
  const { window } = dom;
  const createdTabs = [];
  const updatedTabs = [];
  const errors = [];
  const defaultDetails = (id) => ({
    imdbId: id, type: 'Movie', title: 'Test Movie', year: 1994, genres: ['Drama']
  });

  const sandbox = {
    window, document: window.document, console, URL: window.URL, TextEncoder,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    fetch: async () => { throw new Error('network disabled in tests'); },
    chrome: {
      storage: { local: storageArea(local), sync: storageArea({}) },
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => {
          if (msg.action === 'inWatchlist') return cb && cb({ saved: watchlist.includes(msg.imdbId) });
          if (msg.action === 'getWatchlist') return cb && cb({ list: [] });
          if (msg.action === 'getContentDetails') {
            return cb && cb((details || defaultDetails)(msg.imdbId));
          }
          if (cb) cb({});
        }
      },
      tabs: {
        query: (q, cb) => cb([{ id: 1, url: tabUrl }]),
        create: (o) => createdTabs.push(o.url),
        update: (id, o) => updatedTabs.push(o.url)
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  vm.runInContext(read('providers.js'), sandbox);
  vm.runInContext(read('popup.js'), sandbox);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { window, doc: window.document, api: sandbox, local, createdTabs, updatedTabs, errors };
}

// Let queued callbacks and timers drain.
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// Objects built inside a vm context carry that context's prototypes, so
// assert.deepStrictEqual rejects them against a literal declared out here.
// Round-tripping re-homes the value in the test realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

module.exports = { loadProviders, loadBackground, loadContent, loadPopup, tick, plain, storageArea, read, ROOT };
