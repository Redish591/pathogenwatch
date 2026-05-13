#!/usr/bin/env node
/**
 * PathogenWatch auto-updater
 *
 * Runs in GitHub Actions every 6 hours. Pulls RSS feeds from WHO, CDC, ECDC,
 * filters for hantavirus mentions, and prepends new items to data.json.
 *
 * Safety rules:
 *   - Never modifies existing cases/contacts/travel entries.
 *   - Only adds news items it has never seen before (deduped by URL).
 *   - Caps news at 100 items.
 *   - Skips items older than 90 days.
 *   - If all feeds fail, writes nothing (preserves last-known-good data).
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const CHANGELOG_PATH = path.join(ROOT, 'changelog.txt');

const FEEDS = [
  { src: 'WHO',  tag: 'w', url: 'https://www.who.int/rss-feeds/news-releases.xml' },
  { src: 'WHO DON', tag: 'w', url: 'https://www.who.int/feeds/entity/csr/don/en/rss.xml' },
  { src: 'CDC HAN', tag: 'c', url: 'https://emergency.cdc.gov/han/han.rss' },
  { src: 'ECDC', tag: 'u', url: 'https://www.ecdc.europa.eu/en/rss/news' },
  { src: 'ProMED', tag: 'u', url: 'https://promedmail.org/feed/' },
];

const KEYWORDS = /\b(hantavirus|hanta\s+virus|andes\s*virus|andv|hps|hantaan|sin\s*nombre|puumala|seoul\s*virus|dobrava|laguna\s*negra|hondius)\b/i;

const MAX_NEWS = 100;
const MAX_AGE_DAYS = 90;

/* ───── helpers ─────────────────────────────────────────────────── */

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function formatTime(pubDate) {
  if (!pubDate) return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const d = new Date(pubDate);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function ageDays(pubDate) {
  if (!pubDate) return 0;
  const d = new Date(pubDate);
  if (isNaN(d)) return 0;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

async function fetchFeed(feed) {
  try {
    const ctl = AbortSignal.timeout(15000);
    const r = await fetch(feed.url, {
      signal: ctl,
      headers: { 'User-Agent': 'PathogenWatch-bot/1.0 (+github actions)' }
    });
    if (!r.ok) {
      log(`  ✗ ${feed.src}: HTTP ${r.status}`);
      return [];
    }
    const xml = await r.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const j = parser.parse(xml);
    // RSS 2.0
    let items = j?.rss?.channel?.item;
    // Atom
    if (!items) items = j?.feed?.entry;
    if (!items) return [];
    if (!Array.isArray(items)) items = [items];
    log(`  ✓ ${feed.src}: ${items.length} items fetched`);
    return items;
  } catch (e) {
    log(`  ✗ ${feed.src}: ${e.message}`);
    return [];
  }
}

function extractField(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    return String(v['#text'] || v['@_href'] || v.href || '').trim();
  }
  return String(v).trim();
}

function normalise(item) {
  const title = extractField(item.title);
  let link = '';
  if (typeof item.link === 'string') link = item.link.trim();
  else if (Array.isArray(item.link)) {
    const alt = item.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
    link = alt ? extractField(alt) : extractField(item.link[0]);
  } else if (item.link) link = extractField(item.link);

  const pubDate = item.pubDate || item.published || item.updated || item['dc:date'] || '';
  const desc = extractField(item.description || item.summary || item.content || '');
  return {
    title: title.replace(/\s+/g, ' ').slice(0, 240),
    url: link,
    pubDate: typeof pubDate === 'string' ? pubDate : extractField(pubDate),
    desc: desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)
  };
}

function matchesOutbreak(item) {
  return KEYWORDS.test(item.title) || KEYWORDS.test(item.desc);
}

/* ───── main ────────────────────────────────────────────────────── */

async function main() {
  log('PathogenWatch updater starting…');

  if (!fs.existsSync(DATA_PATH)) {
    log('ERROR: data.json not found.');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existingUrls = new Set((data.news || []).map(n => n.url).filter(Boolean));
  const existingTitles = new Set((data.news || []).map(n => n.title?.toLowerCase().slice(0, 80)));

  log(`Existing: ${(data.news || []).length} news items, ${(data.cases || []).length} cases.`);

  const newNews = [];
  const changes = [];
  let allFailed = true;

  for (const feed of FEEDS) {
    const items = await fetchFeed(feed);
    if (items.length > 0) allFailed = false;

    for (const raw of items) {
      const n = normalise(raw);
      if (!matchesOutbreak(n)) continue;
      if (ageDays(n.pubDate) > MAX_AGE_DAYS) continue;
      if (!n.url || existingUrls.has(n.url)) continue;
      const titleKey = n.title.toLowerCase().slice(0, 80);
      if (existingTitles.has(titleKey)) continue;

      existingUrls.add(n.url);
      existingTitles.add(titleKey);

      newNews.push({
        src: feed.src,
        time: formatTime(n.pubDate),
        title: n.title,
        tag: feed.tag,
        url: n.url,
        live: true,
        added: new Date().toISOString()
      });
      changes.push(`+ ${feed.src} | ${n.title.slice(0, 70)}`);
    }
  }

  if (allFailed) {
    log('All feeds failed — preserving last-known-good data.json.');
    process.exit(0);
  }

  if (newNews.length === 0) {
    log('No new outbreak news. Refreshing timestamp only.');
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
    return;
  }

  // newest first; cap at MAX_NEWS
  newNews.sort((a, b) => new Date(b.added) - new Date(a.added));
  data.news = [...newNews, ...(data.news || [])].slice(0, MAX_NEWS);
  data.last_updated = new Date().toISOString();

  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

  const stamp = new Date().toISOString();
  const logBlock = `\n[${stamp}] +${changes.length} item(s):\n${changes.map(c => '  ' + c).join('\n')}\n`;
  fs.appendFileSync(CHANGELOG_PATH, logBlock);

  log(`Done. Added ${newNews.length} news item(s).`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
