/**
 * PHASE 6 — Hindi (Devanagari) caption segmentation for vertical Shorts.
 *
 * Pure functions only: no IO, no ffmpeg, no network. The renderer writes the returned ASS/SRT
 * text; the QA layer re-validates the same segments against the portrait safe area.
 *
 * Design rules:
 *   · Split on Devanagari sentence punctuation first (`।`, `?`, `!`), then commas, then words.
 *     A word is NEVER split.
 *   · Captions stay inside a portrait-safe band: 80 px left, 160 px right (platform action rail),
 *     and above the bottom UI (380 px margin), two lines maximum.
 *   · Timing is derived from the narration audio duration proportional to character weight, so a
 *     paused/slow line gets more screen time and nothing is cut mid-sentence.
 */

import crypto from 'node:crypto';
import {
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  type CaptionSegment,
  type CaptionValidation,
  type CaptionValidationIssue,
  type NarrationSegment,
} from './shortsTypes.js';

export const CAPTION_DEFAULTS = {
  fontSize: 56,
  marginLeft: 80,
  marginRight: 160,
  marginBottom: 380,
  maxLines: 2,
  minSeconds: 1.1,
  maxSeconds: 4.5,
  /** Above this reading speed a caption is flagged for review. */
  maxCharsPerSecond: 17,
  /** Line spacing multiplier used for the safe-area height estimate. */
  lineHeightFactor: 1.35,
} as const;

export interface CaptionStyle {
  fontSize: number;
  marginLeft: number;
  marginRight: number;
  marginBottom: number;
  maxLines: number;
  minSeconds: number;
  maxSeconds: number;
  maxCharsPerSecond: number;
  lineHeightFactor: number;
}

export type CaptionStyleInput = Partial<CaptionStyle>;

function style(input?: CaptionStyleInput): CaptionStyle {
  return { ...CAPTION_DEFAULTS, ...(input ?? {}) };
}

const normalize = (text: unknown): string => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Maximum characters that fit on one caption line for this style/width. */
export function maxCharsPerLine(styleInput?: CaptionStyleInput, width = SHORTS_WIDTH): number {
  const s = style(styleInput);
  const usable = width - s.marginLeft - s.marginRight;
  // Devanagari glyph advance is wider than Latin; 0.56em is a conservative estimate.
  return Math.max(12, Math.floor(usable / (s.fontSize * 0.56)));
}

/**
 * Split narration text into caption-sized chunks. Deterministic for the same input.
 */
export function splitCaptionText(text: unknown, styleInput?: CaptionStyleInput, width = SHORTS_WIDTH): string[] {
  const s = style(styleInput);
  const maxChars = maxCharsPerLine(s, width);
  const maxChunk = maxChars * s.maxLines;
  const clean = normalize(text);
  if (!clean) return [];

  // 1. Sentence-ish clauses, keeping the Devanagari danda and Latin terminators.
  const clauses = clean
    .split(/(?<=[।?!])\s+|(?<=[.,;:])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  for (const clause of clauses) {
    if ([...clause].length <= maxChunk) {
      // A clause that fits becomes its own chunk unless it is tiny and can join the previous one.
      if (chunks.length > 0 && [...chunks[chunks.length - 1]].length + 1 + [...clause].length <= maxChunk && [...clause].length < maxChars) {
        chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${clause}`.trim();
      } else {
        chunks.push(clause);
      }
      continue;
    }
    // 2. A long clause is packed word-by-word; a single word is never split.
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) { chunks.push(current.join(' ')); current = []; }
    };
    for (const word of clause.split(/\s+/)) {
      const candidate = current.length ? `${current.join(' ')} ${word}` : word;
      if ([...candidate].length <= maxChunk) {
        current.push(word);
      } else {
        flush();
        // A single token longer than a chunk is kept whole (a word is never split); QA then
        // reports the over-long line instead of the renderer silently mangling the text.
        current = [word];
      }
    }
    flush();
  }
  return chunks.filter((chunk) => normalize(chunk).length > 0);
}

/** Wrap one caption chunk into at most `maxLines` display lines. */
export function wrapCaptionLines(text: string, styleInput?: CaptionStyleInput, width = SHORTS_WIDTH): string[] {
  const s = style(styleInput);
  const maxChars = maxCharsPerLine(s, width);
  const words = normalize(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if ([...candidate].length <= maxChars) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= s.maxLines) return lines;
  // Too many lines: rebalance into exactly maxLines rather than truncating any words.
  const perLine = Math.ceil([...normalize(text)].length / s.maxLines);
  const rebalanced: string[] = [];
  let buffer = '';
  for (const word of words) {
    if ([...`${buffer} ${word}`.trim()].length > perLine && buffer) { rebalanced.push(buffer); buffer = word; }
    else buffer = `${buffer} ${word}`.trim();
  }
  if (buffer) rebalanced.push(buffer);
  return rebalanced;
}

const weight = (text: string): number => Math.max(1, [...text].length);

/**
 * Build ordered caption segments for a Short.
 *
 * `segments` must already carry the timeline window (`start_seconds`/`end_seconds`) of the scene
 * they belong to. Each scene's captions are distributed proportionally inside that window.
 */
export function buildCaptionSegments(
  segments: NarrationSegment[],
  styleInput?: CaptionStyleInput,
  width = SHORTS_WIDTH,
): CaptionSegment[] {
  const s = style(styleInput);
  const ordered = [...segments]
    .filter((segment) => Number.isFinite(segment.start_seconds) && Number.isFinite(segment.end_seconds))
    .sort((a, b) => a.start_seconds - b.start_seconds || a.scene_number - b.scene_number);

  const captions: CaptionSegment[] = [];
  let index = 0;
  for (const segment of ordered) {
    const chunks = splitCaptionText(segment.text, s, width);
    if (chunks.length === 0) continue;
    const windowStart = Math.max(0, segment.start_seconds);
    const windowEnd = Math.max(windowStart + 0.2, segment.end_seconds);
    const totalChars = chunks.reduce((sum, chunk) => sum + weight(chunk), 0);
    let cursor = windowStart;
    // Minimum duration may not fit every chunk; merge the smallest tail chunks deterministically.
    const minTotal = chunks.length * s.minSeconds;
    let effective = chunks;
    if (windowEnd - windowStart < minTotal) {
      const keep = Math.max(1, Math.floor((windowEnd - windowStart) / s.minSeconds));
      if (keep < chunks.length) {
        // Distribute the text across `keep` merged chunks (never lose text).
        const merged: string[] = [];
        const perChunk = Math.ceil(chunks.length / keep);
        for (let i = 0; i < chunks.length; i += perChunk) merged.push(chunks.slice(i, i + perChunk).join(' '));
        effective = merged;
      }
    }
    const effectiveChars = effective.reduce((sum, chunk) => sum + weight(chunk), 0);
    for (let i = 0; i < effective.length; i += 1) {
      const chunk = effective[i];
      const share = (windowEnd - windowStart) * (weight(chunk) / Math.max(1, effectiveChars));
      const clamped = Math.min(s.maxSeconds, Math.max(s.minSeconds, share));
      const start = cursor;
      const end = i === effective.length - 1 ? windowEnd : Math.min(windowEnd, start + clamped);
      captions.push({
        index,
        scene_number: segment.scene_number,
        text: chunk,
        lines: wrapCaptionLines(chunk, s, width),
        start_seconds: Number(start.toFixed(3)),
        end_seconds: Number(Math.max(start + 0.2, end).toFixed(3)),
      });
      index += 1;
      cursor = end;
      if (cursor >= windowEnd) break;
    }
  }
  return captions;
}

/** Validate ordering, timing, readability and the portrait safe area. */
export function validateCaptions(
  captions: CaptionSegment[],
  opts: { style?: CaptionStyleInput; width?: number; height?: number; durationSeconds?: number | null } = {},
): CaptionValidation {
  const s = style(opts.style);
  const width = opts.width ?? SHORTS_WIDTH;
  const height = opts.height ?? SHORTS_HEIGHT;
  const issues: CaptionValidationIssue[] = [];
  let checks = 0;

  const maxChars = maxCharsPerLine(s, width);
  const bandTop = height - s.marginBottom - (s.maxLines * s.fontSize * s.lineHeightFactor);
  const safeTop = 160;
  const safeBottom = height - 320;

  if (bandTop < safeTop) {
    issues.push({ code: 'caption.safe_area_vertical', severity: 'FAIL', detail: `caption band starts at ${Math.round(bandTop)}px, inside the ${safeTop}px top safe margin` });
  }
  if (bottomOfBand(s, height) > safeBottom) {
    issues.push({ code: 'caption.safe_area_bottom', severity: 'FAIL', detail: `caption band ends at ${Math.round(bottomOfBand(s, height))}px, below the ${safeBottom}px bottom safe margin` });
  }

  if (captions.length === 0) {
    issues.push({ code: 'caption.empty', severity: 'FAIL', detail: 'no caption segments were produced for a narrated Short' });
    return { status: 'FAIL', issues, checks };
  }

  let previousEnd = -1;
  for (const caption of captions) {
    checks += 1;
    const tag = caption.index;
    if (!(caption.start_seconds >= 0) || !(caption.end_seconds > caption.start_seconds)) {
      issues.push({ code: 'caption.timing', severity: 'FAIL', detail: `caption ${tag} has an invalid window`, segment_index: tag });
    }
    if (caption.start_seconds < previousEnd - 0.05) {
      issues.push({ code: 'caption.overlap', severity: 'FAIL', detail: `caption ${tag} overlaps the previous caption`, segment_index: tag });
    }
    previousEnd = Math.max(previousEnd, caption.end_seconds);

    const lines = caption.lines.length > 0 ? caption.lines : wrapCaptionLines(caption.text, s, width);
    if (lines.length > s.maxLines) {
      issues.push({ code: 'caption.lines', severity: 'FAIL', detail: `caption ${tag} needs ${lines.length} lines (max ${s.maxLines})`, segment_index: tag });
    }
    for (const line of lines) {
      if ([...line].length > maxChars) {
        issues.push({ code: 'caption.line_length', severity: 'FAIL', detail: `caption ${tag} line is ${[...line].length} chars (max ${maxChars})`, segment_index: tag });
        break;
      }
    }
    const seconds = Math.max(0.001, caption.end_seconds - caption.start_seconds);
    const chars = [...caption.text].length;
    if (chars / seconds > s.maxCharsPerSecond) {
      issues.push({ code: 'caption.reading_speed', severity: 'WARNING', detail: `caption ${tag} runs at ${(chars / seconds).toFixed(1)} chars/s (max ${s.maxCharsPerSecond})`, segment_index: tag });
    }
  }

  if (typeof opts.durationSeconds === 'number' && Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0) {
    checks += 1;
    const last = captions[captions.length - 1];
    if (last.end_seconds > opts.durationSeconds + 0.25) {
      issues.push({ code: 'caption.beyond_media', severity: 'FAIL', detail: `the last caption ends at ${last.end_seconds.toFixed(2)}s but the media is ${opts.durationSeconds.toFixed(2)}s` });
    }
  }

  const status = issues.some((issue) => issue.severity === 'FAIL')
    ? 'FAIL'
    : issues.length > 0 ? 'WARNING' : 'PASS';
  return { status, issues, checks };
}

function bottomOfBand(s: CaptionStyle, height: number): number {
  // With Alignment=2 the text block bottom sits `marginBottom` above the frame bottom.
  return height - s.marginBottom;
}

/** Escape text for an ASS Dialogue line. */
function assEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, (char) => `\\${char}`).replace(/\r?\n/g, '\\N');
}

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * Build the ASS subtitle file burned into the portrait render.
 * Fonts resolve through fontconfig; no machine-specific font directory is embedded.
 */
export function buildAssFile(captions: CaptionSegment[], styleInput?: CaptionStyleInput, width = SHORTS_WIDTH, height = SHORTS_HEIGHT): string {
  const s = style(styleInput);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: ShortCaption,Noto Sans Devanagari,${s.fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0.4,0,1,3.2,1.6,2,${s.marginLeft},${s.marginRight},${s.marginBottom},1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];
  const events = captions.map((caption) => {
    const lines = caption.lines.length > 0 ? caption.lines : [caption.text];
    const text = lines.map(assEscape).join('\\N');
    return `Dialogue: 0,${assTime(caption.start_seconds)},${assTime(caption.end_seconds)},ShortCaption,,0,0,0,,{\\fad(120,120)}${text}`;
  });
  return `${header.concat(events).join('\n')}\n`;
}

function srtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Build a portable SRT track (stored beside the Short for review/upload metadata). */
export function buildSrtFile(captions: CaptionSegment[]): string {
  return captions
    .map((caption, i) => `${i + 1}\n${srtTime(caption.start_seconds)} --> ${srtTime(caption.end_seconds)}\n${caption.text}\n`)
    .join('\n');
}

/** Stable hash of the caption track (part of the Short render key). */
export function captionHash(captions: CaptionSegment[]): string {
  const canonical = captions.map((caption) => [
    caption.index,
    caption.scene_number,
    caption.start_seconds.toFixed(3),
    caption.end_seconds.toFixed(3),
    caption.text,
  ].join('|')).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
