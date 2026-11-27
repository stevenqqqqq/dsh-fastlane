import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, featuresOf, isRuntimeContext, repeatKeyOf, scoreTurn, turnEntry } from '../lib/classify.mjs';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const tool = (text) => ({ role: 'tool', content: [{ type: 'text', text }] });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const runtime = (text = '<system-reminder>runtime</system-reminder>') => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'runtime-context' },
});
const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'write' }];

test('greeting routes direct with a negative score', () => {
  const plan = classify({ messages: [user('你好')], tools });
  assert.equal(plan.kind, 'turn');
  assert.equal(plan.route, 'direct');
  assert.ok(plan.score <= -2, `score ${plan.score}`);
});

test('short question without file surface routes direct', () => {
  const plan = classify({ messages: [user('DSH 的 profile 目录在哪？')], tools });
  assert.equal(plan.route, 'direct');
});

test('enumerated multi-file brief routes plan', () => {
  const text = [
    '请把三个插件的配置迁移到新 profile，并重构启动脚本。',
    '1) 读取 a.md 和 b.json 的现有配置',
    '2) 合并到 c.yaml，处理冲突',
    '3) 更新 d.ps1 并跑测试验证',
  ].join('\n');
  const plan = classify({ messages: [user(text)], tools });
  assert.equal(plan.route, 'plan', JSON.stringify(plan.reasons));
  assert.ok(plan.confidence >= 0.7);
});

test('tool continuation is a step, not a turn', () => {
  const plan = classify({ messages: [user('改一下配置'), assistant('好'), tool('done')], tools });
  assert.equal(plan.kind, 'step');
});

test('runtime-context after the user message still reads as turn entry', () => {
  const messages = [user('总结这份报告的结构'), runtime()];
  assert.equal(isRuntimeContext(messages[1]), true);
  const entry = turnEntry(messages);
  assert.equal(entry.isEntry, true);
  assert.equal(classify({ messages, tools }).kind, 'turn');
});

test('a repeated payload routes reuse once the counter reaches the threshold', () => {
  const messages = [user('把 build 目录里的产物按日期归档，并生成清单文件')];
  const key = repeatKeyOf('把 build 目录里的产物按日期归档，并生成清单文件', tools);
  const first = classify({ messages, tools, repeatHitsOf: () => 0, reuseMinHits: 2 });
  const third = classify({ messages, tools, repeatHitsOf: () => 2, reuseMinHits: 2 });
  assert.equal(first.route !== 'reuse', true);
  assert.equal(third.route, 'reuse');
  assert.equal(third.repeatKey, key);
});

test('repeat key ignores whitespace but respects the tool surface', () => {
  const a = repeatKeyOf('整理  日志', [{ name: 'bash' }]);
  const b = repeatKeyOf('整理 日志', [{ name: 'bash' }]);
  const c = repeatKeyOf('整理 日志', [{ name: 'bash' }, { name: 'read' }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('features survive odd message shapes', () => {
  assert.equal(featuresOf('', []).chars, 0);
  assert.equal(turnEntry([]).isEntry, false);
  const missing = classify({ messages: [{ role: 'assistant', content: 'hi' }], tools: undefined });
  assert.equal(missing.kind, 'step');
});

test('score rewards enumerated work and penalizes tiny turns', () => {
  const long = scoreTurn(featuresOf('- a\n- b\n- c\n- d', tools));
  const tiny = scoreTurn(featuresOf('嗯', tools));
  assert.ok(long.score > tiny.score);
});
