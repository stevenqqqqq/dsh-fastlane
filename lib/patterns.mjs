/**
 * Answer-reuse patterns for the L2 layer (`fastlane.reuse`).
 *
 * A pattern is authored, never inferred: it names the exact repeats it answers,
 * carries provenance for every fact it emits, and stays disabled by default.
 * A match can only shorten a turn when all of these hold -- the repeat count is
 * real, the pattern is not demoted, its provenance is complete, and the
 * deployment opted in.
 */

import { createHash } from 'node:crypto';

/** Stable short hash used for pattern and slot fingerprints. */
export function hashOf(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** Collect the text of one message's content blocks. */
export function messageText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

const CORRECTION_PATTERN = /^(?:不对|不是|错了|纠正|更正|重来|重新|再看|漏了|no[,. ]|wrong|actually|instead)/i;

/** Whether a user message reads as a correction of the previous answer. */
export function looksLikeCorrection(text) {
  return CORRECTION_PATTERN.test(String(text ?? '').trim());
}

/** Normalize a pattern record, dropping anything malformed. */
export function normalizePattern(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
  const template = typeof raw.template === 'string' && raw.template.trim().length > 0 ? raw.template : null;
  if (id === null || template === null) return null;
  const match = raw.match !== null && typeof raw.match === 'object' ? raw.match : {};
  const provenance = Array.isArray(raw.provenance) ? raw.provenance.filter((item) => item !== null && typeof item === 'object') : [];
  return {
    id,
    version: Number.isFinite(raw.version) ? raw.version : 1,
    match: {
      repeatKey: typeof match.repeatKey === 'string' ? match.repeatKey : null,
      keywords: Array.isArray(match.keywords) ? match.keywords.filter((word) => typeof word === 'string' && word.length > 0) : [],
      allOf: Array.isArray(match.allOf) ? match.allOf.filter((word) => typeof word === 'string' && word.length > 0) : [],
      noneOf: Array.isArray(match.noneOf) ? match.noneOf.filter((word) => typeof word === 'string' && word.length > 0) : [],
      maxChars: Number.isFinite(match.maxChars) ? match.maxChars : 1200,
    },
    template,
    provenance,
    minHits: Number.isFinite(raw.minHits) ? Math.max(1, raw.minHits) : 3,
    minSuccesses: Number.isFinite(raw.minSuccesses) ? Math.max(0, raw.minSuccesses) : 0,
    successes: Number.isFinite(raw.successes) ? raw.successes : 0,
    failures: Number.isFinite(raw.failures) ? raw.failures : 0,
    demotedUntil: Number.isFinite(raw.demotedUntil) ? raw.demotedUntil : 0,
  };
}

/** Parse a patterns file body; a malformed file yields no patterns, never a throw. */
export function parsePatterns(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.patterns) ? parsed.patterns : [];
  return list.map(normalizePattern).filter((pattern) => pattern !== null);
}

/** Whether every fact slot in the template has a provenance record. */
export function provenanceComplete(pattern) {
  const slots = [...String(pattern.template).matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)].map((match) => match[1]);
  const unique = [...new Set(slots)].filter((slot) => !slot.endsWith('.id'));
  const recorded = new Set(pattern.provenance.map((item) => item.slot));
  return unique.every((slot) => recorded.has(slot));
}

/**
 * Decide whether one turn may be answered from a pattern.
 *
 * @returns the matched pattern, or a reason string when nothing is eligible.
 */
export function selectPattern({ text, repeatKey, repeatHits, patterns, now = Date.now(), enabled = false }) {
  if (!enabled) return { hit: null, reason: 'disabled' };
  const body = String(text ?? '');
  if (body.length > 4000) return { hit: null, reason: 'turn-too-large' };
  for (const pattern of patterns) {
    if (pattern.demotedUntil > now) continue;
    const { repeatKey: wantKey, keywords, allOf, noneOf, maxChars } = pattern.match;
    if (wantKey !== null && wantKey !== repeatKey) continue;
    if (body.length > maxChars) continue;
    if (noneOf.some((word) => body.includes(word))) continue;
    if (!allOf.every((word) => body.includes(word))) continue;
    if (keywords.length > 0 && !keywords.some((word) => body.includes(word))) continue;
    if (repeatHits < pattern.minHits) return { hit: null, reason: 'repeat-below-min' };
    if ((pattern.successes ?? 0) < pattern.minSuccesses) return { hit: null, reason: 'success-below-min' };
    if (!provenanceComplete(pattern)) return { hit: null, reason: 'provenance-incomplete' };
    return { hit: pattern, reason: 'matched' };
  }
  return { hit: null, reason: 'no-pattern' };
}

/** Fill `{{slot}}` references; returns null when any slot is missing. */
export function renderPattern(pattern, slots = {}) {
  let missing = null;
  const text = String(pattern.template).replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, slot) => {
    const value = slots[slot];
    if (value === undefined || value === null || String(value).length === 0) {
      missing = slot;
      return '';
    }
    return String(value);
  });
  return missing === null ? text : null;
}

/** Provenance footer appended to every reused answer, so the reader can audit it. */
export function provenanceFooter(pattern) {
  const refs = pattern.provenance.map((item) => `${item.slot}←${item.source}`);
  return `\n\n---\nfastlane reuse: pattern ${pattern.id} v${pattern.version}${refs.length > 0 ? ' · ' + refs.join(' · ') : ''}`;
}
