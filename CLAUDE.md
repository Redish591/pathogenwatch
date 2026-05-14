# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

PathogenWatch is a **single-file static HTML application** — `index.html`. There is no build step, no package manager, no server. All dependencies are loaded from CDN at runtime.

**Live site:** https://redish591.github.io/pathogenwatch/
**GitHub repo:** https://github.com/Redish591/pathogenwatch (public, user: Redish591)

## Running / developing

Open `index.html` directly in a browser, or serve it locally:

```
# Python (any directory)
python -m http.server 8080
# then visit http://localhost:8080/
```

There are no tests, no lint commands, and no compilation step.

### Manual updater run

The auto-update bot can be triggered locally from `scripts/`:

```
cd scripts
npm install         # one-time
npm run refresh     # real run — writes data.json + changelog.txt + maybe index.html
npm run dry-run     # preview what would change, no file writes
```

For AI features to fire, set `ANTHROPIC_API_KEY` in `scripts/.env` (gitignored)
or in the shell env. Without it the bot still runs and updates news, just
skips the AI filter + case extraction.

## Architecture

### Single-file structure

All HTML, CSS, and JavaScript live in `index.html` in this order:

1. `<style>` — CSS variables + all component styles (no external stylesheet)
2. HTML body — landing screen, header, tab nav, three tab panels
3. `<script>` — inline fallback data arrays, then all JS functions, then init calls at the bottom

### Data layer

All live data is in `data.json` (fetched on load via `fetch('./data.json')`). The HTML contains inline fallback copies of the same arrays for `file://` usage. Keys:

- **`cases[]`** — country-level outbreak entries: `{name, flag, status, cases, deaths, city, lat, lon, note, iso, sources[]}`. `iso` is zero-padded 3-digit ISO 3166-1 numeric string (e.g. `"792"` for Turkey) used for choropleth. `Tristan da Cunha` has `iso: null` — intentional, no choropleth fill.
- **`travel[]`** — travel risk per country `{name, flag, risk, summary, rec}`. Risk levels: `extreme > high > moderate > low > minimal`.
- **`news[]`** — feed items `{src, time, title, tag, url}`. Tags: `c` (confirmed), `d` (death), `w` (WHO), `u` (update).
- **`contacts[]`** — sub-national contact trace nodes `{id, city, country, flag, lat, lng, count, status, from, route, days, daysTotal, note, source, url}`. `from` is `[lat, lng]` arc origin — either `SHIP_POS = [28.29, -16.63]` (Tenerife) or `ROME_FCO = [41.80, 12.25]`.
- **`stats{}`** — header numbers: `confirmed_cases`, `deaths`, `countries`, `contacts_traced`.
- **`last_updated`** — ISO timestamp shown in the UI tab nav.

`regions.json` is fetched separately for sub-regional choropleth detail.

### Map layer (Leaflet + TopoJSON)

`buildMap()` runs once (guarded by `mapReady` flag), triggered 400ms after `enterApp()`. It:
1. Initialises a Leaflet map on `#map` with a dark CartoDB tile layer
2. Fetches world TopoJSON from jsDelivr CDN and builds a choropleth using `isoMap` (a lookup of ISO code → cases entry built at startup)
3. Draws the ship route polyline and waypoint markers
4. Adds `L.marker` for each cases entry with pulsing divIcon for confirmed/suspected

`colFor(status)` maps status strings to hex colors — update this if adding new statuses.

### Contact trace layer

`buildTraceLayer()` creates a `traceLayerGroup` (Leaflet LayerGroup) with:
- Ship origin marker at Tenerife with CSS pulse animation + "MV HONDIUS" label
- Rome Fiumicino hub marker (`.wp-hub` — larger violet circle with transit SVG + "FCO" label), auto-added if any contact's track contains a point within 0.15° of `ROME_FCO`
- Arc segments per contact: first segment uses `ct-arc-line` (amber, "evacuation arc"), subsequent segments use `ct-arc-sub` (violet, "sub-arc from transit hub")
- Waypoint markers for each intermediate `track[]` entry — 26px circles with SVG icons (plane/ship/transit/home/hospital) via `iconChar(t)`
- Destination markers: hospital/plane final-track icons render as `.wp-dest` SVG markers (amber border, red if confirmed); other contacts get a `L.circleMarker` sized by `count`

Lazily built on first activation, guarded by `if(!traceLayerGroup)`. Toggled via `showRegionMode()` / `showCountryMode()` triggered by the `dt-country` / `dt-region` buttons (top-left of map) and the "Contact Trace" landing-page button (`enterApp('dashboard','region')`).

**Icon system:** `iconChar(t)` returns inline SVG strings (Material Design paths, `fill="white"`) for keys `plane`/`ship`/`transit`/`home`/`hospital`. Default fallback is `'•'`. Used both in waypoint markers on the map and in the journey-track mini-list inside contact popups.

### Tab + filter state

- `switchTab(name, btn)` shows/hides `.tab-content` divs
- `setFilter(f, btn)` drives the left panel
- `activeFilter` and `activeCountry` are module-level globals
- `selectContact(id)` calls `leafMap.flyTo()`

### News feed

`fetchLiveNews()` tries WHO RSS via `rss2json.com` on load as a secondary live source. Falls back silently. Primary news comes from `data.json` which is updated by the cron workflow.

## Key conventions

- CSS uses `var(--*)` custom properties. Status colors: `--red`, `--amber`, `--sky`, `--violet`, `--emerald`.
- Monospace text uses `'JetBrains Mono'`. Display headings use `'DM Serif Display'`.
- ISO codes in `cases[]` must be zero-padded to 3 digits. `isoMap` builds with `String(c.iso).padStart(3,'0')`.

## Auto-update pipeline

`.github/workflows/update.yml` runs every 6 hours (cron `0 */6 * * *`):
1. `npm install` in `scripts/`
2. `node scripts/update.js` — fetches 4 Google News RSS feeds, filters by KEYWORDS regex, dedupes by URL + title, caps news at 100 items
3. Commits `data.json` + `changelog.txt` back to `main` if anything changed
4. GitHub Pages rebuilds automatically

**News-only by default.** The bot always modifies `news[]`. When `ANTHROPIC_API_KEY` is set it may also adjust `stats.confirmed_cases` and `stats.deaths` based on AI extraction from headlines (with a self-verification pass and sanity gates). It never touches `cases[]`, `contacts[]`, or `travel[]` — those remain manual.

### AI pipeline (active when `ANTHROPIC_API_KEY` is set)

Three Claude Haiku calls per run, all schema-validated. On any failure (bad JSON, network, schema mismatch) the step is skipped and the run continues.

1. **News filter** — scores each candidate headline 1–10; items below 6 are dropped.
2. **Case extraction** — reads the top 20 headlines, returns updated global `confirmed_cases` / `deaths` if an official source (WHO / CDC / ECDC / national ministry) explicitly states them. Returns nulls otherwise.
3. **Self-verification** — a second call audits the extraction; updates are only applied when `verified: true`.

After extraction, sanity gates still apply: cases must not decrease and must not exceed 3× current; deaths must not decrease and must not jump by more than 50 in one run. Rejected extractions are logged in `changelog.txt` with the verifier's reason.

### Inline-fallback auto-sync

When `stats.confirmed_cases`, `stats.deaths`, or `stats.countries` changes, the bot also rewrites the hardcoded values in `index.html` (header stat row, landing stats, landing subtitle "across N countries"). Regex-anchored to the specific class names so the rest of the file is untouched. No manual sync needed after stats change.

### Why Google News RSS (not official feeds)

WHO, CDC HAN, ECDC, and ProMED RSS endpoints all return 404 as of May 2026. Google News RSS (`news.google.com/rss/search?q=...`) aggregates from all those sources. The 4 feeds used:
- `q=hantavirus` — broad
- `q="andes+virus"+OR+hondius` — outbreak-specific
- `q=hantavirus+site:who.int` — WHO items, tagged `w`
- `q=hantavirus+site:cdc.gov` — CDC items, tagged `c`

## Deployment

- GitHub Pages, branch `main`, root `/`
- Actions write permission enabled (Settings → Actions → General → Read and write)
- Node.js 24 in workflow (bumped from 20 which is deprecated June 2026)

## SEO

Added to `<head>` of `index.html`:
- `<meta name="description">`, keywords, robots, canonical
- Open Graph + Twitter Card tags (reference `preview.png` — **not yet created**)
- Google Search Console verification tag
- `sitemap.xml` submitted to Search Console

## Inline fallback ↔ data.json sync

The HTML contains inline fallback copies of `CASES`, `CONTACTS`, `TRAVEL`, and `NEWS_STATIC` plus hardcoded header/landing stats. These render first; `loadLiveData()` then fetches `data.json` and overrides.

**Stats (`confirmed_cases` / `deaths` / `countries`) auto-sync** — the bot rewrites the three spots in `index.html` whenever `stats` changes in `data.json`:
- Header stats at `<div class="hd-stat-row">` (line ~416)
- Landing page stats at `<div class="l-stats">` (line ~395)
- Landing subtitle text in `<p class="l-sub">` ("across N countries")

**Manual sync still required** for inline `CASES`, `CONTACTS`, `TRAVEL`, and `NEWS_STATIC` arrays — those exist for `file://` previews and slow-CDN loads, and the bot doesn't currently rewrite arrays.

## Pending / TODO

1. **`preview.png`** — OG/Twitter card image is referenced in meta tags but the file doesn't exist. Should be a 1200×630 screenshot of the dashboard. Without it social shares show no image.
2. **Google Analytics** — user wants visitor tracking. Steps: analytics.google.com → create property → get `G-XXXXXXXXXX` script tag → add to `<head>` of `index.html`.
3. **Manual data maintenance** — `cases[]`, `contacts[]`, `travel[]` never auto-update. Add new countries/cases manually as the outbreak evolves.
4. **Netherlands deaths** — possibly 2 deaths (Wikipedia), currently 1 in data.json. Needs verification before changing.
