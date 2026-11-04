/** CLI: explicit reusable-asset lock operations (human confirmation for backgrounds).
 *
 * Usage:
 *   npm run lock -- confirm-background-empty --project <pipeline.json> --tag #BGD-01-VILLAGE-STREET-WIDE
 *   npm run lock -- unlock-background --project <pipeline.json> --tag #BGD-01-VILLAGE-STREET-WIDE
 *   npm run lock -- status --project <pipeline.json>
 */
import path from 'node:path';
import { confirmBackgroundEmpty, loadProject, unlockBackground, isLocked } from './lockState.js';

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const command = process.argv[2] ?? 'status';
const projectFile = arg('--project');
if (!projectFile) throw new Error('Pass --project <pipeline.json>.');
const file = path.resolve(projectFile);

if (command === 'confirm-background-empty') {
  const tag = arg('--tag');
  if (!tag) throw new Error('Pass --tag <#BGD-...>.');
  const background = await confirmBackgroundEmpty(file, tag);
  console.log(JSON.stringify({ confirmed: true, tag: background.tag, locked: background.locked }, null, 2));
} else if (command === 'unlock-background') {
  const tag = arg('--tag');
  if (!tag) throw new Error('Pass --tag <#BGD-...>.');
  const background = await unlockBackground(file, tag);
  console.log(JSON.stringify({ unlocked: true, tag: background.tag, locked: background.locked }, null, 2));
} else if (command === 'status') {
  const project = await loadProject(file);
  console.log(JSON.stringify({
    characters: (project.characters ?? []).map((c) => ({ tag: c.tag, status: c.status ?? null, locked: isLocked(c) })),
    backgrounds: (project.backgrounds ?? []).map((b) => ({ tag: b.tag, status: b.status ?? null, locked: isLocked(b) })),
  }, null, 2));
} else {
  throw new Error('Use one of: confirm-background-empty, unlock-background, status.');
}
