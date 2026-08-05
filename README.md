# imdb2vidsrc

A Chrome extension that turns any IMDb title into a playable link. It adds a
**▶ Watch** button next to IMDb links on any page, resolves whether the title is
a movie or a series, and opens it on your chosen embed provider.

## Features

- **Inline Watch buttons** on every IMDb title link, on any site.
- **Provider switcher** — seven presets plus a custom host, switchable per title.
- **Episode browser** — pulls the real episode list (titles and air dates) for a
  season, with a persistent 6-hour cache.
- **Continue watching** — remembers the last season/episode per series and
  offers Resume / Next episode.
- **Watchlist** — star any title; synced across your Chrome profiles.
- **Search** — find titles by name without leaving the popup.
- **Keyboard shortcuts** for next/previous episode and cycling providers.

## Install

The extension is not on the Chrome Web Store. Load it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder.

## Usage

| Where | What happens |
|---|---|
| Any page with IMDb links | **▶ Watch** opens the title; **☆** saves it to your watchlist |
| Right-click an IMDb link | **Open in Vidsrc** context menu entry |
| Toolbar icon on an IMDb page | Popup opens pre-filled with that title |
| Toolbar icon on a player page | Popup detects the current season/episode |

Movies open directly. Series open the popup so you can pick a season and
episode; if the popup can't be opened programmatically, the extension falls
back to your last watched episode (or S1E1).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Shift + Y` | Open the popup |
| `Alt + Shift + →` | Next episode (on a player tab) |
| `Alt + Shift + ←` | Previous episode (on a player tab) |
| `Alt + Shift + P` | Cycle to the next enabled provider |

Rebind these at `chrome://extensions/shortcuts`.

## Providers

Providers are defined in `providers.js` as URL templates using `{imdb}`,
`{season}`, and `{episode}` placeholders. Enable/disable them and pick a default
in the popup's **Settings** tab. The **Custom** provider builds vidsrc-style
URLs from whatever host you enter, so new mirrors work without a code change.

These are third-party embed hosts. They go down, change paths, and serve ads
without warning — if one fails, switch providers with `Alt + Shift + P`.

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest, permissions, commands |
| `providers.js` | Provider registry, URL building/parsing, shared storage helpers |
| `background.js` | Service worker: IMDb metadata fetching, caching, watchlist, shortcuts |
| `content.js` | Injects Watch/star buttons into pages |
| `popup.html` / `popup.js` | Popup UI: watch, search, saved, history, settings |

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read the current tab's URL to detect the title being viewed |
| `contextMenus` | The "Open in Vidsrc" right-click entry |
| `storage` | Settings, watch history, metadata cache (local); watchlist (sync) |
| `*://*.imdb.com/*` | Fetch title metadata and episode lists |
| `*://*.media-imdb.com/*` | Title search suggestions |

The content script runs on all URLs so IMDb links work anywhere. On pages with
no IMDb links it does nothing and stops observing after 30 seconds.

## Development

No build step — edit the files and hit **Reload** on `chrome://extensions`.
Reloading invalidates content scripts on open tabs, so refresh any page you're
testing against.

### Tests

```sh
npm install   # dev-only; jsdom, for the DOM-backed tests
npm test
```

The extension ships no bundled code — `node_modules` is for the test suite
alone. Tests run on Node's built-in runner and never touch the network.

| File | Covers |
|---|---|
| `tests/providers.test.js` | URL building/parsing round trips, host normalisation, history capping |
| `tests/background.test.js` | Watch routing (movie/series/episode), metadata decoding, caching, watchlist quota |
| `tests/content.test.js` | Button injection, batched watchlist, observer lifecycle |
| `tests/popup.test.js` | Popup init, handoff expiry, tab a11y, settings validation, episode-list races |

`tests/helpers.js` loads each source file in a `vm` context seeded with the
globals it would get in Chrome (`chrome.*`, `document`, `importScripts`), so the
sources stay plain classic scripts with no module wrapper.

## License

See [LICENSE](LICENSE).
