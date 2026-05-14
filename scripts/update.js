#!/usr/bin/env node
/**
 * PathogenWatch auto-updater
 *
 * Runs in GitHub Actions every 6 hours. Pulls RSS feeds, filters by keyword,
 * then (if ANTHROPIC_API_KEY is set) uses Claude Haiku to:
 *   1. Score each candidate news item and drop low-quality ones (< 6/10).
 *   2. Extract global confirmed-case / death totals from top headlines and
 *      update stats{} in data.json if a credible new figure is found.
 *
 * Safety rules:
 *   - Never modifies existing contacts[] or travel[] entries.
 *   - Only adds news items it has never seen before (deduped by URL + title).
 *   - Caps news at 100 items.
 *   - Skips items older than 90 days.
 *   - If all feeds fail, writes nothing (preserves last-known-good data).
 *   - Case count updates must be >= current and <= current * 3 (sanity gate).
 *   - If ANTHROPIC_API_KEY is absent, AI steps are silently skipped.
 */

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data.json');
const CHANGELOG_PATH = path.join(ROOT, 'changelog.txt');

const FEEDS = [
  { src: 'News', tag: 'u', url: 'https://www.bing.com/news/search?q=hantavirus&format=rss&mkt=en-US&setlang=en-US' },
  { src: 'News', tag: 'u', url: 'https://www.bing.com/news/search?q=%22andes+virus%22+OR+hondius&format=rss&mkt=en-US&setlang=en-US' },
  { src: 'WHO',  tag: 'w', url: 'https://www.bing.com/news/search?q=hantavirus+site%3Awho.int&format=rss&mkt=en-US&setlang=en-US' },
  { src: 'CDC',  tag: 'c', url: 'https://www.bing.com/news/search?q=hantavirus+site%3Acdc.gov&format=rss&mkt=en-US&setlang=en-US' },
];

const KEYWORDS = /\b(hantavirus|hanta\s+virus|andes\s*virus|andv|hps|hantaan|sin\s*nombre|puumala|seoul\s*virus|dobrava|laguna\s*negra|hondius)\b/i;

const MAX_NEWS = 100;
const MAX_AGE_DAYS = 90;
const AI_SCORE_THRESHOLD = 6;

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
    const r = await fetch(feed.url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'PathogenWatch-bot/1.0 (+github actions)' }
    });
    if (!r.ok) { log(`  ✗ ${feed.src}: HTTP ${r.status}`); return []; }
    const xml = await r.text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const j = parser.parse(xml);
    let items = j?.rss?.channel?.item || j?.feed?.entry;
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
  if (typeof v === 'object') return String(v['#text'] || v['@_href'] || v.href || '').trim();
  return String(v).trim();
}

function resolveUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.hostname.includes('bing.com') && u.searchParams.has('url'))
      return decodeURIComponent(u.searchParams.get('url'));
  } catch {}
  return raw;
}

function normalise(item) {
  const title = extractField(item.title);
  let link = '';
  if (typeof item.link === 'string') link = item.link.trim();
  else if (Array.isArray(item.link)) {
    const alt = item.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
    link = alt ? extractField(alt) : extractField(item.link[0]);
  } else if (item.link) link = extractField(item.link);
  link = resolveUrl(link);
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

/* ───── AI helpers ──────────────────────────────────────────────── */

async function claudeAPI(messages, maxTokens = 512) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages })
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${await r.text()}`);
  return (await r.json()).content[0].text;
}

async function filterNewsWithAI(items) {
  if (!process.env.ANTHROPIC_API_KEY || items.length === 0) return items;
  log(`AI filtering ${items.length} candidate item(s)…`);
  try {
    const list = items.map((n, i) => `${i}: [${n.src}] ${n.title}`).join('\n');
    const raw = await claudeAPI([{ role: 'user', content:
      `You curate a hantavirus outbreak news tracker. Score each headline 1-10:\n` +
      `7-10 = direct outbreak reporting (confirmed cases, deaths, new countries, official health-authority statements, travel advisories)\n` +
      `5-6 = vaguely relevant (hantavirus research, rodent studies, past outbreaks)\n` +
      `1-4 = off-topic (unrelated disease, opinion, click-bait)\n\n` +
      `Return ONLY a JSON array, e.g. [{"i":0,"s":8},{"i":1,"s":3}]\n\n${list}`
    }], Math.min(50 + items.length * 12, 1024));
    const scores = JSON.parse(raw.trim());
    const scoreMap = Object.fromEntries(scores.map(s => [s.i, s.s]));
    const kept = items.filter((_, i) => (scoreMap[i] ?? 5) >= AI_SCORE_THRESHOLD);
    log(`AI filter: kept ${kept.length}/${items.length} (threshold ${AI_SCORE_THRESHOLD})`);
    return kept;
  } catch (e) {
    log(`AI filter error: ${e.message} — keeping all items`);
    return items;
  }
}

async function extractCaseStats(newsItems, currentStats) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const headlines = [...newsItems].slice(0, 20).map(n => `- ${n.title} (${n.src})`).join('\n');
  if (!headlines) return null;
  log('Checking headlines for updated global case totals…');
  try {
    const raw = await claudeAPI([{ role: 'user', content:
      `You update a hantavirus outbreak case tracker.\n` +
      `Current confirmed: ${currentStats.confirmed_cases} cases, ${currentStats.deaths} deaths.\n\n` +
      `From these recent headlines, extract the most up-to-date GLOBAL confirmed case count and/or death toll ` +
      `ONLY if a headline explicitly states a new total from WHO, CDC, ECDC, or a national health ministry.\n\n` +
      `${headlines}\n\n` +
      `Return JSON only — no prose:\n` +
      `{"cases": <number or null>, "deaths": <number or null>, "source": "<article title or null>"}`
    }], 200);
    return JSON.parse(raw.trim());
  } catch (e) {
    log(`Case extraction error: ${e.message}`);
    return null;
  }
}

/* ───── main ────────────────────────────────────────────────────── */

async function main() {
  log('PathogenWatch updater starting…');

  if (!fs.existsSync(DATA_PATH)) { log('ERROR: data.json not found.'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const existingUrls   = new Set((data.news || []).map(n => n.url).filter(Boolean));
  const existingTitles = new Set((data.news || []).map(n => n.title?.toLowerCase().slice(0, 80)));

  log(`Existing: ${(data.news || []).length} news items, ${(data.cases || []).length} case entries.`);

  let newNews = [];
  const changes = [];
  let allFailed = true;

  /* ── fetch RSS feeds ── */
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
    }
  }

  if (allFailed) {
    log('All feeds failed — preserving last-known-good data.json.');
    process.exit(0);
  }

  /* ── AI news filter ── */
  if (newNews.length > 0) {
    const before = newNews.length;
    newNews = await filterNewsWithAI(newNews);
    const dropped = before - newNews.length;
    if (dropped > 0) changes.push(`~ AI filtered ${dropped} low-quality item(s)`);
  }

  newNews.forEach(n => changes.push(`+ ${n.src} | ${n.title.slice(0, 70)}`));

  /* ── AI case-count extraction ── */
  const statsUpdated = [];
  if (data.stats) {
    // Combine freshest new items + recent existing news for better context
    const pool = [...newNews, ...(data.news || []).slice(0, 15)];
    const extracted = await extractCaseStats(pool, data.stats);

    if (extracted?.cases != null) {
      const cur = data.stats.confirmed_cases;
      const upd = extracted.cases;
      if (upd >= cur && upd <= cur * 3) {
        if (upd !== cur) {
          log(`Confirmed cases: ${cur} → ${upd} (${extracted.source || 'news'})`);
          data.stats.confirmed_cases = upd;
          statsUpdated.push(`cases ${cur}→${upd}`);
          changes.push(`↑ confirmed_cases: ${cur} → ${upd} (${extracted.source || 'AI extract'})`);
        }
      } else {
        log(`Skipped case update ${upd} — outside sanity range [${cur}, ${cur * 3}]`);
      }
    }

    if (extracted?.deaths != null) {
      const cur = data.stats.deaths;
      const upd = extracted.deaths;
      if (upd >= cur && upd <= cur + 50) {
        if (upd !== cur) {
          log(`Deaths: ${cur} → ${upd}`);
          data.stats.deaths = upd;
          statsUpdated.push(`deaths ${cur}→${upd}`);
          changes.push(`↑ deaths: ${cur} → ${upd}`);
        }
      }
    }
  }

  /* ── write ── */
  const hasNews  = newNews.length > 0;
  const hasStats = statsUpdated.length > 0;

  if (!hasNews && !hasStats) {
    log('No changes. Refreshing timestamp only.');
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
    return;
  }

  if (hasNews) {
    newNews.sort((a, b) => new Date(b.added) - new Date(a.added));
    data.news = [...newNews, ...(data.news || [])].slice(0, MAX_NEWS);
  }

  data.last_updated = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

  const stamp = new Date().toISOString();
  const logBlock = `\n[${stamp}] ${changes.length} change(s):\n${changes.map(c => '  ' + c).join('\n')}\n`;
  fs.appendFileSync(CHANGELOG_PATH, logBlock);

  log(`Done. ${newNews.length} news item(s) added${hasStats ? ', stats updated: ' + statsUpdated.join(', ') : ''}.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
