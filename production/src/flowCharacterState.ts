/**
 * Flow-native character state model (browser-free).
 *
 * Flow becomes the PRIMARY character provider for scene/video generation. A Flow-native character
 * is a first-class Flow project asset (a character tile / ingredient), NOT a local transparent PNG.
 * Its authoritative identity is the Flow-native character UUID — never a local PNG SHA.
 *
 * This module is PURE: no Playwright, no filesystem, no network, no Flow, no credits. It defines
 * the state machine + identity resolution that the FlowCharacterProvider drives.
 */
import type { CharacterGenerationSpec } from './characterGenerationSpec.js';

/** Explicit, fail-closed states for a Flow-native character. */
export type FlowCharacterState =
  | 'FLOW_CHARACTER_PENDING'
  | 'FLOW_CHARACTER_GENERATING'
  | 'FLOW_CHARACTER_READY'
  | 'FLOW_CHARACTER_NOT_FOUND'
  | 'FLOW_CHARACTER_AMBIGUOUS'
  | 'FLOW_CHARACTER_INVALID'
  | 'FLOW_CHARACTER_GENERATION_FAILED';

/** Error classification for a Flow-native character (null when none). */
export type FlowCharacterErrorClass =
  | 'PROMPT_UNAVAILABLE'
  | 'GENERATION_CONTROL_MISSING'
  | 'GENERATION_TIMEOUT'
  | 'POST_GENERATION_TILE_MISSING'
  | 'IDENTITY_UNVERIFIABLE'
  | 'RENAME_FAILED'
  | 'DUPLICATE_IDENTITY'
  | null;

/**
 * One Flow-native character record. `flowCharacterUuid` is authoritative; the local PNG SHA is
 * intentionally NOT part of this identity.
 */
export interface FlowCharacterRecord {
  tag: string;
  /** The pipeline spec this character was generated from (source of truth). */
  spec: CharacterGenerationSpec;
  flowProjectId: string;
  /** Authoritative Flow-native identity; null until the tile/ingredient exposes it. */
  flowCharacterUuid: string | null;
  state: FlowCharacterState;
  /** Display name observed in Flow (may differ from tag until rename persists). */
  displayName: string | null;
  verification: 'UNVERIFIED' | 'VERIFIED';
  /** ISO timestamp of the last state transition/verification, or null. */
  lastVerifiedAt: string | null;
  errorClass: FlowCharacterErrorClass;
  /** Optional free-text reason (never a secret). */
  error?: string;
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a well-formed Flow character UUID. */
export function isValidFlowCharacterUuid(id: unknown): boolean {
  return typeof id === 'string' && uuidRe.test(id.trim());
}

/**
 * Extract the AUTHORITATIVE Flow-native character identity from a character detail route.
 * Observed live: `/project/<projectId>/character/<characterId>` — `<characterId>` is the stable
 * character identity (the route reflects the same value on reload). Returns null when the URL is
 * not a character detail route or the id is malformed (fail closed — never guess from name/order).
 */
export function resolveFlowCharacterIdFromUrl(url: unknown): string | null {
  const m = String(url ?? '').match(/(?:\/u\/\d+)?\/project\/[0-9a-f-]{36}\/character\/([0-9a-f-]{36})/i);
  return m && isValidFlowCharacterUuid(m[1]) ? m[1] : null;
}

/** Create a PENDING record for a pipeline-specified character. */
export function pendingFlowCharacter(input: { tag: string; spec: CharacterGenerationSpec; flowProjectId: string }, now?: string): FlowCharacterRecord {
  return {
    tag: String(input.tag),
    spec: input.spec,
    flowProjectId: String(input.flowProjectId),
    flowCharacterUuid: null,
    state: 'FLOW_CHARACTER_PENDING',
    displayName: null,
    verification: 'UNVERIFIED',
    lastVerifiedAt: now ?? null,
    errorClass: null,
  };
}

/** Legal, explicit state transitions (fail-closed; no implicit retry). */
const TRANSITIONS: Record<FlowCharacterState, FlowCharacterState[]> = {
  FLOW_CHARACTER_PENDING: ['FLOW_CHARACTER_GENERATING', 'FLOW_CHARACTER_NOT_FOUND'],
  FLOW_CHARACTER_GENERATING: ['FLOW_CHARACTER_READY', 'FLOW_CHARACTER_GENERATION_FAILED', 'FLOW_CHARACTER_AMBIGUOUS'],
  FLOW_CHARACTER_READY: ['FLOW_CHARACTER_INVALID', 'FLOW_CHARACTER_NOT_FOUND'],
  FLOW_CHARACTER_NOT_FOUND: ['FLOW_CHARACTER_PENDING'],
  FLOW_CHARACTER_AMBIGUOUS: [],
  FLOW_CHARACTER_INVALID: [],
  FLOW_CHARACTER_GENERATION_FAILED: [],
};

/** Pure transition guard. Returns the next record or a fail-closed error. */
export function transitionFlowCharacter(
  record: FlowCharacterRecord,
  next: FlowCharacterState,
  patch: Partial<Pick<FlowCharacterRecord, 'flowCharacterUuid' | 'displayName' | 'verification' | 'errorClass' | 'error'>> = {},
  now?: string,
): { ok: true; record: FlowCharacterRecord } | { ok: false; reason: string } {
  const allowed = TRANSITIONS[record.state] ?? [];
  if (!allowed.includes(next)) return { ok: false, reason: `Illegal Flow character transition ${record.state} → ${next}.` };
  if (next === 'FLOW_CHARACTER_READY' && patch.flowCharacterUuid !== undefined && !isValidFlowCharacterUuid(patch.flowCharacterUuid)) {
    return { ok: false, reason: `FLOW_CHARACTER_READY requires a well-formed Flow character UUID, got ${JSON.stringify(patch.flowCharacterUuid)}.` };
  }
  return { ok: true, record: { ...record, ...patch, state: next, lastVerifiedAt: now ?? record.lastVerifiedAt } };
}

/** Verification outcome for a resolved candidate tile. */
export type CharacterMatchDecision =
  | { state: 'FLOW_CHARACTER_READY'; index: number; uuid: string | null }
  | { state: 'FLOW_CHARACTER_NOT_FOUND'; index: -1; uuid: null }
  | { state: 'FLOW_CHARACTER_AMBIGUOUS'; index: -1; uuid: null };

export interface FlowCharacterCandidate {
  displayName: string;
  uuid: string | null;
}

/**
 * PURE lookup decision: resolve a character by EXACT tag/name (case-insensitive trim), prefer an
 * authoritative UUID match, and fail closed on ambiguity (never guess). No fuzzy matching.
 */
export function resolveFlowCharacterMatch(candidates: readonly FlowCharacterCandidate[], input: { tag?: string; uuid?: string | null }): CharacterMatchDecision {
  const list = Array.isArray(candidates) ? candidates : [];
  const wantUuid = isValidFlowCharacterUuid(input.uuid) ? String(input.uuid).trim() : null;
  if (wantUuid) {
    const matches = list.filter((c) => c.uuid === wantUuid);
    if (matches.length === 1) return { state: 'FLOW_CHARACTER_READY', index: list.indexOf(matches[0]), uuid: wantUuid };
    if (matches.length > 1) return { state: 'FLOW_CHARACTER_AMBIGUOUS', index: -1, uuid: null };
    return { state: 'FLOW_CHARACTER_NOT_FOUND', index: -1, uuid: null };
  }
  const wantTag = String(input.tag ?? '').trim().toLowerCase();
  if (!wantTag) return { state: 'FLOW_CHARACTER_NOT_FOUND', index: -1, uuid: null };
  const matches = list.filter((c) => String(c.displayName ?? '').trim().toLowerCase() === wantTag);
  if (matches.length === 1) return { state: 'FLOW_CHARACTER_READY', index: list.indexOf(matches[0]), uuid: matches[0].uuid ?? null };
  if (matches.length > 1) return { state: 'FLOW_CHARACTER_AMBIGUOUS', index: -1, uuid: null };
  return { state: 'FLOW_CHARACTER_NOT_FOUND', index: -1, uuid: null };
}

/** Explicit generation mode. A read-only recon must NEVER be treated as real generation. */
export type CharacterOperationMode = 'READ_ONLY_RECON' | 'REAL_GENERATION';

/** Generation/creation controls that a READ_ONLY_RECON must never click. */
export const GENERATION_CONTROLS: readonly string[] = ['Start generation', 'Generate', 'Create', 'Submit generation', 'Create character'];

/** Pure safety gate: may `control` be clicked under `mode`? */
export function generationActionAllowed(mode: CharacterOperationMode, control: string): boolean {
  const c = String(control ?? '').trim().toLowerCase();
  const isGeneration = GENERATION_CONTROLS.some((g) => c === g.toLowerCase()); // exact, never substring
  if (mode === 'REAL_GENERATION') return true;
  return !isGeneration;
}

/** Retry policy is currently DISABLED for Flow character generation (fail closed, no auto-retry). */
export const FLOW_CHARACTER_AUTO_RETRY_ENABLED = false;

/** Pure policy: should a failed Flow character generation be retried automatically? Always false. */
export function shouldRetryFlowCharacter(): boolean {
  return FLOW_CHARACTER_AUTO_RETRY_ENABLED;
}
