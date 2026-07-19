#!/usr/bin/env node
/**
 * Webflow Schema & Meta Updater
 *
 * Updates meta title, meta description, and JSON-LD schema across all pages
 * via the Webflow v2 API.
 *
 * USAGE
 *   node webflow-seo-update.js                              dry run — preview only (default, safe)
 *   TEST_PAGE=/contact-us node webflow-seo-update.js        test on one page, dry run
 *   DRY_RUN=false TEST_PAGE=/contact-us node webflow-seo-update.js   apply to one page
 *   DRY_RUN=false node webflow-seo-update.js               apply to all pages
 *
 * SETUP
 *   Fill in your token and site ID below, OR export as env vars before running.
 *   Requires Node 18+.
 */

// ── LOAD .env (always wins over shell environment) ────────────────────────────
import { readFileSync } from 'fs';
try {
  const lines = readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env file — fall back to environment variables */ }

// ── CONFIG ───────────────────────────────────────────────────────────────────
const TOKEN     = process.env.WEBFLOW_API_TOKEN || 'PASTE_YOUR_API_TOKEN_HERE';
const SITE_ID   = process.env.WEBFLOW_SITE_ID   || 'PASTE_YOUR_SITE_ID_HERE';
const DRY_RUN   = process.env.DRY_RUN !== 'false';
const TEST_PAGE = process.env.TEST_PAGE || null;
// ─────────────────────────────────────────────────────────────────────────────

const BASE = 'https://api.webflow.com/v2';
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

// ── PAGE DATA ─────────────────────────────────────────────────────────────────
// Keys are publishedPath values (what Webflow returns for each page).
// Below are two example entries for a fictional "Acme Corp" — in real use, this
// object holds one entry per page on the client's site with its target meta
// title, meta description, and JSON-LD schema block.

const PAGES = {

  '/': {
    metaTitle: 'Acme Corp | Advanced Materials Technology Company',
    metaDescription: 'Acme Corp develops advanced materials technology products. An example entry — replace with the client\'s real homepage copy.',
    schema: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.example.com/#organization",
      "name": "Acme Corp",
      "legalName": "Acme Corp Ltd",
      "url": "https://www.example.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://www.example.com/logo.svg"
      },
      "description": "Acme Corp is an example organization used to illustrate this schema-update pattern. Replace with the client's real description, products, and identifiers.",
      "foundingDate": "2007",
      "address": [
        {"@type": "PostalAddress","streetAddress": "123 Example Street","addressLocality": "Sydney","addressRegion": "NSW","postalCode": "2000","addressCountry": "AU"}
      ],
      "contactPoint": [
        {"@type": "ContactPoint","telephone": "+61-2-0000-0000","contactType": "customer service","email": "hello@example.com","areaServed": "AU"}
      ],
      "sameAs": ["https://www.linkedin.com/company/example/"]
    },
    {
      "@type": "WebSite",
      "@id": "https://www.example.com/#website",
      "url": "https://www.example.com",
      "name": "Acme Corp",
      "publisher": {"@id": "https://www.example.com/#organization"}
    }
  ]
}
</script>`,
  },

  '/contact-us': {
    metaTitle: 'Contact Acme Corp',
    metaDescription: 'Contact Acme Corp. General enquiries: hello@example.com.',
    schema: `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "ContactPage",
  "@id": "https://www.example.com/contact-us",
  "url": "https://www.example.com/contact-us",
  "name": "Contact Acme Corp",
  "publisher": {"@id": "https://www.example.com/#organization"},
  "mainEntity": {
    "@type": "Organization",
    "@id": "https://www.example.com/#organization",
    "name": "Acme Corp",
    "email": "hello@example.com",
    "telephone": "+61-2-0000-0000"
  }
}
</script>`,
  },

};

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, ...options });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

// Remove any existing JSON-LD blocks so re-runs don't stack up duplicates
function stripExistingSchema(headCode) {
  if (!headCode) return '';
  return headCode
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, '')
    .trim();
}

function buildHead(existingHead, schema) {
  const cleaned = stripExistingSchema(existingHead);
  return cleaned ? `${cleaned}\n${schema}` : schema;
}

function log(msg) { console.log(msg); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); }
function ok(msg)   { console.log(`  ✓  ${msg}`); }

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (TOKEN === 'PASTE_YOUR_API_TOKEN_HERE' || SITE_ID === 'PASTE_YOUR_SITE_ID_HERE') {
    console.error('\nFill in TOKEN and SITE_ID at the top of this script (or set env vars) before running.\n');
    process.exit(1);
  }

  log('\n── Webflow SEO & Schema Updater ────────────────────────────────');
  log(`   Mode:      ${DRY_RUN ? 'DRY RUN (no changes will be made)' : '⚡ LIVE — changes will be applied'}`);
  log(`   Test page: ${TEST_PAGE || 'all pages'}`);
  log('────────────────────────────────────────────────────────────────\n');

  // 1. Fetch all pages and build a publishedPath → page map
  log('Fetching pages from Webflow...');
  const { pages } = await apiFetch(`/sites/${SITE_ID}/pages`);
  log(`Found ${pages.length} pages.\n`);

  // Show the full list so you can verify slug mapping before applying
  log('Page list (publishedPath → title):');
  for (const p of pages) {
    log(`  ${(p.publishedPath || '/').padEnd(40)} ${p.title || ''}`);
  }
  log('');

  const pageByPath = {};
  for (const p of pages) {
    pageByPath[p.publishedPath || '/'] = p;
  }

  // 2. Determine which pages to process
  const targets = TEST_PAGE
    ? { [TEST_PAGE]: PAGES[TEST_PAGE] }
    : PAGES;

  if (TEST_PAGE && !PAGES[TEST_PAGE]) {
    console.error(`TEST_PAGE "${TEST_PAGE}" not found in page data. Check the path.`);
    process.exit(1);
  }

  // 3. Process each page
  let matched = 0, skipped = 0;

  for (const [path, data] of Object.entries(targets)) {
    const webflowPage = pageByPath[path];

    if (!webflowPage) {
      warn(`No Webflow page found for "${path}" — skipping.`);
      skipped++;
      continue;
    }

    log(`Page: ${path} (${webflowPage.title || webflowPage.id})`);
    log(`  Meta title:  ${data.metaTitle}`);
    log(`  Meta desc:   ${data.metaDescription}`);
    log(`  Schema:      → add manually in Webflow Designer (Page Settings > Custom Code > head)`);

    if (DRY_RUN) {
      ok('Dry run — no changes applied.');
    } else {
      // Webflow v2 API: PUT /v2/pages/{id} updates SEO only.
      // Inline head code (schema) is not writable via REST — add manually in
      // Webflow Designer: Page Settings > Custom Code > <head> section.
      await apiFetch(`/pages/${webflowPage.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          seo: {
            title: data.metaTitle,
            description: data.metaDescription,
          },
        }),
      });

      ok('SEO updated (meta title + description).');
    }

    matched++;
    log('');
  }

  // 4. Summary
  log('────────────────────────────────────────────────────────────────');
  log(`Done. ${matched} page(s) ${DRY_RUN ? 'previewed' : 'updated'}, ${skipped} skipped.`);

  if (DRY_RUN) {
    log('\nRun with DRY_RUN=false to apply changes.');
  } else {
    log('\nPublish the site in Webflow to make changes live.');
    log('Then validate each page at: https://search.google.com/test/rich-results');
  }

  if (skipped > 0) {
    log(`\n${skipped} page(s) not matched — check published paths above.`);
  }

  // Remind about manual steps
  log('\nManual steps still required:');
  log('  1. CMS-templated pages (e.g. blog/newsroom article template) — add schema via Embed element in Designer (CMS binding)');
  log('  2. FAQPage blocks on key landing pages — add after FAQ sections are live');
  log('  3. Disable Webflow auto-generated schema in Site Settings > SEO to avoid conflicts');
  log('');
}

run().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
