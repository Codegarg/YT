/**
 * Real pipeline → scene composition planner (STEP-8DA).
 *
 * Turns an existing pipeline scene record into a deterministic SceneCompositionPlan for the
 * local renderer. This module is a PLANNING layer only:
 *   · it never renders
 *   · it never writes to pipeline.json or any file
 *   · it never requires a background/character FILE to exist
 *   · it never invents a production duration
 *   · it never contacts Flow
 *
 * It is browser-independent and pure (input objects in, plan objects out). It reuses the
 * existing `CharacterPlacement` type and the existing `motionFromSceneText()` helper — no
 * duplicated motion algorithm and no duplicated placement type.
 */
import { motionFromSceneText, type SceneMotion } from './sceneRender.js';
import type { CharacterPlacement } from './characterComposite.js';

/** Known background/character tags are supplied by the caller (from pipeline.json). */
export interface PlannerKnownTags {
  backgrounds: readonly string[];
  characters: readonly string[];
}

/** A requirement is a demand for an asset — NOT a claim that the asset exists. */
export interface BackgroundRequirement {
  tag: string | null;
  required: true;
  state: 'REQUIRED' | 'BACKGROUND_ASSET_TAG_MISSING' | 'BACKGROUND_ASSET_TAG_INVALID' | 'BACKGROUND_ASSET_UNKNOWN';
}

export interface CharacterRequirement {
  tag: string;
  required: true;
  /** PLANNING state — real assets do not exist yet, so this is never CHARACTER_ASSET_HIT. */
  assetState: 'REQUIRED' | 'CHARACTER_TAG_MISSING' | 'CHARACTER_TAG_INVALID' | 'CHARACTER_TAG_UNKNOWN' | 'CHARACTER_TAG_DUPLICATE';
}

export type NarrationKind = 'NARRATOR_ONLY' | 'DIALOGUE' | 'MIXED' | 'SILENT';

export type DurationSource = 'pipeline' | 'narration' | 'flow-clip' | 'unresolved';

export type ScenePlanStatus = 'READY_FOR_RENDER' | 'REQUIRES_CHARACTER_ASSETS' | 'REQUIRES_DURATION' | 'INVALID_SCENE';

export type PositionSource = 'deterministic-fallback' | 'none';

export interface SceneCompositionPlan {
  sceneNumber: number;
  title: string;
  background: BackgroundRequirement;
  characters: CharacterRequirement[];
  /** Deterministic placements (fallback layout); empty when the scene has no characters. */
  placements: CharacterPlacement[];
  positionSource: PositionSource;
  motion: SceneMotion | null;
  motionSource: string[];
  durationSeconds: number | null;
  durationSource: DurationSource;
  narration: NarrationKind;
  requiresNarration: boolean;
  status: ScenePlanStatus;
  reasons: string[];
}

/** Deterministic fallback placement layout markers (NOT Flow's original composition). */
export const FALLBACK_LAYOUT = {
  heightFraction: 0.8,
  baselineY: 0.9,
  xBands: { one: [0.5], two: [0.28, 0.72], three: [0.2, 0.5, 0.8], many: [0.12, 0.36, 0.64, 0.88] },
} as const;

const TAG_PATTERN = /^[@#][A-Za-z0-9][A-Za-z0-9-]*$/;
const MOTION_NEUTRAL: SceneMotion = 'STATIC';

/** Deterministic fallback layout from the character count. Documented, reproducible. */
export function fallbackLayout(count: number, width: number, height: number): CharacterPlacement[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const h = Math.round(height * FALLBACK_LAYOUT.heightFraction);
  const y = Math.round(height * FALLBACK_LAYOUT.baselineY - h);
  const w = Math.round(h * 0.7);
  const bands = count === 1 ? FALLBACK_LAYOUT.xBands.one
    : count === 2 ? FALLBACK_LAYOUT.xBands.two
    : count === 3 ? FALLBACK_LAYOUT.xBands.three
    : FALLBACK_LAYOUT.xBands.many;
  const out: CharacterPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const frac = bands[i] ?? bands[bands.length - 1];
    out.push({ characterTag: '', assetPath: '', x: Math.max(0, Math.round(width * frac - w / 2)), y: Math.max(0, y), width: w, height: h, zIndex: i });
  }
  return out;
}

/** Classify narration/dialogue from multiple fields (never a single signal). */
export function classifyNarration(scene: any): NarrationKind {
  const hasNarration = !!(scene?.narration_text && String(scene.narration_text).trim());
  const hasDialogue = !!(scene?.devanagari_dialogue && String(scene.devanagari_dialogue).trim());
  const speaker = String(scene?.speaker ?? '').trim();
  const speakerIsNarrator = /^narrator$/i.test(speaker);
  const speakerIsNobody = speaker === '' || /^(none|null)$/i.test(speaker);
  const speakerIsCharacter = !!speaker && !speakerIsNarrator && !speakerIsNobody;

  if (hasNarration && hasDialogue) return 'MIXED';
  if (hasDialogue && (speakerIsCharacter || !speakerIsNarrator)) return 'DIALOGUE';
  if (hasNarration && (speakerIsNarrator || speakerIsNobody)) return 'NARRATOR_ONLY';
  if (hasNarration) return 'MIXED';
  if (speakerIsNarrator || speakerIsCharacter) return 'DIALOGUE';
  return 'SILENT';
}

/** Whether narration audio is required for this scene (per the AGENTS.md narration contract). */
export function requiresNarrationAudio(scene: any, narration: NarrationKind): boolean {
  const explicit = scene?.animation_prompt_NARRATOR_ONLY;
  const narratorPrompt = typeof explicit === 'string' && /No voice synthesis|Narrator voiceover will be layered/i.test(explicit);
  return narration === 'NARRATOR_ONLY' || narration === 'MIXED' || (narration === 'DIALOGUE' && narratorPrompt && !!(scene?.narration_text && String(scene.narration_text).trim()));
}

/**
 * Build a deterministic composition plan for ONE pipeline scene.
 * Never mutates the input. Never invents durations. Preserves ALL failure reasons.
 */
export function planScene(scene: any, known: PlannerKnownTags, options: { width?: number; height?: number } = {}): SceneCompositionPlan {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const reasons: string[] = [];

  const n = Number(scene?.scene_number);
  const title = String(scene?.title ?? '');
  const invalidScene = !Number.isInteger(n) || n <= 0;

  // ---- background requirement ----
  const bgTagRaw = scene?.background_tag;
  let background: BackgroundRequirement;
  if (bgTagRaw === undefined || bgTagRaw === null || String(bgTagRaw).trim() === '') {
    background = { tag: null, required: true, state: 'BACKGROUND_ASSET_TAG_MISSING' };
    reasons.push('BACKGROUND_ASSET_TAG_MISSING');
  } else {
    const tag = String(bgTagRaw).trim();
    if (!TAG_PATTERN.test(tag)) { background = { tag, required: true, state: 'BACKGROUND_ASSET_TAG_INVALID' }; reasons.push(`BACKGROUND_ASSET_TAG_INVALID:${tag}`); }
    else if (!known.backgrounds.includes(tag)) { background = { tag, required: true, state: 'BACKGROUND_ASSET_UNKNOWN' }; reasons.push(`BACKGROUND_ASSET_UNKNOWN:${tag}`); }
    else background = { tag, required: true, state: 'REQUIRED' };
  }

  // ---- character requirements (fail closed on unknown/malformed/duplicate) ----
  const rawChars = Array.isArray(scene?.character_tags) ? scene.character_tags : [];
  const characters: CharacterRequirement[] = [];
  const seen = new Set<string>();
  for (const raw of rawChars) {
    const tag = String(raw ?? '').trim();
    if (!tag) { characters.push({ tag: '', required: true, assetState: 'CHARACTER_TAG_MISSING' }); reasons.push('CHARACTER_TAG_MISSING'); continue; }
    if (!TAG_PATTERN.test(tag)) { characters.push({ tag, required: true, assetState: 'CHARACTER_TAG_INVALID' }); reasons.push(`CHARACTER_TAG_INVALID:${tag}`); continue; }
    if (seen.has(tag)) { characters.push({ tag, required: true, assetState: 'CHARACTER_TAG_DUPLICATE' }); reasons.push(`CHARACTER_TAG_DUPLICATE:${tag}`); continue; }
    seen.add(tag);
    if (!known.characters.includes(tag)) { characters.push({ tag, required: true, assetState: 'CHARACTER_TAG_UNKNOWN' }); reasons.push(`CHARACTER_TAG_UNKNOWN:${tag}`); continue; }
    characters.push({ tag, required: true, assetState: 'REQUIRED' });
    reasons.push(`CHARACTER_ASSET_REQUIRED:${tag}`);
  }

  // ---- deterministic fallback placements (only for valid, known tags) ----
  const placeable = characters.filter((c) => c.assetState === 'REQUIRED');
  const layout = fallbackLayout(placeable.length, width, height);
  const placements: CharacterPlacement[] = layout.map((p, i) => ({ ...p, characterTag: placeable[i].tag }));

  // ---- motion (existing helper only; no new algorithm) ----
  const motionSource = ['camera', 'visual_action', 'effects'];
  const motionText = [scene?.camera, scene?.visual_action, scene?.effects].filter(Boolean).join(' ');
  let motion: SceneMotion | null = null;
  if (motionText.trim()) {
    motion = motionFromSceneText(motionText);
    if (!motion) { motion = null; reasons.push('MOTION_UNRESOLVED'); }
  } else {
    reasons.push('MOTION_UNRESOLVED');
  }

  // ---- duration (authoritative only; never invented) ----
  const clip = scene?.clip_length_seconds;
  const edit = scene?.edit_length_seconds;
  let durationSeconds: number | null = null;
  let durationSource: DurationSource = 'unresolved';
  const numeric = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const flowClip = numeric(clip);
  const editLen = numeric(edit);
  if (flowClip !== null) { durationSeconds = flowClip; durationSource = 'flow-clip'; }
  else if (editLen !== null) { durationSeconds = editLen; durationSource = 'pipeline'; }
  if (durationSeconds === null) reasons.push('DURATION_UNRESOLVED');

  // ---- narration ----
  const narration = classifyNarration(scene);
  const requiresNarration = requiresNarrationAudio(scene, narration);

  // ---- status (precedence: invalid > needs character assets > needs duration).
  // ALL reasons are preserved in `reasons` regardless of which status wins.
  let status: ScenePlanStatus;
  if (invalidScene) { status = 'INVALID_SCENE'; reasons.unshift('INVALID_SCENE'); }
  else if (background.state !== 'REQUIRED') status = 'INVALID_SCENE';
  else if (characters.some((c) => c.assetState !== 'REQUIRED')) status = 'INVALID_SCENE';
  else if (characters.length > 0) status = 'REQUIRES_CHARACTER_ASSETS';
  else status = 'REQUIRES_DURATION';

  return {
    sceneNumber: Number.isInteger(n) ? n : 0,
    title,
    background,
    characters,
    placements,
    positionSource: placements.length > 0 ? 'deterministic-fallback' : 'none',
    motion,
    motionSource,
    durationSeconds,
    durationSource,
    narration,
    requiresNarration,
    status,
    reasons: [...new Set(reasons)],
  };
}

/** Plan every scene. Preserves input order; never mutates the input pipeline. */
export function planPipeline(pipeline: any, options: { width?: number; height?: number } = {}): SceneCompositionPlan[] {
  const known: PlannerKnownTags = {
    backgrounds: (pipeline?.backgrounds ?? []).map((b: any) => String(b?.tag ?? '')),
    characters: (pipeline?.characters ?? []).map((c: any) => String(c?.tag ?? '')),
  };
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  return scenes.map((s: any) => planScene(s, known, options));
}

/** Compact summary of a plan set (counts used by the audit report). */
export function summarizePlans(plans: readonly SceneCompositionPlan[]) {
  const count = (fn: (p: SceneCompositionPlan) => boolean) => plans.filter(fn).length;
  const tally = <T extends string>(items: T[]) => items.reduce<Record<string, number>>((m, k) => { m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return {
    total: plans.length,
    ready: count((p) => p.status === 'READY_FOR_RENDER'),
    requiresCharacterAssets: count((p) => p.status === 'REQUIRES_CHARACTER_ASSETS'),
    requiresDuration: count((p) => p.status === 'REQUIRES_DURATION'),
    invalid: count((p) => p.status === 'INVALID_SCENE'),
    unknownBackgrounds: count((p) => p.background.state !== 'REQUIRED'),
    unknownCharacters: count((p) => p.characters.some((c) => c.assetState !== 'REQUIRED')),
    narratorOnly: count((p) => p.narration === 'NARRATOR_ONLY'),
    dialogue: count((p) => p.narration === 'DIALOGUE'),
    mixed: count((p) => p.narration === 'MIXED'),
    silent: count((p) => p.narration === 'SILENT'),
    uniqueCharacters: [...new Set(plans.flatMap((p) => p.characters.map((c) => c.tag)))].filter(Boolean).sort(),
    uniqueBackgrounds: [...new Set(plans.map((p) => p.background.tag))].filter(Boolean).sort() as string[],
    motion: tally(plans.map((p) => p.motion ?? 'MOTION_UNRESOLVED')),
    duration: tally(plans.map((p) => p.durationSource)),
    statuses: tally(plans.map((p) => p.status)),
  };
}
