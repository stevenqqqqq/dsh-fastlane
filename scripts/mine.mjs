/**
 * Mine the shadow log for reuse candidates.
 *
 *   node scripts/mine.mjs [path-to-shadow.jsonl] [--min-hits 3] [--json]
 *
 * A candidate is a turn payload that keeps coming back: same normalized text and
 * tool set. The report is deliberately conservative — it prints the payload, how
 * often it occurred, whether those turns needed no tools at all (the strongest
 * signal that a direct answer would serve), and the exact `match` block a pattern
 * should carry. Authoring the template and provenance stays a human decision.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const positional = args.filter(arg => !arg.startsWith('--'));
const minHitsAt = args.indexOf('--min-hits');
const minHits = minHitsAt >= 0 ? Number(args[minHitsAt + 1]) || 3 : 3;
const path = positional[0]
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'fastlane', 'shadow.jsonl');

let rows;
try {
  rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(row => row !== null);
} catch (error) {
  console.error(`cannot read ${path}: ${error.message}`);
  process.exit(1);
}

const groups = new Map();
for (const row of rows) {
  if (row.kind !== 'turn' || row.purpose) continue;
  const key = row.repeat?.key;
  if (typeof key !== 'string') continue;
  const group = groups.get(key) ?? { key, route: row.route, hits: 0, noTool: 0, models: new Set(), turns: [] };
  group.hits += 1;
  if ((row.out?.toolCalls ?? []).length === 0) group.noTool += 1;
  if (row.model) group.models.add(row.model);
  group.turns.push(row);
  groups.set(key, group);
}

const candidates = [...groups.values()]
  .filter(group => group.hits >= minHits)
  .sort((a, b) => b.hits - a.hits || b.noTool - a.noTool);

const out = candidates.map((group) => ({
  repeatKey: group.key,
  hits: group.hits,
  noToolShare: group.hits === 0 ? null : Number((group.noTool / group.hits).toFixed(2)),
  routes: [...new Set(group.turns.map(row => row.route))],
  models: [...group.models],
  // A candidate earns authoring only when the repeats are cheap to answer; a
  // payload that always ran tools needs a deterministic recipe, not prose.
  suggestedMatch: {
    repeatKey: group.key,
    maxChars: 1200,
    minHits: Math.max(3, group.hits),
  },
  sample: group.turns[0]?.features?.pathSamples ?? null,
}));

if (flags.has('--json')) {
  console.log(JSON.stringify({ path, candidates: out }, null, 2));
} else {
  if (out.length === 0) {
    console.log(`no repeat payload reached ${minHits} hits in ${path}`);
  } else {
    console.log(`reuse candidates in ${path} (min-hits ${minHits})`);
    for (const candidate of out) {
      console.log([
        '',
        `repeatKey ${candidate.repeatKey}  hits ${candidate.hits}  no-tool ${candidate.noToolShare}`,
        `routes: ${candidate.routes.join(',')}  models: ${candidate.models.join(',') || 'n/a'}`,
        `match: ${JSON.stringify(candidate.suggestedMatch)}`,
      ].join('\n'));
    }
    console.log('\nAuthor a template + provenance for each accepted candidate in ~/.dsh/fastlane/patterns.json; nothing is enabled from this report.');
  }
}
