/**
 * Generates the GEO Baseline Report HTML.
 * Loads data/scores.csv (baseline), data/discovery_scores.csv (discovery),
 * and optionally data/gsc_data.json + data/ga_data.json (Google API exports).
 *
 * Workflow:
 *   1. npm run scores-template       → data/scores.csv (100 blank rows)
 *   2. Fill in scores.csv from baseline screenshots
 *   3. npm run screenshots-discovery → ChatGPT/Claude/Google discovery screenshots
 *   4. npm run perplexity-discovery  → Perplexity discovery screenshots
 *   5. npm run discovery-template    → data/discovery_scores.csv (60 blank rows)
 *   6. Fill in discovery_scores.csv from discovery screenshots
 *   7. npm run fetch-all             → data/gsc_data.json + data/ga_data.json (optional)
 *   8. npm run report                → generates full report
 *   9. Chrome → Print → Save as PDF
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';

// ── CSV parser ─────────────────────────────────────────────────────────────
function parseCSV(content) {
  const lines = content.trim().split('\n').filter(Boolean);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, (fields[i] || '').replace(/^"|"$/g, '').trim()]));
  });
}

// ── Stats helpers ──────────────────────────────────────────────────────────
function pct(n, d) { return d === 0 ? 0 : Math.round((n / d) * 100); }
function isMentioned(v) { return v === 'Y' || v === '1' || v === 1 || v === true; }

function framingCounts(rows) {
  const counts = { positive: 0, neutral: 0, caveated: 0, absent: 0 };
  for (const r of rows) {
    const f = (r.framing || '').toLowerCase();
    if (f === 'positive') counts.positive++;
    else if (f === 'neutral') counts.neutral++;
    else if (f === 'caveated') counts.caveated++;
    else counts.absent++;
  }
  return counts;
}

const BASELINE_GROUPS       = ['brand', 'investor', 'partner', 'customer', 'media'];
const BASELINE_GROUP_LABELS = { brand: 'Brand / Direct', investor: 'Investor Intent', partner: 'Industry Partner', customer: 'Customer / End User', media: 'Media / Analyst' };
const DISCOVERY_GROUPS      = ['investor', 'medical', 'tech', 'media'];
const DISCOVERY_GROUP_LABELS = { investor: 'Investor Intent', medical: 'Medical / Diagnostics', tech: 'Technology', media: 'Media / Analyst' };

function computeStats(scores, options = {}) {
  const PLATFORMS = ['chatgpt', 'claude', 'perplexity', 'google'];
  const GROUPS    = options.groups      || BASELINE_GROUPS;
  const GROUP_LABELS = options.groupLabels || BASELINE_GROUP_LABELS;
  const PLATFORM_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', google: 'Google AI Mode' };

  const mentioned = scores.filter(s => isMentioned(s.mentioned)).length;

  const byPlatform = {};
  for (const p of PLATFORMS) {
    const ps = scores.filter(s => s.platform === p);
    const m  = ps.filter(s => isMentioned(s.mentioned)).length;
    byPlatform[p] = { label: PLATFORM_LABELS[p], total: ps.length, mentioned: m, rate: pct(m, ps.length), framing: framingCounts(ps) };
  }

  const byGroup = {};
  for (const g of GROUPS) {
    const gs = scores.filter(s => s.group === g);
    const m  = gs.filter(s => isMentioned(s.mentioned)).length;
    byGroup[g] = { label: GROUP_LABELS[g] || g, total: gs.length, mentioned: m, rate: pct(m, gs.length), framing: framingCounts(gs) };
  }

  const heatmap = {};
  for (const p of PLATFORMS) {
    heatmap[p] = {};
    for (const g of GROUPS) {
      const gs = scores.filter(s => s.platform === p && s.group === g);
      heatmap[p][g] = gs.length ? pct(gs.filter(s => isMentioned(s.mentioned)).length, gs.length) : null;
    }
  }

  const competitorCounts = {};
  for (const s of scores) {
    for (const c of (s.competitors || '').split('|').map(x => x.trim()).filter(Boolean)) {
      competitorCounts[c] = (competitorCounts[c] || 0) + 1;
    }
  }

  const sourceCounts = {};
  for (const s of scores.filter(s => s.platform === 'perplexity' || s.platform === 'google')) {
    for (const src of (s.sources || '').split('|').map(x => x.trim()).filter(Boolean)) {
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
  }

  const topCompetitors = Object.entries(competitorCounts).sort(([,a],[,b]) => b - a).slice(0, 12);
  const topSources     = Object.entries(sourceCounts).sort(([,a],[,b]) => b - a).slice(0, 15);
  const acmeSourceCount = topSources.filter(([d]) => d.includes('acme') || d.includes('acmematerials')).reduce((s,[,n]) => s + n, 0);

  return {
    total: scores.length, mentioned, overallRate: pct(mentioned, scores.length),
    PLATFORMS, GROUPS, GROUP_LABELS, byPlatform, byGroup, heatmap,
    topCompetitors, topSources, acmeSourceCount, scores,
  };
}

// ── Color helpers ──────────────────────────────────────────────────────────
function rateColor(rate) {
  if (rate === null) return '#E5E7EB';
  if (rate >= 70) return '#16A34A';
  if (rate >= 40) return '#F59E0B';
  if (rate > 0)  return '#EF4444';
  return '#DC2626';
}
function rateTextColor(rate) { return (rate === null) ? '#9CA3AF' : '#fff'; }

function framingBadge(framing) {
  const map = { positive: ['#DCFCE7','#15803D'], neutral: ['#DBEAFE','#1D4ED8'], caveated: ['#FEF3C7','#92400E'], absent: ['#FEE2E2','#B91C1C'] };
  const [bg, color] = map[(framing||'absent').toLowerCase()] || map.absent;
  const label = framing ? framing.charAt(0).toUpperCase() + framing.slice(1) : 'Absent';
  return `<span style="background:${bg};color:${color};padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;">${label}</span>`;
}
function mentionBadge(v) {
  return isMentioned(v)
    ? `<span style="color:#16A34A;font-weight:700;">✓ Yes</span>`
    : `<span style="color:#DC2626;font-weight:700;">✗ No</span>`;
}

// ── Platform authority content ─────────────────────────────────────────────
// NOTE: this is example/placeholder content for a fictional company ("Acme Corp") —
// customize per client based on their industry, products, and target queries.
const PLATFORM_AUTHORITY = {
  chatgpt: {
    label:     'ChatGPT',
    icon:      '🤖',
    mechanism: 'Training data + live web search (Bing)',
    how:       'ChatGPT combines its training data with live Bing web search results. The most effective way to improve Acme\'s visibility here is press coverage. The more Acme appears in well-known publications and news sites, the more likely ChatGPT is to include it.',
    actions:   ['Secure coverage in relevant trade and business press', 'Issue press releases that get picked up by news sites indexed by Bing', 'Publish long-form content optimised for the client\'s core product searches'],
    color:     '#10A37F',
  },
  claude: {
    label:     'Claude',
    icon:      '🧠',
    mechanism: 'Training data (updated periodically)',
    how:       'Claude is trained on a large dataset and updated regularly. It favours well-cited, authoritative content. A Wikipedia page, academic or industry references, and detailed long-form pages on the client\'s own site all contribute to visibility.',
    actions:   ['Create or expand a Wikipedia page for the brand', 'Pursue citations in industry or research publications', 'Publish detailed explainers on the client\'s flagship products'],
    color:     '#7C3AED',
  },
  perplexity: {
    label:     'Perplexity',
    icon:      '🔍',
    mechanism: 'Real-time web search with source citations',
    how:       'Perplexity pulls directly from websites and cites its sources in every response. Every well-structured new page on the client\'s site is a potential reference. It\'s the most responsive platform to content improvements.',
    actions:   ['Build audience-focused landing pages for key search topics', 'Create a dedicated product technology page with clear headings', 'Issue press releases — Perplexity indexes news content quickly'],
    color:     '#1D4ED8',
  },
  google: {
    label:     'Google AI Mode',
    icon:      '✦',
    mechanism: 'Google Search index + structured data markup',
    how:       'Google AI draws from its own search index. Pages that are well-structured and include schema markup (structured data that labels page content for search engines) are more likely to be cited. FAQ pages are especially effective.',
    actions:   ['Add FAQ sections and schema markup to key pages', 'Implement organisation and product structured data (JSON-LD)', 'Strengthen page authority with author credentials and external citations'],
    color:     '#EA4335',
  },
};

// ── Discovery gap content ──────────────────────────────────────────────────
// Example placeholder copy for a fictional "Acme Corp" — replace with real,
// client-specific reasoning per query when running this for an actual client.
const DISCOVERY_WHY = {
  D01: 'Acme is one of the only companies in its category with this specific combination of products. There is no more direct answer to this search.',
  D02: 'Acme is a strong match for this investor-intent search given its market position and listed status. It is a direct answer to this query.',
  D03: 'Acme operates across two related product lines that are both relevant to this search. That combination is uncommon and directly relevant.',
  D04: 'Acme is one of a small number of companies building this kind of product locally. The flagship product is a physical offering, not just a service.',
  D05: "Acme's diagnostic product is a direct match for this search based on its design and intended use.",
  D06: "Acme's diagnostic product addresses a specific, well-defined use case that matches this search closely.",
  D07: "Acme's diagnostic product's core function is the most directly relevant answer to this specific search.",
  D08: 'Acme is building a commercial product in this exact category. It is one of the most directly relevant companies for this search.',
  D09: 'Acme\'s flagship product uses a distinctive underlying technology that sets it apart from most alternatives.',
  D10: 'Acme\'s flagship product has a technical differentiator that most competitors in the category do not offer.',
  D11: 'Acme\'s flagship product uses a proprietary architecture, making it one of the more distinctive local results for this search.',
  D12: "Acme's flagship product has applications beyond its primary use case. Acme is one of few companies developing this commercially.",
  D13: "Acme is one of a small number of listed companies in its category with active development across two product lines.",
  D14: 'Acme operates across two related fields, which makes it a natural fit for coverage of this broader search.',
  D15: "Acme is actively commercialising its diagnostic product. It is one of the more advanced local commercialisation stories in this space.",
};

const GROUP_ACTION = {
  investor: 'Build investor-focused pages that position Acme clearly within its market category. A dedicated landing page for the client\'s core investor search terms would help significantly.',
  medical:  "Create plain-language content about the diagnostic product's application. Focus on what it does, who it's for, and what stage it's at.",
  tech:     'Publish technical pages on the flagship product covering its key differentiators and architecture. Getting cited in relevant technical or trade publications would improve visibility on this platform.',
  media:    "Issue press releases that position Acme as a leading company in its category. Brief journalists who cover the relevant industry and listed companies.",
};

function computeGapStats(discoveryScores) {
  const byId = {};
  for (const s of discoveryScores.filter(s => s.mentioned !== '')) {
    if (!byId[s.id]) byId[s.id] = [];
    byId[s.id].push(s);
  }
  const groups = Object.values(byId);
  return {
    missedEverywhere: groups.filter(rows => rows.every(r => !isMentioned(r.mentioned))).length,
    gapOpportunities: groups.filter(rows => rows.filter(r => !isMentioned(r.mentioned)).length >= 2).length,
  };
}

function buildDiscoveryGapCards(discoveryScores) {
  const PLATFORM_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', google: 'Google AI Mode' };

  const byId = {};
  for (const s of discoveryScores.filter(s => s.mentioned !== '')) {
    if (!byId[s.id]) byId[s.id] = [];
    byId[s.id].push(s);
  }

  if (Object.keys(byId).length === 0) return '';

  const gaps = [];
  for (const [id, rows] of Object.entries(byId).sort(([a],[b]) => a.localeCompare(b))) {
    const missed = rows.filter(r => !isMentioned(r.mentioned));
    if (missed.length >= 2) gaps.push({ id, rows, missed });
  }

  if (gaps.length === 0) return `<p style="color:#9CA3AF;font-size:14px;padding:16px 0;text-align:center;">No discovery gaps found. Acme appeared on at least 3 platforms for all 15 queries.</p>`;

  const byGroup = { investor: [], medical: [], tech: [], media: [] };
  for (const gap of gaps) {
    const group = gap.rows[0]?.group || 'investor';
    if (byGroup[group]) byGroup[group].push(gap);
  }

  const GROUP_TITLES = { investor: 'Investor & Market', medical: 'Medical & Diagnostics', tech: 'Technology', media: 'Media & Analyst' };

  let html = '';
  for (const [group, groupGaps] of Object.entries(byGroup)) {
    if (groupGaps.length === 0) continue;
    html += `<h3 style="font-size:15px;font-weight:700;color:var(--navy);margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--border);">${GROUP_TITLES[group]}</h3>`;
    for (const { id, rows, missed } of groupGaps) {
      const queryText    = rows[0]?.query || id;
      const missedLabels = missed.map(r => PLATFORM_LABELS[r.platform] || r.platform).join(' · ');
      const competitorSet = [...new Set(missed.flatMap(r => (r.competitors || '').split('|').map(x => x.trim()).filter(Boolean)))];
      const why   = DISCOVERY_WHY[id]   || "Acme's technology is directly relevant to this query.";
      const action = GROUP_ACTION[group] || 'Create targeted content for this query.';

      html += `
      <div style="border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;margin-bottom:16px;">
        <div style="background:#FEF2F2;padding:14px 18px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #FECACA;flex-wrap:wrap;gap:8px;">
          <span style="background:#DC2626;color:#fff;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;">MISSED</span>
          <span style="font-weight:700;font-size:14px;color:#111827;">"${queryText}"</span>
          <span style="margin-left:auto;font-size:12px;color:#9CA3AF;white-space:nowrap;">${missedLabels}</span>
        </div>
        <div style="padding:16px 18px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
          <div>
            <div style="font-size:11px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">What appeared instead</div>
            ${competitorSet.length > 0
              ? `<ul style="font-size:13px;color:#374151;line-height:1.8;list-style:none;padding:0;margin:0;">${competitorSet.map(c => `<li>• ${c}</li>`).join('')}</ul>`
              : `<p style="font-size:13px;color:#9CA3AF;margin:0;">See screenshot notes column.</p>`}
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;color:#16A34A;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Why Acme should appear</div>
            <p style="font-size:13px;color:#374151;line-height:1.6;margin:0;">${why}</p>
          </div>
          <div>
            <div style="font-size:11px;font-weight:700;color:#1D4ED8;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Recommended action</div>
            <p style="font-size:13px;color:#374151;line-height:1.6;margin:0;">${action}</p>
          </div>
        </div>
      </div>`;
    }
  }
  return html;
}

// ── Per-query competitor mapping (discovery misses) ────────────────────────
function buildCompetitorQueryMap(discoveryScores) {
  const PLATFORM_LABELS = { chatgpt: 'ChatGPT', claude: 'Claude', perplexity: 'Perplexity', google: 'Google AI Mode' };
  const byGroup = { investor: [], medical: [], tech: [], media: [] };
  const GROUP_TITLES = { investor: 'Investor & Market', medical: 'Medical & Diagnostics', tech: 'Technology', media: 'Media & Analyst' };

  const byId = {};
  for (const s of discoveryScores.filter(s => s.mentioned !== '' && !isMentioned(s.mentioned))) {
    if (!byId[s.id]) byId[s.id] = { query: s.query, group: s.group, id: s.id, platforms: [], competitors: new Set() };
    byId[s.id].platforms.push(PLATFORM_LABELS[s.platform] || s.platform);
    (s.competitors || '').split('|').map(x => x.trim()).filter(Boolean).forEach(c => byId[s.id].competitors.add(c));
  }

  for (const item of Object.values(byId)) {
    if (byGroup[item.group]) byGroup[item.group].push(item);
  }

  let html = '';
  for (const [group, items] of Object.entries(byGroup)) {
    if (items.length === 0) continue;
    html += `<div style="margin-bottom:24px;">
      <div style="font-size:13px;font-weight:700;color:var(--navy);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border);">${GROUP_TITLES[group]}</div>`;
    for (const item of items.sort((a,b) => a.id.localeCompare(b.id))) {
      const comps = [...item.competitors].slice(0, 5);
      html += `<div style="display:grid;grid-template-columns:160px 1fr 1fr;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid #F3F4F6;font-size:13px;">
        <div style="font-weight:600;color:#374151;">${item.id}: "${item.query}"</div>
        <div style="color:#6B7280;">Missed on: <span style="color:#DC2626;font-weight:600;">${item.platforms.join(', ')}</span></div>
        <div style="color:#374151;">${comps.length > 0 ? comps.join(' · ') : '—'}</div>
      </div>`;
    }
    html += `</div>`;
  }
  return html || '<p style="color:#9CA3AF;font-size:14px;">No per-query competitor data available.</p>';
}

// ── Per-platform source strategy ───────────────────────────────────────────
function buildSourceStrategy(stats, discoveryScores) {
  const PLATFORMS = ['perplexity', 'google', 'chatgpt', 'claude'];
  const strategies = {
    perplexity: {
      label:     'Perplexity',
      mechanism: 'Real-time source retrieval',
      color:     '#1D4ED8',
    },
    google: {
      label:     'Google AI Mode',
      mechanism: 'Search index + structured data',
      color:     '#EA4335',
    },
    chatgpt: {
      label:     'ChatGPT',
      mechanism: 'Training data + Bing',
      color:     '#10A37F',
    },
    claude: {
      label:     'Claude',
      mechanism: 'Training data weighted',
      color:     '#7C3AED',
    },
  };

  const allScores = [...stats.scores, ...discoveryScores];

  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">';
  for (const p of PLATFORMS) {
    const pScores = allScores.filter(s => s.platform === p);
    const sourceDomains = new Set();
    let acmeCitations = 0;
    for (const s of pScores) {
      for (const src of (s.sources || '').split('|').map(x => x.trim()).filter(Boolean)) {
        sourceDomains.add(src);
        if (/acme|acmematerials\.com/i.test(src)) acmeCitations++;
      }
    }
    const totalCitations = sourceDomains.size;
    const st = strategies[p];

    const citationInsight = p === 'chatgpt' || p === 'claude'
      ? `<div style="font-size:12px;color:#6B7280;line-height:1.5;margin-top:8px;">This platform uses training data. URL citations are rare. Visibility comes from <strong>press coverage</strong> and <strong>authoritative publications</strong> rather than direct page citations.</div>`
      : acmeCitations > 0
        ? `<div style="font-size:12px;color:#16A34A;line-height:1.5;margin-top:8px;">✓ <strong>acmematerials.com cited ${acmeCitations} time(s).</strong> This platform is already retrieving Acme-owned content. Each additional citable page on acmematerials.com directly improves this platform's mention rate.</div>`
        : `<div style="font-size:12px;color:#DC2626;line-height:1.5;margin-top:8px;">✗ <strong>No acmematerials.com citations detected.</strong> Acme-owned content is not being retrieved. Publishing structured, citable pages on acmematerials.com is the highest-ROI action for this platform.</div>`;

    html += `<div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <span style="width:8px;height:8px;border-radius:50%;background:${st.color};display:inline-block;"></span>
        <span style="font-weight:700;font-size:14px;color:var(--navy);">${st.label}</span>
        <span style="margin-left:auto;font-size:11px;color:#9CA3AF;">${st.mechanism}</span>
      </div>
      <div style="display:flex;gap:20px;margin-bottom:8px;">
        <div><div style="font-size:22px;font-weight:800;color:${st.color};">${totalCitations}</div><div style="font-size:11px;color:#9CA3AF;">unique sources cited</div></div>
        <div><div style="font-size:22px;font-weight:800;color:${acmeCitations > 0 ? '#16A34A' : '#DC2626'};">${acmeCitations}</div><div style="font-size:11px;color:#9CA3AF;">acmematerials.com citations</div></div>
      </div>
      ${citationInsight}
    </div>`;
  }
  html += '</div>';
  return html;
}

// ── GSC section ────────────────────────────────────────────────────────────
function buildGSCSection(gscData) {
  if (!gscData) {
    return `<div class="finding" style="background:#FFFBEB;border-left:4px solid #F59E0B;color:#92400E;">
      <strong>Google Search Console data not yet connected.</strong><br>
      To add live organic search data to this report:<br>
      <code style="display:block;background:rgba(0,0,0,0.06);padding:10px 14px;border-radius:6px;margin:12px 0 6px;font-size:13px;color:#374151;line-height:2;">
        1. Add credentials/google-service-account.json<br>
        2. npm run fetch-gsc
      </code>
      See the setup instructions at the top of fetch-gsc-data.js.
    </div>`;
  }

  const { summary, topBrandedQueries, topNonBrandedQueries, discoveryQueryMatches, dateRange } = gscData;

  const brandedRows = topBrandedQueries.slice(0, 10).map(q =>
    `<tr>
      <td style="padding:9px 12px;font-size:13px;">${q.query}</td>
      <td style="padding:9px 12px;text-align:right;">${q.impressions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.clicks.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.ctr}%</td>
      <td style="padding:9px 12px;text-align:right;">${q.position}</td>
    </tr>`
  ).join('');

  const nonBrandedRows = topNonBrandedQueries.slice(0, 10).map(q =>
    `<tr>
      <td style="padding:9px 12px;font-size:13px;">${q.query}</td>
      <td style="padding:9px 12px;text-align:right;">${q.impressions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.clicks.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.ctr}%</td>
      <td style="padding:9px 12px;text-align:right;">${q.position}</td>
    </tr>`
  ).join('');

  const discoveryRows = discoveryQueryMatches.slice(0, 8).map(q =>
    `<tr>
      <td style="padding:9px 12px;font-size:13px;">${q.query}</td>
      <td style="padding:9px 12px;text-align:right;">${q.impressions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.clicks.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${q.ctr}%</td>
      <td style="padding:9px 12px;text-align:right;">${q.position}</td>
    </tr>`
  ).join('');

  const brandedShare = pct(summary.totalBrandedImpressions, summary.totalBrandedImpressions + summary.totalNonBrandedImpressions);

  return `
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;">
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--blue);">${summary.totalBrandedImpressions.toLocaleString()}</div>
      <div class="kpi-label">Branded Impressions</div>
      <div class="kpi-sub">${dateRange.days}-day window</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--navy);">${summary.totalNonBrandedImpressions.toLocaleString()}</div>
      <div class="kpi-label">Non-Branded Impressions</div>
      <div class="kpi-sub">Discovery opportunity</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:${brandedShare > 70 ? 'var(--amber)' : 'var(--green)'};">${brandedShare}%</div>
      <div class="kpi-label">Branded Share</div>
      <div class="kpi-sub">of total impressions</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--navy);">${summary.discoveryThemeMatches}</div>
      <div class="kpi-label">Discovery Theme Queries</div>
      <div class="kpi-sub">matching D01–D15 themes</div>
    </div>
  </div>

  ${brandedShare > 70 ? `<div class="finding" style="background:#FFFBEB;border-left:4px solid #F59E0B;color:#92400E;margin-bottom:24px;">
    <strong>${brandedShare}% of organic search impressions are branded</strong>, which matches what the AI data shows: Acme performs well when people already know the name. Growing non-branded organic reach and AI visibility need to move together.
  </div>` : ''}

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
    <div>
      <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">Top Branded Queries</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Query</th><th style="text-align:right;width:80px;">Impr.</th><th style="text-align:right;width:60px;">Clicks</th><th style="text-align:right;width:60px;">CTR</th><th style="text-align:right;width:60px;">Pos.</th></tr></thead>
          <tbody>${brandedRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#9CA3AF;">No branded query data</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div>
      <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">Top Non-Branded Queries</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Query</th><th style="text-align:right;width:80px;">Impr.</th><th style="text-align:right;width:60px;">Clicks</th><th style="text-align:right;width:60px;">CTR</th><th style="text-align:right;width:60px;">Pos.</th></tr></thead>
          <tbody>${nonBrandedRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#9CA3AF;">No non-branded query data</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </div>

  ${discoveryRows ? `<div style="margin-bottom:20px;">
    <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">Queries Matching Discovery Themes (D01–D15)</div>
    <div class="finding" style="margin-bottom:12px;">These organic queries align with the 15 open-ended searches tested in the AI audit. The <strong>position</strong> column shows where acmematerials.com ranks in Google search. Compare this against the AI mention rates to find searches where organic ranking is strong but AI visibility is low. Those are the priority gaps.</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Query</th><th style="text-align:right;width:80px;">Impr.</th><th style="text-align:right;width:60px;">Clicks</th><th style="text-align:right;width:60px;">CTR</th><th style="text-align:right;width:60px;">Pos.</th></tr></thead>
        <tbody>${discoveryRows}</tbody>
      </table>
    </div>
  </div>` : ''}

  <p style="font-size:12px;color:#9CA3AF;text-align:right;">GSC data: ${dateRange.start} → ${dateRange.end} (${dateRange.days} days). Fetched ${new Date(gscData.fetchedAt).toLocaleDateString('en-AU')}.</p>`;
}

// ── GA section ─────────────────────────────────────────────────────────────
function buildGASection(gaData) {
  if (!gaData) {
    return `<div class="finding" style="background:#FFFBEB;border-left:4px solid #F59E0B;color:#92400E;">
      <strong>Google Analytics data not yet connected.</strong><br>
      To add live traffic data to this report:<br>
      <code style="display:block;background:rgba(0,0,0,0.06);padding:10px 14px;border-radius:6px;margin:12px 0 6px;font-size:13px;color:#374151;line-height:2;">
        1. Add credentials/google-service-account.json<br>
        2. Set GA_PROPERTY_ID env var<br>
        3. npm run fetch-ga
      </code>
      See the setup instructions at the top of fetch-ga-data.js.
    </div>`;
  }

  const { summary, channelBreakdown, aiPlatformReferrals, topOrganicLandingPages, organicNewVsReturning, dateRange } = gaData;
  const totalAI = summary.totalAiReferralSessions;

  const channelRows = channelBreakdown.slice(0, 8).map(r =>
    `<tr>
      <td style="padding:9px 12px;font-size:13px;font-weight:500;">${r.channel}</td>
      <td style="padding:9px 12px;text-align:right;">${r.sessions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${r.newUsers.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${r.bounceRate}%</td>
      <td style="padding:9px 12px;text-align:right;">${Math.floor(r.avgSessionSecs / 60)}m ${r.avgSessionSecs % 60}s</td>
    </tr>`
  ).join('');

  const aiRows = aiPlatformReferrals.map(r => {
    const label = { 'perplexity.ai': 'Perplexity', 'claude.ai': 'Claude', 'chatgpt.com': 'ChatGPT', 'chat.openai.com': 'ChatGPT (legacy)', 'gemini.google.com': 'Google Gemini', 'bard.google.com': 'Google Bard' }[r.source] || r.source;
    return `<tr style="${r.sessions > 0 ? 'background:#F0FDF4;' : ''}">
      <td style="padding:9px 12px;font-size:13px;font-weight:500;">${label}</td>
      <td style="padding:9px 12px;text-align:right;font-weight:${r.sessions > 0 ? '700' : '400'};color:${r.sessions > 0 ? '#16A34A' : '#9CA3AF'};">${r.sessions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${r.newUsers.toLocaleString()}</td>
      <td style="padding:9px 12px;font-size:12px;color:#6B7280;">${r.sessions > 0 ? 'Active referral source' : 'No sessions detected yet'}</td>
    </tr>`;
  }).join('');

  const landingRows = topOrganicLandingPages.map(p =>
    `<tr>
      <td style="padding:9px 12px;font-size:12px;color:#374151;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.page}</td>
      <td style="padding:9px 12px;text-align:right;">${p.sessions.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${p.newUsers.toLocaleString()}</td>
      <td style="padding:9px 12px;text-align:right;">${p.bounceRate}%</td>
    </tr>`
  ).join('');

  const newPct = organicNewVsReturning['new'] && summary.totalOrganicSessions
    ? pct(organicNewVsReturning['new'], summary.totalOrganicSessions)
    : null;

  return `
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;">
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--blue);">${summary.totalOrganicSessions.toLocaleString()}</div>
      <div class="kpi-label">Organic Sessions</div>
      <div class="kpi-sub">${dateRange.days}-day window</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--navy);">${summary.totalOrganicNewUsers.toLocaleString()}</div>
      <div class="kpi-label">New Organic Users</div>
      <div class="kpi-sub">${newPct !== null ? `${newPct}% of organic` : ''}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:${totalAI > 0 ? 'var(--green)' : 'var(--red)'};">${totalAI}</div>
      <div class="kpi-label">AI Platform Sessions</div>
      <div class="kpi-sub">from Perplexity, Claude, ChatGPT</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="font-size:32px;color:var(--grey);">${summary.topChannel}</div>
      <div class="kpi-label">Top Traffic Channel</div>
      <div class="kpi-sub">${dateRange.days}-day period</div>
    </div>
  </div>

  ${totalAI === 0 ? `<div class="finding" style="background:#FEF2F2;border-left:4px solid var(--red);color:#991B1B;margin-bottom:24px;">
    <strong>AI platforms are sending 0 tracked referral sessions to acmematerials.com.</strong>
    This means the GEO citations captured in this report are not yet converting to measurable web traffic.
    As visibility improves and Perplexity and ChatGPT start citing acmematerials.com pages, this figure will rise. It's the most direct measure of whether the work is generating real results.
  </div>` : `<div class="finding" style="margin-bottom:24px;">
    <strong>${totalAI} sessions from AI platforms</strong> are arriving at acmematerials.com. AI citations are beginning to generate real traffic. Track this metric monthly as the measure of whether the work is paying off.
  </div>`}

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
    <div>
      <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">Sessions by Channel</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Channel</th><th style="text-align:right;">Sessions</th><th style="text-align:right;">New Users</th><th style="text-align:right;">Bounce</th><th style="text-align:right;">Avg Time</th></tr></thead>
          <tbody>${channelRows}</tbody>
        </table>
      </div>
    </div>
    <div>
      <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">AI Platform Referrals</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Platform</th><th style="text-align:right;">Sessions</th><th style="text-align:right;">New Users</th><th>Status</th></tr></thead>
          <tbody>${aiRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  ${landingRows ? `<div style="margin-bottom:20px;">
    <div style="font-size:14px;font-weight:700;color:var(--navy);margin-bottom:10px;">Top Organic Landing Pages</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Page</th><th style="text-align:right;">Sessions</th><th style="text-align:right;">New Users</th><th style="text-align:right;">Bounce</th></tr></thead>
        <tbody>${landingRows}</tbody>
      </table>
    </div>
    <div class="finding" style="margin-top:12px;">Compare these pages with the source citation data in Section 7. Pages that rank well in Google but are <em>not</em> cited by AI tools are the priority. That's the gap to close with structured data and content improvements.</div>
  </div>` : ''}

  <p style="font-size:12px;color:#9CA3AF;text-align:right;">GA4 data: ${dateRange.start} → ${dateRange.end} (${dateRange.days} days). Fetched ${new Date(gaData.fetchedAt).toLocaleDateString('en-AU')}.</p>`;
}

// ── Key Insights page ─────────────────────────────────────────────────────
function buildKeyInsightsPage(stats, discoveryStats, discoveryScores) {
  const { overallRate, byPlatform, PLATFORMS } = stats;
  const platforms = PLATFORMS.map(p => ({ key: p, label: byPlatform[p].label, rate: byPlatform[p].rate }));
  const bestP  = platforms.reduce((a,b) => a.rate > b.rate ? a : b);
  const worstP = platforms.reduce((a,b) => a.rate < b.rate ? a : b);
  const discoveryRate    = discoveryStats?.overallRate;
  const investorDiscRate = discoveryStats?.byGroup['investor']?.rate;
  const gap = discoveryRate !== undefined ? overallRate - discoveryRate : null;
  const { gapOpportunities } = discoveryStats ? computeGapStats(discoveryScores) : { gapOpportunities: 0 };

  const findings = [
    {
      icon: '🔍',
      headline: discoveryRate !== undefined
        ? `Acme shows up well in direct searches. Open searches are a different story.`
        : `Acme shows up well when people search for it directly.`,
      detail: discoveryRate !== undefined
        ? `When someone searches for "Acme Corp" or its flagship product by name, AI tools mention Acme <strong>${overallRate}%</strong> of the time. When they're just exploring the category, searching for broader terms instead of the brand name, that drops to <strong>${discoveryRate}%</strong>.`
        : `When people search for Acme directly, AI tools mention the brand <strong>${overallRate}%</strong> of the time. The bigger question is what happens when someone is exploring the space without already knowing the name.`,
      meaning: gap ? `A ${gap}-point gap between brand searches and open searches. The <strong>${discoveryRate}%</strong> figure is the more meaningful number. It shows how visible Acme is to someone who hasn't heard of it yet.` : `This is Acme's starting point. The goal is to be visible when investors and partners are still forming a view, not just when they're already looking for Acme.`,
      accent: '#0F2340',
    },
    {
      icon: '📈',
      headline: investorDiscRate !== undefined
        ? `When investors search for companies in Acme's listed category, Acme appears ${investorDiscRate}% of the time.`
        : `Investor searches are the biggest opportunity.`,
      detail: investorDiscRate !== undefined
        ? `When an investor uses an AI tool to research listed companies in Acme's category, Acme is mentioned <strong>${investorDiscRate}%</strong> of the time. The other <strong>${100 - investorDiscRate}%</strong> of those searches result in a competitor being recommended instead.`
        : `Investor searches are where AI visibility has the most direct business impact. Improving Acme's presence for these queries should be the first priority.`,
      meaning: `Investors use AI tools to shortlist companies before reaching out or investing. If Acme doesn't appear in those results, it's not a website problem. It's a missed investor touchpoint.`,
      accent: '#0066CC',
    },
    {
      icon: '🤖',
      headline: `${bestP.label} is the strongest platform for Acme. ${worstP.label} barely mentions it.`,
      detail: `Across the four AI platforms tested, <strong>${bestP.label} mentions Acme ${bestP.rate}%</strong> of the time. <strong>${worstP.label} mentions Acme only ${worstP.rate}%</strong> of the time. Each platform sources its answers differently, so the fix is different for each one.`,
      meaning: `There's no single action that improves visibility across all platforms at once. ChatGPT, Claude, Perplexity, and Google AI all work in different ways. The recommendations at the end of this report address each one directly.`,
      accent: '#16A34A',
    },
  ];

  if (gapOpportunities > 0) {
    findings.push({
      icon: '🚨',
      headline: `There are ${gapOpportunities} searches where Acme should appear, but doesn't.`,
      detail: `Across 15 open-ended searches directly relevant to Acme's products and technology, there are <strong>${gapOpportunities} searches</strong> where Acme is a clear match but AI tools don't mention the company at all.`,
      meaning: `These are the most fixable gaps in the report. The technology is relevant, the audience is right, and the solution is achievable with the content and website changes outlined in the recommendations.`,
      accent: '#DC2626',
    });
  }

  const findingCards = findings.map((f, i) => `
    <div style="background:#fff;border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:16px;">
        <div style="background:${f.accent};color:#fff;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${f.icon}</div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;">Finding ${i + 1}</div>
          <div style="font-size:17px;font-weight:700;color:var(--navy);line-height:1.3;">${f.headline}</div>
        </div>
      </div>
      <div style="padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#9CA3AF;margin-bottom:8px;">What the data shows</div>
          <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">${f.detail}</p>
        </div>
        <div style="background:${f.accent}08;border-left:3px solid ${f.accent};padding:14px 16px;border-radius:0 8px 8px 0;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${f.accent};margin-bottom:8px;">What this means for Acme</div>
          <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">${f.meaning}</p>
        </div>
      </div>
    </div>`).join('');

  return `
<div style="background:#F8FAFC;min-height:100vh;padding:60px 80px;page-break-after:always;">
  <div style="max-width:860px;margin:0 auto;">
    <div style="font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--blue);margin-bottom:12px;">Key Findings</div>
    <h1 style="font-size:38px;font-weight:800;color:var(--navy);line-height:1.2;margin-bottom:8px;">What this report found</h1>
    <p style="font-size:16px;color:var(--grey);line-height:1.6;margin-bottom:40px;max-width:600px;">
      This report measured how often Acme appears when people use AI tools to research its product category and industry. Four platforms were tested: ChatGPT, Claude, Perplexity, and Google AI.
    </p>

    ${findingCards}

    <div style="background:var(--navy);border-radius:14px;padding:28px 32px;margin-top:8px;">
      <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:10px;">What comes next</div>
      <p style="font-size:14px;color:rgba(255,255,255,0.75);line-height:1.7;margin:0;">
        The full data sits in the sections that follow. At the end of the report are <strong style="color:#fff;">six specific actions</strong>: practical changes to Acme's website and online presence that will improve how often AI tools mention, cite, and recommend Acme.
      </p>
    </div>
  </div>
</div>`;
}

// ── Recommendations section ────────────────────────────────────────────────
function buildRecommendations(stats, discoveryStats, gaData, caveatedPct) {
  const { overallRate, byGroup, topSources, acmeSourceCount } = stats;

  // Dynamic data alerts shown above the 6 fixed cards
  const alerts = [];

  if (caveatedPct > 20) {
    alerts.push(`<div style="background:#FEF2F2;border-left:4px solid var(--red);padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:14px;font-size:14px;color:#B91C1C;line-height:1.6;">
      <strong>Note on language:</strong> ${caveatedPct}% of AI mentions include cautious language like "pre-revenue" or "still in R&D". An investor reading this may hesitate. Publishing content focused on achieved milestones, test results, and technical progress will help shift this over time.
    </div>`);
  }

  if (acmeSourceCount === 0 && topSources.length > 0) {
    alerts.push(`<div style="background:#FEF2F2;border-left:4px solid var(--red);padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:14px;font-size:14px;color:#B91C1C;line-height:1.6;">
      <strong>Acme's website isn't being cited:</strong> Platforms like Perplexity and Google AI pull directly from websites and reference their sources. Acme's website isn't currently appearing as one of those sources. Recommendations 1 to 4 below address this directly.
    </div>`);
  }

  if (gaData?.summary.totalAiReferralSessions === 0) {
    alerts.push(`<div style="background:#FFFBEB;border-left:4px solid var(--amber);padding:14px 18px;border-radius:0 8px 8px 0;margin-bottom:14px;font-size:14px;color:#92400E;line-height:1.6;">
      <strong>No traffic from AI tools yet:</strong> AI platforms aren't currently sending tracked visitors to acmematerials.com. As visibility improves, this will change. It's worth monitoring monthly as the clearest indicator that the work is generating real results.
    </div>`);
  }

  const deliverables = [
    {
      n: 1,
      priority: 'High',
      title: 'Schema Implementation',
      desc: 'Add structured data markup to Acme\'s website so AI tools can read and understand the content more easily. Schema is code that runs in the background of a webpage and labels what things are: "this is a product", "this is a company", "this is an FAQ". When AI tools scan the web for answers, pages with schema markup are significantly more likely to be cited.',
      helps: 'All platforms, especially Google AI and Perplexity',
    },
    {
      n: 2,
      priority: 'High',
      title: 'Content Structure Review',
      desc: 'Update page headings, subheadings, and content hierarchy across the website so information is clearly structured for AI comprehension. Pages should be organised to directly answer the questions investors and researchers are most likely to ask. Not just describe what Acme does, but answer "why does this matter?" and "how does it work?" in plain, structured language.',
      helps: 'Investor searches (D01–D04), Medical searches (D05–D08)',
    },
    {
      n: 3,
      priority: 'High',
      title: 'Keyword & Phrase Optimisation',
      desc: 'Identify and integrate the specific words and phrases most commonly used in AI-driven searches related to Acme\'s product category and industry. These terms should be applied consistently across page copy, meta fields, and image alt text so that when AI tools scan Acme\'s website, the language matches what people are searching for.',
      helps: 'All discovery query groups (D01–D15)',
    },
    {
      n: 4,
      priority: 'High',
      title: 'FAQ Blocks',
      desc: 'Add FAQ sections to priority pages: Homepage, Technology, and Investors. FAQs are one of the strongest signals AI tools use to pull direct answers from a website. When someone asks an AI tool a question, it looks for pages that answer that question clearly. A well-structured FAQ on Acme\'s investor page directly increases the likelihood of being cited when investors ask AI tools about the company.',
      helps: 'ChatGPT, Google AI',
    },
    {
      n: 5,
      priority: 'Medium',
      title: 'Third-Party Listings',
      desc: 'Audit and ensure Acme is accurately listed across credible third-party sources: industry databases, Crunchbase, Wikipedia, ASX profiles, and media coverage. AI tools rely heavily on external sources to validate businesses. A company that appears across multiple trusted sources is treated with more authority than one that only appears on its own website. Getting Acme accurately listed in these places strengthens how AI tools present the brand.',
      helps: 'Claude, ChatGPT',
    },
    {
      n: 6,
      priority: 'Medium',
      title: 'Internal Linking',
      desc: 'Build a deliberate internal linking structure across the website that connects Technology, Newsroom, Investors, and Homepage content. When AI tools scan a website, they notice which pages link to which others. A well-connected site signals depth and authority. A loosely connected site can appear shallow, even if the content itself is strong.',
      helps: 'Google AI, Perplexity',
    },
  ];

  const cards = deliverables.map(d => {
    const isHigh = d.priority === 'High';
    const priorityBg    = isHigh ? '#FEE2E2' : '#FEF3C7';
    const priorityColor = isHigh ? '#B91C1C' : '#92400E';
    const borderColor   = isHigh ? '#DC2626' : '#F59E0B';
    return `<div style="background:#fff;border:1px solid var(--border);border-left:4px solid ${borderColor};border-radius:0 12px 12px 0;padding:24px 28px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
        <div style="background:var(--navy);color:#fff;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;flex-shrink:0;">${d.n}</div>
        <div style="font-size:17px;font-weight:700;color:var(--navy);flex:1;">${d.title}</div>
        <span style="background:${priorityBg};color:${priorityColor};padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;">${d.priority} Priority</span>
      </div>
      <p style="font-size:14px;color:#374151;line-height:1.75;margin:0 0 14px;">${d.desc}</p>
      <div style="font-size:12px;color:#9CA3AF;">Helps with: <span style="color:#374151;font-weight:500;">${d.helps}</span></div>
    </div>`;
  }).join('');

  return `
    ${alerts.join('')}
    <div style="font-size:13px;color:var(--grey);margin-bottom:20px;line-height:1.6;">
      Listed in priority order. Items 1 to 4 are website changes that can be implemented straight away and will have the most immediate impact. Items 5 and 6 are ongoing activities that build Acme's authority across the web over time.
    </div>
    ${cards}
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:20px 24px;margin-top:8px;">
      <div style="font-size:14px;font-weight:700;color:#15803D;margin-bottom:8px;">Re-audit in December 2026</div>
      <p style="font-size:13px;color:#374151;line-height:1.6;margin:0;">Once these changes are in place, re-run this audit to measure progress. Things to look at: how often Acme appears in open-ended searches, whether AI tools have dropped the cautious framing, and whether AI platforms are starting to send traffic to acmematerials.com.</p>
    </div>`;
}

// ── HTML report ────────────────────────────────────────────────────────────
function generateHTML(stats, discoveryStats, discoveryScores, meta, gscData, gaData) {
  const { total, mentioned, overallRate, byPlatform, byGroup, heatmap, topCompetitors, topSources, acmeSourceCount, scores, PLATFORMS, GROUPS, GROUP_LABELS } = stats;

  const bestPlatform    = Object.entries(byPlatform).sort(([,a],[,b]) => b.rate - a.rate)[0];
  const bestGroup       = Object.entries(byGroup).sort(([,a],[,b]) => b.rate - a.rate)[0];
  const competitorCount = topCompetitors.length;

  // Framing aggregates across all baseline scores
  const allFraming = framingCounts(scores.filter(s => isMentioned(s.mentioned)));
  const totalMentioned = scores.filter(s => isMentioned(s.mentioned)).length;
  const positivePct  = totalMentioned > 0 ? pct(allFraming.positive, totalMentioned) : 0;
  const neutralPct   = totalMentioned > 0 ? pct(allFraming.neutral, totalMentioned) : 0;
  const caveatedPct  = totalMentioned > 0 ? pct(allFraming.caveated, totalMentioned) : 0;

  // ── Baseline chart data
  const platformChartData = JSON.stringify({
    labels: PLATFORMS.map(p => byPlatform[p].label),
    rates:  PLATFORMS.map(p => byPlatform[p].rate),
    colors: PLATFORMS.map(p => rateColor(byPlatform[p].rate)),
  });
  const groupChartData = JSON.stringify({
    labels: GROUPS.map(g => byGroup[g].label),
    rates:  GROUPS.map(g => byGroup[g].rate),
    colors: GROUPS.map(g => rateColor(byGroup[g].rate)),
  });

  // ── Baseline heatmap
  const heatmapRows = PLATFORMS.map(p => {
    const cells = GROUPS.map(g => {
      const v = heatmap[p][g];
      return `<td style="background:${rateColor(v)};color:${rateTextColor(v)};text-align:center;font-weight:700;font-size:13px;padding:12px 8px;">${v === null ? '—' : `${v}%`}</td>`;
    }).join('');
    return `<tr><td style="padding:10px 14px;font-weight:600;white-space:nowrap;">${byPlatform[p].label}</td>${cells}</tr>`;
  }).join('');

  // ── Competitor / source tables
  const competitorRows = topCompetitors.length
    ? topCompetitors.map(([name, count], i) =>
        `<tr><td style="padding:10px 14px;">${i+1}. ${name}</td><td style="padding:10px 14px;font-weight:700;">${count}</td><td style="padding:10px 14px;">
          <div style="background:#E5E7EB;border-radius:4px;height:10px;width:100%;">
            <div style="background:#EF4444;height:10px;border-radius:4px;width:${Math.round(count/total*100*4)}%"></div>
          </div></td></tr>`).join('')
    : `<tr><td colspan="3" style="padding:20px;text-align:center;color:#9CA3AF;">No competitor data. Fill in the competitors column in scores.csv.</td></tr>`;

  const acmeDomains = topSources.filter(([d]) => /acme|acmematerials\.com/i.test(d));
  const otherDomains  = topSources.filter(([d]) => !/acme|acmematerials\.com/i.test(d));
  const sourceRows = topSources.length
    ? [...acmeDomains, ...otherDomains].map(([domain, count]) => {
        const isAcme = /acme|acmematerials\.com/i.test(domain);
        return `<tr style="${isAcme ? 'background:#F0FDF4;' : ''}">
          <td style="padding:10px 14px;">${isAcme ? '⭐ ' : ''}${domain}</td>
          <td style="padding:10px 14px;font-weight:700;">${count}</td>
          <td style="padding:10px 14px;font-size:12px;color:#6B7280;">${isAcme ? 'Acme-owned' : 'Third-party'}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="3" style="padding:20px;text-align:center;color:#9CA3AF;">No source data. Fill in the sources column for Perplexity and Google rows.</td></tr>`;

  // ── Full results table
  const resultRows = scores.map(s =>
    `<tr>
      <td style="padding:8px 10px;color:#6B7280;font-size:12px;">${s.id}</td>
      <td style="padding:8px 10px;font-size:13px;">${s.query}</td>
      <td style="padding:8px 10px;font-size:12px;">${s.group}</td>
      <td style="padding:8px 10px;font-size:12px;text-transform:capitalize;">${s.platform === 'google' ? 'Google AI' : s.platform.charAt(0).toUpperCase() + s.platform.slice(1)}</td>
      <td style="padding:8px 10px;">${s.mentioned ? mentionBadge(s.mentioned) : '<span style="color:#9CA3AF">—</span>'}</td>
      <td style="padding:8px 10px;">${s.framing ? framingBadge(s.framing) : '<span style="color:#9CA3AF">—</span>'}</td>
      <td style="padding:8px 10px;font-size:12px;color:#4B5563;">${(s.competitors||'').replace(/\|/g, ', ') || '—'}</td>
      <td style="padding:8px 10px;font-size:12px;color:#4B5563;">${s.notes || '—'}</td>
    </tr>`
  ).join('');

  // ── Discovery section ──────────────────────────────────────────────────────
  let discoveryKPIRow = '';
  let discoveryCallout = '';
  let discoverySectionContent = '';
  let discoveryChartData = '';

  if (discoveryStats) {
    const { gapOpportunities, missedEverywhere } = computeGapStats(discoveryScores);
    const worstDiscPlatform = Object.entries(discoveryStats.byPlatform)
      .filter(([,v]) => v.total > 0)
      .sort(([,a],[,b]) => a.rate - b.rate)[0];
    const gap = overallRate - discoveryStats.overallRate;

    discoveryChartData = JSON.stringify({
      labels: PLATFORMS.map(p => discoveryStats.byPlatform[p].label),
      rates:  PLATFORMS.map(p => discoveryStats.byPlatform[p].rate),
      colors: PLATFORMS.map(p => rateColor(discoveryStats.byPlatform[p].rate)),
    });

    discoveryKPIRow = `
      <div style="margin:20px 0 8px;padding-bottom:6px;border-top:2px dashed #E5E7EB;padding-top:20px;">
        <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">Open-Ended Searches: 15 Broader Queries &nbsp;<span style="background:#DBEAFE;color:#1D4ED8;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:0;text-transform:none;">Real-World AI Score</span></div>
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-value" style="color:${rateColor(discoveryStats.overallRate)};">${discoveryStats.overallRate}%</div>
            <div class="kpi-label">Visibility in Open Searches</div>
            <div class="kpi-sub">${discoveryStats.mentioned} of ${discoveryStats.total} AI responses</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-value" style="color:var(--red);">${worstDiscPlatform ? worstDiscPlatform[1].rate : 0}%</div>
            <div class="kpi-label">Weakest AI Platform</div>
            <div class="kpi-sub">${worstDiscPlatform ? worstDiscPlatform[1].label : '—'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-value" style="color:var(--red);">${missedEverywhere}</div>
            <div class="kpi-label">Missed Everywhere</div>
            <div class="kpi-sub">searches with no mentions at all</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-value" style="color:var(--amber);">${gapOpportunities}</div>
            <div class="kpi-label">Priority Gaps</div>
            <div class="kpi-sub">missed on 2 or more platforms</div>
          </div>
        </div>
      </div>`;

    discoveryCallout = `
      <div class="finding" style="background:linear-gradient(135deg,#EFF6FF 0%,#F0FDF4 100%);border-left:4px solid var(--navy);">
        <strong>Brand searches vs open-ended searches:</strong> When people search for Acme directly, AI tools mention the brand <strong>${overallRate}%</strong> of the time.
        When they're just exploring the space, that drops to <strong>${discoveryStats.overallRate}%</strong>. That's a <strong>${Math.abs(gap)}-point difference</strong>.
        The ${discoveryStats.overallRate}% figure is Acme's real score. It's how the brand performs when someone discovers it for the first time.
      </div>
      <div class="finding" style="background:#F0FDF4;border-left:4px solid var(--green);margin-top:12px;">
        <strong>Investor searches:</strong> When investors ask AI tools about listed companies in Acme's category, Acme is mentioned <strong>${discoveryStats.byGroup['investor'] ? discoveryStats.byGroup['investor'].rate : '—'}%</strong> of the time.
        The other <strong>${100 - (discoveryStats.byGroup['investor']?.rate || 0)}%</strong> of those searches end with a competitor being recommended instead.
      </div>
      <div class="finding" style="background:#FFFBEB;border-left:4px solid var(--amber);margin-top:12px;">
        <strong>Re-audit date: December 2026.</strong> Once the recommended changes are in place, re-run this audit to measure how much Acme's AI visibility has improved.
      </div>`;

    // Discovery heatmap
    const discHeatmapRows = PLATFORMS.map(p => {
      const cells = DISCOVERY_GROUPS.map(g => {
        const v = discoveryStats.heatmap[p][g];
        return `<td style="background:${rateColor(v)};color:${rateTextColor(v)};text-align:center;font-weight:700;font-size:13px;padding:12px 8px;">${v === null ? '—' : `${v}%`}</td>`;
      }).join('');
      return `<tr><td style="padding:10px 14px;font-weight:600;white-space:nowrap;">${discoveryStats.byPlatform[p].label}</td>${cells}</tr>`;
    }).join('');

    // Discovery results matrix
    const discQueryIds = [...new Set(discoveryScores.map(s => s.id))].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    const discMatrixRows = discQueryIds.map(id => {
      const qRows = discoveryScores.filter(s => s.id === id);
      const queryText = qRows[0]?.query || id;
      const group = qRows[0]?.group || '';
      const cells = PLATFORMS.map(p => {
        const r = qRows.find(s => s.platform === p);
        if (!r || r.mentioned === '') return `<td style="text-align:center;color:#D1D5DB;font-size:12px;">—</td>`;
        return isMentioned(r.mentioned)
          ? `<td style="text-align:center;color:#16A34A;font-weight:700;font-size:14px;">✓</td>`
          : `<td style="text-align:center;color:#DC2626;font-weight:700;font-size:14px;">✗</td>`;
      }).join('');
      return `<tr>
        <td style="padding:8px 10px;font-size:12px;color:#6B7280;font-weight:600;">${id}</td>
        <td style="padding:8px 10px;font-size:13px;">${queryText}</td>
        <td style="padding:8px 10px;font-size:11px;text-transform:capitalize;color:#6B7280;">${group}</td>
        ${cells}
      </tr>`;
    }).join('');

    discoverySectionContent = `
      <div class="chart-wrap">
        <div class="chart-title">Discovery Mention Rate by Platform (%)</div>
        <canvas id="discoveryPlatformChart" height="220"></canvas>
      </div>

      <div class="heatmap-wrap" style="margin-bottom:24px;">
        <table>
          <thead>
            <tr>
              <th style="width:160px;">Platform</th>
              ${DISCOVERY_GROUPS.map(g => `<th style="text-align:center;">${DISCOVERY_GROUP_LABELS[g].replace(' / ', '<br>')}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${discHeatmapRows}</tbody>
        </table>
        <div class="heatmap-legend">
          <strong style="font-size:12px;">Legend:</strong>
          <div class="legend-item"><div class="legend-dot" style="background:#16A34A;"></div>≥70%</div>
          <div class="legend-item"><div class="legend-dot" style="background:#F59E0B;"></div>40–69%</div>
          <div class="legend-item"><div class="legend-dot" style="background:#EF4444;"></div>1–39%</div>
          <div class="legend-item"><div class="legend-dot" style="background:#DC2626;"></div>0%</div>
        </div>
      </div>

      <div class="chart-title" style="font-size:15px;font-weight:700;color:var(--navy);margin:0 0 12px;">Discovery Results Matrix</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:52px;">ID</th>
              <th>Query</th>
              <th style="width:90px;">Group</th>
              <th style="width:84px;text-align:center;">ChatGPT</th>
              <th style="width:84px;text-align:center;">Claude</th>
              <th style="width:84px;text-align:center;">Perplexity</th>
              <th style="width:84px;text-align:center;">Google AI</th>
            </tr>
          </thead>
          <tbody>${discMatrixRows}</tbody>
        </table>
      </div>`;

  } else {
    discoverySectionContent = `
      <div class="finding" style="background:#FFFBEB;border-left:4px solid #F59E0B;color:#92400E;">
        <strong>Discovery analysis pending.</strong> Run the following to capture 15 broader discovery queries:<br>
        <code style="display:block;background:rgba(0,0,0,0.06);padding:10px 14px;border-radius:6px;margin:12px 0 6px;font-size:13px;color:#374151;line-height:2;">
          npm run screenshots-discovery &nbsp;&nbsp;# ChatGPT, Claude, Google<br>
          npm run perplexity-discovery &nbsp;&nbsp;# Perplexity — keep Chrome visible<br>
          npm run discovery-template &nbsp;&nbsp;&nbsp;&nbsp;# Creates data/discovery_scores.csv
        </code>
        Fill in <strong>data/discovery_scores.csv</strong> while reviewing screenshots, then re-run <code>npm run report</code>.
      </div>`;

    discoveryCallout = `
      <div class="finding" style="background:#FFFBEB;border-left:4px solid #F59E0B;color:#92400E;margin-top:20px;">
        <strong>Discovery KPIs pending.</strong> The current ${overallRate}% baseline includes brand-directed queries that guarantee high mention rates.
        Run <code>npm run screenshots-discovery</code> to reveal the true broader GEO visibility score.
      </div>`;
  }

  // ── Platform authority cards
  const platformAuthorityCards = PLATFORMS.map(p => {
    const pa = PLATFORM_AUTHORITY[p];
    const rate = byPlatform[p].rate;
    return `<div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px;border-top:3px solid ${pa.color};">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        <span style="font-size:20px;">${pa.icon}</span>
        <div>
          <div style="font-weight:700;font-size:15px;color:var(--navy);">${pa.label}</div>
          <div style="font-size:11px;color:#9CA3AF;">${pa.mechanism}</div>
        </div>
        <div style="margin-left:auto;text-align:right;">
          <div style="font-size:24px;font-weight:800;color:${rateColor(rate)};">${rate}%</div>
          <div style="font-size:11px;color:#9CA3AF;">baseline rate</div>
        </div>
      </div>
      <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 12px;">${pa.how}</p>
      <div style="font-size:11px;font-weight:700;color:${pa.color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Key Actions</div>
      <ul style="font-size:12px;color:#374151;line-height:1.8;list-style:none;padding:0;margin:0;">
        ${pa.actions.map(a => `<li>→ ${a}</li>`).join('')}
      </ul>
    </div>`;
  }).join('');

  // ── Framing quality section
  const framingDonutData = JSON.stringify({
    labels: ['Positive', 'Neutral', 'Caveated'],
    values: [allFraming.positive, allFraming.neutral, allFraming.caveated],
    colors: ['#16A34A', '#3B82F6', '#F59E0B'],
  });

  const framingPlatformTableRows = PLATFORMS.map(p => {
    const r = byPlatform[p];
    const mentionedCount = r.framing.positive + r.framing.neutral + r.framing.caveated;
    const posP = mentionedCount > 0 ? pct(r.framing.positive, mentionedCount) : 0;
    const cavP = mentionedCount > 0 ? pct(r.framing.caveated, mentionedCount) : 0;
    return `<tr>
      <td style="padding:10px 14px;font-weight:600;">${r.label}</td>
      <td style="padding:10px 14px;text-align:center;">${r.mentioned}</td>
      <td style="padding:10px 14px;text-align:center;color:#16A34A;font-weight:700;">${r.framing.positive} <span style="font-size:11px;color:#9CA3AF;">(${posP}%)</span></td>
      <td style="padding:10px 14px;text-align:center;color:#3B82F6;">${r.framing.neutral}</td>
      <td style="padding:10px 14px;text-align:center;color:#F59E0B;font-weight:700;">${r.framing.caveated} <span style="font-size:11px;color:#9CA3AF;">(${cavP}%)</span></td>
      <td style="padding:10px 14px;text-align:center;color:#DC2626;">${r.framing.absent}</td>
    </tr>`;
  }).join('');

  const recHTML = buildRecommendations(stats, discoveryStats, gaData, caveatedPct);

  const keyInsightsPage    = buildKeyInsightsPage(stats, discoveryStats, discoveryScores);
  const gapCardsHTML       = buildDiscoveryGapCards(discoveryScores);
  const competitorQueryMapHTML = buildCompetitorQueryMap(discoveryScores);
  const sourceStrategyHTML = buildSourceStrategy(stats, discoveryScores);
  const gscSectionHTML     = buildGSCSection(gscData);
  const gaSectionHTML      = buildGASection(gaData);

  const sectionCount = 9 + (gscData ? 1 : 0) + (gaData ? 1 : 0);
  let sectionN = 1;
  const S = () => String(sectionN++).padStart(2, '0');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GEO Baseline Report — Acme Materials</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --navy:  #0F2340;
    --blue:  #0066CC;
    --green: #16A34A;
    --amber: #F59E0B;
    --red:   #DC2626;
    --grey:  #6B7280;
    --light: #F8FAFC;
    --border: #E5E7EB;
  }
  body { font-family: 'Inter', system-ui, sans-serif; color: #111827; background: var(--light); }

  .cover {
    background: var(--navy);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 60px 80px;
    page-break-after: always;
  }
  .cover-tag { color: #60A5FA; font-size: 12px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; }
  .cover-title { color: #fff; font-size: 56px; font-weight: 800; line-height: 1.1; margin-top: 24px; }
  .cover-subtitle { color: #93C5FD; font-size: 22px; margin-top: 16px; }
  .cover-divider { border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 48px 0; }
  .cover-meta { color: rgba(255,255,255,0.7); font-size: 14px; line-height: 2; }
  .cover-meta strong { color: #fff; }
  .cover-platforms { display: flex; gap: 12px; margin-top: 40px; flex-wrap: wrap; }
  .platform-pill { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); padding: 6px 16px; border-radius: 999px; font-size: 13px; font-weight: 500; border: 1px solid rgba(255,255,255,0.15); }

  .page { max-width: 960px; margin: 0 auto; padding: 0 40px; }

  .section { padding: 60px 0; border-bottom: 1px solid var(--border); page-break-inside: avoid; }
  .section:last-child { border-bottom: none; }
  .section-header { margin-bottom: 32px; }
  .section-number { color: var(--blue); font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
  .section-title { font-size: 28px; font-weight: 800; color: var(--navy); margin-top: 6px; }
  .section-desc { font-size: 15px; color: var(--grey); margin-top: 8px; line-height: 1.6; }

  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 16px 0; }
  .kpi-card { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
  .kpi-value { font-size: 42px; font-weight: 800; line-height: 1; }
  .kpi-label { font-size: 13px; color: var(--grey); margin-top: 8px; font-weight: 500; }
  .kpi-sub   { font-size: 12px; color: var(--grey); margin-top: 4px; }

  .chart-wrap { background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 28px; margin-bottom: 24px; }
  .chart-title { font-size: 15px; font-weight: 700; color: var(--navy); margin-bottom: 20px; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }

  .table-wrap { background: #fff; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead th { background: var(--navy); color: #fff; padding: 14px 14px; text-align: left; font-size: 12px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
  tbody tr:nth-child(even) { background: #FAFAFA; }
  tbody tr:hover { background: #EFF6FF; }

  .heatmap-wrap { background: #fff; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .heatmap-legend { display: flex; align-items: center; gap: 20px; padding: 14px 20px; border-top: 1px solid var(--border); font-size: 12px; color: var(--grey); flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 3px; }

  .finding { background: #EFF6FF; border-left: 4px solid var(--blue); padding: 16px 20px; border-radius: 0 8px 8px 0; margin: 24px 0; font-size: 14px; line-height: 1.7; color: #1E40AF; }

  .platform-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 24px; }

  @media print {
    body { background: #fff; }
    .cover { min-height: auto; padding: 40px; }
    .section { page-break-inside: avoid; }
    canvas { max-height: 280px !important; }
    .chart-grid { grid-template-columns: 1fr 1fr; }
    .platform-cards { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>

<!-- ══════════════════════════════ COVER ════════════════════════════════════ -->
<div class="cover">
  <div>
    <div class="cover-tag">Generative Engine Optimisation</div>
    <div class="cover-title">Baseline<br>Report</div>
    <div class="cover-subtitle">AI Visibility Analysis — Acme Materials (ASX: ACM)</div>
  </div>
  <div>
    <hr class="cover-divider">
    <div class="cover-meta">
      <strong>Client</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; Acme Materials Ltd<br>
      <strong>Report Type</strong> &nbsp; GEO Baseline (Pre-Optimisation)<br>
      <strong>Date</strong> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${meta.date}<br>
      <strong>Prepared by</strong> &nbsp; ${meta.preparedBy}
    </div>
    <div class="cover-platforms">
      <span class="platform-pill">ChatGPT</span>
      <span class="platform-pill">Claude</span>
      <span class="platform-pill">Perplexity</span>
      <span class="platform-pill">Google AI Mode</span>
      ${gscData ? '<span class="platform-pill">Google Search Console</span>' : ''}
      ${gaData  ? '<span class="platform-pill">Google Analytics</span>' : ''}
    </div>
    <p style="color:rgba(255,255,255,0.4);font-size:12px;margin-top:40px;">
      25 baseline queries × 4 platforms = ${total} data points${discoveryStats ? ` &nbsp;+&nbsp; 15 discovery queries × 4 platforms = ${discoveryStats.total} additional data points` : ''} &nbsp;|&nbsp; Screenshots provided separately
    </p>
  </div>
</div>

${keyInsightsPage}

<div class="page">

<!-- ══════════════════════════ EXECUTIVE SUMMARY ════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Overview</div>
    <div class="section-title">Executive Summary</div>
    <div class="section-desc">
      Where Acme stands today with AI tools, before any changes are made.
      ${discoveryStats ? 'Results are split into two groups: <strong>Targeted searches</strong> (25 queries including direct brand searches) and <strong>Open-ended searches</strong> (15 broader queries, the more meaningful visibility score).' : 'Run the open-ended discovery queries to see how Acme performs when people explore the space without already knowing the brand.'}
    </div>
  </div>

  <div style="font-size:11px;font-weight:700;color:var(--grey);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px;">
    Baseline: 25 Targeted Queries (incl. branded)
  </div>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-value" style="color:${overallRate >= 40 ? 'var(--green)' : overallRate > 0 ? 'var(--amber)' : 'var(--red)'};">${overallRate}%</div>
      <div class="kpi-label">Overall Mention Rate</div>
      <div class="kpi-sub">${mentioned} of ${total} responses</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:var(--blue);">${bestPlatform[1].rate}%</div>
      <div class="kpi-label">Best Platform</div>
      <div class="kpi-sub">${bestPlatform[1].label}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:var(--blue);">${bestGroup[1].rate}%</div>
      <div class="kpi-label">Strongest Query Group</div>
      <div class="kpi-sub">${bestGroup[1].label}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-value" style="color:${competitorCount > 0 ? 'var(--red)' : 'var(--green)'};">${competitorCount}</div>
      <div class="kpi-label">Competitors Named</div>
      <div class="kpi-sub">across all AI responses</div>
    </div>
  </div>

  ${discoveryKPIRow}
  ${discoveryCallout || `
  <div class="finding">
    ${overallRate === 0
      ? `Acme Materials was <strong>not mentioned</strong> in any of the ${total} AI responses captured.`
      : `Acme Materials appeared in <strong>${overallRate}% of AI responses</strong> (${mentioned} of ${total}). Brand-direct queries showed the strongest visibility. Non-branded investor, partner, and customer-intent queries represent the primary GEO growth opportunity.`
    }
  </div>`}
</div>

<!-- ══════════════════════════ DISCOVERY VISIBILITY ═════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Discovery Analysis</div>
    <div class="section-title">Discovery Visibility Rate</div>
    <div class="section-desc">
      How often Acme appears when people use AI tools to explore its product category and industry, without already knowing the Acme name.
      These are the searches that matter most for reaching new investors, researchers, and partners.
    </div>
  </div>
  ${discoverySectionContent}
</div>

<!-- ══════════════════════════ PLATFORM PERFORMANCE ════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Platform Analysis</div>
    <div class="section-title">Platform Performance</div>
    <div class="section-desc">How often Acme appears on each AI platform, and why each platform behaves differently. Each AI tool sources its answers in a different way, which means improving visibility on each one requires a different approach.</div>
  </div>

  <div class="chart-grid">
    <div class="chart-wrap">
      <div class="chart-title">Mention Rate by Platform (%)</div>
      <canvas id="platformChart" height="220"></canvas>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Response Framing by Platform</div>
      <canvas id="framingChart" height="220"></canvas>
    </div>
  </div>

  <div class="table-wrap" style="margin-bottom:24px;">
    <table>
      <thead>
        <tr>
          <th>Platform</th>
          <th>Queries Run</th>
          <th>Mentioned</th>
          <th>Mention Rate</th>
          <th>Positive</th>
          <th>Neutral</th>
          <th>Caveated</th>
          <th>Absent</th>
        </tr>
      </thead>
      <tbody>
        ${PLATFORMS.map(p => {
          const r = byPlatform[p];
          return `<tr>
            <td style="padding:12px 14px;font-weight:600;">${r.label}</td>
            <td style="padding:12px 14px;">25</td>
            <td style="padding:12px 14px;">${r.mentioned}</td>
            <td style="padding:12px 14px;"><strong style="color:${rateColor(r.rate)}">${r.rate}%</strong></td>
            <td style="padding:12px 14px;color:var(--green);">${r.framing.positive}</td>
            <td style="padding:12px 14px;color:#1D4ED8;">${r.framing.neutral}</td>
            <td style="padding:12px 14px;color:#92400E;">${r.framing.caveated}</td>
            <td style="padding:12px 14px;color:var(--red);">${r.framing.absent}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>

  <div style="font-size:15px;font-weight:700;color:var(--navy);margin-bottom:14px;">How Each AI Platform Works</div>
  <div class="platform-cards">
    ${platformAuthorityCards}
  </div>
</div>

<!-- ════════════════════════ FRAMING QUALITY ════════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Framing Quality</div>
    <div class="section-title">Mention Framing Quality Score</div>
    <div class="section-desc">
      When AI tools mention Acme, what do they actually say? This section looks at whether Acme is described positively, mentioned matter-of-factly, or introduced with caution. The language matters. It shapes how investors perceive Acme before they ever visit the website.
    </div>
  </div>

  <div class="chart-grid" style="margin-bottom:24px;">
    <div class="chart-wrap">
      <div class="chart-title">Framing Distribution: Mentioned Responses</div>
      <canvas id="framingDonutChart" height="220"></canvas>
    </div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:28px;display:flex;flex-direction:column;justify-content:center;gap:16px;">
      <div style="display:flex;align-items:center;gap:14px;padding:14px;background:#F0FDF4;border-radius:8px;">
        <div style="font-size:32px;font-weight:800;color:#16A34A;">${positivePct}%</div>
        <div>
          <div style="font-weight:700;color:#15803D;">Positive Framing</div>
          <div style="font-size:12px;color:#6B7280;">${allFraming.positive} of ${totalMentioned} mentions: strong, direct endorsement</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:14px;padding:14px;background:#FEF3C7;border-radius:8px;">
        <div style="font-size:32px;font-weight:800;color:#92400E;">${caveatedPct}%</div>
        <div>
          <div style="font-weight:700;color:#92400E;">Caveated Framing</div>
          <div style="font-size:12px;color:#6B7280;">${allFraming.caveated} of ${totalMentioned} mentions: "pre-revenue", "speculative", "R&amp;D stage"</div>
        </div>
      </div>
      ${caveatedPct > 20 ? `
      <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px;font-size:13px;color:#B91C1C;line-height:1.6;">
        <strong>Worth addressing:</strong> ${caveatedPct}% of Acme's AI mentions include cautious language like "pre-revenue" or "still in R&amp;D". An investor reading this may hesitate before looking further. Publishing content focused on achieved milestones (clinical test results, technical validations, partnership announcements) helps shift this language over time.
      </div>` : `
      <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:12px;font-size:13px;color:#15803D;line-height:1.6;">
        <strong>Good result.</strong> The majority of Acme's AI mentions are positive or neutral. Keep publishing milestone-led content to maintain this.
      </div>`}
    </div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Platform</th>
          <th style="text-align:center;">Mentioned</th>
          <th style="text-align:center;">Positive</th>
          <th style="text-align:center;">Neutral</th>
          <th style="text-align:center;">Caveated</th>
          <th style="text-align:center;">Absent</th>
        </tr>
      </thead>
      <tbody>${framingPlatformTableRows}</tbody>
    </table>
  </div>
</div>

<!-- ════════════════════════ QUERY GROUP ANALYSIS ═══════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Query Intent</div>
    <div class="section-title">Query Group Analysis</div>
    <div class="section-desc">How Acme performs depending on who is searching and why: an investor, a researcher, a potential partner, or a journalist. Different audiences use different language, and Acme's visibility varies significantly across them.</div>
  </div>

  <div class="chart-wrap" style="margin-bottom:24px;">
    <div class="chart-title">Baseline Mention Rate by Query Group (%)</div>
    <canvas id="groupChart" height="180"></canvas>
  </div>

  <div class="heatmap-wrap">
    <table>
      <thead>
        <tr>
          <th style="width:160px;">Platform</th>
          ${GROUPS.map(g => `<th style="text-align:center;">${GROUP_LABELS[g].replace(' / ', '<br>')}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${heatmapRows}</tbody>
    </table>
    <div class="heatmap-legend">
      <strong style="font-size:12px;">Legend:</strong>
      <div class="legend-item"><div class="legend-dot" style="background:#16A34A;"></div>≥70%</div>
      <div class="legend-item"><div class="legend-dot" style="background:#F59E0B;"></div>40–69%</div>
      <div class="legend-item"><div class="legend-dot" style="background:#EF4444;"></div>1–39%</div>
      <div class="legend-item"><div class="legend-dot" style="background:#DC2626;"></div>0%</div>
      <div class="legend-item"><div class="legend-dot" style="background:#E5E7EB;"></div>No data</div>
    </div>
  </div>
</div>

<!-- ════════════════════════ COMPETITIVE LANDSCAPE ══════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Competitive Intelligence</div>
    <div class="section-title">Competitive Landscape in AI Responses</div>
    <div class="section-desc">When AI tools don't mention Acme, they mention someone else. This section shows which competitors are filling that space and for which specific searches.</div>
  </div>

  <div class="table-wrap" style="margin-bottom:24px;">
    <table>
      <thead>
        <tr><th style="width:40px;">#</th><th>Competitor / Alternative Brand</th><th style="width:100px;">Mentions</th><th>Relative Frequency</th></tr>
      </thead>
      <tbody>${competitorRows}</tbody>
    </table>
  </div>

  ${topCompetitors.length > 0 ? `
  <div class="finding" style="margin-bottom:24px;">
    <strong>${topCompetitors[0][0]}</strong> is the most frequently mentioned competitor in AI responses for Acme's target queries, appearing ${topCompetitors[0][1]} time(s). GEO content should explicitly address how Acme's technology differentiates from these alternatives.
  </div>` : ''}

  ${discoveryScores.length > 0 ? `
  <div style="font-size:15px;font-weight:700;color:var(--navy);margin:24px 0 12px;">Competitor Mapping: Discovery Misses</div>
  <div class="finding" style="margin-bottom:16px;">For each open-ended search where Acme was absent, these are the specific competitors that appeared instead. Grouped by the type of search, this shows the direct competitive threat by query category.</div>
  ${competitorQueryMapHTML}` : ''}
</div>

<!-- ═══════════════════════════ SOURCE CITATIONS ════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Source Analysis</div>
    <div class="section-title">Source Citation Analysis</div>
    <div class="section-desc">Which websites are AI tools actually using as their sources? Perplexity and Google AI cite specific pages when they respond. This section shows whether Acme's own website is being used as a reference, and what to do for platforms that don't cite URLs at all.</div>
  </div>

  <div class="table-wrap" style="margin-bottom:24px;">
    <table>
      <thead><tr><th>Domain / Source</th><th style="width:100px;">Citations</th><th style="width:140px;">Type</th></tr></thead>
      <tbody>${sourceRows}</tbody>
    </table>
  </div>
  ${acmeSourceCount === 0 && topSources.length > 0 ? `
  <div class="finding" style="border-left-color:var(--red);background:#FEF2F2;color:#991B1B;margin-bottom:24px;">
    <strong>Alert:</strong> Acme-owned content is not appearing as a cited source. All citations are third-party. AI tools have no direct authoritative signal from Acme itself. This is the most important thing to fix.
  </div>` : ''}

  <div style="font-size:15px;font-weight:700;color:var(--navy);margin-bottom:14px;">Per-Platform Source Strategy</div>
  ${sourceStrategyHTML}
</div>

<!-- ═════════════════════════════ FULL DATA ═════════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Full Data</div>
    <div class="section-title">Baseline Query Results: All ${total} Data Points</div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th style="width:32px;">#</th>
          <th>Query</th>
          <th style="width:80px;">Group</th>
          <th style="width:90px;">Platform</th>
          <th style="width:72px;">Mentioned</th>
          <th style="width:90px;">Framing</th>
          <th>Competitors</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>${resultRows}</tbody>
    </table>
  </div>
</div>

<!-- ═════════════════════ GOOGLE SEARCH CONSOLE ════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Organic Search</div>
    <div class="section-title">Google Search Console: Organic Visibility</div>
    <div class="section-desc">
      Organic search performance for acmematerials.com. Compare with the GEO discovery scores to find searches where Acme ranks well in Google but is absent from AI responses. Those are the highest-priority pages to improve.
    </div>
  </div>
  ${gscSectionHTML}
</div>

<!-- ═══════════════════════ GOOGLE ANALYTICS ═══════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Traffic & AI Referrals</div>
    <div class="section-title">Google Analytics: Traffic and AI Platform Referrals</div>
    <div class="section-desc">
      Website traffic breakdown including AI platform referral sessions. AI referral sessions are the clearest measure of whether this work is paying off. They prove AI citations are translating into real website visits.
    </div>
  </div>
  ${gaSectionHTML}
</div>

<!-- ════════════════════════════ GEO GAP SPOTLIGHT ══════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Gap Evidence</div>
    <div class="section-title">GEO Gap Spotlight</div>
    <div class="section-desc">
      Searches where Acme's technology is a direct match, but AI tools don't mention the company. Each card shows what came up instead, why Acme should be there, and what content change would fix it.
    </div>
  </div>

  ${gapCardsHTML ? `
  <div style="margin-bottom:32px;">
    <div style="font-size:13px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;">Discovery Query Gaps</div>
    ${gapCardsHTML}
  </div>
  <div style="font-size:13px;font-weight:700;color:var(--grey);text-transform:uppercase;letter-spacing:1.5px;margin:24px 0 16px;padding-top:24px;border-top:1px solid var(--border);">Example: Evidence from Baseline Capture</div>
  <div class="finding" style="margin-bottom:20px;">The three cards below are a worked example using a fictional company ("Acme Corp") to illustrate the kind of evidence this section presents — replace with real captured examples when running this for an actual client.</div>
  ` : ''}

  <!-- Gap 1 -->
  <div style="border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;margin-bottom:20px;">
    <div style="background:#FEF2F2;padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #FECACA;flex-wrap:wrap;">
      <span style="background:#DC2626;color:#fff;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;">MISSED</span>
      <span style="font-weight:700;font-size:15px;color:#111827;">"best companies to invest in [Acme's category]"</span>
      <span style="margin-left:auto;font-size:12px;color:#9CA3AF;">ChatGPT · example</span>
    </div>
    <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div>
        <div style="font-size:12px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">What appeared instead</div>
        <ul style="font-size:14px;color:#374151;line-height:1.8;list-style:none;padding:0;margin:0;">
          <li>🥇 <strong>Competitor A</strong>: named "best overall pure-play company in the category"</li>
          <li>• Competitor B</li>
          <li>• Competitor C</li>
          <li>• Competitor D &amp; Competitor E (big-tech exposure)</li>
        </ul>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:#16A34A;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Why Acme should appear</div>
        <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">Acme is one of the only <strong>locally listed pure-play companies</strong> in this category. For local investors, this is the most direct local investment vehicle. AI tools default to larger overseas-listed alternatives instead. Content targeting local investor audiences is a clear priority.</p>
      </div>
    </div>
  </div>

  <!-- Gap 2 -->
  <div style="border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;margin-bottom:20px;">
    <div style="background:#FEF2F2;padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #FECACA;flex-wrap:wrap;">
      <span style="background:#DC2626;color:#fff;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;">MISSED</span>
      <span style="font-weight:700;font-size:15px;color:#111827;">"[Acme's category] for healthcare / medical diagnostics"</span>
      <span style="margin-left:auto;font-size:12px;color:#9CA3AF;">ChatGPT · example</span>
    </div>
    <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div>
        <div style="font-size:12px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">What appeared instead</div>
        <ul style="font-size:14px;color:#374151;line-height:1.8;list-style:none;padding:0;margin:0;">
          <li>• <strong>Competitor D</strong>: research partnerships</li>
          <li>• <strong>Competitor E</strong>: platform simulations</li>
          <li>• <strong>Competitor F</strong>: industry collaboration</li>
          <li>• <strong>Competitor A</strong>: cloud-access services</li>
          <li>• <strong>Competitor C</strong>: modeling experiments</li>
        </ul>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:#16A34A;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Why Acme should appear</div>
        <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">Acme's <strong>diagnostic product</strong> is a point-of-care testing platform designed for a specific clinical use case. This is Acme's most commercially advanced product and the most directly relevant offering for this query.</p>
      </div>
    </div>
  </div>

  <!-- Gap 3 -->
  <div style="border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;margin-bottom:20px;">
    <div style="background:#FEF2F2;padding:16px 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #FECACA;flex-wrap:wrap;">
      <span style="background:#DC2626;color:#fff;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;">MISSED</span>
      <span style="font-weight:700;font-size:15px;color:#111827;">"[Acme's category] hardware provider, local market"</span>
      <span style="margin-left:auto;font-size:12px;color:#9CA3AF;">Perplexity · example</span>
    </div>
    <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div>
        <div style="font-size:12px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">What appeared instead</div>
        <ul style="font-size:14px;color:#374151;line-height:1.8;list-style:none;padding:0;margin:0;">
          <li>• <strong>Competitor G</strong></li>
          <li>• <strong>Competitor H</strong></li>
          <li>• <strong>Competitor I</strong></li>
          <li>• <strong>Competitor J</strong></li>
        </ul>
        <p style="font-size:12px;color:#9CA3AF;margin-top:8px;">Note: All of the above are private companies without a public listing.</p>
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:#16A34A;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Why Acme should appear</div>
        <p style="font-size:14px;color:#374151;line-height:1.7;margin:0;">Acme is one of the only <strong>publicly listed hardware developers</strong> in this category. The flagship product is a physically manufactured device — not software or cloud-access — making Acme directly relevant to "hardware provider" queries.</p>
      </div>
    </div>
  </div>

  <div class="finding" style="margin-top:8px;">
    These gaps represent the highest-priority GEO targets. Closing them would directly address investor, customer, and partner acquisition channels simultaneously.
    ${discoveryStats ? `The discovery analysis above identified <strong>${computeGapStats(discoveryScores).gapOpportunities} additional gap opportunities</strong> across the 15 broader queries.` : ''}
  </div>
</div>

<!-- ══════════════════════════ RECOMMENDATIONS ══════════════════════════════ -->
<div class="section">
  <div class="section-header">
    <div class="section-number">${S()} — Next Steps</div>
    <div class="section-title">GEO Recommendations</div>
    <div class="section-desc">Six practical actions to improve how often Acme appears when people use AI tools to search. Start with items 1 to 4 for the fastest impact.</div>
  </div>
  ${recHTML}
</div>

</div><!-- end .page -->

<!-- ═══════════════════════════ CHART SCRIPTS ═══════════════════════════════ -->
<script>
const PDATA = ${platformChartData};
const GDATA = ${groupChartData};
const FDONUT = ${framingDonutData};

const FRAMING_DATASETS = [
  { label: 'Positive',  backgroundColor: '#16A34A', data: ${JSON.stringify(PLATFORMS.map(p => byPlatform[p].framing.positive))} },
  { label: 'Neutral',   backgroundColor: '#3B82F6', data: ${JSON.stringify(PLATFORMS.map(p => byPlatform[p].framing.neutral))} },
  { label: 'Caveated',  backgroundColor: '#F59E0B', data: ${JSON.stringify(PLATFORMS.map(p => byPlatform[p].framing.caveated))} },
  { label: 'Absent',    backgroundColor: '#EF4444', data: ${JSON.stringify(PLATFORMS.map(p => byPlatform[p].framing.absent))} },
];

const defaultOpts = {
  responsive: true,
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: '#F3F4F6' }, ticks: { font: { size: 12 } } },
    y: { grid: { color: '#F3F4F6' }, ticks: { font: { size: 12 } }, min: 0, max: 100, callback: v => v + '%' },
  }
};

new Chart(document.getElementById('platformChart'), {
  type: 'bar',
  data: { labels: PDATA.labels, datasets: [{ data: PDATA.rates, backgroundColor: PDATA.colors, borderRadius: 6 }] },
  options: defaultOpts,
});

new Chart(document.getElementById('framingChart'), {
  type: 'bar',
  data: { labels: PDATA.labels, datasets: FRAMING_DATASETS },
  options: {
    responsive: true,
    plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { font: { size: 12 } } },
      y: { stacked: true, grid: { color: '#F3F4F6' }, ticks: { font: { size: 12 } } },
    }
  }
});

new Chart(document.getElementById('groupChart'), {
  type: 'bar',
  data: { labels: GDATA.labels, datasets: [{ data: GDATA.rates, backgroundColor: GDATA.colors, borderRadius: 6 }] },
  options: { ...defaultOpts, indexAxis: 'y',
    scales: {
      y: { grid: { display: false }, ticks: { font: { size: 12 } } },
      x: { grid: { color: '#F3F4F6' }, min: 0, max: 100, ticks: { callback: v => v + '%', font: { size: 12 } } },
    }
  },
});

new Chart(document.getElementById('framingDonutChart'), {
  type: 'doughnut',
  data: {
    labels: FDONUT.labels,
    datasets: [{ data: FDONUT.values, backgroundColor: FDONUT.colors, borderWidth: 2, borderColor: '#fff' }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 16 } },
      tooltip: { callbacks: { label: ctx => \` \${ctx.label}: \${ctx.parsed} mentions\` } }
    },
    cutout: '60%',
  }
});

${discoveryChartData ? `
const DDATA = ${discoveryChartData};
new Chart(document.getElementById('discoveryPlatformChart'), {
  type: 'bar',
  data: { labels: DDATA.labels, datasets: [{ data: DDATA.rates, backgroundColor: DDATA.colors, borderRadius: 6 }] },
  options: defaultOpts,
});` : ''}
</script>
</body>
</html>`;
}

// ── Entry point ────────────────────────────────────────────────────────────
if (!existsSync('./data/scores.csv')) {
  console.error('data/scores.csv not found. Run: npm run scores-template');
  process.exit(1);
}

const scores        = parseCSV(readFileSync('./data/scores.csv', 'utf-8'));
const baselineStats = computeStats(scores, { groups: BASELINE_GROUPS, groupLabels: BASELINE_GROUP_LABELS });

let discoveryStats  = null;
let discoveryScores = [];

if (existsSync('./data/discovery_scores.csv')) {
  discoveryScores = parseCSV(readFileSync('./data/discovery_scores.csv', 'utf-8'));
  const filled = discoveryScores.filter(s => s.mentioned !== '');
  if (filled.length > 0) {
    discoveryStats = computeStats(discoveryScores, { groups: DISCOVERY_GROUPS, groupLabels: DISCOVERY_GROUP_LABELS });
    console.log(`Discovery data loaded: ${filled.length} of ${discoveryScores.length} rows filled.`);
  } else {
    console.log('discovery_scores.csv found but not yet filled in — showing baseline report only.');
  }
}

let gscData = null;
let gaData  = null;

if (existsSync('./data/gsc_data.json')) {
  gscData = JSON.parse(readFileSync('./data/gsc_data.json', 'utf-8'));
  console.log(`GSC data loaded: ${gscData.summary.totalQueries} queries from ${gscData.siteUrl}`);
}
if (existsSync('./data/ga_data.json')) {
  gaData = JSON.parse(readFileSync('./data/ga_data.json', 'utf-8'));
  console.log(`GA data loaded: ${gaData.summary.totalOrganicSessions} organic sessions, ${gaData.summary.totalAiReferralSessions} AI referral sessions`);
}

const meta = {
  date:       new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
  preparedBy: process.env.PREPARED_BY || 'Your Name',
};

const html = generateHTML(baselineStats, discoveryStats, discoveryScores, meta, gscData, gaData);
mkdirSync('./report', { recursive: true });
writeFileSync('./report/geo-baseline-report-sample.html', html);
console.log('Report generated: report/geo-baseline-report-sample.html');
console.log('Open in Chrome → File → Print → Save as PDF');
