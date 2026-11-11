/**
 * PHASE 6 — deterministic Shorts planning.
 *
 * Derives 2–3 standalone vertical Shorts from a validated long-form story. This is a PURE
 * planning layer: it reads only the pipeline document and caller-supplied duration evidence, and
 * it never writes, never touches the long-form pipeline, and never calls a model.
 *
 * Narrative selection is score-based, not positional:
 *   · every contiguous 3–6 scene window is scored for hook strength, escalation and payoff;
 *   · self-containment penalises an arc whose protagonist is never introduced inside it;
 *   · the highest-scoring non-overlapping arcs are selected and then ordered by story position.
 *
 * The result is stable for the same inputs (sorted scoring + deterministic tie-breaks), so an
 * unchanged story re-plans to the same Short IDs and the same plan hash.
 */

import crypto from 'node:crypto';
import {
  SHORTS_SCHEMA_VERSION,
  SHORTS_WIDTH,
  SHORTS_HEIGHT,
  SHORTS_FPS,
  SHORTS_MIN_SECONDS,
  SHORTS_MAX_SECONDS,
  SHORTS_WARN_SECONDS,
  type CaptionSegment,
  type NarrationSegment,
  type ShortCoherence,
  type ShortCoherenceCheck,
  type ShortCompositionRequirement,
  type ShortPlan,
  type ShortsPlanFile,
} from './shortsTypes.js';
import { buildCaptionSegments, splitCaptionText } from './shortsCaptions.js';
import { buildShortMetadata } from './shortsMetadata.js';

/** Devanagari hook cues. Matched literally (no NLP) so selection stays explainable. */
export const HOOK_MARKERS = [
  'आवाज़', 'आवाज', 'खून', 'मौत', 'भूत', 'रात', 'दरवाज़ा', 'दरवाजा', 'कुआं', 'कुँआ', 'श्राप', 'आत्मा',
  'चीख', 'साया', 'अंधेरा', 'डर', 'कौन', 'क्यों', 'क्या', 'मदद', 'बचाओ', 'पीछे', 'देखा', 'सुना', 'रोशनी', 'बंद',
] as const;

/** Devanagari payoff/resolution cues. */
export const PAYOFF_MARKERS = [
  'सच', 'रहस्य', 'पता', 'अंत', 'खत्म', 'बंद', 'भाग', 'मर', 'समझ', 'फिर', 'अब', 'निकल', 'छोड़', 'वापस',
  'मिला', 'दिखा', 'खुल', 'बुझ', 'शांत', 'आज़ाद', 'आजाद',
] as const;

/** Cliffhanger cues: an unresolved question at the end of the arc. */
export const CLIFFHANGER_MARKERS = ['कौन', 'क्या', 'क्यों', 'कहाँ', 'कब', 'अभी', 'शायद', 'लगता'] as const;

export interface SceneSummary {
  sceneNumber: number;
  title: string;
  speaker: string;
  narration: string;
  dialogue: string;
  visualAction: string;
  soundDesign: string;
  camera: string;
  effects: string;
  characterTags: string[];
  backgroundTag: string;
  text: string;
}

export interface PlanOptions {
  projectId: string;
  pipeline: any;
  /** 2 or 3. Defaults to 3 (clamped to what the story can support). */
  count?: number;
  /** Measured scene-clip durations (scene number → seconds). */
  sceneDurations?: Record<number, number> | null;
  /** Measured narration audio durations (scene number → seconds). */
  narrationDurations?: Record<number, number> | null;
  /** Resolved narration files (scene number → project-relative path). */
  narrationFiles?: Record<number, string> | null;
  now?: string;
}

const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
const charCount = (value: string): number => [...value].length;
const endsWithQuestion = (value: string): boolean => /[?]\s*$/.test(value) || /(?:कौन|क्या|क्यों|कहाँ)\s*$/u.test(value);

function markerHits(text: string, markers: readonly string[]): number {
  let hits = 0;
  for (const marker of markers) if (text.includes(marker)) hits += 1;
  return hits;
}

/** Normalise a pipeline scene into the planning view (never mutates the source). */
export function summarizeScene(scene: any): SceneSummary {
  const narration = normalize(scene?.narration_text);
  const dialogue = normalize(scene?.devanagari_dialogue);
  const tags = Array.isArray(scene?.character_tags)
    ? scene.character_tags
    : Array.isArray(scene?.assets?.character_tags) ? scene.assets.character_tags : [];
  return {
    sceneNumber: Number(scene?.scene_number),
    title: normalize(scene?.title),
    speaker: normalize(scene?.speaker).toUpperCase(),
    narration,
    dialogue,
    visualAction: normalize(scene?.visual_action),
    soundDesign: normalize(scene?.sound_design),
    camera: normalize(scene?.camera),
    effects: normalize(scene?.effects),
    characterTags: tags.map((tag: unknown) => normalize(tag)).filter(Boolean),
    backgroundTag: normalize(scene?.background_tag ?? scene?.assets?.background_tag),
    text: narration || dialogue,
  };
}

export function summarizeScenes(pipeline: any): SceneSummary[] {
  const scenes = Array.isArray(pipeline?.scenes) ? pipeline.scenes : [];
  return scenes
    .map(summarizeScene)
    .filter((scene: SceneSummary) => Number.isInteger(scene.sceneNumber))
    .sort((a: SceneSummary, b: SceneSummary) => a.sceneNumber - b.sceneNumber);
}

/** A scene is a usable hook when it opens with spoken or narrated text. */
export function hookStrength(scene: SceneSummary): number {
  if (!scene.text) return 0;
  let score = 1;
  if (endsWithQuestion(scene.text)) score += 2;
  score += Math.min(3, markerHits(scene.text, HOOK_MARKERS));
  if (charCount(scene.text) <= 140) score += 1;
  if (scene.soundDesign) score += 1;
  return score;
}

/** A scene is a usable payoff when it resolves or deliberately withholds. */
export function payoffStrength(scene: SceneSummary): number {
  if (!scene.text) return 0;
  let score = 1;
  score += Math.min(3, markerHits(scene.text, PAYOFF_MARKERS));
  if (scene.effects) score += 1;
  if (endsWithQuestion(scene.text)) score += 1;
  return score;
}

export interface ArcCandidate {
  startIndex: number;
  length: number;
  scenes: SceneSummary[];
  score: number;
  hook: number;
  payoff: number;
  escalation: number;
  importPenalty: number;
  protagonist: string | null;
  rationale: string;
}

/** Score ONE contiguous window. Pure; deterministic. */
export function scoreArc(scenes: SceneSummary[], startIndex: number, length: number): ArcCandidate {
  const window = scenes.slice(startIndex, startIndex + length);
  const first = window[0];
  const last = window[window.length - 1];
  const middle = window.slice(1, -1);

  const hook = hookStrength(first);
  const payoff = payoffStrength(last);
  const escalation = middle.reduce((sum, scene) => {
    let value = scene.text ? 1 : 0;
    value += Math.min(2, markerHits(scene.text, HOOK_MARKERS) + markerHits(scene.text, PAYOFF_MARKERS));
    if (scene.effects) value += 1;
    if (scene.soundDesign) value += 1;
    return sum + value;
  }, 0);

  // Protagonist = the most frequent character in the window (ties → earliest appearance).
  const counts = new Map<string, number>();
  for (const scene of window) for (const tag of scene.characterTags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  let protagonist: string | null = null;
  let bestCount = 0;
  for (const scene of window) {
    for (const tag of scene.characterTags) {
      const count = counts.get(tag) ?? 0;
      if (count > bestCount) { bestCount = count; protagonist = tag; }
    }
  }

  // Self-containment: a viewer who has not seen the long form must meet the protagonist inside
  // this Short. First scene is ideal; a late entrance is a (recoverable) penalty.
  let importPenalty = 0;
  if (protagonist) {
    const firstIndex = window.findIndex((scene) => scene.characterTags.includes(protagonist!));
    if (firstIndex < 0) importPenalty = 2.5;
    else if (firstIndex > 1) importPenalty = 1.5;
    else if (firstIndex === 1) importPenalty = 0.5;
  }

  const duration = window.length * 4.2;
  let durationPenalty = 0;
  if (duration < 10) durationPenalty = 1.2;
  if (duration > 34) durationPenalty = 1.0;

  const score = hook * 1.4 + payoff * 1.6 + escalation * 0.8 - importPenalty - durationPenalty;
  const rationale = `hook ${hook.toFixed(1)}, escalation ${escalation.toFixed(1)}, payoff ${payoff.toFixed(1)}, import penalty ${importPenalty.toFixed(1)}`;
  return { startIndex, length, scenes: window, score, hook, payoff, escalation, importPenalty, protagonist, rationale };
}

export interface ArcSelection {
  arcs: ArcCandidate[];
  warnings: string[];
}

/**
 * Enumerate every contiguous 3–6 scene window, rank deterministically and greedily pick
 * non-overlapping arcs. Ties break on start position then length so the plan is stable.
 */
export function selectArcs(scenes: SceneSummary[], count: number): ArcSelection {
  const wanted = Math.min(3, Math.max(2, Math.trunc(count) || 3));
  const warnings: string[] = [];
  const candidates: ArcCandidate[] = [];
  for (let length = 3; length <= Math.min(6, scenes.length); length += 1) {
    for (let start = 0; start + length <= scenes.length; start += 1) {
      const candidate = scoreArc(scenes, start, length);
      // A hook must exist; a window with no opening text cannot stand alone.
      if (!candidate.scenes[0].text) continue;
      if (!candidate.scenes[candidate.scenes.length - 1].text) continue;
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.startIndex - b.startIndex || b.length - a.length);

  const chosen: ArcCandidate[] = [];
  const used = new Set<number>();
  for (const candidate of candidates) {
    if (chosen.length >= wanted) break;
    const overlap = candidate.scenes.some((scene) => used.has(scene.sceneNumber));
    if (overlap) continue;
    chosen.push(candidate);
    for (const scene of candidate.scenes) used.add(scene.sceneNumber);
  }
  if (chosen.length < 2) {
    warnings.push(`only ${chosen.length} coherent Short arc(s) could be formed from ${scenes.length} scene(s); at least 2 require a longer story`);
  }
  chosen.sort((a, b) => a.startIndex - b.startIndex);
  if (chosen.length < wanted) warnings.push(`requested ${wanted} Shorts but selected ${chosen.length}`);
  return { arcs: chosen, warnings };
}

function estimatedSceneSeconds(scene: SceneSummary, durationById: Record<number, number> | null | undefined): number {
  const measured = Number(durationById?.[scene.sceneNumber]);
  if (Number.isFinite(measured) && measured > 0) return measured;
  // Fallback: Hindi narration pace ~ 13 characters per second, plus breathing room.
  const spoken = charCount(scene.text) / 13;
  return Math.max(3, Math.min(12, spoken + 1.2));
}

function compositionFor(arc: ArcCandidate): ShortCompositionRequirement {
  return {
    target_width: SHORTS_WIDTH,
    target_height: SHORTS_HEIGHT,
    fps: SHORTS_FPS,
    strategies: ['cover'],
    safe_area: { top: 160, bottom: 320, left: 80, right: 160 },
    caption_band_top: SHORTS_HEIGHT - 380 - Math.round(2 * 56 * 1.35),
    caption_band_bottom: SHORTS_HEIGHT - 380,
  };
}

function coherenceFor(arc: ArcCandidate, sceneRefs: number[]): ShortCoherence {
  const checks: ShortCoherenceCheck[] = [];
  const first = arc.scenes[0];
  const last = arc.scenes[arc.scenes.length - 1];
  const push = (id: string, ok: boolean, detail: string, severity: 'FAIL' | 'WARNING' = 'FAIL') => {
    checks.push({ id, status: ok ? 'PASS' : severity, detail });
  };
  push('hook.present', charCount(first.text) >= 12, charCount(first.text) >= 12 ? `opening line has ${charCount(first.text)} characters` : 'the opening line is too short to hook a viewer');
  push('escalation.present', arc.escalation >= 2, arc.escalation >= 2 ? `middle beats accumulate ${arc.escalation.toFixed(1)} escalation points` : 'the middle beats do not escalate', 'WARNING');
  push('payoff.present', payoffStrength(last) >= 2, payoffStrength(last) >= 2 ? 'the final beat resolves or withholds' : 'the final beat does not read as a payoff');
  push('self_contained.setup', Boolean(first.text), first.text ? 'the first scene carries its own context' : 'the Short opens without context');
  push('self_contained.protagonist', !arc.protagonist || arc.importPenalty <= 1.0,
    arc.protagonist ? (arc.importPenalty <= 1.0 ? `${arc.protagonist} appears early in the arc` : `${arc.protagonist} first appears late in the arc`) : 'the arc is narrator-driven and needs no character introduction',
    'WARNING');
  push('scene_refs.contiguous', sceneRefs.every((n, i) => i === 0 || n === sceneRefs[i - 1] + 1), 'scene references are contiguous');
  const duration = arc.scenes.length * 4.2;
  push('duration.plausible', duration >= SHORTS_MIN_SECONDS && duration <= SHORTS_MAX_SECONDS,
    `estimated ${duration.toFixed(1)}s is ${duration >= SHORTS_MIN_SECONDS && duration <= SHORTS_MAX_SECONDS ? 'inside' : 'outside'} the ${SHORTS_MIN_SECONDS}–${SHORTS_MAX_SECONDS}s window`,
    'WARNING');
  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARNING') ? 'WARNING' : 'PASS';
  return { status, checks };
}

function titleFromHook(hookText: string, parentTitle: string | null, index: number): string {
  const clean = hookText.replace(/[।?!.,;:]+$/u, '').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  let title = '';
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (charCount(candidate) > 42) break;
    title = candidate;
  }
  if (!title) title = parentTitle ? `${parentTitle} — भाग ${index}` : `कहानी का भाग ${index}`;
  return charCount(title) > 70 ? `${[...title].slice(0, 69).join('')}…` : title;
}

function narrationSegmentsFor(arc: ArcCandidate, sceneDurations: Record<number, number>, narrationDurations: Record<number, number> | null | undefined, narrationFiles: Record<number, string> | null | undefined): NarrationSegment[] {
  const segments: NarrationSegment[] = [];
  let cursor = 0;
  for (const scene of arc.scenes) {
    const clipSeconds = sceneDurations[scene.sceneNumber] ?? estimatedSceneSeconds(scene, null);
    const audioSeconds = Number(narrationDurations?.[scene.sceneNumber]);
    const kind: NarrationSegment['kind'] = scene.speaker === 'NARRATOR' || (!scene.dialogue && scene.narration) ? 'narration' : 'dialogue';
    const text = kind === 'narration' ? scene.narration : scene.dialogue || scene.narration;
    const spoken = Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : Math.max(1.2, Math.min(clipSeconds - 0.2, charCount(text) / 13));
    segments.push({
      scene_number: scene.sceneNumber,
      kind,
      text,
      audio: narrationFiles?.[scene.sceneNumber] ?? null,
      duration_seconds: Number(spoken.toFixed(3)),
      start_seconds: Number((cursor + 0.15).toFixed(3)),
      end_seconds: Number((cursor + 0.15 + spoken).toFixed(3)),
    });
    cursor += clipSeconds;
  }
  return segments;
}

export function planHashFor(plan: Omit<ShortPlan, 'plan_hash'>): string {
  const canonical = {
    project_id: plan.project_id,
    short_id: plan.short_id,
    index: plan.index,
    scene_refs: plan.scene_refs,
    hook: plan.hook,
    escalation: plan.escalation,
    payoff: plan.payoff,
    narration: plan.narration_segments.map((s) => [s.scene_number, s.kind, s.text, s.duration_seconds]),
    captions: plan.caption_segments.map((c) => [c.index, c.scene_number, c.start_seconds.toFixed(3), c.end_seconds.toFixed(3), c.text]),
    composition: plan.composition,
    metadata_hash: plan.metadata.metadata_hash,
  };
  return sha(JSON.stringify(canonical));
}

/**
 * Build the full plan for the whole story. Pure: no IO, no writes, no model calls.
 */
export function createShortsPlan(options: PlanOptions): ShortsPlanFile {
  const projectId = String(options.projectId ?? '').trim();
  if (!projectId) throw new Error('createShortsPlan requires a project id.');
  const pipeline = options.pipeline ?? {};
  const count = Math.min(3, Math.max(2, Math.trunc(Number(options.count ?? 3)) || 3));
  const scenes = summarizeScenes(pipeline);
  if (scenes.length < 3) {
    return {
      schema_version: SHORTS_SCHEMA_VERSION,
      project_id: projectId,
      parent_title: null,
      requested_count: count,
      count: 0,
      created_at: options.now ?? new Date().toISOString(),
      input_hash: sha(JSON.stringify({ projectId, count, scenes: scenes.map((s) => [s.sceneNumber, sha(s.text)]) })),
      shorts: [],
      warnings: [`the story has ${scenes.length} scene(s); at least 3 are required to form a standalone Short`],
    };
  }

  const parentTitle = (() => {
    for (const raw of [pipeline?.idea?.selected?.title, pipeline?.publishing?.title, pipeline?.review?.title, pipeline?.script?.title]) {
      const value = normalize(raw);
      if (value) return value;
    }
    return null;
  })();

  const { arcs, warnings } = selectArcs(scenes, count);
  const sceneDurations: Record<number, number> = {};
  for (const scene of scenes) sceneDurations[scene.sceneNumber] = Number((options.sceneDurations?.[scene.sceneNumber] ?? estimatedSceneSeconds(scene, options.sceneDurations)).toFixed(3));

  const shorts: ShortPlan[] = arcs.map((arc, index) => {
    const shortId = `short-${String(index + 1).padStart(2, '0')}`;
    const sceneRefs = arc.scenes.map((scene) => scene.sceneNumber);
    const narrationSegments = narrationSegmentsFor(arc, sceneDurations, options.narrationDurations, options.narrationFiles);
    const captionSegments: CaptionSegment[] = buildCaptionSegments(narrationSegments);
    const composition = compositionFor(arc);
    const hookScene = arc.scenes[0];
    const payoffScene = arc.scenes[arc.scenes.length - 1];
    const payoffKind: 'reveal' | 'cliffhanger' = endsWithQuestion(payoffScene.text) || markerHits(payoffScene.text, CLIFFHANGER_MARKERS) > 0
      ? 'cliffhanger' : 'reveal';
    const title = titleFromHook(hookScene.text, parentTitle, index + 1);
    const estimatedDuration = Number(sceneRefs.reduce((sum, n) => sum + sceneDurations[n], 0).toFixed(2));
    const coherence = coherenceFor(arc, sceneRefs);
    const metadata = buildShortMetadata({
      projectId,
      shortId,
      index: index + 1,
      title,
      hookText: hookScene.text,
      payoffText: payoffScene.text,
      sceneTitles: arc.scenes.map((s) => s.title).filter(Boolean),
      keywords: arc.scenes.flatMap((s) => splitKeywords(s.text)),
      parentTitle,
      estimatedDurationSeconds: estimatedDuration,
      hookSceneNumber: hookScene.sceneNumber,
    });
    const base: Omit<ShortPlan, 'plan_hash'> = {
      schema_version: SHORTS_SCHEMA_VERSION,
      project_id: projectId,
      short_id: shortId,
      index: index + 1,
      title,
      parent_title: parentTitle,
      scene_refs: sceneRefs,
      hook: { scene_number: hookScene.sceneNumber, text: hookScene.text },
      escalation: arc.scenes.slice(1, -1).map((scene, i) => ({
        scene_number: scene.sceneNumber,
        beat: `beat ${i + 1}: ${scene.text || scene.visualAction || 'silent escalation'}`,
      })),
      payoff: { scene_number: payoffScene.sceneNumber, text: payoffScene.text, kind: payoffKind },
      narration_segments: narrationSegments,
      caption_segments: captionSegments,
      estimated_duration_seconds: estimatedDuration,
      composition,
      sound_design: arc.scenes.map((s) => s.soundDesign).filter(Boolean),
      clips: [],
      coherence,
      metadata,
    };
    return { ...base, plan_hash: planHashFor(base) };
  });

  for (const short of shorts) {
    if (short.coherence.status === 'FAIL') warnings.push(`${short.short_id} failed an independent-coherence check`);
    if (short.estimated_duration_seconds > SHORTS_WARN_SECONDS) warnings.push(`${short.short_id} is estimated at ${short.estimated_duration_seconds}s (above the ${SHORTS_WARN_SECONDS}s Shorts convention)`);
  }

  const inputHash = sha(JSON.stringify({
    projectId,
    count,
    scenes: scenes.map((scene) => [scene.sceneNumber, sha(scene.text), scene.characterTags.join(',')]),
    durations: sceneDurations,
  }));

  return {
    schema_version: SHORTS_SCHEMA_VERSION,
    project_id: projectId,
    parent_title: parentTitle,
    requested_count: count,
    count: shorts.length,
    created_at: options.now ?? new Date().toISOString(),
    input_hash: inputHash,
    shorts,
    warnings,
  };
}

/** Extract short Hindi keywords for metadata (pure). */
export function splitKeywords(text: string): string[] {
  const stop = new Set(['और', 'में', 'से', 'को', 'का', 'की', 'के', 'है', 'था', 'थी', 'थे', 'पर', 'यह', 'वह', 'एक', 'नहीं', 'हो', 'गया', 'गई', 'रहा', 'रही', 'लिए', 'साथ', 'अपने', 'उसने', 'मैंने']);
  return normalize(text)
    .replace(/[।?!.,;:"'()\[\]{}]/gu, ' ')
    .split(/\s+/)
    .filter((word) => charCount(word) >= 3 && !stop.has(word));
}
