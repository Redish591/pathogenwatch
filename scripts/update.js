#!/usr/bin/env node
/**
 * PathogenWatch auto-updater
 *
 * Runs in GitHub Actions every 6 hours (and locally via `npm run refresh`).
 * Pulls RSS feeds, filters by keyword, then — if ANTHROPIC_API_KEY is set —
 * uses Claude Haiku to:
 *   1. Score each candidate news item and drop low-quality ones (< 6/10).
 *   2. Extract global confirmed-case / death totals from top headlines.
 *   3. Verify its own extraction (second-pass critique) before writing.
 *
 * Reliability layers:
 *   - Schema validation on every Claude response. Bad JSON → skip, never crash.
 *   - Sanity gate on case counts: must not decrease, max 3× current.
 *   - Verification pass: second Claude call confirms extraction is grounded.
 *   - Auto-syncs hardcoded fallback values in index.html when stats change.
 *   - Audit trail in changelog.txt with Claude's reasoning per decision.
 *
 * Flags:
 *   --dry-run   Print what would change without writing any files.
 *
 * Env:
 *   ANTHROPIC_API_KEY   Required for AI features. Falls back gracefully if absent.
 *                       Read from process.env or scripts/.env (gitignored).
 */

const fs   = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

/* ───── env + flags ─────────────────────────────────────────────── */

const DRY_RUN = process.argv.includes('--dry-run');

(function loadDotenv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const ROOT           = path.join(__dirname, '..');
const DATA_PATH      = path.join(ROOT, 'data.json');
const CHANGELOG_PATH = path.join(ROOT, 'changelog.txt');
const HTML_PATH      = path.join(ROOT, 'index.html');

/* ───── feeds + config ──────────────────────────────────────────── */

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

function writeFile(p, content) {
  if (DRY_RUN) { log(`  [dry-run] would write ${path.relative(ROOT, p)} (${content.length} bytes)`); return; }
  fs.writeFileSync(p, content);
}

function appendFile(p, content) {
  if (DRY_RUN) { log(`  [dry-run] would append to ${path.relative(ROOT, p)}`); return; }
  fs.appendFileSync(p, content);
}

/* ───── AI ──────────────────────────────────────────────────────── */

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
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).content[0].text;
}

function parseJSON(raw) {
  // Strip markdown fences if Claude wraps the JSON despite instructions.
  const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(trimmed);
}

/* ── schema validators ── */

function validScoreArray(v) {
  return Array.isArray(v) && v.every(o =>
    o && typeof o.i === 'number' && Number.isInteger(o.i) &&
    typeof o.s === 'number' && o.s >= 0 && o.s <= 10);
}

function validExtraction(v) {
  return v && typeof v === 'object' &&
    (v.cases === null  || (typeof v.cases  === 'number' && v.cases  >= 0 && v.cases  < 1e7)) &&
    (v.deaths === null || (typeof v.deaths === 'number' && v.deaths >= 0 && v.deaths < 1e7)) &&
    (v.source === null || typeof v.source === 'string');
}

function validVerification(v) {
  return v && typeof v === 'object' &&
    typeof v.verified === 'boolean' &&
    typeof v.reason === 'string';
}

/* ── AI: news filter ── */

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
    const scores = parseJSON(raw);
    if (!validScoreArray(scores)) { log('AI filter: schema invalid, keeping all items'); return items; }
    const scoreMap = Object.fromEntries(scores.map(s => [s.i, s.s]));
    const kept = items.filter((_, i) => (scoreMap[i] ?? 5) >= AI_SCORE_THRESHOLD);
    log(`AI filter: kept ${kept.length}/${items.length} (threshold ${AI_SCORE_THRESHOLD})`);
    return kept;
  } catch (e) {
    log(`AI filter error: ${e.message} — keeping all items`);
    return items;
  }
}

/* ── AI: case-count extraction ── */

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
      `ONLY if a headline explicitly states a new total from WHO, CDC, ECDC, or a national health ministry. ` +
      `Do not infer. If no headline explicitly states an updated official total, return nulls.\n\n` +
      `${headlines}\n\n` +
      `Return JSON only — no prose:\n` +
      `{"cases": <number or null>, "deaths": <number or null>, "source": "<article title or null>"}`
    }], 200);
    const parsed = parseJSON(raw);
    if (!validExtraction(parsed)) { log('Case extraction: schema invalid, ignoring'); return null; }
    return parsed;
  } catch (e) {
    log(`Case extraction error: ${e.message}`);
    return null;
  }
}

/* ── AI: self-verification ── */

async function verifyExtraction(extraction, newsItems, currentStats) {
  if (!process.env.ANTHROPIC_API_KEY) return { verified: false, reason: 'no API key' };
  const headlines = [...newsItems].slice(0, 20).map(n => `- ${n.title} (${n.src})`).join('\n');
  log('Verifying extraction…');
  try {
    const raw = await claudeAPI([{ role: 'user', content:
      `You are auditing an automated extraction step. Another model proposed these updates ` +
      `to a hantavirus outbreak tracker:\n\n` +
      `Proposed: cases=${extraction.cases}, deaths=${extraction.deaths}, source="${extraction.source}"\n` +
      `Current values: cases=${currentStats.confirmed_cases}, deaths=${currentStats.deaths}\n\n` +
      `These headlines were the evidence:\n${headlines}\n\n` +
      `Question: do the proposed values clearly follow from an explicit statement in one of these ` +
      `headlines, attributed to an official health authority (WHO, CDC, ECDC, national ministry)? ` +
      `Be strict — if the proposed number is plausible but not explicitly stated, reject it.\n\n` +
      `Return JSON only:\n{"verified": <true|false>, "reason": "<one short sentence>"}`
    }], 200);
    const parsed = parseJSON(raw);
    if (!validVerification(parsed)) return { verified: false, reason: 'verifier schema invalid' };
    return parsed;
  } catch (e) {
    return { verified: false, reason: `verifier error: ${e.message}` };
  }
}

/* ───── inline-fallback sync ────────────────────────────────────── */

function syncInlineFallback(stats) {
  if (!fs.existsSync(HTML_PATH)) { log('index.html not found, skipping inline sync'); return null; }
  const before = fs.readFileSync(HTML_PATH, 'utf8');
  let html = before;

  // Header stats: <div class="hd-stat-n" style="color:var(--red)">11</div>...<div class="hd-stat-l">Cases</div>
  html = html.replace(
    /(<div class="hd-stat-n" style="color:var\(--red\)">)\d+(<\/div><div class="hd-stat-l">Cases<\/div>)/,
    `$1${stats.confirmed_cases}$2`);
  html = html.replace(
    /(<div class="hd-stat-n" style="color:#fca5a5">)\d+(<\/div><div class="hd-stat-l">Deaths<\/div>)/,
    `$1${stats.deaths}$2`);
  html = html.replace(
    /(<div class="hd-stat-n" style="color:var\(--sky\)">)\d+(<\/div><div class="hd-stat-l">Countries<\/div>)/,
    `$1${stats.countries}$2`);

  // Landing stats: <div class="l-stat-n" style="color:var(--red)">11</div>...<div class="l-stat-l">Confirmed Cases</div>
  html = html.replace(
    /(<div class="l-stat-n" style="color:var\(--red\)">)\d+(<\/div><div class="l-stat-l">Confirmed Cases<\/div>)/,
    `$1${stats.confirmed_cases}$2`);
  html = html.replace(
    /(<div class="l-stat-n" style="color:#fca5a5">)\d+(<\/div><div class="l-stat-l">Deaths<\/div>)/,
    `$1${stats.deaths}$2`);
  html = html.replace(
    /(<div class="l-stat-n" style="color:var\(--sky\)">)\d+(<\/div><div class="l-stat-l">Countries<\/div>)/,
    `$1${stats.countries}$2`);

  // Landing subtitle: "across N countries"
  html = html.replace(
    /(<p class="l-sub">[^<]*?across )\d+( countries)/,
    `$1${stats.countries}$2`);

  if (html === before) { log('Inline fallback already in sync'); return null; }
  writeFile(HTML_PATH, html);
  log(`Inline fallback synced (cases=${stats.confirmed_cases}, deaths=${stats.deaths}, countries=${stats.countries})`);
  return { synced: true };
}

/* ───── main ────────────────────────────────────────────────────── */

async function main() {
  log(`PathogenWatch updater starting${DRY_RUN ? ' (DRY RUN)' : ''}…`);
  if (!process.env.ANTHROPIC_API_KEY) log('AI disabled (no ANTHROPIC_API_KEY) — running in news-only mode');

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

  /* ── AI case-count extraction + verification ── */
  const statsUpdated = [];
  if (data.stats) {
    const pool = [...newNews, ...(data.news || []).slice(0, 15)];
    const extracted = await extractCaseStats(pool, data.stats);

    if (extracted && (extracted.cases != null || extracted.deaths != null)) {
      const verdict = await verifyExtraction(extracted, pool, data.stats);
      if (!verdict.verified) {
        log(`Extraction rejected by verifier: ${verdict.reason}`);
        changes.push(`~ extraction skipped: ${verdict.reason}`);
      } else {
        log(`Extraction verified: ${verdict.reason}`);

        if (extracted.cases != null) {
          const cur = data.stats.confirmed_cases;
          const upd = extracted.cases;
          if (upd >= cur && upd <= cur * 3) {
            if (upd !== cur) {
              data.stats.confirmed_cases = upd;
              statsUpdated.push(`cases ${cur}→${upd}`);
              changes.push(`↑ confirmed_cases: ${cur} → ${upd} (${extracted.source || 'AI'}) — verified ✓`);
              log(`Confirmed cases: ${cur} → ${upd}`);
            }
          } else {
            log(`Skipped case update ${upd} — outside sanity range [${cur}, ${cur * 3}]`);
            changes.push(`~ rejected cases=${upd} (out of sanity range)`);
          }
        }

        if (extracted.deaths != null) {
          const cur = data.stats.deaths;
          const upd = extracted.deaths;
          if (upd >= cur && upd <= cur + 50) {
            if (upd !== cur) {
              data.stats.deaths = upd;
              statsUpdated.push(`deaths ${cur}→${upd}`);
              changes.push(`↑ deaths: ${cur} → ${upd} — verified ✓`);
              log(`Deaths: ${cur} → ${upd}`);
            }
          } else {
            log(`Skipped death update ${upd} — outside sanity range [${cur}, ${cur + 50}]`);
            changes.push(`~ rejected deaths=${upd} (out of sanity range)`);
          }
        }
      }
    }
  }

  /* ── write data.json ── */
  const hasNews  = newNews.length > 0;
  const hasStats = statsUpdated.length > 0;

  if (!hasNews && !hasStats) {
    log('No content changes. Refreshing timestamp only.');
    data.last_updated = new Date().toISOString();
    data.ai_active = !!process.env.ANTHROPIC_API_KEY;
    writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');
    return;
  }

  if (hasNews) {
    newNews.sort((a, b) => new Date(b.added) - new Date(a.added));
    data.news = [...newNews, ...(data.news || [])].slice(0, MAX_NEWS);
  }

  data.last_updated = new Date().toISOString();
  data.ai_active = !!process.env.ANTHROPIC_API_KEY;
  writeFile(DATA_PATH, JSON.stringify(data, null, 2) + '\n');

  /* ── sync inline fallback if stats changed ── */
  if (hasStats) syncInlineFallback(data.stats);

  /* ── audit trail ── */
  const stamp = new Date().toISOString();
  const logBlock = `\n[${stamp}] ${changes.length} change(s):\n${changes.map(c => '  ' + c).join('\n')}\n`;
  appendFile(CHANGELOG_PATH, logBlock);

  log(`Done. ${newNews.length} news item(s) added${hasStats ? ', stats updated: ' + statsUpdated.join(', ') : ''}.`);
  if (DRY_RUN) log('Dry run complete — no files were modified.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
