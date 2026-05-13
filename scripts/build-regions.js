#!/usr/bin/env node
/**
 * One-off data prep: download Natural Earth admin-1 boundaries and filter to
 * just the sub-national regions we care about (Italian regions + US states
 * with monitored contacts). Output: ../regions.json (~50-80 KB)
 *
 * Re-run this whenever a new region_id appears in data.json's contacts[].
 */
const fs = require('fs');
const path = require('path');

const SOURCES = [
  // martynafford mirror — well-maintained, includes iso_3166_2
  'https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson@master/50m/cultural/ne_50m_admin_1_states_provinces.json',
  // backup: nvkelso (original)
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_1_states_provinces.geojson'
];

const WANTED = new Set([
  // Italy
  'IT-52', // Tuscany
  'IT-78', // Calabria
  'IT-72', // Campania
  'IT-34', // Veneto
  // US
  'US-NE', // Nebraska
  'US-GA', // Georgia
  'US-TX', // Texas
  'US-VA', // Virginia
  'US-AZ', // Arizona
  'US-CA', // California
  'US-NJ', // New Jersey
  'US-MD'  // Maryland
]);

async function fetchSource(url){
  console.log(`Trying ${url}…`);
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function extractIso(props){
  // Natural Earth uses several keys depending on the source
  return props.iso_3166_2 || props.iso_a2_us || props.adm1_code || props.code_hasc?.replace('.','-');
}

async function main(){
  let src;
  for (const url of SOURCES){
    try { src = await fetchSource(url); break; }
    catch(e){ console.error(`  failed: ${e.message}`); }
  }
  if (!src) throw new Error('All sources failed');

  console.log(`Source has ${src.features.length} total features.`);

  // Inspect first feature so we know what keys are available
  const sample = src.features[0]?.properties || {};
  console.log('Sample properties keys:', Object.keys(sample).filter(k => /iso|code|adm|name|region/i.test(k)).join(', '));

  // First pass: collect by iso_3166_2 directly
  const byIso = new Map();
  for (const f of src.features){
    const iso = extractIso(f.properties);
    if (iso && WANTED.has(iso)) byIso.set(iso, f);
  }

  // Second pass for any missing: try name match
  const missing = [...WANTED].filter(w => !byIso.has(w));
  if (missing.length){
    console.log('Missing after iso match:', missing.join(', '));
    // map iso → expected name fragments
    const fallback = {
      'IT-52':'Toscana', 'IT-78':'Calabria', 'IT-72':'Campania', 'IT-34':'Veneto',
      'US-NE':'Nebraska','US-GA':'Georgia','US-TX':'Texas','US-VA':'Virginia',
      'US-AZ':'Arizona','US-CA':'California','US-NJ':'New Jersey','US-MD':'Maryland'
    };
    for (const iso of missing){
      const wantName = fallback[iso]?.toLowerCase();
      if (!wantName) continue;
      const country = iso.startsWith('IT') ? 'italy' : iso.startsWith('US') ? 'united states' : '';
      const hit = src.features.find(f => {
        const p = f.properties;
        const n = (p.name||p.name_en||'').toLowerCase();
        const a = (p.admin||p.iso_a2||'').toLowerCase();
        return n === wantName && (a.includes(country) || a.includes(country.replace(' ','')));
      });
      if (hit) {
        byIso.set(iso, hit);
        console.log(`  recovered ${iso} via name match`);
      }
    }
  }

  const features = [];
  for (const iso of WANTED){
    const f = byIso.get(iso);
    if (!f){
      console.warn(`  !! still missing: ${iso}`);
      continue;
    }
    // Slim down properties to just what we need
    features.push({
      type: 'Feature',
      properties: {
        iso_3166_2: iso,
        name: f.properties.name || f.properties.name_en || iso,
        admin: f.properties.admin || (iso.startsWith('IT') ? 'Italy' : iso.startsWith('US') ? 'United States' : '')
      },
      geometry: f.geometry
    });
  }

  const out = { type: 'FeatureCollection', features };
  const outPath = path.join(__dirname, '..', 'regions.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\nWrote ${features.length} of ${WANTED.size} requested regions to regions.json (${kb} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
