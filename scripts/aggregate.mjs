/**
 * Aggregate the fastlane shadow log into the numbers each phase exists to produce.
 *
 *   node scripts/aggregate.mjs [path-to-shadow.jsonl]
 *
 * Per route: turns, share, mean score/confidence, how many requests emitted zero
 * tool calls (the "would a direct answer have been enough" proxy), cache read
 * ratio (cacheReadTokens / (input+cacheRead+cacheWrite), because DSH token-meter
 * reports inputTokens as UNCACHED input), and mean first-chunk latency.
 *
 * Then the per-layer counters: plan injections and the parallel ratio of the
 * turns they preceded, prune passes/landed/chars removed, reuse hits, repeat
 * histogram, abandoned streams, failures.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.argv[2]
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'fastlane', 'shadow.jsonl');

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(1);
}

const rows = [];
for (const line of raw.split('\n')) {
  if (!line.trim()) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // A torn last line is expected while the app is writing.
  }
}

const turns = rows.filter(row => row.kind === 'turn' && !row.purpose);
const steps = rows.filter(row => row.kind === 'step' || row.reason === 'step');
const auxiliary = rows.filter(row => row.kind === 'turn' && row.purpose);
const plans = rows.filter(row => row.kind === 'plan');
const prunes = rows.filter(row => row.kind === 'prune');
const reuses = rows.filter(row => row.kind === 'reuse');
const errors = rows.filter(row => row.kind === 'error');
if (turns.length === 0 && plans.length === 0) {
  console.log(`no classified turns in ${path} (${rows.length} records, ${auxiliary.length} auxiliary-skipped)`);
  process.exit(0);
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const pct = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const num = (value, digits = 1) => (value === null ? 'n/a' : value.toFixed(digits));

const byRoute = new Map();
for (const row of turns) {
  const bucket = byRoute.get(row.route) ?? { rows: [] };
  bucket.rows.push(row);
  byRoute.set(row.route, bucket);
}

const lines = [
  `log: ${path}`,
  `records: ${rows.length}  turns: ${turns.length}  steps: ${steps.length}  auxiliary (skipped): ${auxiliary.length}`,
  '',
  ['route', 'turns', 'share', 'score', 'conf', 'no-tool', 'cache-hit', '1st-chunk ms'].join('\t'),
];

for (const route of ['reuse', 'direct', 'plan', 'normal']) {
  const bucket = byRoute.get(route);
  if (!bucket) continue;
  const rowsOfRoute = bucket.rows;
  const zeroTool = rowsOfRoute.filter(row => (row.out?.toolCalls ?? []).length === 0).length / rowsOfRoute.length;
  // TokenUsage.inputTokens is the UNCACHED input; the prompt total is
  // input + cacheRead + cacheWrite (dsh-token-meter/lib/index.js:328-332).
  const cacheRead = rowsOfRoute.reduce((sum, row) => sum + (row.usage?.cacheReadTokens ?? 0), 0);
  const prompt = rowsOfRoute.reduce((sum, row) => sum
    + (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.cacheWriteTokens ?? 0), 0);
  const firstChunk = median(rowsOfRoute.map(row => row.out?.firstChunkMs).filter(value => typeof value === 'number'));
  lines.push([
    route,
    rowsOfRoute.length,
    pct(rowsOfRoute.length / turns.length),
    num(mean(rowsOfRoute.map(row => row.score).filter(value => typeof value === 'number')), 2),
    num(mean(rowsOfRoute.map(row => row.confidence).filter(value => typeof value === 'number')), 2),
    pct(zeroTool),
    prompt > 0 ? pct(cacheRead / prompt) : 'n/a',
    firstChunk === null ? 'n/a' : firstChunk,
  ].join('\t'));
}

// L2 metric: of the turns that called at least one tool, how many issued two or
// more in a single assistant message (the shape concurrent tool calls take).
const withTools = turns.filter(row => (row.out?.toolCalls ?? []).length > 0);
const parallel = withTools.filter(row => (row.out?.toolCalls ?? []).length >= 2);
const planTurns = turns.filter(row => row.route === 'plan' && !row.purpose);
const planned = new Set(plans.map(row => row.plan_id));
const followed = planTurns.filter(row => (row.out?.toolCalls ?? []).length >= 2);

const repeatHistogram = new Map();
for (const row of turns) {
  const hits = row.repeat?.hits ?? 0;
  repeatHistogram.set(hits, (repeatHistogram.get(hits) ?? 0) + 1);
}
const repeated = turns.filter(row => (row.repeat?.hits ?? 0) >= 1).length;

lines.push(
  '',
  `L1 plan injections: ${plans.length}  (plan-route turns: ${planTurns.length}, distinct plans: ${planned.size})`,
  `L1 plan-route turns issuing >=2 tool calls: ${followed.length}/${planTurns.length}`,
  `L2 parallel ratio (>=2 tool calls | >=1): ${parallel.length}/${withTools.length} = ${pct(withTools.length === 0 ? null : parallel.length / withTools.length)}`,
  `L3 prune passes: ${prunes.length}  landed replacements: ${prunes.reduce((sum, row) => sum + (row.landed ?? 0), 0)}  chars removed: ${prunes.reduce((sum, row) => sum + (row.charsRemoved ?? 0), 0)}`,
  `L4 reuse hits: ${reuses.length}  (patterns: ${[...new Set(reuses.map(row => row.pattern))].join(', ') || 'none'})`,
  `repeated payloads (hits>=1): ${repeated}/${turns.length} = ${pct(turns.length === 0 ? null : repeated / turns.length)}`,
  `repeat histogram: ${[...repeatHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([hits, count]) => `${hits}x:${count}`).join('  ')}`,
  `tool calls observed: ${turns.reduce((sum, row) => sum + (row.out?.toolCalls?.length ?? 0), 0)}`,
  `abandoned streams: ${turns.filter(row => row.out?.abandoned === true).length}/${turns.length}`,
  `failures: ${turns.reduce((sum, row) => sum + (row.out?.failures?.length ?? 0), 0)}`,
  `errors: ${errors.length}${errors.length > 0 ? '  (' + errors.slice(-3).map(row => `${row.where}:${row.message}`).join(' | ') + ')' : ''}`,
);

console.log(lines.join('\n'));
