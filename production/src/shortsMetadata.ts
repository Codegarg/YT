/**
 * PHASE 6 — independent YouTube Shorts metadata.
 *
 * Every Short ships with its OWN title, description, hashtags, tags, language, category, parent
 * reference and cover frame. Nothing is copied from the long-form `youtube-metadata.json`, and the
 * long-form metadata file is never read or written here — the parent story is referenced by id and
 * title only.
 *
 * Pure: no IO, no network, no model call. `metadata_hash` binds the render key / approval to the
 * exact metadata object so a metadata edit invalidates only that Short.
 */

import crypto from 'node:crypto';
import type { ShortMetadata } from './shortsTypes.js';

export interface ShortMetadataInput {
  projectId: string;
  shortId: string;
  index: number;
  title: string;
  hookText: string;
  payoffText: string;
  sceneTitles: string[];
  keywords: string[];
  parentTitle: string | null;
  estimatedDurationSeconds: number;
  hookSceneNumber: number;
}

/** YouTube Shorts category id used for the Hindi horror/entertainment shelf. */
export const SHORT_CATEGORY = 'Entertainment';
/** Fixed, non-spammy discovery tags. Order is stable so the hash is stable. */
const BASE_HASHTAGS = ['#shorts', '#horrorstories', '#hindikahani'] as const;
const MAX_HASHTAGS = 6;
const MAX_TAGS = 14;
const MAX_DESCRIPTION_CHARS = 480;

const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Deduplicate while preserving first-seen order (deterministic). */
function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Turn a Devanagari keyword into a hashtag body (spaces/punctuation removed). */
function hashtagFor(keyword: string): string | null {
  const body = normalize(keyword).replace(/[^\p{L}\p{N}]/gu, '');
  if ([...body].length < 3 || [...body].length > 24) return null;
  return `#${body}`;
}

/**
 * Choose the cover frame deterministically.
 *
 * The cover sits in the late-arc payoff window (≈62% into the Short) because the opening seconds
 * still carry the hook text caption, and a payoff frame reads better as a static thumbnail.
 */
export function chooseCoverFrame(estimatedDurationSeconds: number): { frame_seconds: number; reason: string } {
  const duration = Number.isFinite(estimatedDurationSeconds) && estimatedDurationSeconds > 0
    ? estimatedDurationSeconds
    : 12;
  const raw = duration * 0.62;
  const frame = Math.max(0.5, Math.min(Math.max(0.5, duration - 0.5), raw));
  return {
    frame_seconds: Number(frame.toFixed(2)),
    reason: 'late-arc payoff window; independent of the long-form thumbnail',
  };
}

/** Canonical hash over every metadata field except `metadata_hash` itself. */
export function shortMetadataHash(metadata: Omit<ShortMetadata, 'metadata_hash'>): string {
  const canonical = {
    title: metadata.title,
    description: metadata.description,
    hashtags: metadata.hashtags,
    tags: metadata.tags,
    language: metadata.language,
    category: metadata.category,
    parent_story: metadata.parent_story,
    thumbnail: metadata.thumbnail,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Build a complete, self-contained metadata record for one Short. */
export function buildShortMetadata(input: ShortMetadataInput): ShortMetadata {
  const projectId = normalize(input.projectId);
  if (!projectId) throw new Error('buildShortMetadata requires a project id.');
  const shortId = normalize(input.shortId);
  if (!shortId) throw new Error('buildShortMetadata requires a short id.');

  const hook = normalize(input.hookText);
  const payoff = normalize(input.payoffText);
  const parentTitle = input.parentTitle ? normalize(input.parentTitle) : null;

  // Title: the planner proposed one; keep it verbatim so the plan and metadata cannot drift.
  const title = clip(normalize(input.title) || (parentTitle ? `${parentTitle} — भाग ${input.index}` : `कहानी का भाग ${input.index}`), 70);

  const hashtags = uniq([
    ...BASE_HASHTAGS,
    ...input.keywords.map(hashtagFor).filter((value): value is string => Boolean(value)),
  ]).slice(0, MAX_HASHTAGS);

  const descriptionParts: string[] = [];
  if (hook) descriptionParts.push(clip(hook, 180));
  if (payoff && payoff !== hook) descriptionParts.push(clip(payoff, 180));
  descriptionParts.push(`पूरी कहानी: ${parentTitle ?? 'रात का खौफ'} (मूल वीडियो)।`);
  descriptionParts.push(hashtags.join(' '));
  const description = clip(descriptionParts.filter(Boolean).join('\n\n'), MAX_DESCRIPTION_CHARS);

  const tags = uniq([
    'hindi horror story',
    'short horror',
    'devanagari',
    ...hashtags.map((hashtag) => hashtag.replace(/^#/, '')),
    ...input.keywords,
    ...input.sceneTitles,
  ])
    .filter((tag) => [...tag].length >= 3)
    .slice(0, MAX_TAGS);

  const withoutHash: Omit<ShortMetadata, 'metadata_hash'> = {
    title,
    description,
    hashtags,
    tags,
    language: 'hi',
    category: SHORT_CATEGORY,
    parent_story: { project_id: projectId, title: parentTitle },
    thumbnail: chooseCoverFrame(input.estimatedDurationSeconds),
  };

  return { ...withoutHash, metadata_hash: shortMetadataHash(withoutHash) };
}

/** Validate a metadata record produced by `buildShortMetadata` (or loaded from disk). */
export function validateShortMetadata(metadata: unknown, expected?: { projectId?: string; shortId?: string }): { ok: true; metadata: ShortMetadata } | { ok: false; reason: string } {
  const value = metadata as Partial<ShortMetadata> | null | undefined;
  if (!value || typeof value !== 'object') return { ok: false, reason: 'metadata is not an object' };
  if (typeof value.title !== 'string' || !value.title.trim()) return { ok: false, reason: 'metadata.title is missing' };
  if (typeof value.description !== 'string' || !value.description.trim()) return { ok: false, reason: 'metadata.description is missing' };
  if (!Array.isArray(value.hashtags) || value.hashtags.length === 0) return { ok: false, reason: 'metadata.hashtags is empty' };
  if (!Array.isArray(value.tags)) return { ok: false, reason: 'metadata.tags is not an array' };
  if (value.language !== 'hi') return { ok: false, reason: `metadata.language must be "hi", got ${JSON.stringify(value.language)}` };
  if (typeof value.category !== 'string' || !value.category.trim()) return { ok: false, reason: 'metadata.category is missing' };
  if (!value.parent_story || typeof value.parent_story.project_id !== 'string' || !value.parent_story.project_id) {
    return { ok: false, reason: 'metadata.parent_story.project_id is missing' };
  }
  if (expected?.projectId && value.parent_story.project_id !== expected.projectId) {
    return { ok: false, reason: `metadata belongs to ${value.parent_story.project_id}, not ${expected.projectId}` };
  }
  if (!value.thumbnail || !Number.isFinite(value.thumbnail.frame_seconds) || (value.thumbnail.frame_seconds as number) < 0) {
    return { ok: false, reason: 'metadata.thumbnail.frame_seconds is invalid' };
  }
  const recomputed = shortMetadataHash(value as Omit<ShortMetadata, 'metadata_hash'>);
  if (value.metadata_hash !== recomputed) {
    return { ok: false, reason: 'metadata_hash does not match the metadata contents' };
  }
  void expected?.shortId;
  return { ok: true, metadata: value as ShortMetadata };
}
