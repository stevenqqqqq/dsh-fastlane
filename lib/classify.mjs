/**
 * Zero-model turn classifier for dsh-fastlane.
 *
 * Everything here is a pure function over the request the loop is about to
 * send: `messages`, the offered `tools`, and a repeat counter the plugin keeps
 * per normalized request. No provider call, no clock, no session state — so the
 * shadow numbers are exactly reproducible from a logged request.
 *
 * Routes:
 *   reuse  — the same normalized request was already answered in this session
 *            window; phase 3 may serve it from the stored turn instead of
 *            paying for a second model callback.
 *   direct — small, self-contained question with no file/command surface;
 *            phase 1 may answer without tools and phase 3 may template it.
 *   plan   — multi-step work (enumerated steps, several intents, long brief,
 *            multiple paths); phase 2 injects a plan and asks for parallel
 *            tool calls.
 *   normal — not confident; stock behavior.
 */

import { createHash } from 'node:crypto';

export const ROUTES = ['reuse', 'direct', 'plan', 'normal'];

const ZH_VERBS = [
  '实现', '修复', '调研', '重构', '部署', '生成', '搭建', '写一个', '写个', '写份', '审查', '评审', '迁移',
  '批量', '清理', '优化', '对比', '分析', '整理', '导出', '安装', '配置', '升级', '测试', '验证', '接入',
  '抓取', '爬取', '总结', '翻译', '排版', '制作', '画', '改', '替换', '归档', '蒸馏', '补全', '校准',
  '排期', '估算', '拆分', '设计', '渲染', '编译', '跑通', '调试', '定位', '复现', '审计',
];

const EN_VERBS = [
  'implement', 'refactor', 'fix', 'migrate', 'build', 'generate', 'research', 'review', 'audit', 'deploy',
  'install', 'configure', 'upgrade', 'benchmark', 'analyze', 'summarize', 'translate', 'scrape', 'create',
  'rewrite', 'debug', 'reproduce', 'profile', 'optimize', 'compare', 'export', 'split', 'design', 'render',
];

const PATH_RE = /(?:[A-Za-z]:[\\/]|(?:^|[\s(])(?:\.{1,2}\/|\/)[\w./-]+|[\w@.$-]+\.(?:md|markdown|ts|tsx|mjs|cjs|js|jsx|json|jsonl|py|ya?ml|toml|txt|csv|tsv|xlsx?|pdf|docx?|pptx?|png|jpe?g|webp|gif|html|css|scss|sh|ps1|bat|exe|zip)\b)/g;
const ERROR_RE = /(Traceback \(most recent call last\)|^\s*at .+:\d+:\d+|TypeError|ReferenceError|RangeError|ENOENT|EACCES|exit code \d+|报错|异常|崩溃|失败|超时)/m;
const SEQUENCE_RE = /(然后|接着|之后再|并且|同时|分别|最后一步|步骤\s*\d|step\s*\d|首先|其次|最后)/g;
const GREETING_RE = /^(你好|您好|hi|hello|hey|嗨|在吗|谢谢|多谢|thanks|thank you|早上好|晚上好|早安)[\s!！。.~？?]*$/i;
const CODE_FENCE_RE = /```/g;
const BULLET_RE = /^\s*(?:\d+[.)、]\s*|[-*+]\s+)\S/gm;
const URL_RE = /https?:\/\/[^\s)]+/g;
const SLASH_CMD_RE = /^\/[a-z][\w-]*/i;

/** Text carried by one request message, ignoring non-text blocks. */
export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += `${out ? '\n' : ''}${block.text}`;
  }
  return out;
}

/**
 * Runtime-context snapshots are appended as the LAST message every step, so
 * "last message is a user message" alone would read every tool-continuation
 * step as a fresh turn. They are identifiable two ways.
 */
export function isRuntimeContext(message) {
  if (message?.source?.kind === 'runtime-context') return true;
  if (Array.isArray(message?.source)) {
    for (const kind of message.source) if (kind?.kind === 'runtime-context') return true;
  }
  const text = textOfMessage(message).trimStart();
  return text.startsWith('<system-reminder>');
}

/**
 * The user message that opens this turn: the last user message that is not a
 * runtime-context snapshot. `isEntry` is true when nothing but runtime-context
 * snapshots (and nothing at all) follows it, i.e. this is the turn's first
 * model call rather than a tool continuation.
 */
export function turnEntry(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { index: -1, text: '', isEntry: false };
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (isRuntimeContext(message)) continue;
    index = i;
    break;
  }
  if (index < 0) return { index: -1, text: '', isEntry: false };
  let isEntry = true;
  for (let i = index + 1; i < messages.length; i++) {
    if (!isRuntimeContext(messages[i])) {
      isEntry = false;
      break;
    }
  }
  return { index, text: textOfMessage(messages[index]), isEntry };
}

/** Stable identity of one turn payload: text shape plus the tool surface offered. */
export function repeatKeyOf(text, tools) {
  const names = Array.isArray(tools)
    ? tools.map(tool => String(tool?.name ?? '')).filter(Boolean).sort().join(',')
    : '';
  const normalized = String(text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 4000);
  return createHash('sha256').update(`${normalized}\u0000${names}`).digest('hex').slice(0, 16);
}

/** Count non-overlapping matches without keeping a stateful global regex. */
function countMatches(text, re) {
  re.lastIndex = 0;
  let count = 0;
  while (re.exec(text) !== null) count++;
  re.lastIndex = 0;
  return count;
}

/** Observable facts about one turn, used both for routing and for the log. */
export function featuresOf(text, tools) {
  const chars = text.length;
  const lines = text ? text.split('\n').length : 0;
  const paths = new Set((text.match(PATH_RE) ?? []).map(match => match.trim()));
  const toolNames = Array.isArray(tools) ? tools.map(tool => String(tool?.name ?? '')).filter(Boolean) : [];
  const lower = text.toLowerCase();
  const zhVerbs = ZH_VERBS.filter(verb => text.includes(verb));
  const enVerbs = EN_VERBS.filter(verb => new RegExp(`(?:^|[^a-z])${verb}(?:[^a-z]|$)`, 'i').test(lower));
  const sequences = countMatches(text, SEQUENCE_RE);
  return {
    chars,
    lines,
    paths: paths.size,
    pathSamples: [...paths].slice(0, 4),
    tools: toolNames.length,
    toolNames: toolNames.slice(0, 8),
    codeFences: Math.floor(countMatches(text, CODE_FENCE_RE) / 2),
    bullets: countMatches(text, BULLET_RE),
    urls: countMatches(text, URL_RE),
    errors: ERROR_RE.test(text),
    sequences,
    verbs: zhVerbs.length + enVerbs.length,
    verbSamples: [...zhVerbs, ...enVerbs].slice(0, 6),
    greeting: GREETING_RE.test(text.trim()),
    question: /[？?]\s*$/.test(text.trim()),
    slashCommand: SLASH_CMD_RE.test(text.trim()),
    codeBlocks: (text.match(/```[\s\S]*?```/g) ?? []).length,
  };
}

/**
 * Score one turn. Positive leans "plan", negative leans "direct"; |score| is
 * the confidence margin. `reasons` is the audit trail the shadow log keeps, so
 * a wrong route can be argued with a specific term rather than re-derived.
 */
export function scoreTurn(features) {
  let score = 0;
  const reasons = [];
  const add = (delta, reason) => {
    score += delta;
    reasons.push(`${delta > 0 ? '+' : ''}${delta} ${reason}`);
  };

  if (features.chars === 0) return { score: 0, reasons: ['empty'] };
  if (features.slashCommand) add(2, 'slash-command');
  if (features.greeting) add(-3, 'greeting');
  if (features.chars <= 40) add(-2, 'tiny');
  if (features.chars <= 160 && features.question && !features.paths && !features.codeFences && !features.errors) add(-2, 'short-question');
  if (features.chars >= 900) add(2, 'long-brief');
  if (features.chars >= 2500) add(1, 'very-long-brief');
  if (features.verbs >= 2) add(2, 'multiple-intents');
  if (features.verbs >= 4) add(1, 'many-intents');
  if (features.paths >= 1) add(1, 'named-files');
  if (features.paths >= 3) add(1, 'many-files');
  if (features.codeFences >= 1) add(1, 'code-fence');
  if (features.codeBlocks >= 2) add(1, 'multiple-code-blocks');
  if (features.bullets >= 3) add(2, 'enumerated-work');
  if (features.sequences >= 2) add(1, 'sequence-words');
  if (features.errors) add(1, 'error-payload');
  if (features.urls >= 2) add(1, 'multiple-urls');
  if (features.tools === 0 && features.chars <= 200) add(-1, 'no-tool-surface');

  return { score, reasons };
}

/** Route a turn from its features and repeat count. Pure. */
export function routeOf(features, score, repeatHits, { reuseMinHits = 2 } = {}) {
  if (repeatHits >= reuseMinHits && features.chars >= 8) return 'reuse';
  if (score >= 3) return 'plan';
  if (score <= -2) return 'direct';
  return 'normal';
}

/**
 * Classify one request.
 *
 * `repeatHitsOf` is called at most once with the request's repeat key, after
 * the entry check, so the caller owns the counter and this module stays pure.
 * @returns route, score, confidence, features, reasons, repeatKey, repeatHits
 *   — or a `step` marker for a tool continuation that is not a fresh turn.
 */
export function classify({ messages, tools, repeatHitsOf = () => 0, reuseMinHits = 2 } = {}) {
  const entry = turnEntry(messages);
  if (entry.index < 0) return { kind: 'step', route: 'normal', reason: 'no-user-message' };
  if (!entry.isEntry) return { kind: 'step', route: 'normal', reason: 'tool-continuation' };
  const features = featuresOf(entry.text, tools);
  const scored = scoreTurn(features);
  const repeatKey = repeatKeyOf(entry.text, tools);
  // The counter reports hits observed BEFORE this turn, so the first repeat is 1.
  const repeatHits = Number(repeatHitsOf(repeatKey)) || 0;
  const route = routeOf(features, scored.score, repeatHits, { reuseMinHits });
  const confidence = Math.min(0.96, Math.round((0.55 + 0.09 * Math.abs(scored.score)) * 100) / 100);
  return {
    kind: 'turn',
    route,
    score: scored.score,
    confidence,
    features,
    reasons: scored.reasons,
    repeatKey,
    repeatHits,
  };
}
