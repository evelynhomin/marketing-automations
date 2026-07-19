#!/usr/bin/env node
/**
 * Webflow Newsroom CMS Field Updater — Homin Studio Template
 *
 * Writes two SEO/GEO fields per CMS article via the Webflow v2 API:
 *   meta-description   — 155 chars, click-optimised for HTML <meta> tag
 *   schema-description — 250 chars, keyword-rich for NewsArticle JSON-LD schema
 *
 * SETUP FOR A NEW CLIENT
 * ─────────────────────
 * 1. In Webflow CMS > Collections > [Newsroom collection]:
 *    - Add field: Plain Text | Name: "Meta Description" | slug: meta-description
 *    - Add field: Plain Text | Name: "Schema Description" | slug: schema-description
 *    (If Webflow appends -2 to the slug, update SCHEMA_FIELD below)
 *
 * 2. In Webflow Designer — Collection Template page:
 *    - Page Settings > SEO > Meta Description → bind to "Meta Description" field
 *    - Add an HTML Embed element (bottom of page body, before footer)
 *    - Paste this into the embed, binding CMS variables via "Add Field":
 *
 *    <script type="application/ld+json">
 *    {"@context":"https://schema.org","@type":"NewsArticle","headline":"[Name]","description":"[Schema Description]","url":"https://[CLIENT-DOMAIN]/[newsroom-path]/[Slug]","datePublished":"[Published Date]","author":{"@type":"Organization","name":"[Client Name]"},"publisher":{"@type":"Organization","name":"[Client Name]","url":"https://[CLIENT-DOMAIN]"},"about":{"@type":"Organization","name":"[Client Name]","tickerSymbol":"[ASX CODE IF LISTED]"}}
 *    </script>
 *
 * 3. Copy .env from root and fill in credentials:
 *    WEBFLOW_API_TOKEN=...
 *    WEBFLOW_SITE_ID=...
 *
 * 4. Fill in CONFIG and CLIENT sections below.
 *
 * 5. Add hand-crafted entries to ARTICLE_META for priority articles.
 *    Everything else is auto-generated from title + boilerplate.
 *
 * USAGE
 *   node webflow-newsroom-updater.js                    dry run
 *   DRY_RUN=false node webflow-newsroom-updater.js      apply all
 *   SKIP_EXISTING=false node webflow-newsroom-updater.js  overwrite
 */

// ── LOAD .env ─────────────────────────────────────────────────────────────────
import { readFileSync } from 'fs';
try {
  const lines = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env — fall back to environment variables */ }

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN           = process.env.WEBFLOW_API_TOKEN || 'PASTE_TOKEN_HERE';
const SITE_ID         = process.env.WEBFLOW_SITE_ID   || 'PASTE_SITE_ID_HERE';
const DRY_RUN         = process.env.DRY_RUN !== 'false';
const SKIP_EXISTING   = process.env.SKIP_EXISTING !== 'false';

// ── CLIENT SETTINGS — edit these for each new client ─────────────────────────
const COLLECTION_NAME  = 'newsroom';          // partial match on collection displayName or slug
const META_FIELD       = 'meta-description';  // CMS field slug for meta description
const SCHEMA_FIELD     = 'schema-description'; // CMS field slug for schema description (check for -2 suffix)
const MAX_META         = 155;
const MAX_SCHEMA       = 250;

// Brand suffix appended to auto-generated meta descriptions
// e.g. ' | Acme Corp (ASX: ACM)'
const BRAND_SUFFIX     = ' | CLIENT NAME (ASX: XXX)';

// Boilerplate appended to auto-generated schema descriptions
// Should explain what the company does — used by AI to understand each article's context
const SCHEMA_BOILERPLATE = '. CLIENT NAME (ASX: XXX) is a [describe company and products in one sentence].';

// Articles to skip entirely (test pages, drafts)
const SKIP_SLUGS = new Set([
  // 'test-page',
]);

// ── HAND-CRAFTED META + SCHEMA ────────────────────────────────────────────────
// Add entries here for priority articles.
// meta   — 155 chars max, written for humans clicking from search results
// schema — 250 chars max, keyword-rich for AI indexing
//
// Format:
//   'article-slug': {
//     meta:   '...',
//     schema: '...',
//   },
//
// Tips:
//   - Include the company name and product names in every entry
//   - Schema should be more technical and keyword-dense than meta
//   - Match the language people actually use to search for this topic
//   - Everything not listed here is auto-generated from title + boilerplate

const ARTICLE_META = {

  // ── EXAMPLE ENTRIES (delete these and add client-specific ones) ──────────

  // 'major-product-announcement': {
  //   meta:   'Client Name launches [Product] — a [one-line description]. ASX: XXX.',
  //   schema: 'Client Name (ASX: XXX) announces [Product], a [technical description with keywords]. [Context about commercial significance or milestone]. ASX: XXX.',
  // },

  // 'partnership-announcement': {
  //   meta:   'Client Name and [Partner] sign [agreement type], advancing [commercial goal]. ASX: XXX.',
  //   schema: 'Client Name and [Partner] sign a [agreement type] to [specific purpose] — [commercial significance for the company and its products]. ASX: XXX.',
  // },

};

// ── AUTO-GENERATION ───────────────────────────────────────────────────────────

function autoGenerateMeta(itemName) {
  if (!itemName) return null;
  const maxTitle = MAX_META - BRAND_SUFFIX.length;
  const title = itemName.length > maxTitle
    ? itemName.slice(0, maxTitle - 1) + '…'
    : itemName;
  return title + BRAND_SUFFIX;
}

function autoGenerateSchema(itemName) {
  if (!itemName) return null;
  const maxTitle = MAX_SCHEMA - SCHEMA_BOILERPLATE.length;
  const title = itemName.length > maxTitle
    ? itemName.slice(0, maxTitle - 1) + '…'
    : itemName;
  return title + SCHEMA_BOILERPLATE;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

const BASE    = 'https://api.webflow.com/v2';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function getAllItems(collectionId) {
  const items = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await apiFetch(`/collections/${collectionId}/items?limit=${limit}&offset=${offset}`);
    items.push(...(data.items || []));
    if (items.length >= (data.pagination?.total ?? 0) || (data.items || []).length < limit) break;
    offset += limit;
  }
  return items;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (TOKEN === 'PASTE_TOKEN_HERE' || SITE_ID === 'PASTE_SITE_ID_HERE') {
    console.error('\nFill in WEBFLOW_API_TOKEN and WEBFLOW_SITE_ID in .env before running.\n');
    process.exit(1);
  }

  console.log('\n── Webflow Newsroom CMS Updater (Homin Studio) ──────────────────');
  console.log(`   Mode:          ${DRY_RUN ? 'DRY RUN (no changes)' : '⚡ LIVE — will update CMS items'}`);
  console.log(`   Skip existing: ${SKIP_EXISTING ? 'yes — skip articles with both fields populated' : 'no — overwrite all'}`);
  console.log(`   Hand-crafted:  ${Object.keys(ARTICLE_META).length} articles`);
  console.log('────────────────────────────────────────────────────────────────\n');

  // Find the collection
  console.log('Fetching CMS collections...');
  const { collections } = await apiFetch(`/sites/${SITE_ID}/collections`);
  const collection = collections.find(c =>
    c.displayName?.toLowerCase().includes(COLLECTION_NAME) ||
    c.slug?.toLowerCase().includes(COLLECTION_NAME)
  );

  if (!collection) {
    console.error(`Could not find a collection matching "${COLLECTION_NAME}".`);
    console.log('Available collections:');
    collections.forEach(c => console.log(`  "${c.slug}" — ${c.displayName}`));
    process.exit(1);
  }
  console.log(`Found collection: "${collection.displayName}" (${collection.id})\n`);

  // Fetch full collection to get field list
  const fullCollection = await apiFetch(`/collections/${collection.id}`);
  const fields = fullCollection.fields || [];

  const hasMetaField   = fields.some(f => f.slug === META_FIELD);
  const hasSchemaField = fields.some(f => f.slug === SCHEMA_FIELD);

  if (!hasMetaField || !hasSchemaField) {
    console.log('Fields in this collection:');
    fields.forEach(f => console.log(`  slug: "${f.slug}"  —  name: "${f.displayName}"`));
    console.log('');
  }
  if (!hasMetaField) {
    console.error(`Field "${META_FIELD}" not found. Check slugs above and update META_FIELD.\n`);
    process.exit(1);
  }
  if (!hasSchemaField) {
    console.warn(`⚠  Field "${SCHEMA_FIELD}" not found — schema field will be skipped.\n`);
  }

  // Fetch all articles
  console.log('Fetching articles...');
  const items = await getAllItems(collection.id);
  console.log(`Found ${items.length} article(s).\n`);

  let handCrafted = 0, autoGenerated = 0, skippedExisting = 0, skippedList = 0, errors = 0;
  const needsReview = [];

  for (const item of items) {
    const slug           = item.fieldData?.slug || item.slug || '';
    const name           = item.fieldData?.name || '';
    const existingMeta   = item.fieldData?.[META_FIELD]   || '';
    const existingSchema = item.fieldData?.[SCHEMA_FIELD] || '';

    if (SKIP_SLUGS.has(slug)) {
      console.log(`  ⊘  Skipped (skip list): "${slug}"`);
      skippedList++;
      continue;
    }

    if (SKIP_EXISTING && existingMeta && existingSchema) {
      skippedExisting++;
      continue;
    }

    const manual = ARTICLE_META[slug];
    let newMeta, newSchema, source;

    if (manual) {
      newMeta   = manual.meta;
      newSchema = manual.schema;
      source    = 'hand-crafted';
      handCrafted++;
    } else {
      newMeta   = autoGenerateMeta(name);
      newSchema = autoGenerateSchema(name);
      source    = 'auto-generated';
      autoGenerated++;
      needsReview.push({ slug, name });
    }

    if (!newMeta) {
      console.warn(`  ⚠  No title for "${slug}" — skipping`);
      errors++;
      continue;
    }

    if (newMeta.length > MAX_META)       newMeta   = newMeta.slice(0, MAX_META - 1)   + '…';
    if (newSchema?.length > MAX_SCHEMA)  newSchema = newSchema.slice(0, MAX_SCHEMA - 1) + '…';

    console.log(`  [${source}] "${name || slug}"`);
    console.log(`    meta:   "${newMeta}" (${newMeta.length})`);
    if (newSchema) console.log(`    schema: "${newSchema}" (${newSchema.length})`);

    if (!DRY_RUN) {
      try {
        const fieldData = { [META_FIELD]: newMeta };
        if (hasSchemaField && newSchema) fieldData[SCHEMA_FIELD] = newSchema;

        await apiFetch(`/collections/${collection.id}/items/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fieldData }),
        });
        console.log('    ✓ Updated\n');
      } catch (err) {
        console.error(`    ✗ Failed: ${err.message}\n`);
        errors++;
        if (source === 'hand-crafted') handCrafted--;
        else autoGenerated--;
      }
    } else {
      console.log('    ✓ Dry run\n');
    }
  }

  const processed = handCrafted + autoGenerated;
  console.log('────────────────────────────────────────────────────────────────');
  console.log(`${DRY_RUN ? 'Preview' : 'Done'}. ${processed} article(s) ${DRY_RUN ? 'to update' : 'updated'}:`);
  console.log(`  ${handCrafted} hand-crafted  |  ${autoGenerated} auto-generated  |  ${skippedExisting} skipped (already set)  |  ${skippedList} skipped (list)`);
  if (errors) console.log(`  ${errors} error(s)`);

  if (needsReview.length > 0) {
    console.log(`\n── Auto-generated (${needsReview.length}) — review when time allows ──`);
    console.log('   Add entries to ARTICLE_META for any priority articles in this list.\n');
    needsReview.forEach(({ slug, name }) => {
      console.log(`   ${slug}`);
      if (name) console.log(`   → "${name}"\n`);
    });
  }

  if (DRY_RUN) {
    console.log('\nRun with DRY_RUN=false to apply. SKIP_EXISTING=false to overwrite.');
  } else {
    console.log('\nNext: publish the site in Webflow, then validate:');
    console.log('https://search.google.com/test/rich-results\n');
  }
}

run().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
