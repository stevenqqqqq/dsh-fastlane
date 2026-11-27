/**
 * Deterministic plan construction for the L1 (plan) layer.
 *
 * The planner never calls a model: it derives a short, checkable plan from the
 * turn's own text so an extra model round-trip cannot cost more than it saves.
 * Every output is a pure function of (text, features, caps) so the same turn
 * always yields the same `planId` -- that stability is what lets the injector
 * skip re-emitting an unchanged plan (and keeps the request prefix intact).
 */

/** Marker prefix carried by an injected plan message; `planHasMarker` reads it back. */
export const PLAN_PREFIX = '[fastlane plan v';

const NUMBERED = /^\s*(?:\d+[.)、]|[（(]\d+[)）])\s*/;
const BULLET = /^\s*[-*+•]\s+/;
const LEADS = new Set(['先', '再', '然后', '接着', '最后', '同时', '并行', '另外', '之后']);

/** Slice a string by Unicode code point, never splitting a surrogate pair. */
export function clip(text, max) {
  if (max <= 0) return '';
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('') + '…';
}

/**
 * Split a turn's text into candidate steps.
 *
 * Explicit lists win (they are the author's own decomposition); otherwise the
 * sentence/lead-word structure supplies at most `maxSteps` steps. Steps are
 * clipped so a pathological turn cannot inflate the injected block.
 */
export function deriveSteps(text, { maxSteps = 6, maxStepChars = 64 } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  const listed = [];
  for (const line of lines) {
    if (NUMBERED.test(line) || BULLET.test(line)) {
      const body = line.replace(NUMBERED, '').replace(BULLET, '').trim();
      if (body.length > 0) listed.push(clip(body, maxStepChars));
    }
  }
  if (listed.length >= 2) return listed.slice(0, maxSteps);
  const sentences = String(text ?? '')
    .split(/[。；;!?！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
  const stepped = sentences
    .filter((s) => /\d|[A-Za-z]:[\\/]|\/|跑|测|读|改|写|查|验证|执行|检查|实现|调研|对比|安装|运行|导出|生成/.test(s))
    .slice(0, maxSteps)
    .map((s) => clip(s.replace(/^[\s、,，]+/, ''), maxStepChars));
  if (stepped.length >= 2) return stepped;
  return [clip(String(text ?? '').trim() || '读取目标并给出结论', maxStepChars)];
}

/**
 * Explicit parallel units: distinct paths/URLs/commands named in the turn. Two
 * or more independent units is the only signal strong enough to ask for
 * concurrent tool calls in the same assistant message.
 */
export function parallelUnits(text, { maxUnits = 4 } = {}) {
  const source = String(text ?? '');
  const found = [];
  const push = (unit) => {
    const clean = unit.trim().replace(/[.,;:)\]】」》]+$/, '');
    if (clean.length < 4) return;
    if (found.some((existing) => existing === clean || existing.includes(clean) || clean.includes(existing))) return;
    found.push(clean);
  };
  for (const match of source.match(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|]+/g) ?? []) push(match);
  for (const match of source.match(/https?:\/\/[^\s"'`<>]+/g) ?? []) push(match);
  for (const match of source.match(/`([^`\n]{4,80})`/g) ?? []) push(match.slice(1, -1));
  return found.slice(0, maxUnits);
}

/** A single verification line: exact enough to run, honest when nothing is runnable. */
export function deriveVerify(text, features) {
  const source = String(text ?? '');
  const testFile = source.match(/[\w./\\-]*\.(?:test|spec)\.[cm]?[jt]s\b/);
  if (testFile) return `node --test ${testFile[0]}`;
  if (/\b(npm|pnpm|yarn)\b/.test(source)) return '运行约定的测试/构建命令，贴出退出码';
  if (features.paths >= 1 || /文件|目录|导出|生成/.test(source)) return 'grep 或 read 确认产物存在且内容非空';
  return '给出一条可复现命令并贴出退出码';
}

/**
 * Build the deterministic plan for one turn.
 *
 * @returns {{steps: string[], parallel: number, units: string[], verify: string, id: string}}
 */
export function buildPlan(text, features = {}, { maxSteps = 6, maxStepChars = 64, hash = null } = {}) {
  const steps = deriveSteps(text, { maxSteps, maxStepChars });
  const units = parallelUnits(text);
  const verify = deriveVerify(text, features);
  const body = steps.join('\u0001') + '\u0002' + units.join('\u0001') + '\u0002' + verify;
  const id = hash === null ? null : hash(body);
  return { steps, parallel: units.length, units, verify, id };
}

/** Whether messages already carry the plan identified by `planId`. */
export function planHasMarker(messages, planId, { scanTail = 12 } = {}) {
  if (typeof planId !== 'string' || planId.length === 0) return false;
  const marker = PLAN_PREFIX + planId + ']';
  const start = Math.max(0, messages.length - scanTail);
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(marker)) return true;
    }
  }
  return false;
}

/**
 * Render the injected plan directive. Fixed template: the variable parts
 * (plan id, steps) sit at the tail of the request, never in the system prompt,
 * so an unchanged prefix keeps its cache entry.
 */
export function renderDirective(plan, { route = 'plan' } = {}) {
  const lines = [`${PLAN_PREFIX}${plan.id ?? '0000000000000000'}] route=${route}`];
  const steps = plan.steps.length > 0 ? plan.steps : ['读取目标并给出结论'];
  lines.push('steps: ' + steps.map((step, index) => `${index + 1}) ${step}`).join(' '));
  if (plan.parallel >= 2) {
    const units = plan.units.map((unit) => clip(unit, 48)).join(' | ');
    lines.push(`parallel: ${plan.parallel} 个互不依赖单元（${units}）→ 必须在同一条 assistant 消息里并行发出这些调用`);
  } else {
    lines.push('parallel: 无独立单元，顺序执行');
  }
  lines.push(`verify: ${plan.verify}`);
  lines.push('rules: 不要复述本计划；每步完成直接推进；某步不适用就跳过；只做用户要求的事。');
  return lines.join('\n');
}
