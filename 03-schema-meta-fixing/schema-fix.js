#!/usr/bin/env node
/**
 * Product Schema Fix
 * Adds an "offers" property to Product schemas on specific pages
 * to resolve Google Rich Results Test critical errors.
 *
 * USAGE
 *   node schema-fix.js              dry run — shows what would change
 *   DRY_RUN=false node schema-fix.js  apply changes
 */

import { readFileSync } from 'fs';

try {
  const lines = readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch {}

const TOKEN   = process.env.WEBFLOW_API_TOKEN;
const SITE_ID = process.env.WEBFLOW_SITE_ID;
const DRY_RUN = process.env.DRY_RUN !== 'false';

// Which page slugs to check and patch — customize per client
const TARGET_SLUGS = (process.env.TARGET_SLUGS || 'product-a,product-b').split(',');

const BASE    = 'https://api.webflow.com/v2';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

const OFFERS = {
  "@type": "Offer",
  "availability": "https://schema.org/PreOrder"
};

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

function patchHeadCode(headCode) {
  const results = [];
  let updated = headCode;

  const regex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  const matches = [...headCode.matchAll(regex)];

  for (const match of matches) {
    let schema;
    try {
      schema = JSON.parse(match[1]);
    } catch {
      results.push({ status: 'parse-error' });
      continue;
    }

    if (schema['@type'] !== 'Product') continue;

    if (schema.offers) {
      results.push({ name: schema.name, status: 'already-has-offers' });
      continue;
    }

    schema.offers = OFFERS;
    const newBlock = `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
    updated = updated.replace(match[0], newBlock);
    results.push({ name: schema.name, status: 'patched' });
  }

  return { updated, results };
}

async function run() {
  console.log(`\n── Product Schema Fix ────────────────────────────────────────`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : '⚡ LIVE — will update pages'}`);
  console.log(`────────────────────────────────────────────────────────────\n`);

  const { pages } = await apiFetch(`/sites/${SITE_ID}/pages`);
  const targets = pages.filter(p => TARGET_SLUGS.includes(p.slug));

  if (targets.length === 0) {
    console.error('Pages not found. Available slugs:');
    pages.forEach(p => console.log(`  /${p.slug}`));
    process.exit(1);
  }

  for (const page of targets) {
    console.log(`/${page.slug}  (id: ${page.id})`);
    const full = await apiFetch(`/pages/${page.id}`);

    // Detect where customCode lives in the API response
    const headCode = full.customCode?.head ?? full.headCode ?? '';

    if (!headCode) {
      console.log(`  No head custom code found via API.`);
      console.log(`  API fields: ${Object.keys(full).join(', ')}\n`);
      continue;
    }

    const { updated, results } = patchHeadCode(headCode);

    for (const r of results) {
      if (r.status === 'patched')            console.log(`  + Added offers to "${r.name}"`);
      if (r.status === 'already-has-offers') console.log(`  ✓ "${r.name}" already has offers`);
      if (r.status === 'parse-error')        console.log(`  ⚠ Could not parse a JSON-LD block`);
    }

    const anyPatched = results.some(r => r.status === 'patched');

    if (!anyPatched) {
      console.log(`  Nothing to change.\n`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ✓ Dry run — would update head code\n`);
    } else {
      try {
        await apiFetch(`/pages/${page.id}`, {
          method: 'PUT',
          body: JSON.stringify({ customCode: { head: updated } }),
        });
        console.log(`  ✓ Updated\n`);
      } catch (err) {
        console.error(`  ✗ Failed: ${err.message}\n`);
      }
    }
  }

  if (DRY_RUN) {
    console.log('Run with DRY_RUN=false to apply.');
  } else {
    console.log('Done. Publish the site in Webflow, then re-test:');
    console.log('https://search.google.com/test/rich-results\n');
  }
}

run().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
