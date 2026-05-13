# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

PathogenWatch is a **single-file static HTML application** — `index.html`. There is no build step, no package manager, no server. Open the file directly in a browser to run it. All dependencies are loaded from CDN at runtime.

## Running / developing

Open `index.html` directly in a browser, or serve it locally:

```
# Python (any directory)
python -m http.server 8080

# Node (if npx available)
npx serve .
```

There are no tests, no lint commands, and no compilation step.

## Architecture

### Single-file structure

All HTML, CSS, and JavaScript live in `pathogenwatch.html` in this order:

1. `<style>` — CSS variables + all component styles (no external stylesheet)
2. HTML body — landing screen, header, tab nav, three tab panels
3. `<script>` — data arrays, then all JS functions, then init calls at the bottom

### Data layer (top of `<script>`)

Three main data arrays drive all UI:

- **`CASES`** — country-level outbreak entries. Each entry has `{name, flag, status, cases, deaths, city, lat, lon, note, iso, sources[]}`. `iso` is the numeric ISO 3166-1 code (as string) used to match TopoJSON country features for choropleth coloring.
- **`TRAVEL`** — travel risk entries per country `{name, flag, risk, summary, rec}`. Risk levels: `extreme > high > moderate > low > minimal`.
- **`NEWS_STATIC`** — static news feed items `{src, time, title, tag, url}`. Tags: `c` (confirmed), `d` (death), `w` (WHO), `u` (update).
- **`CONTACTS`** — sub-national contact trace nodes `{id, city, country, flag, lat, lng, count, status, from, route, days, daysTotal, note, source, url}`. `from` is a `[lat, lng]` coordinate for the arc origin — either `SHIP_POS` (Tenerife) or `ROME_FCO` (Italy flight contacts).

Two constants define arc origins: `SHIP_POS = [28.29, -16.63]` and `ROME_FCO = [41.80, 12.25]`.

### Map layer (Leaflet + TopoJSON)

`buildMap()` runs once (guarded by `mapReady` flag), triggered 400ms after `enterApp()`. It:
1. Initialises a Leaflet map on `#map` with a dark CartoDB tile layer
2. Fetches world TopoJSON from jsDelivr CDN and builds a choropleth using `isoMap` (a lookup of ISO code → CASES entry built at startup)
3. Draws the ship route polyline and waypoint markers
4. Adds `L.marker` for each CASES entry with pulsing divIcon for confirmed/suspected

`colFor(status)` maps status strings to hex colors — update this if adding new statuses.

### Contact trace layer

`buildTraceLayer()` creates a `traceLayerGroup` (Leaflet LayerGroup) containing:
- A ship origin marker at Tenerife with a CSS pulse animation
- A hollow waypoint marker at Rome Fiumicino
- One arc (dashed, animated via `.ct-arc-line` / `.ct-arc-sub` CSS classes) per CONTACTS entry, drawn using `arcPoints(from, to)` which computes a quadratic Bézier curve with a perpendicular midpoint offset
- One `L.circleMarker` per contact node, radius scaled by `count`

The layer is toggled via `showTraceLayer()` / `hideTraceLayer()`, called from `setFilter('contacts', btn)`. The layer is lazily built on first activation.

Arc animation works because Leaflet sets `className` directly on the SVG `<path>` element, so `stroke-dasharray` + `animation: dashflow` CSS applies directly.

### Tab + filter state

- `switchTab(name, btn)` shows/hides `.tab-content` divs
- `setFilter(f, btn)` drives the left panel: `'contacts'` activates the trace layer and calls `renderContactList()`; any other value calls `renderList()` and hides the trace layer
- `activeFilter` and `activeCountry` are module-level globals
- `selectContact(id)` sets `activeCountry` to the contact ID and calls `leafMap.flyTo()`

### News feed

`fetchLiveNews()` tries to pull the WHO RSS feed via `rss2json.com` on load. On success it prepends live items to `NEWS_STATIC`; on failure it falls back to static data silently.

## Key conventions

- CSS uses `var(--*)` custom properties defined in `:root`. Color names: `--red`, `--amber`, `--sky`, `--violet`, `--emerald` for the five status levels.
- All monospace text (badges, stats, labels) uses `'JetBrains Mono'`. Display headings use `'DM Serif Display'`.
- ISO codes in `CASES` must be zero-padded to 3 digits (e.g. `"028"` not `"28"`) to match TopoJSON feature IDs. `isoMap` is built with `String(c.iso).padStart(3,'0')`.
- `Tristan da Cunha` has `iso: null` and gets no choropleth fill — intentional.

## Planned GitHub Actions self-update (not yet implemented)

The intended next step is:
1. Extract `CASES`, `NEWS_STATIC`, `TRAVEL`, `CONTACTS` into a `data.json`
2. Have `pathogenwatch.html` `fetch('data.json')` on load
3. A GitHub Actions workflow (`.github/workflows/update.yml`) running on a cron schedule fetches WHO DON + CDC HAN + ECDC RSS feeds, parses country mentions, updates `data.json`, and commits back — triggering a GitHub Pages rebuild
