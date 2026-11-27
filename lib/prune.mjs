/**
 * Deterministic pruning for the L3 layer.
 *
 * No model, no summary: rules decide, code points are counted, and anything
 * that could be needed verbatim (errors, stack traces, paths, commands) is
 * excluded before a candidate is even considered. Every replacement keeps the
 * original event addressable through the shadowed seq, so replay stays exact.
 */

/** Marker inserted where text was removed; `{{removed}}` is filled with the count. */
export const PRUNE_MARKER = '\n…[fastlane pruned {{removed}} chars]…\n';

/** Count Unicode code points, matching the kernel pruner's unit. */
export function codePointLength(text) {
  return Array.from(String(text ?? '')).length;
}

/** Total text length of a content block array (non-text blocks cost zero). */
export function measureBlocks(blocks) {
  let chars = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += codePointLength(block.text);
  }
  return chars;
}

/** Join the text blocks of a content array. */
export function textOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

const ERROR_PATTERN = /(?:^|\n)\s*(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|Exception|Traceback|panic:|fatal:|FAIL|失败|错误)/;
// Exit codes and tool-error ids can appear mid-line ("Command failed: … exit
// code: 1"), so they are matched anywhere in the text, not only at line start.
const EXIT_CODE_PATTERN = /\bexit code: [1-9]\d*/;
const TOOL_ERROR_PATTERN = /\b(?:npm )?ERR_[A-Z_]+\b/;
const STACK_PATTERN = /^\s*at\s+[\w$.<>]+(?:\s+\(|\s*$)/;
const TIMESTAMP_PATTERN = /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const HEX_PATTERN = /^\s*(?:0x)?[0-9a-f]{8,}\b/i;
const PROGRESS_PATTERN = /^\s*(?:\d{1,3}%|\[\s*\d+%\]|progress[: ])/i;
// Real tool output rarely starts with the id: `000123 0x00ab12cd build ok
// elapsed 45ms` and `done in 1.20s, 12.5 MB` are machine output all the same.
const INDEX_COLUMN_PATTERN = /^\s*\d{3,}\s/;
const INLINE_HEX_PATTERN = /\b0x[0-9a-f]{4,}\b/i;
const MEASURE_PATTERN = /\b\d+(?:\.\d+)?\s*(?:ms|µs|us|ns|s|KiB|MiB|GiB|KB|MB|GB|bytes?)\b/;

/** Content that must survive verbatim: errors and stack traces. */
export function isProtected(text) {
  const body = String(text ?? '');
  return ERROR_PATTERN.test(body)
    || EXIT_CODE_PATTERN.test(body)
    || TOOL_ERROR_PATTERN.test(body)
    || STACK_PATTERN.test(body.split('\n').slice(0, 40).join('\n'));
}

/**
 * Whether text reads like machine output rather than prose: at least three
 * lines, and most of them look like timestamps, hex ids, stack frames,
 * progress lines, or literal duplicates.
 */
export function looksLikeMachineOutput(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length < 3) return false;
  let machine = 0;
  let counted = 0;
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    counted += 1;
    if (seen.has(trimmed)) machine += 1;
    else {
      seen.add(trimmed);
      if (TIMESTAMP_PATTERN.test(trimmed)
        || HEX_PATTERN.test(trimmed)
        || STACK_PATTERN.test(trimmed)
        || PROGRESS_PATTERN.test(trimmed)
        || INDEX_COLUMN_PATTERN.test(trimmed)
        || INLINE_HEX_PATTERN.test(trimmed)) machine += 1;
      else if (MEASURE_PATTERN.test(trimmed) && /\d/.test(trimmed)) machine += 1;
    }
  }
  if (counted < 3) return false;
  return machine / counted >= 0.6;
}

function renderMarker(removed) {
  return PRUNE_MARKER.replace('{{removed}}', String(removed));
}

/**
 * Replace the middle of oversized content with head + marker + tail.
 *
 * Slicing is per code point across the whole content (not per block), exactly
 * like the kernel pruner, so retained boundaries cannot split a surrogate pair
 * and non-text blocks keep their order.
 *
 * @returns pruned blocks, or null when the content is within budget.
 */
export function pruneBlocks(blocks, { thresholdChars = 8192, headChars = 4096, tailChars = 1024 } = {}) {
  const total = measureBlocks(blocks);
  if (total <= thresholdChars) return null;
  const removedStart = Math.max(0, headChars);
  const removedEnd = Math.max(removedStart, total - tailChars);
  if (removedEnd <= removedStart) return null;
  const removed = removedEnd - removedStart;
  const marker = renderMarker(removed);
  const pruned = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type !== 'text') {
      pruned.push(block);
      continue;
    }
    const points = Array.from(block.text);
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const here = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? marker : '';
    if (here.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + here + points.slice(tailStart).join('');
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) return null;
  const after = measureBlocks(pruned);
  if (after >= total) return null;
  return { blocks: pruned, removed, charsBefore: total, charsAfter: after };
}

/** One-line replacement for a tool result whose content an earlier result already carried. */
export function duplicateLine(refSeq) {
  return `[fastlane: 与 #${refSeq} 内容相同，已省略；需要时按 seq 回放]`;
}
