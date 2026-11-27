import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneSession } from '../lib/index.js';

/**
 * A session double that keeps the kernel contract the pruner depends on:
 * an append-only event map (old seqs stay addressable after a replacement), a
 * mutable surface node list, and `deriveEventMessage` reading the event data.
 */
function fakeSession() {
  const events = new Map();
  const nodes = [];
  const appended = [];
  let seq = 0;
  const session = {
    surface: { nodes },
    get seq() {
      return seq;
    },
    append(type, data, opts) {
      seq += 1;
      const event = { seq, type, data };
      events.set(seq, event);
      appended.push({ type, data, opts, seq });
      if (opts?.surfaceOp?.op === 'replace') {
        const at = nodes.indexOf(opts.surfaceOp.startSeq);
        assert.ok(at >= 0, 'replace target must be on the surface');
        nodes[at] = seq;
      } else {
        nodes.push(seq);
      }
      return event;
    },
    eventAt(target) {
      return events.get(target);
    },
    deriveEventMessage(event) {
      return event.data.message ?? null;
    },
  };
  const push = (turn, text) => {
    seq += 1;
    const event = {
      seq,
      type: 'tool/result',
      data: {
        turn,
        step: 1,
        message: { id: `m-${turn}-${seq}`, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId: `c-${seq}` } },
      },
    };
    events.set(seq, event);
    nodes.push(seq);
    return event;
  };
  return { session, appended, push, nodes, events };
}

const tokenMeter = { estimateMessage: () => 7 };

const cfg = {
  thresholdChars: 500,
  headChars: 100,
  tailChars: 50,
  minTurnsBeforeFold: 3,
  minDuplicateChars: 100,
  maxPerPass: 4,
  everyEvents: 1,
};

test('pruneSession collapses the later duplicate into a seq pointer', () => {
  const { session, appended, push, nodes } = fakeSession();
  const body = `${'x'.repeat(700)}\n${'y'.repeat(700)}`;
  const first = push(0, body);
  const second = push(1, body);
  push(2, 'result two');
  push(3, 'result three');
  push(4, 'result four');

  const outcome = pruneSession({ session, cfg: { thresholdChars: 4096, headChars: 2048, tailChars: 1024, minTurnsBeforeFold: 3, minDuplicateChars: 100, maxPerPass: 4 }, tokenMeter, record: () => {} });

  assert.equal(outcome.landed, 1);
  const prune = appended.find(entry => entry.type === 'compaction/prune');
  assert.ok(prune, 'must price the shadowed node');
  assert.deepEqual(prune.data.shadowedSeqs, [second.seq]);
  assert.equal(prune.data.shadowedTokenCount, 7);
  const replacement = appended.find(entry => entry.type === 'tool/result');
  assert.deepEqual(replacement.opts.surfaceOp, { op: 'replace', startSeq: second.seq, endSeq: second.seq });
  assert.match(replacement.data.message.content[0].text, new RegExp(`#${first.seq}`));
  assert.equal(nodes.includes(second.seq), false, 'the redundant copy leaves the surface');
  assert.equal(nodes.includes(first.seq), true, 'the first copy stays addressable');
  assert.equal(outcome.charsRemoved > 0, true);
});

test('pruneSession folds oversized machine output but keeps head and tail', () => {
  const { session, appended, push } = fakeSession();
  const log = Array.from({ length: 120 }, (_, index) => `2026-11-27T09:00:${String(index % 60).padStart(2, '0')} step ${index} 0xdeadbeef`).join('\n');
  push(0, log);
  for (let turn = 1; turn <= 3; turn += 1) push(turn, `result ${turn}`);

  const outcome = pruneSession({ session, cfg, tokenMeter, record: () => {} });
  assert.ok(outcome.landed >= 1);
  const replacement = appended.find(entry => entry.type === 'tool/result');
  const text = replacement.data.message.content[0].text;
  assert.match(text, /fastlane pruned \d+ chars/);
  assert.equal(text.startsWith('2026-11-27T09:00:00'), true);
});

test('pruneSession protects errors from folding', () => {
  const { session, push } = fakeSession();
  const failure = `${'z'.repeat(900)}\nError: boom\n    at run (x.js:1:1)`;
  push(0, failure);
  for (let turn = 1; turn <= 3; turn += 1) push(turn, `result ${turn}`);
  const outcome = pruneSession({ session, cfg: { ...cfg, thresholdChars: 100 }, tokenMeter, record: () => {} });
  assert.equal(outcome.landed, 0);
});
