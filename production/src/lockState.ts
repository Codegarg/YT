/** Reusable-asset lock state helpers (characters/backgrounds).
 *
 * A reusable asset is usable by scene generation only when `locked === true`.
 * - Characters lock automatically once generation + rename + voice verification pass.
 * - Backgrounds lock ONLY after explicit human confirmation that the plate is an
 *   empty environment (no automatic emptiness detection exists in this repo).
 * A missing `locked` field is treated as false (backward compatible).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface LockableItem { tag?: string; status?: string; locked?: boolean; [key: string]: unknown }
export interface LockProject { characters?: LockableItem[]; backgrounds?: LockableItem[]; [key: string]: unknown }

export function isLocked(item: LockableItem | undefined | null): boolean {
  return item?.locked === true;
}

export function findByTag(items: LockableItem[] | undefined, tag: string): LockableItem | undefined {
  return (items ?? []).find((item) => String(item.tag) === String(tag));
}

/** Characters lock only after generation + rename + voice verification succeeded. */
export function canLockCharacter(item: LockableItem, verifications: { generated: boolean; renamed: boolean; voiceVerified: boolean }): boolean {
  if (item?.status !== 'done') return false;
  return verifications.generated === true && verifications.renamed === true && verifications.voiceVerified === true;
}

/** Backgrounds can NEVER auto-lock; an explicit human confirmation is required. */
export function canLockBackground(item: LockableItem, confirmedEmpty: boolean): boolean {
  if (item?.status !== 'done') return false;
  return confirmedEmpty === true;
}

export async function loadProject(file: string): Promise<LockProject> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as LockProject;
}

export async function saveProject(file: string, project: LockProject): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}

/** Explicitly confirm a generated background is an empty environment, then lock it. */
export async function confirmBackgroundEmpty(file: string, tag: string): Promise<LockableItem> {
  const project = await loadProject(file);
  const background = findByTag(project.backgrounds, tag);
  if (!background) throw new Error(`No background with tag ${tag} in ${file}.`);
  if (background.status !== 'done') throw new Error(`Background ${tag} is not generated yet (status=${background.status ?? 'unknown'}); generate it before confirming.`);
  if (!canLockBackground(background, true)) throw new Error(`Background ${tag} cannot be locked.`);
  background.locked = true;
  await saveProject(file, project);
  return background;
}

export async function unlockBackground(file: string, tag: string): Promise<LockableItem> {
  const project = await loadProject(file);
  const background = findByTag(project.backgrounds, tag);
  if (!background) throw new Error(`No background with tag ${tag} in ${file}.`);
  background.locked = false;
  await saveProject(file, project);
  return background;
}
