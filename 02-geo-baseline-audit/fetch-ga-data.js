/**
 * Fetches Google Analytics 4 traffic data for a client's website.
 * Outputs data/ga_data.json for use in the GEO baseline report.
 *
 * Setup required (once):
 *   1. Enable Google Analytics Data API at console.cloud.google.com
 *   2. Create service account → download JSON key → save as credentials/google-service-account.json
 *   3. In GA4: Admin → Property Access Management → add service account email as Viewer
 *   4. Set GA_PROPERTY_ID env var (numeric, from GA4 Admin → Property details)
 *
 * Usage: npm run fetch-ga
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import readline from 'readline';

const CREDENTIALS_PATH = './credentials/google-service-account.json';
const OUTPUT_PATH      = './data/ga_data.json';
const DAYS_BACK        = 90;

const AI_REFERRERS = ['perplexity.ai', 'claude.ai', 'chatgpt.com', 'chat.openai.com', 'bard.google.com', 'gemini.google.com'];

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function getPropertyId() {
  const envId = process.env.GA_PROPERTY_ID;
  if (envId) return envId;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const id = await new Promise(r => rl.question('\nEnter your GA4 Property ID (numeric, e.g. 123456789): ', r));
  rl.close();
  return id.trim();
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

  const propertyId = await getPropertyId();
  const property   = `properties/${propertyId}`;

  const client = new BetaAnalyticsDataClient({ credentials });

  const startDate = dateStr(DAYS_BACK);
  const endDate   = dateStr(0);
  const dateRange = [{ startDate, endDate }];

  console.log(`\nFetching GA4 data for property: ${propertyId}`);
  console.log(`Date range: ${startDate} → ${endDate}\n`);

  // 1. Sessions by default channel group
  const [channelResp] = await client.runReport({
    property,
    dateRanges: dateRange,
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics:    [{ name: 'sessions' }, { name: 'newUsers' }, { name: 'bounceRate' }, { name: 'averageSessionDuration' }],
    orderBys:   [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 20,
  });

  const channelRows = (channelResp.rows || []).map(r => ({
    channel:         r.dimensionValues[0].value,
    sessions:        parseInt(r.metricValues[0].value, 10),
    newUsers:        parseInt(r.metricValues[1].value, 10),
    bounceRate:      Math.round(parseFloat(r.metricValues[2].value) * 1000) / 10,
    avgSessionSecs:  Math.round(parseFloat(r.metricValues[3].value)),
  }));

  // 2. All referral sources (to find AI platforms)
  const [referralResp] = await client.runReport({
    property,
    dateRanges: dateRange,
    dimensions: [{ name: 'sessionSource' }],
    metrics:    [{ name: 'sessions' }, { name: 'newUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionMedium',
        stringFilter: { value: 'referral' },
      },
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 50,
  });

  const allReferrals = (referralResp.rows || []).map(r => ({
    source:   r.dimensionValues[0].value,
    sessions: parseInt(r.metricValues[0].value, 10),
    newUsers: parseInt(r.metricValues[1].value, 10),
  }));

  const aiReferrals = AI_REFERRERS.map(domain => {
    const found = allReferrals.find(r => r.source.includes(domain));
    return { source: domain, sessions: found?.sessions || 0, newUsers: found?.newUsers || 0 };
  }).sort((a, b) => b.sessions - a.sessions);

  // 3. Top organic landing pages
  const [landingResp] = await client.runReport({
    property,
    dateRanges: dateRange,
    dimensions: [{ name: 'landingPage' }],
    metrics:    [{ name: 'sessions' }, { name: 'newUsers' }, { name: 'bounceRate' }],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { value: 'Organic Search' },
      },
    },
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 10,
  });

  const topOrganicLandingPages = (landingResp.rows || []).map(r => ({
    page:       r.dimensionValues[0].value,
    sessions:   parseInt(r.metricValues[0].value, 10),
    newUsers:   parseInt(r.metricValues[1].value, 10),
    bounceRate: Math.round(parseFloat(r.metricValues[2].value) * 1000) / 10,
  }));

  // 4. New vs returning for organic
  const [newReturnResp] = await client.runReport({
    property,
    dateRanges: dateRange,
    dimensions: [{ name: 'newVsReturning' }],
    metrics:    [{ name: 'sessions' }],
    dimensionFilter: {
      filter: {
        fieldName: 'sessionDefaultChannelGroup',
        stringFilter: { value: 'Organic Search' },
      },
    },
  });

  const newVsReturning = {};
  for (const r of (newReturnResp.rows || [])) {
    newVsReturning[r.dimensionValues[0].value] = parseInt(r.metricValues[0].value, 10);
  }

  const organicRow = channelRows.find(r => r.channel === 'Organic Search') || { sessions: 0, newUsers: 0 };
  const totalAiSessions = aiReferrals.reduce((s, r) => s + r.sessions, 0);

  const output = {
    fetchedAt:   new Date().toISOString(),
    propertyId,
    dateRange:   { start: startDate, end: endDate, days: DAYS_BACK },
    summary: {
      totalOrganicSessions:   organicRow.sessions,
      totalOrganicNewUsers:   organicRow.newUsers,
      totalAiReferralSessions: totalAiSessions,
      topChannel:              channelRows[0]?.channel || 'Unknown',
    },
    channelBreakdown:       channelRows,
    aiPlatformReferrals:    aiReferrals,
    topOrganicLandingPages,
    organicNewVsReturning:  newVsReturning,
    allTopReferrals:        allReferrals.slice(0, 20),
  };

  mkdirSync('./data', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nGA4 data saved to ${OUTPUT_PATH}`);
  console.log(`  Organic sessions:     ${organicRow.sessions.toLocaleString()}`);
  console.log(`  AI referral sessions: ${totalAiSessions}`);
  console.log(`  Top channel:          ${channelRows[0]?.channel || 'Unknown'}`);
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  if (err.message?.includes('PERMISSION_DENIED')) {
    console.error('Check that the service account has Viewer access to this GA4 property.');
  }
  process.exit(1);
});
