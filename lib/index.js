/**
 * dsh-fastlane — layered speedup for DeepSeek Harness.
 *
 * L0  observe  (`llm/stream`, shadow): classify every request, wrap the chunk
 *              stream read-only, append one JSONL record. Never edits a request.
 * L1  plan     (`agent/pre-step` + `system-prompt/assemble`): a stable policy
 *              section, and one deterministic plan directive appended to the
 *              tail of the turn only when its hash is new. Tail placement keeps
 *              the cached prefix bit-identical; the hash check stops a plan from
 *              being re-emitted every step.
 * L2  parallel (plan directive + metrics): the directive names the independent
 *              units and the exact instruction to issue them in one assistant
 *              message; the shadow record counts tool calls per assistant
 *              message, so the aggregate can measure the ratio before/after.
 * L3  prune    (`tools/result` -> `compaction/prune` + surface replace): pure
 *              rules, code-point measurement, errors and stack traces excluded,
 *              duplicate reads collapsed to a seq pointer. Only rewrites old
 *              results (>= minTurnsBeforeFold turns), one small batch per pass.
 * L4  reuse    (`llm/stream` substitution): authored patterns with provenance,
 *              disabled by default; a match skips the model callback entirely.
 *
 * Every layer is independently switchable; `mode: shadow` keeps classification
 * and metrics while disabling every mutation.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { classify, textOfMessage, turnEntry } from './classify.mjs';
import { buildPlan, renderDirective, planHasMarker } from './plan.mjs';
import { duplicateLine, isProtected, looksLikeMachineOutput, measureBlocks, pruneBlocks, textOfBlocks } from './prune.mjs';
import { hashOf, looksLikeCorrection, parsePatterns, provenanceFooter, renderPattern, selectPattern } from './patterns.mjs';

export const name = 'fastlane';
export const inject = [];

const LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const STORE_LIMIT = 512;
const PLAN_MARKER_SCAN_TAIL = 12;
/**
 * Message sources that must never open a plan: completion notices, peer agent
 * traffic and review prompts are delivered as `user` messages with these kinds.
 */
const AUXILIARY_SOURCE = /settled|notice|review|agent-message|plan-mode|system|runtime/i;

/**
 * A config field may be a plain value or a live source (`{ get() }`) from the
 * loader. The plugin deliberately exports no `Config` schema: a workspace-linked
 * bundle resolves `@deepseek-ai/schemastery` from its own directory, which a
 * local `link:` install does not create. Cordis validates only when a plugin
 * declares `Config` (`cordis/lib/index.js:245`), so omitting it keeps the
 * plugin dependency-free while the same config keys still reach `apply`.
 */
function read(field, fallback) {
  let value = field;
  for (let depth = 0; depth < 4; depth++) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object' && typeof value.get === 'function') {
      try {
        value = value.get();
        continue;
      } catch {
        return fallback;
      }
    }
    break;
  }
  return value === undefined || value === null ? fallback : value;
}

function bool(field, fallback) {
  const value = read(field, fallback);
  return value === true || value === 'true';
}

function num(field, fallback) {
  const value = Number(read(field, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function str(field, fallback) {
  const value = read(field, fallback);
  return typeof value === 'string' ? value : fallback;
}

/** The stable policy section registered in the system prompt (prefix-safe). */
const PLAN_POLICY_TEXT = [
  'Planning policy (fastlane):',
  '- Classify the turn before acting: a single concrete question or one-step command is answered directly, without a planning preamble.',
  '- A multi-step task gets a plan executed in order; when two or more subtasks are independent, issue their tool calls in the SAME assistant message instead of one per turn.',
  '- Never restate a plan that is already present in the conversation; continue from where it stopped.',
  '- Keep the final answer limited to the requested result, its evidence, and any blocking issue.',
].join('\n');

export function apply(ctx, config = {}) {
  const enabled = () => bool(config.enabled, true);
  const mode = () => str(config.mode, 'active');
  const active = () => enabled() && mode() === 'active';
  const reuseMinHits = () => num(config.reuseMinHits, 2) || 2;
  const stepRecords = () => bool(config.stepRecords, false);
  const maxLoggedTextChars = () => num(config.maxLoggedTextChars, 4000) || 4000;
  const debug = () => bool(config.debug, false);
  // Per-node scan records are only useful while tuning the prune detectors;
  // left on they write hundreds of lines per pass and drown the real records.
  const diagnostics = () => debug() && bool(config.prune?.diagnostics, false);

  const planCfg = () => ({
    enabled: bool(config.plan?.enabled, true),
    maxSteps: num(config.plan?.maxSteps, 6),
    maxStepChars: num(config.plan?.maxStepChars, 64),
  });
  const pruneCfg = () => ({
    enabled: bool(config.prune?.enabled, true),
    thresholdChars: num(config.prune?.thresholdChars, 8192),
    headChars: num(config.prune?.headChars, 4096),
    tailChars: num(config.prune?.tailChars, 1024),
    minTurnsBeforeFold: num(config.prune?.minTurnsBeforeFold, 3),
    minDuplicateChars: num(config.prune?.minDuplicateChars, 1200),
    maxPerPass: num(config.prune?.maxPerPass, 4),
    everyEvents: num(config.prune?.everyEvents, 6),
  });
  const reuseCfg = () => ({
    enabled: bool(config.reuse?.enabled, false),
    requireThinking: bool(config.reuse?.requireThinking, true),
    patternsFile: str(config.reuse?.patternsFile, ''),
  });

  const logPath = () => {
    const explicit = read(config.logFile, '');
    if (typeof explicit === 'string' && explicit.trim()) return explicit;
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(home, 'fastlane', 'shadow.jsonl');
  };

  const rotate = (path) => {
    try {
      if (!existsSync(path)) return;
      if (statSync(path).size < LOG_LIMIT_BYTES) return;
      renameSync(path, `${path}.1`);
    } catch {
      // A rotated log must never break a model turn.
    }
  };

  const record = (entry) => {
    try {
      const path = logPath();
      mkdirSync(dirname(path), { recursive: true });
      rotate(path);
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch {
      // Observation durability must never break a model turn.
    }
  };

  // Per-session repeat counter: normalized payload -> times seen this boot.
  const repeats = new Map();
  const bumpRepeat = (key) => {
    const hits = repeats.get(key)?.hits ?? 0;
    repeats.delete(key);
    repeats.set(key, { hits: hits + 1, lastAt: Date.now() });
    while (repeats.size > STORE_LIMIT) repeats.delete(repeats.keys().next().value);
    return hits;
  };

  // Mount record: proves the bundle was loaded in this process even before any
  // turn arrives, and pins which log file the run wrote to.
  record({
    kind: 'mount',
    mode: mode(),
    log: logPath(),
    layers: {
      plan: planCfg().enabled,
      prune: pruneCfg().enabled,
      reuse: reuseCfg().enabled,
    },
  });

  /* --------------------------------------------------------------------- *
   * L1 — stable policy section (system prompt prefix) + per-turn plan (tail)
   * --------------------------------------------------------------------- */

  ctx.inject(['systemPrompt'], (serviceCtx) => {
    try {
      const order = typeof serviceCtx.systemPrompt.getSectionOrder === 'function'
        ? serviceCtx.systemPrompt.getSectionOrder('PLAN_POLICY')
        : 500;
      serviceCtx.systemPrompt.section({
        name: 'fastlane:plan-policy',
        order: Number.isFinite(order) ? order : 500,
        text: PLAN_POLICY_TEXT,
      });
    } catch (error) {
      record({ kind: 'error', where: 'section', message: String(error?.message ?? error).slice(0, 200) });
    }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    if (debug()) {
      const last = Array.isArray(payload?.messages) ? payload.messages.at(-1) : undefined;
      record({
        kind: 'pstep',
        step: Number(payload?.step ?? -1),
        messages: Array.isArray(payload?.messages) ? payload.messages.length : -1,
        role: last?.role ?? '',
        source: last?.source?.kind ?? '',
      });
    }
    if (!active() || !planCfg().enabled) return next();
    try {
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const tools = Array.isArray(payload?.tools) ? payload.tools : [];
      // `payload.step` is the session-lifetime step counter (1 for the first
      // step ever, then 125, 126 …), so it cannot identify a turn opening. The
      // loop only claims messages when new input arrives; a non-empty claimed
      // batch is the turn-opening step, and later steps of the same turn carry
      // an empty batch. That keeps the directive to exactly one per turn.
      if (!messages.length) return next();
      const entry = turnEntry(messages);
      if (!entry || !entry.isEntry || typeof entry.text !== 'string' || entry.text.length === 0) return next();
      // Only human input opens a plan. Subagent completion notices, peer agent
      // messages and review prompts also arrive as user messages; planning them
      // would spend a directive on text the user never wrote.
      const claimedSource = String(messages[entry.index]?.source?.kind ?? '');
      if (AUXILIARY_SOURCE.test(claimedSource)) return next();
      const plan0 = classify({ messages, tools, reuseMinHits: reuseMinHits(), repeatHitsOf: () => 0 });
      if (plan0.route !== 'plan') return next();
      const cfg = planCfg();
      const plan = buildPlan(entry.text, plan0.features ?? {}, { maxSteps: cfg.maxSteps, maxStepChars: cfg.maxStepChars, hash: hashOf });
      if (planHasMarker(messages, plan.id, { scanTail: PLAN_MARKER_SCAN_TAIL })) return next();
      const directive = renderDirective(plan, { route: plan0.route });
      const decision = await next();
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      const injected = {
        id: `fastlane-plan-${plan.id}`,
        role: 'user',
        content: [{ type: 'text', text: directive }],
        source: { kind: 'plan-mode' },
      };
      record({
        kind: 'plan',
        plan_id: plan.id,
        turn: Number(payload?.turn ?? -1),
        steps: plan.steps,
        parallel: plan.parallel,
        units: plan.units,
        verify: plan.verify,
        chars: directive.length,
        route: plan0.route,
      });
      return { ...decision, messages: [...decision.messages, injected] };
    } catch (error) {
      record({ kind: 'error', where: 'pre-step', message: String(error?.message ?? error).slice(0, 200) });
      return next();
    }
  });

  /* --------------------------------------------------------------------- *
   * L3 — deterministic prune of old tool results
   * --------------------------------------------------------------------- */

  const pruneState = new Map();
  ctx.on('tools/result', (exec) => {
    try {
      const cfg = pruneCfg();
      if (!active() || !cfg.enabled) return;
      const session = exec?.agent?.session;
      if (!session || !Array.isArray(session?.surface?.nodes) || typeof session.append !== 'function') return;
      const sid = String(session.id ?? '');
      const state = pruneState.get(sid) ?? { lastSeq: -1 };
      if (session.seq - state.lastSeq < cfg.everyEvents) return;
      state.lastSeq = session.seq;
      pruneState.set(sid, state);
      if (pruneState.size > 128) pruneState.delete(pruneState.keys().next().value);
      const outcome = pruneSession({ session, cfg, tokenMeter: ctx.get('tokenMeter'), record, probe: diagnostics() });
      if (debug()) {
        record({
          kind: 'pcheck',
          session: sid,
          seq: session.seq,
          scanned: outcome.scanned ?? -1,
          candidates: outcome.candidates ?? -1,
          landed: outcome.landed ?? -1,
          reason: outcome.reason ?? '',
        });
      }
      if (outcome.landed > 0) {
        record({ kind: 'prune', ...outcome, session: sid });
      }
    } catch (error) {
      record({ kind: 'error', where: 'prune', message: String(error?.message ?? error).slice(0, 200) });
    }
  });

  /* --------------------------------------------------------------------- *
   * L0 — shadow classification of every model call (+ L4 substitution)
   * --------------------------------------------------------------------- */

  ctx.on('llm/stream', (options, next) => {
    if (!enabled() || mode() === 'off') return next();
    const sessionId = options?.sessionId === undefined ? '' : String(options.sessionId);
    const messages = Array.isArray(options?.messages) ? options.messages : [];
    const tools = Array.isArray(options?.tools) ? options.tools : [];
    let enterInfo = null;
    if (debug()) {
      const last = messages[messages.length - 1];
      enterInfo = {
        session: sessionId,
        provider: options?.provider,
        model: options?.model,
        purpose: options?.purpose,
        messages: messages.length,
        tools: tools.length,
        lastRole: last?.role ?? null,
        lastSource: last?.source?.kind ?? null,
        lastText: typeof last?.content === 'string' ? last.content.slice(0, 80) : null,
      };
    }
    // `options.purpose` marks auxiliary calls (auto-review, titles, summaries).
    // They run on behalf of a turn but are not the turn: they must neither feed
    // the repeat counter nor be answered from a pattern.
    const auxiliary = typeof options?.purpose === 'string' && options.purpose.length > 0;
    // One pass: the counter reports hits seen before this turn, so the first
    // repeat observes 1 and `reuseMinHits: 2` needs a third occurrence.
    let plan;
    try {
      plan = classify({
        messages,
        tools,
        reuseMinHits: reuseMinHits(),
        repeatHitsOf: (key) => (auxiliary ? 0 : bumpRepeat(`${sessionId ?? ''}\u0000${key}`)),
      });
    } catch (error) {
      // Classification is an optimisation; an exception must never break a turn.
      if (enterInfo) {
        record({ kind: 'error', where: 'classify', message: String(error?.message ?? error).slice(0, 200), ...enterInfo });
      }
      return next();
    }
    if (enterInfo) {
      record({
        kind: 'enter',
        decision: plan.kind,
        route: plan.route,
        score: plan.score,
        reasons: plan.reasons ?? null,
        ...enterInfo,
      });
    }

    // L4: a repeated task may be answered from an authored pattern. Disabled by
    // default; a match returns a synthetic stream and never calls `next()`.
    if (active() && !auxiliary && reuseCfg().enabled && plan.route === 'reuse') {
      try {
        // The turn's own user text is not always the last user message: the
        // harness appends a runtime-context message each step, and a subagent
        // turn can carry its task prompt further up. Try the recent ones.
        const entry = turnEntry(messages);
        const candidates = userTexts(messages).slice(-3);
        const text = typeof entry?.text === 'string' ? entry.text : '';
        if (text && !candidates.includes(text)) candidates.unshift(text);
        const cfg = reuseCfg();
        const patterns = loadPatterns(cfg.patternsFile, record);
        let selection = { hit: null, reason: candidates.length ? 'no-pattern' : 'no-text' };
        let matchedOn = null;
        for (const candidate of candidates) {
          const attempt = selectPattern({
            text: candidate,
            repeatKey: plan.repeatKey ?? null,
            repeatHits: plan.repeatHits ?? 0,
            patterns,
            enabled: cfg.enabled,
          });
          if (attempt.hit) {
            selection = attempt;
            matchedOn = candidate;
            break;
          }
          if (selection.reason === 'no-pattern' || selection.reason === 'no-text') selection = attempt;
        }
        if (selection.hit) {
          const rendered = renderPattern(selection.hit, {
            request: matchedOn ?? text,
            date: new Date().toISOString().slice(0, 10),
          });
          if (rendered !== null) {
            record({ kind: 'reuse', pattern: selection.hit.id, version: selection.hit.version, session: sessionId, route: plan.route, repeat: plan.repeatKey ?? null, auxiliary });
            return reuseStream({
              answer: rendered + provenanceFooter(selection.hit),
              requireThinking: cfg.requireThinking,
              sessionId,
            });
          }
          record({ kind: 'reuse-rejected', pattern: selection.hit.id, reason: 'slot-missing', session: sessionId });
        } else {
          record({ kind: 'reuse-miss', reason: selection.reason, session: sessionId, candidates: candidates.length, textChars: text.length });
        }
      } catch (error) {
        record({ kind: 'error', where: 'reuse', message: String(error?.message ?? error).slice(0, 200), session: sessionId });
      }
    }

    if (plan.kind === 'step' && !stepRecords()) {
      if (debug()) {
        record({
          kind: 'skip',
          reason: 'step',
          mode: mode(),
          route: plan.route,
          score: plan.score,
          session: sessionId,
          provider: options?.provider,
          model: options?.model,
          purpose: options?.purpose,
          route0: plan.reasons?.[0] ?? null,
        });
      }
      return next();
    }

    return shadowStream({ options, next, plan, sessionId, record, mode: mode(), maxLoggedTextChars: maxLoggedTextChars() });
  });

  /**
   * Wrap the stock stream. The wrapper is a pure pass-through: every chunk is
   * yielded unchanged to the loop, and the record is written once the stream
   * ends (or throws). Timing starts when the loop pulls the first chunk, so the
   * figure measures model latency, not wrapper bookkeeping.
   */
  async function* shadowStream({ options, next, plan, sessionId, record, mode, maxLoggedTextChars }) {
    const startedAt = Date.now();
    let firstChunkAt = 0;
    let chunks = 0;
    let usage = null;
    let finish = null;
    let textChars = 0;
    const toolCalls = [];
    const failures = [];

    const stock = () => {
      const produced = next();
      return produced && typeof produced[Symbol.asyncIterator] === 'function' ? produced : produced();
    };

    let completed = false;
    try {
      for await (const chunk of stock()) {
        if (!chunk) continue;
        if (chunks === 0) firstChunkAt = Date.now();
        chunks++;
        if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
        else if (chunk.type === 'finish') finish = chunk.reason ?? null;
        else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') textChars += chunk.text.length;
        else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          const name = chunk.block.name ?? chunk.block.toolName;
          if (typeof name === 'string' && !toolCalls.includes(name)) toolCalls.push(name);
        }
        yield chunk;
      }
      completed = true;
    } catch (error) {
      failures.push(String(error?.message ?? error).slice(0, 200));
      throw error;
    } finally {
      // A consumer that stops at `finish` injects a return at the yield point:
      // the loop ends without reaching its end, so record from `finally` too.
      record(recordOf({ plan, sessionId, options, mode, maxLoggedTextChars, startedAt, firstChunkAt, chunks, usage, finish, textChars, toolCalls, failures, abandoned: !completed && failures.length === 0 }));
    }
  }
}

/** One JSONL line: the route decision, its evidence, and what the turn became. */
function recordOf({ plan, sessionId, options, mode, maxLoggedTextChars, startedAt, firstChunkAt, chunks, usage, finish, textChars, toolCalls, failures, abandoned = false }) {
  const endedAt = Date.now();
  const features = plan.features ? { ...plan.features } : null;
  if (features && Array.isArray(features.pathSamples)) {
    features.pathSamples = features.pathSamples.map(path => path.slice(0, 120));
  }
  return {
    kind: plan.kind,
    mode,
    session: sessionId,
    provider: options?.provider ?? null,
    model: options?.model ?? null,
    purpose: options?.purpose ?? null,
    request: {
      messages: Array.isArray(options?.messages) ? options.messages.length : 0,
      tools: Array.isArray(options?.tools) ? options.tools.length : 0,
      maxTokens: options?.maxTokens ?? null,
    },
    route: plan.route,
    score: plan.score ?? null,
    confidence: plan.confidence ?? null,
    reasons: plan.reasons ?? [plan.reason ?? null],
    features,
    repeat: plan.repeatKey ? { key: plan.repeatKey, hits: plan.repeatHits ?? 0 } : null,
    out: {
      chunks,
      textChars,
      toolCalls,
      toolCallCount: toolCalls.length,
      finish,
      failures,
      abandoned,
      firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null,
      totalMs: endedAt - startedAt,
      cappedChars: maxLoggedTextChars,
    },
    usage: usage
      ? {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          totalTokens: usage.totalTokens ?? null,
          cacheReadTokens: usage.cacheReadTokens ?? null,
          cacheWriteTokens: usage.cacheWriteTokens ?? null,
          uncachedInputTokens: usage.uncachedInputTokens ?? null,
        }
      : null,
  };
}

/* ----------------------------------------------------------------------- *
 * L3 implementation: one deterministic pass over the current surface
 * ----------------------------------------------------------------------- */

/**
 * Rewrite at most `cfg.maxPerPass` old tool results. Each replacement keeps the
 * original event reachable (`compaction/prune` cites its seq) and preserves the
 * complete event data apart from `content`.
 */
/**
 * User-authored texts carried by one request, oldest first.
 *
 * Runtime-context messages are skipped: they are harness prose, not the turn.
 */
function userTexts(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'user') continue;
    if (message.source?.kind === 'runtime-context') continue;
    const text = textOfMessage(message);
    if (typeof text === 'string' && text.length > 0) out.push(text);
  }
  return out;
}

function pruneSession({ session, cfg, tokenMeter, record, probe = false }) {
  const nodes = [...session.surface.nodes];
  const seen = new Map();
  const jobs = [];
  let maxTurn = -1;
  let scanned = 0;

  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const turn = Number(event.data?.turn ?? -1);
    if (turn > maxTurn) maxTurn = turn;
  }

  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = session.deriveEventMessage(event);
    if (!message || !Array.isArray(message.content)) continue;
    const text = textOfBlocks(message.content);
    if (text.length === 0) continue;
    scanned += 1;
    const turn = Number(event.data?.turn ?? -1);
    const age = maxTurn >= 0 && turn >= 0 ? maxTurn - turn : 0;
    const key = hashOf(text);
    if (probe) {
      record({
        kind: 'pscan',
        seq,
        turn,
        age,
        len: text.length,
        protected: isProtected(text),
        machine: looksLikeMachineOutput(text),
      });
    }

    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, { seq, message, event });
    } else if (text.length >= cfg.minDuplicateChars && age >= cfg.minTurnsBeforeFold && !isProtected(text)) {
      // Collapse the LATER copy and point it at the earlier one: the rewrite
      // sits as deep in the prefix as the duplicate itself, so the cache entry
      // it invalidates starts at the redundant copy, not above cached content.
      jobs.push({ kind: 'dup', seq, message, event, ref: prior.seq, charsBefore: text.length });
    }

    if (age >= cfg.minTurnsBeforeFold && text.length > cfg.thresholdChars && !isProtected(text) && looksLikeMachineOutput(text)) {
      const pruned = pruneBlocks(message.content, cfg);
      if (pruned !== null) {
        jobs.push({ kind: 'log', seq, message, event, pruned, charsBefore: pruned.charsBefore });
      }
    }
    if (jobs.length >= cfg.maxPerPass * 2) break;
  }

  const picked = jobs.slice(0, cfg.maxPerPass);
  let landed = 0;
  let charsRemoved = 0;
  const applied = [];
  for (const job of picked) {
    const content = job.kind === 'dup' ? [{ type: 'text', text: duplicateLine(job.ref) }] : job.pruned.blocks;
    const nextMessage = { ...job.message, content };
    let shadowedTokenCount = 0;
    try {
      shadowedTokenCount = typeof tokenMeter?.estimateMessage === 'function' ? Number(tokenMeter.estimateMessage(job.message)) || 0 : 0;
    } catch {
      shadowedTokenCount = 0;
    }
    session.append('compaction/prune', {
      shadowedRange: { start: job.seq, end: job.seq },
      shadowedSeqs: [job.seq],
      shadowedTokenCount,
    });
    session.append('tool/result', { ...job.event.data, message: nextMessage }, {
      surfaceOp: { op: 'replace', startSeq: job.seq, endSeq: job.seq },
      sourceEventSeqs: [job.seq],
    });
    landed += 1;
    charsRemoved += job.charsBefore - measureBlocks(content);
    applied.push({ kind: job.kind, seq: job.seq, ref: job.ref ?? null, charsBefore: job.charsBefore });
  }

  return { scanned, candidates: jobs.length, landed, charsRemoved, applied };
}

/* ----------------------------------------------------------------------- *
 * L4 implementation: authored pattern store + synthetic stream
 * ----------------------------------------------------------------------- */

const patternCache = { path: null, mtimeMs: 0, patterns: [] };

/** Load the pattern file, re-reading only when its mtime changed. */
function loadPatterns(explicit, record) {
  const path = explicit && explicit.trim()
    ? explicit
    : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'fastlane', 'patterns.json');
  try {
    if (!existsSync(path)) return [];
    const stat = statSync(path);
    if (patternCache.path === path && patternCache.mtimeMs === stat.mtimeMs) return patternCache.patterns;
    const patterns = parsePatterns(readFileSync(path, 'utf8'));
    patternCache.path = path;
    patternCache.mtimeMs = stat.mtimeMs;
    patternCache.patterns = patterns;
    return patterns;
  } catch (error) {
    record({ kind: 'error', where: 'patterns', message: String(error?.message ?? error).slice(0, 200) });
    return [];
  }
}

/**
 * Answer without a model callback. The synthetic stream mimics a normal
 * assistant turn: an optional reasoning block (thinking-mode endpoints reject an
 * assistant turn without one), the text block, and a `stop` finish reason. No
 * `usage` chunk is emitted because no provider request was made.
 */
async function* reuseStream({ answer, requireThinking, sessionId }) {
  let index = 0;
  if (requireThinking) {
    const thinking = `fastlane reuse: an authored pattern matched this repeated task (${sessionId ? 'session ' + sessionId : 'session'}), so the answer was served from the pattern store with its provenance footer.`;
    yield { type: 'block-start', index, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index, text: thinking };
    yield { type: 'block-end', index, block: { type: 'reasoning', text: thinking } };
    index += 1;
  }
  yield { type: 'block-start', index, blockType: 'text' };
  yield { type: 'text-delta', index, text: answer };
  yield { type: 'block-end', index, block: { type: 'text', text: answer } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

export { looksLikeCorrection, pruneSession };
