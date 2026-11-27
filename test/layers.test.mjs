import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlan, deriveSteps, deriveVerify, parallelUnits, planHasMarker, renderDirective } from '../lib/plan.mjs';
import { codePointLength, duplicateLine, isProtected, looksLikeMachineOutput, measureBlocks, pruneBlocks } from '../lib/prune.mjs';
import { hashOf, parsePatterns, provenanceComplete, provenanceFooter, renderPattern, selectPattern } from '../lib/patterns.mjs';

/* ------------------------------------------------------------------ plan */

test('deriveSteps prefers an explicit list and caps it', () => {
  const text = ['1. 读 a.mjs', '2. 改 b.mjs', '3. 跑测试', '4. 交付'].join('\n');
  const steps = deriveSteps(text, { maxSteps: 3 });
  assert.deepEqual(steps, ['读 a.mjs', '改 b.mjs', '跑测试']);
  assert.deepEqual(deriveSteps(text, { maxSteps: 9 }).length, 4);
});

test('deriveSteps falls back to prose sentences', () => {
  const steps = deriveSteps('先读 config 文件，再跑 node --test，最后记录结果。');
  assert.ok(steps.length >= 1);
  assert.ok(steps.every((step) => step.length > 0));
});

test('parallelUnits finds distinct paths and dedupes containment', () => {
  const units = parallelUnits('对比 C:/a/log.txt 与 C:/b/log.txt 还有 C:/b/log.txt');
  assert.equal(units.filter((unit) => unit === 'C:/b/log.txt').length, 1);
  assert.ok(units.length >= 2);
});

test('deriveVerify names a runnable test file when the turn names one', () => {
  assert.equal(deriveVerify('修 plugins/dsh-fastlane/test/classify.test.mjs', {}), 'node --test plugins/dsh-fastlane/test/classify.test.mjs');
});

test('buildPlan id is stable for the same text and differs across texts', () => {
  const a = buildPlan('1. 读 x\n2. 改 y', {}, { hash: hashOf });
  const b = buildPlan('1. 读 x\n2. 改 y', {}, { hash: hashOf });
  const c = buildPlan('1. 读 y\n2. 改 x', {}, { hash: hashOf });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(a.parallel, 0);
});

test('planHasMarker finds an injected directive only inside the scanned tail', () => {
  const plan = buildPlan('1. 读 x\n2. 改 y', {}, { hash: hashOf });
  const directive = renderDirective(plan);
  assert.match(directive, /\[fastlane plan v[0-9a-f]{16}\]/);
  assert.equal(planHasMarker([{ content: [{ type: 'text', text: directive }] }], plan.id, { scanTail: 2 }), true);
  assert.equal(planHasMarker([{ content: [{ type: 'text', text: directive }] }, { content: [] }, { content: [] }], plan.id, { scanTail: 2 }), false);
});

test('renderDirective asks for one assistant message only with >=2 units', () => {
  const many = buildPlan('同时对比 C:/a.txt 和 C:/b.txt', {}, { hash: hashOf });
  assert.match(renderDirective(many), /必须在同一条 assistant 消息里并行发出/);
  const one = buildPlan('先读一下这个文件', {}, { hash: hashOf });
  assert.match(renderDirective(one), /无独立单元/);
});

/* ----------------------------------------------------------------- prune */

test('measureBlocks counts code points, not UTF-16 units', () => {
  assert.equal(codePointLength('🧪a'), 2);
  assert.equal(measureBlocks([{ type: 'text', text: '🧪a' }, { type: 'tool-call' }]), 2);
});

test('pruneBlocks leaves small content untouched', () => {
  assert.equal(pruneBlocks([{ type: 'text', text: 'short' }], { thresholdChars: 100 }), null);
});

test('pruneBlocks keeps head and tail and shrinks the content', () => {
  const text = 'H'.repeat(200) + 'M'.repeat(200) + 'T'.repeat(50);
  const result = pruneBlocks([{ type: 'text', text }], { thresholdChars: 100, headChars: 20, tailChars: 10 });
  assert.ok(result !== null);
  assert.ok(result.charsAfter < result.charsBefore);
  assert.equal(result.blocks[0].text.startsWith('H'.repeat(20)), true);
  assert.equal(result.blocks[0].text.endsWith('T'.repeat(10)), true);
  // removed span = total - head - tail = 450 - 20 - 10
  assert.match(result.blocks[0].text, /fastlane pruned 420 chars/);
});

test('pruneBlocks never splits a surrogate pair', () => {
  const text = '🧪'.repeat(100);
  const result = pruneBlocks([{ type: 'text', text }], { thresholdChars: 10, headChars: 4, tailChars: 3 });
  assert.ok(result !== null);
  const kept = result.blocks[0].text;
  assert.equal(kept.startsWith('🧪'), true);
  assert.equal(kept.endsWith('🧪'), true);
  // No lone surrogate may survive the slice.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(kept), false);
});

test('protected content is excluded from pruning candidates', () => {
  assert.equal(isProtected('Error: boom\n    at run (x.js:1:1)'), true);
  assert.equal(isProtected('process exited with exit code: 3'), true);
  assert.equal(isProtected('a plain prose paragraph about the change'), false);
});

test('looksLikeMachineOutput separates logs from prose', () => {
  assert.equal(looksLikeMachineOutput(['2026-11-27T09:00:01 start', '2026-11-27T09:00:02 step', 'abc12345 def', 'abc12345 def'].join('\n')), true);
  assert.equal(looksLikeMachineOutput('The change is small and safe.'), false);
});

test('duplicateLine points at the retained seq', () => {
  assert.match(duplicateLine(42), /#42/);
});

/* -------------------------------------------------------------- patterns */

test('parsePatterns tolerates junk and drops malformed entries', () => {
  assert.deepEqual(parsePatterns('not json'), []);
  const parsed = parsePatterns(JSON.stringify([{ id: 'ok', template: 'hi' }, { id: 'no-template' }, 7]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'ok');
  assert.equal(parsed[0].minHits, 3);
});

test('provenanceComplete requires a record for every non-id slot', () => {
  const pattern = { template: 'a {{x}} b {{y.id}}', provenance: [{ slot: 'x', source: 'doc' }] };
  assert.equal(provenanceComplete(pattern), true);
  assert.equal(provenanceComplete({ template: 'a {{x}} {{y}}', provenance: [{ slot: 'x' }] }), false);
});

test('selectPattern gates on enablement, repeats, exclusions and provenance', () => {
  const pattern = {
    id: 'p', version: 1, template: 'answer {{request}}',
    match: { repeatKey: null, keywords: ['k'], allOf: [], noneOf: ['skip'], maxChars: 100 },
    provenance: [{ slot: 'request', source: 'turn' }], minHits: 3, minSuccesses: 0, successes: 0, demotedUntil: 0,
  };
  assert.equal(selectPattern({ text: 'k', repeatKey: 'r', repeatHits: 3, patterns: [pattern], enabled: false }).reason, 'disabled');
  assert.equal(selectPattern({ text: 'k', repeatKey: 'r', repeatHits: 1, patterns: [pattern], enabled: true }).reason, 'repeat-below-min');
  assert.equal(selectPattern({ text: 'k skip', repeatKey: 'r', repeatHits: 9, patterns: [pattern], enabled: true }).reason, 'no-pattern');
  assert.equal(selectPattern({ text: 'k', repeatKey: 'r', repeatHits: 3, patterns: [pattern], enabled: true }).hit.id, 'p');
});

test('renderPattern refuses a missing slot and provenanceFooter names its source', () => {
  const pattern = { id: 'p', version: 2, template: 'value {{request}}', provenance: [{ slot: 'request', source: 'turn text' }] };
  assert.equal(renderPattern(pattern, {}), null);
  assert.equal(renderPattern(pattern, { request: 'x' }), 'value x');
  assert.match(provenanceFooter(pattern), /pattern p v2 · request←turn text/);
});
