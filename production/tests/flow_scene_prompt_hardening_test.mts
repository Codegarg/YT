// Offline regression tests for the per-scene Flow prompt builder.
// Proves the RAW manifest prompt is never submitted: identifiers are resolved and the
// output restraints are appended. No Flow, no Chrome, no network, no credits.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
const ID = 'youtube-automation-2-20261003160855-2740';
const wf = await import(pathToFileURL(`${SRC}/sceneFlowWorkflow.ts`).href);
const { buildFlowScenePrompt, FLOW_OUTPUT_RESTRAINTS } = wf;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const pipeline = JSON.parse(fs.readFileSync(`${REPO}/scripting/projects/${ID}/pipeline.json`, 'utf8'));
const backgrounds = pipeline.backgrounds;
const characters = pipeline.characters;

const RESIDUAL = /#[A-Za-z0-9_-]*[A-Za-z0-9]|@[A-Za-z0-9_-]*[A-Za-z0-9]/g;

// ---- 1. THE LIVE DEFECT: the raw manifest prompt carries identifiers ----
for (const n of [16, 20, 21, 22, 23]) {
  const s = pipeline.scenes.find((x: any) => Number(x.scene_number) === n);
  const raw = s.animation_prompt_NARRATOR_ONLY as string;
  check(`scene ${n} raw manifest prompt DOES carry identifiers (the live defect)`,
    (raw.match(RESIDUAL) ?? []).length > 0, (raw.match(RESIDUAL) ?? []).length);
}

// ---- 2. every target scene produces a clean, restrained prompt ----
for (const n of [16, 20, 21, 22, 23]) {
  const s = pipeline.scenes.find((x: any) => Number(x.scene_number) === n);
  const built = buildFlowScenePrompt({ prompt: s.animation_prompt_NARRATOR_ONLY, backgrounds, characters });
  check(`scene ${n} builds ok`, built.ok === true, built.ok ? '' : (built as any).reason);
  if (!built.ok) continue;
  const p = built.prompt;
  check(`scene ${n} prompt has NO residual identifier`, (p.match(RESIDUAL) ?? []).length === 0, p.match(RESIDUAL));
  check(`scene ${n} prompt keeps the restraints block`, p.includes(FLOW_OUTPUT_RESTRAINTS));
  check(`scene ${n} states the established art direction`, /flat cel shading/.test(p) && /flat 2D vector-art/.test(p));
  check(`scene ${n} forbids labels/captions/watermarks/logos/UI`,
    /no captions/i.test(p) && /no character names/i.test(p) && /no labels/i.test(p)
    && /NO watermarks/i.test(p) && /NO logos/i.test(p) && /NO UI overlays/i.test(p));
  check(`scene ${n} preserved the original scene action`, p.includes(String(s.visual_action).slice(0, 30)));
  check(`scene ${n} preserved the original camera line`, p.includes(String(s.camera).slice(0, 20)));
}

// ---- 3. the resolved descriptions carry the real character identities ----
{
  const s = pipeline.scenes.find((x: any) => Number(x.scene_number) === 20);
  const built = buildFlowScenePrompt({ prompt: s.animation_prompt_NARRATOR_ONLY, backgrounds, characters });
  const p = (built as any).prompt as string;
  const atma = characters.find((c: any) => c.tag === '@CHAR-03-RADHADEVI-ATMA');
  const arjun = characters.find((c: any) => c.tag === '@CHAR-01-ARJUN');
  check('scene 20 prompt names Radha Devi by her canonical name', p.includes(atma.name));
  check('scene 20 prompt carries Radha Devi look_summary', p.includes(String(atma.look_summary).slice(0, 40)));
  check('scene 20 prompt carries Arjun look_summary', p.includes(String(arjun.look_summary).slice(0, 40)));
  check('scene 20 prompt names Arjun', p.includes(arjun.name));
}

// ---- 4. fail-closed paths (zero credits) ----
{
  const s = pipeline.scenes.find((x: any) => Number(x.scene_number) === 20);
  check('missing metadata fails closed', buildFlowScenePrompt({ prompt: s.animation_prompt_NARRATOR_ONLY }).ok === false);
  check('empty prompt fails closed', buildFlowScenePrompt({ prompt: '', backgrounds, characters }).ok === false);
  check('unknown identifier fails closed',
    buildFlowScenePrompt({ prompt: 'use @CHAR-99-NOBODY here', backgrounds, characters }).ok === false);
  check('no-metadata failure names the unresolved reference',
    /PROMPT_REFERENCE_UNRESOLVED/.test((buildFlowScenePrompt({ prompt: 'use @CHAR-99-NOBODY', backgrounds, characters }) as any).reason));
}

// ---- 5. scene 22 has no characters; its prompt must still build ----
{
  const s = pipeline.scenes.find((x: any) => Number(x.scene_number) === 22);
  const built = buildFlowScenePrompt({ prompt: s.animation_prompt_NARRATOR_ONLY, backgrounds, characters });
  check('scene 22 (no character tags) still builds via its background', built.ok === true, built.ok ? '' : (built as any).reason);
  check('scene 22 background resolved to its human description, not stripped',
    built.ok && /Arjun's Bedroom \(Window Close\)/.test((built as any).prompt) && !/BGD-02/.test((built as any).prompt));
  check('scene 22 background look_summary is carried through', built.ok && /rain-streaked window/i.test((built as any).prompt));
}

console.log(`\nper-scene Flow prompt hardening: ${passed} checks passed`);