# PathogenWatch

Live tracker for the 2026 MV Hondius Andes hantavirus outbreak. Single-page web app with a country choropleth, sub-national contact-trace layer, history timeline, and travel-risk checker. Self-updates from WHO, CDC, ECDC and ProMED feeds.

## Files

```
index.html                the entire app (HTML + CSS + JS)
data.json                 source of truth for cases, contacts, news, travel
changelog.txt             append-only log of bot updates
scripts/update.js         RSS scraper that updates data.json
scripts/package.json      Node deps (fast-xml-parser)
.github/workflows/update.yml   cron Action, runs every 6 hours
CLAUDE.md                 architecture notes for AI assistants
```

## Run locally

The app works as a plain static file. Open it however you like:

```bash
# fastest: just open the file in a browser
open index.html       # mac
start index.html      # windows
xdg-open index.html   # linux

# or serve over HTTP so the data.json overlay loads
python -m http.server 8080
# then visit http://localhost:8080/
```

When opened via `file://`, the page falls back to the inline data baked into the HTML. When served over HTTP, it fetches `data.json` and overlays the live data on top.

## Deploy to GitHub Pages (free, ~5 min)

1. Create a new public repo on GitHub and push these files to `main`.
2. Repo **Settings → Pages → Build and deployment**: set source to **Deploy from branch**, branch **main**, folder `/ (root)`. Save.
3. Visit `https://<user>.github.io/<repo>/` — `index.html` is served automatically at the root.
4. Repo **Settings → Actions → General**: under "Workflow permissions" select **Read and write permissions**, save. This lets the cron commit `data.json` updates back to the repo.

That's it. The Action runs on its own every 6 hours; you can also trigger it manually from the **Actions** tab → "Update outbreak data" → "Run workflow".

## How the self-update works

```
WHO RSS ─┐
WHO DON ─┤
CDC HAN ─┼──► .github/workflows/update.yml (cron 0 */6 * * *)
ECDC    ─┤        └─► node scripts/update.js
ProMED  ─┘                   └─► data.json (commit + push)
                                       └─► GitHub Pages rebuilds
                                              └─► browsers fetch new data.json
```

The bot only **adds** news items. It never modifies `cases`, `contacts`, or `travel` — those stay under your manual control. The "last_updated" badge in the tab nav reflects the most recent commit.

### Safety rules baked into the script

- Deduplicates news by URL and by the first 80 chars of the title
- Skips items older than 90 days
- Caps news at 100 items (drops oldest)
- If every feed fails (network, rate limit, etc.) it commits nothing — preserves last-known-good
- Only matches items whose title or description contains a hantavirus keyword (`hantavirus`, `andes virus`, `andv`, `hondius`, etc.)

### Editing data manually

`data.json` is the single source of truth. Edit it directly to:

- Add/update a country case → `cases[]`
- Add/update a sub-national contact node → `contacts[]`
- Change a travel risk level → `travel[]`
- Pin a manually-curated news item → prepend to `news[]`

Commit your edit; GitHub Pages redeploys in under a minute.

## Sources

- WHO Disease Outbreak News — https://www.who.int/emergencies/disease-outbreak-news
- CDC Health Alert Network — https://emergency.cdc.gov/han/
- ECDC Communicable Disease Threats — https://www.ecdc.europa.eu/en/threats-and-outbreaks
- ProMED-mail — https://promedmail.org/
- National health ministries (RIVM, UKHSA, NICD, ANLIS, Italian MoH, etc.)
