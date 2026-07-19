#!/usr/bin/env node
// Framer Article Research — finds the best topic to write about this week.
//
// Priority order:
//   1. Next item in data/article-topics.json queue (manual — add topics here)
//   2. Auto-research: live web search via Claude's built-in search tool —
//      finds trending GEO/AI topics, checks what's already covered, picks the best gap
//
// USAGE
//   node research-article-topic.js           (standalone — prints research brief)
//   import { getResearchBrief } from ...     (used by generate-framer-article.js)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

// ── Load .env ─────────────────────────────────────────────────────────────────
try {
  const lines = readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch { /* no .env */ }

const TOPICS_PATH = new URL('./data/article-topics.json', import.meta.url);

// ── Topic queue helpers ────────────────────────────────────────────────────────

function readQueue() {
  if (!existsSync(TOPICS_PATH)) return [];
  return JSON.parse(readFileSync(TOPICS_PATH, 'utf8')).queue || [];
}

function popFromQueue() {
  if (!existsSync(TOPICS_PATH)) return null;
  const data = JSON.parse(readFileSync(TOPICS_PATH, 'utf8'));
  if (!data.queue?.length) return null;
  const topic = data.queue.shift();
  writeFileSync(TOPICS_PATH, JSON.stringify(data, null, 2));
  return topic;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function getResearchBrief() {
  const queued = popFromQueue();

  if (queued) {
    console.log(`Topic from queue: "${queued}"`);
    return {
      topic: queued,
      angle: '',
      target_queries: [],
      key_points: [],
      research_sources: [],
    };
  }

  console.error('\nQueue is empty. Add topics to data/article-topics.json to continue.\n');
  process.exit(1);
}

// ── Standalone run ─────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('\n── Article Research ─────────────────────────────────────────────');
  const brief = await getResearchBrief();
  console.log('\nResearch brief:');
  console.log(JSON.stringify(brief, null, 2));
  console.log('\nRun npm run framer-draft to generate and publish this article.\n');
}
