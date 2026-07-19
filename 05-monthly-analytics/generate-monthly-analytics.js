/**
 * Monthly Website Analytics Report
 *
 * Runs on the 1st of each month. Exports the GA4 Reports snapshot as a PDF
 * for each of the two most recent months, uses Claude to write the email
 * body, then creates a Gmail draft with both PDFs attached.
 *
 * Setup (one-time):
 *   1. node setup-ga4-session.js  → log in to GA4 in browser, session saved
 *   2. node setup-gmail-auth.js   → authorise Gmail API
 *   3. Set GA_PROPERTY_ID and ANTHROPIC_API_KEY in .env
 *
 * Usage:
 *   node generate-monthly-analytics.js              ← last 2 complete months
 *   node generate-monthly-analytics.js --month 2026-06  ← specific month
 *   node generate-monthly-analytics.js --no-gmail   ← skip Gmail (preview only)
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { google } from 'googleapis';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH  = './credentials/google-service-account.json';
const GMAIL_CLIENT_PATH = './credentials/gmail-oauth-client.json';
const GMAIL_TOKEN_PATH  = './credentials/gmail-token.json';
const GA4_SESSION_DIR   = './sessions/ga4';
const PDF_OUTPUT_DIR    = './report';
const GA4_PROPERTY_ID   = process.env.GA_PROPERTY_ID || '123456789';

const CLIENT_EMAIL = process.env.CLIENT_EMAIL || 'client@example.com';
const CLIENT_NAME  = process.env.CLIENT_NAME  || 'Client Name';
const FROM_EMAIL   = process.env.FROM_EMAIL   || 'you@example.com';

// ── Env loading ───────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    const lines = readFileSync('.env', 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (match) process.env[match[1]] = match[2].trim();
    }
  } catch { /* no .env — rely on shell env */ }
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args       = process.argv.slice(2);
  const monthArg   = args.find(a => a.startsWith('--month='))?.split('=')[1]
                  || args[args.indexOf('--month') + 1];
  const noGmail    = args.includes('--no-gmail');
  const emailOnly  = args.includes('--email-only');
  return { monthArg, noGmail, emailOnly };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function buildMonthRange(d) {
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const label = d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  // Format for GA4 URL: YYYYMMDD
  const startParam = start.replace(/-/g, '');
  const endParam   = end.replace(/-/g, '');
  return { year, month, label, start, end, startParam, endParam };
}

function getReportMonths(monthArg) {
  if (monthArg) {
    const [y, m] = monthArg.split('-').map(Number);
    return {
      report:  buildMonthRange(new Date(y, m - 1, 1)),
      compare: buildMonthRange(new Date(y, m - 2, 1)),
    };
  }
  const now = new Date();
  return {
    report:  buildMonthRange(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    compare: buildMonthRange(new Date(now.getFullYear(), now.getMonth() - 2, 1)),
  };
}

// ── GA4 snapshot PDF export ───────────────────────────────────────────────────

async function exportGA4SnapshotPDF(monthRange, outputPath) {
  if (!existsSync(GA4_SESSION_DIR)) {
    throw new Error(`GA4 session not found. Run: node setup-ga4-session.js`);
  }

  const { startParam, endParam, label } = monthRange;

  // GA4 Reports snapshot URL with custom date range
  const params = `_u.date00=${startParam}&_u.date01=${endParam}`;
  const url    = `https://analytics.google.com/analytics/web/#/p${GA4_PROPERTY_ID}/reports/reportinghub?params=${encodeURIComponent(params)}`;

  console.log(`  Exporting ${label}...`);

  const browser = await chromium.launchPersistentContext(GA4_SESSION_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });

    // Wait for GA4 charts to render — look for the active users metric card
    await page.waitForSelector('canvas, [data-item-id]', { timeout: 30_000 }).catch(() => {});

    // Extra settle time for all chart animations to finish
    await page.waitForTimeout(4_000);

    // If redirected to login, session has expired
    if (page.url().includes('accounts.google.com')) {
      throw new Error('GA4 session expired. Re-run: node setup-ga4-session.js');
    }

    await page.pdf({
      path:            outputPath,
      format:          'A4',
      landscape:       true,
      printBackground: true,
      margin:          { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      scale:           0.75,
    });

    console.log(`  Saved: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

// ── GA4 API fetch (for Claude analysis) ──────────────────────────────────────

function parseOverview(resp) {
  const r = resp.rows?.[0];
  if (!r) return { activeUsers: 0, sessions: 0, bounceRate: 0, avgEngagementSecs: 0, pageViews: 0, engagementDuration: 0 };
  return {
    activeUsers:        parseInt(r.metricValues[0].value, 10),
    sessions:           parseInt(r.metricValues[1].value, 10),
    bounceRate:         Math.round(parseFloat(r.metricValues[2].value) * 1000) / 10,
    avgEngagementSecs:  Math.round(parseFloat(r.metricValues[3].value)),
    pageViews:          parseInt(r.metricValues[4].value, 10),
    engagementDuration: parseInt(r.metricValues[5].value, 10),
  };
}

function parseRows(resp, dimKeys, metricKeys) {
  return (resp.rows || []).map(r => {
    const obj = {};
    dimKeys.forEach((k, i)    => { obj[k] = r.dimensionValues[i].value; });
    metricKeys.forEach((k, i) => { obj[k] = parseInt(r.metricValues[i].value, 10); });
    return obj;
  });
}

async function fetchMonthlyGA4(client, propertyId, { start, end }) {
  const property   = `properties/${propertyId}`;
  const dateRanges = [{ startDate: start, endDate: end }];

  const [[overviewResp], [pagesResp], [channelResp], [referralResp], [cityResp]] = await Promise.all([
    client.runReport({
      property, dateRanges,
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'screenPageViews' },
        { name: 'userEngagementDuration' },
      ],
    }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'bounceRate' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'newUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 15,
    }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }, { name: 'newUsers' }],
      dimensionFilter: {
        filter: { fieldName: 'sessionMedium', stringFilter: { value: 'referral' } },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    }),
    client.runReport({
      property, dateRanges,
      dimensions: [{ name: 'city' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 10,
    }),
  ]);

  const overview = parseOverview(overviewResp);
  if (overview.activeUsers > 0) {
    overview.avgEngagementSecs = Math.round(overview.engagementDuration / overview.activeUsers);
  }

  return {
    overview,
    pages:     parseRows(pagesResp,    ['pagePath'], ['sessions', 'pageViews', 'bounceRate']),
    channels:  parseRows(channelResp,  ['channel'],  ['sessions', 'newUsers']),
    referrals: parseRows(referralResp, ['source'],   ['sessions', 'newUsers']),
    cities:    parseRows(cityResp,     ['city'],      ['sessions', 'activeUsers']),
  };
}

// ── Claude email draft ────────────────────────────────────────────────────────

function buildAnalysisPrompt(reportData, compareData, reportLabel, compareLabel) {
  const r = reportData.overview;
  const c = compareData.overview;
  const pct = (a, b) => b === 0 ? 'n/a' : `${a > b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%`;

  const compareRefSources = new Set(compareData.referrals.map(x => x.source));
  const newSources = reportData.referrals.filter(x => !compareRefSources.has(x.source) && x.sessions > 0);

  const summary = {
    reportMonth:        reportLabel,
    compareMonth:       compareLabel,
    activeUsers:        { report: r.activeUsers,        compare: c.activeUsers,        change: pct(r.activeUsers, c.activeUsers) },
    sessions:           { report: r.sessions,           compare: c.sessions,           change: pct(r.sessions, c.sessions) },
    engagementSecs:     { report: r.avgEngagementSecs,  compare: c.avgEngagementSecs,  change: pct(r.avgEngagementSecs, c.avgEngagementSecs) },
    bounceRate:         { report: r.bounceRate,         compare: c.bounceRate },
    pageViews:          { report: r.pageViews,          compare: c.pageViews,          change: pct(r.pageViews, c.pageViews) },
    topPages:           reportData.pages.slice(0, 5),
    comparePages:       compareData.pages.slice(0, 5),
    topChannels:        reportData.channels.slice(0, 6),
    topReferrals:       reportData.referrals.slice(0, 10),
    compareReferrals:   compareData.referrals.slice(0, 10),
    newReferralSources: newSources,
    topCities:          reportData.cities.slice(0, 6),
  };

  return `You are drafting a monthly website analytics email on behalf of a freelance digital marketer. Match the exact style from the reference email below.

## Reference email (style example — match this style exactly)
Hi there,

Please find attached the website analytics report for this month. Below is a summary of key insights compared with last month.

Overall, we're seeing a solid increase in new users and website sessions.

- Active users increased by 20% (from 3.0K to 3.6K). New users also increased, up 18% on last month.
- Website sessions grew by 15%.
- Page views dropped slightly and average engagement time fell a little, this is expected as traffic volume increases, we're getting new users who are briefly exploring the site, and we posted fewer articles this month.
- The careers page entered the top five most visited pages, suggesting job postings are driving meaningful traffic.
- A couple of new referral sources appeared this month, pointing to organic interest picking up from a few new channels.
- One international city entered the top three by sessions ahead of two local cities — the site is growing international presence.
- Broken page views increased slightly as overall traffic grew. These come from old URLs and are mostly accessed by automated bots, not real visitors. Google will gradually remove them from search as it learns these old links are inactive. I'll monitor these monthly and work on clearing the old links permanently.

Happy to walk through any of these in more detail.

Thanks,
[Your name]

## Data
${JSON.stringify(summary, null, 2)}

## Your task
Write the complete email body from "Hi ${CLIENT_NAME}," to "Thanks,\\n[Your name]" for ${reportLabel} vs ${compareLabel}. Follow the reference email structure and style exactly:
- No warm opener — go straight to "Please find attached..."
- One overall summary sentence after the intro
- 6–8 bullets, each with the metric + number + inline explanation of why in the same sentence
- Numbers as: 3.3K, 4.2K, 17% format
- No bold text
- Own any issues in first person ("I'll monitor")
- Closer: "Happy to walk through any of these in more detail."
- Australian English. No em dashes. No consultant language.

Return ONLY the email body. No subject line. No notes.`;
}

async function draftEmailBody(reportData, compareData, reportLabel, compareLabel) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response  = await anthropic.messages.create({
    model:    'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildAnalysisPrompt(reportData, compareData, reportLabel, compareLabel) }],
  });
  return response.content[0].text.trim();
}

// ── Gmail draft ───────────────────────────────────────────────────────────────

async function loadGmailOAuthClient() {
  let clientCreds, token;
  try { clientCreds = JSON.parse(readFileSync(GMAIL_CLIENT_PATH, 'utf-8')); }
  catch { throw new Error(`Gmail OAuth client not found. Run: node setup-gmail-auth.js`); }
  try { token = JSON.parse(readFileSync(GMAIL_TOKEN_PATH, 'utf-8')); }
  catch { throw new Error(`Gmail token not found. Run: node setup-gmail-auth.js`); }

  const { client_id, client_secret, redirect_uris } = clientCreds.installed || clientCreds.web;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oauth2Client.setCredentials(token);
  oauth2Client.on('tokens', updated => {
    writeFileSync(GMAIL_TOKEN_PATH, JSON.stringify({ ...token, ...updated }, null, 2));
  });
  return oauth2Client;
}

function encodeMimeRaw(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildMimeMessage({ from, to, subject, textBody, attachments }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines    = [
    'MIME-Version: 1.0',
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    textBody,
  ];

  for (const att of attachments) {
    const b64 = att.content.toString('base64');
    lines.push('', `--${boundary}`,
      `Content-Type: application/pdf; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      'Content-Transfer-Encoding: base64', '',
      ...(b64.match(/.{1,76}/g) || []));
  }

  lines.push('', `--${boundary}--`);
  return lines.join('\r\n');
}

async function createGmailDraft(emailBody, pdfPaths, subject) {
  const auth  = await loadGmailOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const mime = buildMimeMessage({
    from:        FROM_EMAIL,
    to:          CLIENT_EMAIL,
    subject,
    textBody:    emailBody,
    attachments: pdfPaths.map(p => ({ filename: path.basename(p), content: readFileSync(p) })),
  });

  const draft = await gmail.users.drafts.create({
    userId:      'me',
    requestBody: { message: { raw: encodeMimeRaw(mime) } },
  });
  return draft.data.id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();

  const { monthArg, noGmail, emailOnly } = parseArgs();
  const { ANTHROPIC_API_KEY } = process.env;
  const propertyId = process.env.GA_PROPERTY_ID || GA4_PROPERTY_ID;

  if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY env var'); process.exit(1); }

  const { report, compare } = getReportMonths(monthArg);
  console.log(`\nGenerating: ${report.label} vs ${compare.label}\n`);

  mkdirSync(PDF_OUTPUT_DIR, { recursive: true });
  const reportPDFPath  = path.join(PDF_OUTPUT_DIR, `${report.label} - Website Report.pdf`);
  const comparePDFPath = path.join(PDF_OUTPUT_DIR, `${compare.label} - Website Report.pdf`);

  if (!emailOnly) {
    console.log('Exporting GA4 snapshots...');
    await exportGA4SnapshotPDF(report,  reportPDFPath);
    await exportGA4SnapshotPDF(compare, comparePDFPath);
  }

  // Fetch API data for Claude analysis
  console.log('Fetching GA4 data for email analysis...');
  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const gaClient    = new BetaAnalyticsDataClient({ credentials });

  const [reportData, compareData] = await Promise.all([
    fetchMonthlyGA4(gaClient, propertyId, report),
    fetchMonthlyGA4(gaClient, propertyId, compare),
  ]);
  console.log(`  ${report.label}: ${reportData.overview.activeUsers.toLocaleString()} active users`);
  console.log(`  ${compare.label}: ${compareData.overview.activeUsers.toLocaleString()} active users`);

  // 3. Draft email with Claude
  console.log('\nDrafting email with Claude...');
  const emailBody = await draftEmailBody(reportData, compareData, report.label, compare.label);

  console.log('\n── Email draft ──────────────────────────────────────────────\n');
  console.log(emailBody);
  console.log('\n─────────────────────────────────────────────────────────────\n');

  const subject = `${report.label} Website Analytics Report`;

  if (noGmail) {
    console.log('PDFs saved to:');
    console.log(`  ${comparePDFPath}`);
    console.log(`  ${reportPDFPath}`);
    console.log('\nRun without --no-gmail to push directly to Gmail Drafts.');
    return;
  }

  // 4. Create Gmail draft — never auto-sends, always requires manual review and send
  console.log('Creating Gmail draft (will NOT send — review in Gmail Drafts before sending)...');
  const draftId = await createGmailDraft(emailBody, [comparePDFPath, reportPDFPath], subject);
  console.log(`\nDraft created. Open Gmail Drafts to review and send: https://mail.google.com/mail/#drafts`);
  console.log('Update [Opening line] before sending.');
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  if (err.message?.includes('invalid_grant')) console.error('Gmail token expired. Re-run: node setup-gmail-auth.js');
  if (err.message?.includes('session expired'))  console.error('Re-run: node setup-ga4-session.js');
  process.exit(1);
});
