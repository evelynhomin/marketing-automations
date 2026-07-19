#!/usr/bin/env node
// Framer Article Publisher — reads a draft JSON saved by Claude Code and pushes it
// to Framer CMS + logs LinkedIn posts to Google Sheets.
//
// USAGE
//   npm run framer-push [slug]     (slug optional — defaults to latest draft)
//
// To generate a draft first: type /generate-article in Claude Code

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { connect } from 'framer-api';

// ── Load .env ──────────────────────────────────────────────────────────────────
try {
  const lines = readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env */ }

// ── Config ────────────────────────────────────────────────────────────────────
const DRY_RUN     = process.env.DRY_RUN === 'true';
const PROJECT_URL = process.env.FRAMER_PROJECT_URL;
const FRAMER_KEY  = process.env.FRAMER_API_KEY;
const COLLECTION  = process.env.FRAMER_COLLECTION_ID;
const SITE_URL    = process.env.FRAMER_SITE_URL || 'https://example.com';
const BRAND_NAME  = process.env.BRAND_NAME       || 'Your Company';

const FIELDS = {
  title:       process.env.FRAMER_FIELD_TITLE       || null,
  metaTitle:   process.env.FRAMER_FIELD_META_TITLE  || null,
  body:        process.env.FRAMER_FIELD_BODY         || null,
  metaDesc:    process.env.FRAMER_FIELD_META_DESC    || null,
  cardSummary: process.env.FRAMER_FIELD_CARD_SUMMARY || null,
  readTime:    process.env.FRAMER_FIELD_READ_TIME    || null,
  date:        process.env.FRAMER_FIELD_DATE         || null,
  tags:        process.env.FRAMER_FIELD_TAGS         || null,
  image:       process.env.FRAMER_FIELD_IMAGE        || null,
};

// ── Validation ─────────────────────────────────────────────────────────────────
function validateConfig() {
  if (DRY_RUN) return;
  const missing = [];
  if (!PROJECT_URL) missing.push('FRAMER_PROJECT_URL');
  if (!FRAMER_KEY)  missing.push('FRAMER_API_KEY');
  if (!COLLECTION)  missing.push('FRAMER_COLLECTION_ID');
  if (!FIELDS.body) missing.push('FRAMER_FIELD_BODY');
  if (missing.length) {
    console.error('\n── Missing env variables ────────────────────────────────────────');
    for (const v of missing) console.error(`  ${v}`);
    console.error('────────────────────────────────────────────────────────────────\n');
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcReadTime(htmlBody) {
  const text = htmlBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean).length;
  return `${Math.max(1, Math.ceil(words / 200))} min read`;
}

async function fetchUnsplashImage(keywords) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    const q = encodeURIComponent(keywords);
    const res = await fetch(
      `https://api.unsplash.com/photos/random?query=${q}&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${key}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.urls?.regular || null;
  } catch {
    return null;
  }
}

// ── Google Sheets — LinkedIn tracker ──────────────────────────────────────────

async function addToLinkedInSheet(article, posts) {
  const sheetId = process.env.LINKEDIN_SHEET_ID;
  if (!sheetId) {
    console.log('Sheets: skipped (LINKEDIN_SHEET_ID not set)');
    return;
  }

  const { google } = await import('googleapis');

  let auth;
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (keyJson) {
    auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(keyJson),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } else {
    auth = new google.auth.GoogleAuth({
      keyFile: new URL('./credentials/google-service-account.json', import.meta.url).pathname,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  const sheets     = google.sheets({ version: 'v4', auth });
  const date       = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const articleUrl = `${SITE_URL}/articles/${article.slug}`;
  const format     = article.format || 'article';

  const rows = posts.map(post => [
    date,
    article.title,
    articleUrl,
    format,
    post.type,
    post.text,
    '',
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    console.log(`LinkedIn posts added to Google Sheet (${rows.length} rows): ${articleUrl}`);
  } catch (err) {
    console.warn(`Sheets: failed (non-fatal): ${err.message}`);
  }
}

// ── Schema generation ──────────────────────────────────────────────────────────

function buildSchema(article) {
  const today = new Date().toISOString();
  const pageUrl = `${SITE_URL}/blog/${article.slug}`;

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.metaDescription,
    datePublished: today,
    dateModified: today,
    author: { '@type': 'Organization', name: BRAND_NAME, url: SITE_URL },
    publisher: { '@type': 'Organization', name: BRAND_NAME, url: SITE_URL },
    url: pageUrl,
    mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
  };

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (article.faqs || []).map(faq => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a },
    })),
  };

  return { articleSchema, faqSchema };
}

// ── Framer CMS push ────────────────────────────────────────────────────────────

async function pushToFramer(article, extras) {
  console.log('Connecting to Framer...');

  const cleanUrl = PROJECT_URL.split('?')[0];
  const framer = await connect(cleanUrl, FRAMER_KEY);

  const collections = await framer.getCollections();
  const collection  = collections.find(c => c.id === COLLECTION);

  if (!collection) {
    const available = collections.map(c => `${c.name} (${c.id})`).join(', ');
    throw new Error(`Collection "${COLLECTION}" not found. Available: ${available}`);
  }

  const collectionFields = await collection.getFields();
  const fieldTypeMap = Object.fromEntries(collectionFields.map(f => [f.id, f.type]));

  const today = new Date().toISOString().split('T')[0];
  const fieldData = {};

  const set = (fieldKey, value) => {
    if (!fieldKey || value === undefined || value === null || value === '') return;
    const type = fieldTypeMap[fieldKey] || 'string';
    fieldData[fieldKey] = { type, value };
  };

  set(FIELDS.title,       article.title);
  set(FIELDS.metaTitle,   article.metaTitle);
  set(FIELDS.body,        article.body);
  set(FIELDS.metaDesc,    article.metaDescription);
  set(FIELDS.cardSummary, article.cardSummary);
  set(FIELDS.readTime,    extras.readTime);
  set(FIELDS.date,        today);
  set(FIELDS.image,       extras.imageUrl);

  if (FIELDS.tags && article.tags?.length) {
    const tagType = fieldTypeMap[FIELDS.tags];
    if (tagType === 'string') {
      fieldData[FIELDS.tags] = { type: 'string', value: article.tags.join(', ') };
    }
  }

  for (let i = 0; i < Math.min((article.faqs || []).length, 8); i++) {
    const n = i + 1;
    const qField = process.env[`FRAMER_FIELD_FAQ_${n}_Q`];
    const aField = process.env[`FRAMER_FIELD_FAQ_${n}_A`];
    if (qField) fieldData[qField] = { type: fieldTypeMap[qField] || 'string', value: article.faqs[i].q };
    if (aField) fieldData[aField] = { type: fieldTypeMap[aField] || 'string', value: article.faqs[i].a };
  }

  const item = { slug: article.slug, draft: true, fieldData };
  await collection.addItems([item]);

  console.log(`\nDraft added to Framer CMS: ${collection.name}`);
  console.log('Open Framer → CMS → your collection to review and publish.\n');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n── Framer Article Publisher ─────────────────────────────────────');
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (not pushed to Framer)' : 'LIVE — pushing draft to Framer CMS'}`);
  console.log('─────────────────────────────────────────────────────────────────\n');

  // Find draft to push
  let slug = process.argv[2];
  if (!slug) {
    const dir = new URL('./data/', import.meta.url);
    const files = readdirSync(dir)
      .filter(f => f.startsWith('framer-draft-') && f.endsWith('.json'));
    if (!files.length) {
      console.error('No draft JSON found. Run /generate-article in Claude Code first.');
      process.exit(1);
    }
    files.sort((a, b) =>
      statSync(new URL(`./data/${b}`, import.meta.url)).mtimeMs -
      statSync(new URL(`./data/${a}`, import.meta.url)).mtimeMs
    );
    slug = files[0].replace('framer-draft-', '').replace('.json', '');
    console.log(`Using latest draft: framer-draft-${slug}.json\n`);
  }

  const draftPath = new URL(`./data/framer-draft-${slug}.json`, import.meta.url);
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch {
    console.error(`Draft not found: data/framer-draft-${slug}.json`);
    process.exit(1);
  }

  const { article, linkedInPosts } = draft;
  let { readTime, imageUrl, articleSchema, faqSchema } = draft;

  // Recalculate readTime if missing
  if (!readTime && article.body) readTime = calcReadTime(article.body);

  // Try Unsplash image if missing and keywords available
  if (!imageUrl && article.imageKeywords) {
    imageUrl = await fetchUnsplashImage(article.imageKeywords);
    if (!imageUrl) console.log(`Image: add manually. Suggested search: "${article.imageKeywords}"`);
  }

  // Build schema if missing from draft
  if (!articleSchema) ({ articleSchema, faqSchema } = buildSchema(article));

  console.log(`Title:     ${article.title}`);
  console.log(`Slug:      /${article.slug}`);
  console.log(`Format:    ${article.format}`);
  console.log(`Read time: ${readTime}`);
  console.log(`FAQs:      ${article.faqs?.length || 0}`);
  console.log(`LinkedIn:  ${linkedInPosts?.length || 0} posts\n`);

  console.log('── JSON-LD Schema (paste into Framer page Custom Code → <head>) ──');
  console.log(`<script type="application/ld+json">\n${JSON.stringify(articleSchema, null, 2)}\n</script>`);
  if (faqSchema?.mainEntity?.length) {
    console.log(`<script type="application/ld+json">\n${JSON.stringify(faqSchema, null, 2)}\n</script>`);
  }
  console.log('─────────────────────────────────────────────────────────────────\n');

  if (DRY_RUN) {
    console.log('Dry run complete — remove DRY_RUN=true to push to Framer.\n');
  } else {
    validateConfig();
    await pushToFramer(article, { readTime, imageUrl });
  }

  await addToLinkedInSheet(article, linkedInPosts || []);
  console.log('Done.\n');
}

run().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
