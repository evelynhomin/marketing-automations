/**
 * Fetches Google Search Console performance data for a client's website.
 * Outputs data/gsc_data.json for use in the GEO baseline report.
 *
 * Setup required (once):
 *   1. Enable Search Console API at console.cloud.google.com
 *   2. Create service account → download JSON key → save as credentials/google-service-account.json
 *   3. In GSC: Settings → Users → add service account email (Restricted)
 *   4. Set GSC_SITE_URL env var (e.g. sc-domain:example.com or https://example.com/)
 *
 * Usage: npm run fetch-gsc
 */

import { google } from 'googleapis';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import readline from 'readline';

const CREDENTIALS_PATH = './credentials/google-service-account.json';
const OUTPUT_PATH      = './data/gsc_data.json';
const DAYS_BACK        = 90;

// Example values — replace with the client's actual brand terms and industry search themes
const BRAND_TERMS = ['your-brand', 'your-ticker', 'your-product-name'];
const DISCOVERY_THEMES = [
  'your industry category',
  'your market + location',
  'your product category',
  'a broader problem your product solves',
];

function isBranded(query) {
  const q = query.toLowerCase();
  return BRAND_TERMS.some(t => q.includes(t));
}

function matchesDiscovery(query) {
  const q = query.toLowerCase();
  return DISCOVERY_THEMES.some(t => q.includes(t));
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function getSiteUrl(auth) {
  const envUrl = process.env.GSC_SITE_URL;
  if (envUrl) return envUrl;

  const sc = google.searchconsole({ version: 'v1', auth });
  const { data } = await sc.sites.list();
  const sites = (data.siteEntry || []).map(s => s.siteUrl);
  if (sites.length === 0) throw new Error('No sites found in this Search Console account.');
  if (sites.length === 1) return sites[0];

  console.log('\nMultiple sites found:');
  sites.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question('\nEnter site number to use: ', r));
  rl.close();
  return sites[parseInt(answer, 10) - 1];
}

async function fetchQueries(sc, siteUrl, startDate, endDate, rowLimit = 500) {
  const { data } = await sc.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['query'],
      rowLimit,
    },
  });
  return (data.rows || []).map(r => ({
    query:       r.keys[0],
    clicks:      r.clicks,
    impressions: r.impressions,
    ctr:         Math.round(r.ctr * 1000) / 10,
    position:    Math.round(r.position * 10) / 10,
  }));
}

async function fetchAiOverviewPages(sc, siteUrl, startDate, endDate) {
  try {
    const { data } = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: 25,
        searchType: 'web',
        dataState: 'all',
      },
    });
    return (data.rows || []).map(r => ({
      page:        r.keys[0],
      clicks:      r.clicks,
      impressions: r.impressions,
      ctr:         Math.round(r.ctr * 1000) / 10,
      position:    Math.round(r.position * 10) / 10,
    }));
  } catch {
    return [];
  }
}

async function main() {
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch {
    console.error(`\nCredentials not found at ${CREDENTIALS_PATH}`);
    console.error('Follow setup instructions at the top of this file.');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });

  const sc      = google.searchconsole({ version: 'v1', auth });
  const siteUrl = await getSiteUrl(auth);
  const endDate = dateStr(3);
  const startDate = dateStr(DAYS_BACK + 3);

  console.log(`\nFetching GSC data for: ${siteUrl}`);
  console.log(`Date range: ${startDate} → ${endDate}\n`);

  const allQueries = await fetchQueries(sc, siteUrl, startDate, endDate);
  console.log(`  Total queries fetched: ${allQueries.length}`);

  const branded    = allQueries.filter(q => isBranded(q.query));
  const nonBranded = allQueries.filter(q => !isBranded(q.query));
  const discovery  = allQueries.filter(q => matchesDiscovery(q.query));

  const topBranded    = branded.sort((a, b) => b.impressions - a.impressions).slice(0, 15);
  const topNonBranded = nonBranded.sort((a, b) => b.impressions - a.impressions).slice(0, 20);
  const topDiscovery  = discovery.sort((a, b) => b.impressions - a.impressions).slice(0, 15);

  const aiOverviewPages = await fetchAiOverviewPages(sc, siteUrl, startDate, endDate);

  const totalBrandedImpressions    = branded.reduce((s, q) => s + q.impressions, 0);
  const totalNonBrandedImpressions = nonBranded.reduce((s, q) => s + q.impressions, 0);
  const totalBrandedClicks         = branded.reduce((s, q) => s + q.clicks, 0);
  const totalNonBrandedClicks      = nonBranded.reduce((s, q) => s + q.clicks, 0);

  const output = {
    fetchedAt:                new Date().toISOString(),
    siteUrl,
    dateRange:                { start: startDate, end: endDate, days: DAYS_BACK },
    summary: {
      totalQueries:           allQueries.length,
      brandedQueries:         branded.length,
      nonBrandedQueries:      nonBranded.length,
      discoveryThemeMatches:  discovery.length,
      totalBrandedImpressions,
      totalNonBrandedImpressions,
      totalBrandedClicks,
      totalNonBrandedClicks,
    },
    topBrandedQueries:        topBranded,
    topNonBrandedQueries:     topNonBranded,
    discoveryQueryMatches:    topDiscovery,
    aiOverviewPages,
  };

  mkdirSync('./data', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nGSC data saved to ${OUTPUT_PATH}`);
  console.log(`  Branded queries:      ${branded.length} (${totalBrandedImpressions.toLocaleString()} impressions)`);
  console.log(`  Non-branded queries:  ${nonBranded.length} (${totalNonBrandedImpressions.toLocaleString()} impressions)`);
  console.log(`  Discovery matches:    ${discovery.length}`);
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
