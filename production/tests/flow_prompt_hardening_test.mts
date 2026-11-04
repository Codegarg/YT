// Focused OFFLINE tests for Flow prompt hardening, scene-scoped asset locks, and Flow artifact
// staging (TASKS 1-6).
//
// Covers: canonical #BGD-*/@CHAR-* -> human-readable resolution from `pipeline.json` metadata, the
// no-strip guarantee, fail-closed unresolved references, scene-scoped dependency locking, prompt /
// asset correspondence, and the protected-local-artifact staging rules.
//
// Pure-helper tests + browser-free source audits. NO browser, NO Flow, NO credits, NO writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const H = await import(pathToFileURL(`${SRC}/flowPromptHardening.ts`).href);
const ST = await import(pathToFileURL(`${SRC}/flowStaging.ts`).href);
const FCL = await import(pathToFileURL(`${SRC}/firstClipLifecycle.ts`).href);

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

import { OUTPUTS as OUT_ROOT } from './_testPaths.mjs';
const PID = 'youtube-automation-2-20261003160855-2740';

// Canonical metadata taken verbatim from the project's own pipeline.json.
const CANON_BGS = [
  { tag: '#BGD-01-ARJUN-ROOM-WIDE', location_name: "Arjun's Bedroom (Wide)", look_summary: 'Simple Indian bedroom, window facing old cremation ground, night, teal-blue rainy light.' },
  { tag: '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE', location_name: 'Arjun Bedroom Window (Close)', look_summary: 'Rain-streaked window glass at night.' },
];
const CANON_CHARS = [
  { tag: '@CHAR-01-ARJUN', name: 'अर्जुन', look_summary: '22-year-old Indian man, average build, medium brown skin, clean-shaven, expressive eyes, short black hair, casual nightwear, neutral 3/4 pose.' },
  { tag: '@CHAR-02-MAA', name: 'माँ', look_summary: '45-year-old Indian woman, simple cotton saree, tired but warm eyes.' },
];

const SCENE1 = {
  scene_number: 1,
  background_tag: '#BGD-01-ARJUN-ROOM-WIDE',
  character_tags: ['@CHAR-01-ARJUN'],
  animation_prompt_NARRATOR_ONLY: [
    '### SYSTEM & ENVIRONMENT',
    'ACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE',
    'ACTIVE CHARACTERS: @CHAR-01-ARJUN',
    '',
    '### VISUAL ACTION & CAMERA',
    'SCENE ACTION: Arjun sits on the bed and stares out of the window.',
  ].join('\n'),
};

// ============ TASK 2/4: canonical description resolution ============
console.log('--- canonical asset description resolution ---');
{
  const bg = H.resolveBackgroundDescription('#BGD-01-ARJUN-ROOM-WIDE', CANON_BGS);
  check('HD1 a canonical background resolves to location + look from pipeline metadata',
    bg === "Arjun's Bedroom (Wide) — Simple Indian bedroom, window facing old cremation ground, night, teal-blue rainy light.", bg);
  const ch = H.resolveCharacterDescription('@CHAR-01-ARJUN', CANON_CHARS);
  check('HD2 a canonical character resolves to name + look from pipeline metadata',
    ch === 'अर्जुन — 22-year-old Indian man, average build, medium brown skin, clean-shaven, expressive eyes, short black hair, casual nightwear, neutral 3/4 pose.', ch);
  check('HD3 an unknown tag resolves to null and is never invented',
    H.resolveBackgroundDescription('#BGD-99-NOPE', CANON_BGS) === null
    && H.resolveCharacterDescription('@CHAR-99-NOPE', CANON_CHARS) === null);
  check('HD4 a malformed / wrong-sigil / loose-substring tag resolves to null',
    H.resolveBackgroundDescription('#BGD-', CANON_BGS) === null
    && H.resolveBackgroundDescription('BGD-01-ARJUN-ROOM-WIDE', CANON_BGS) === null
    && H.resolveBackgroundDescription('the #BGD-01-ARJUN-ROOM-WIDE plate', CANON_BGS) === null
    && H.resolveCharacterDescription('@CHAR-01-ARJUN (extra)', CANON_CHARS) === null);
  check('HD5 an empty metadata list resolves nothing (no second source of truth)',
    H.resolveBackgroundDescription('#BGD-01-ARJUN-ROOM-WIDE', []) === null);
  check('HD6 a metadata entry with no description resolves to null rather than a placeholder',
    H.resolveBackgroundDescription('#BGD-01-X', [{ tag: '#BGD-01-X', location_name: '', look_summary: '' }]) === null);
}

// ============ TASK 2/4: hardening ============
console.log('--- prompt hardening ---');
{
  const r = H.hardenFlowPrompt({ prompt: SCENE1.animation_prompt_NARRATOR_ONLY, backgrounds: CANON_BGS, characters: CANON_CHARS });
  check('PH1 hardening succeeds for the real Scene 1 prompt', r.ok === true, r);
  check('PH2 NO raw #BGD-* identifier remains in the hardened prompt', !/#BGD-/.test(r.hardenedPrompt), r.hardenedPrompt);
  check('PH3 NO raw @CHAR-* identifier remains in the hardened prompt', !/@CHAR-/.test(r.hardenedPrompt), r.hardenedPrompt);
  check('PH4 findResidualMachineIds reports zero residuals', H.findResidualMachineIds(r.hardenedPrompt).length === 0);
  check('PH5 both references were resolved and reported',
    r.resolved.length === 2 && r.resolved.some((x) => x.tag === '#BGD-01-ARJUN-ROOM-WIDE' && x.kind === 'background')
    && r.resolved.some((x) => x.tag === '@CHAR-01-ARJUN' && x.kind === 'character'), r.resolved);
  check('PH6 the environment line carries the canonical BGD-01 description',
    r.hardenedPrompt.includes(`ACTIVE ENVIRONMENT: ${CANON_BGS[0].location_name} — ${CANON_BGS[0].look_summary}`), r.hardenedPrompt);
  check('PH7 the character line carries the canonical Arjun description',
    r.hardenedPrompt.includes(`ACTIVE CHARACTERS: ${CANON_CHARS[0].name} — ${CANON_CHARS[0].look_summary}`));
  check('PH8 all other prompt text is preserved byte-for-byte',
    r.hardenedPrompt.startsWith('### SYSTEM & ENVIRONMENT\nACTIVE ENVIRONMENT: ')
    && r.hardenedPrompt.endsWith('\n### VISUAL ACTION & CAMERA\nSCENE ACTION: Arjun sits on the bed and stares out of the window.'), r.hardenedPrompt);
  check('PH9 hardening is NOT a strip: the semantics survive',
    /ACTIVE ENVIRONMENT: [^\n]*bedroom/i.test(r.hardenedPrompt)
    && /ACTIVE CHARACTERS: [^\n]*Arjun|ACTIVE CHARACTERS: [^\n]*अर्जुन/i.test(r.hardenedPrompt));
  check('PH10 hardening is deterministic (identical input -> identical output)',
    H.hardenFlowPrompt({ prompt: SCENE1.animation_prompt_NARRATOR_ONLY, backgrounds: CANON_BGS, characters: CANON_CHARS }).hardenedPrompt === r.hardenedPrompt);

  const unresolved = H.hardenFlowPrompt({
    prompt: 'ACTIVE ENVIRONMENT: #BGD-77-MISSING\nACTIVE CHARACTERS: @CHAR-01-ARJUN',
    backgrounds: CANON_BGS, characters: CANON_CHARS,
  });
  check('PH11 an unresolvable #BGD-* fails closed and NAMES the reference',
    unresolved.ok === false && unresolved.code === 'PROMPT_REFERENCE_UNRESOLVED' && unresolved.unresolved.includes('#BGD-77-MISSING'), unresolved);
  const unresolvedChar = H.hardenFlowPrompt({
    prompt: 'ACTIVE CHARACTERS: @CHAR-77-MISSING', backgrounds: CANON_BGS, characters: CANON_CHARS,
  });
  check('PH12 an unresolvable @CHAR-* fails closed', unresolvedChar.ok === false && unresolvedChar.unresolved.includes('@CHAR-77-MISSING'));

  check('PH13 an empty prompt fails closed',
    H.hardenFlowPrompt({ prompt: '   ', backgrounds: CANON_BGS, characters: CANON_CHARS }).code === 'PROMPT_MISSING');
  check('PH14 a prompt with NO asset reference fails closed rather than passing through',
    H.hardenFlowPrompt({ prompt: 'Just some text with no assets.', backgrounds: CANON_BGS, characters: CANON_CHARS }).code === 'PROMPT_SEMANTICS_LOST');
  check('PH15 missing canonical metadata entirely fails closed',
    H.hardenFlowPrompt({ prompt: 'ACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE' }).code === 'PROMPT_REFERENCE_UNRESOLVED');
  check('PH16 the resolver never touches the filesystem or a browser',
    !/fs\.|readFile|page|locator|playwright|await\b|require\(/.test(H.hardenFlowPrompt.toString() + H.resolveBackgroundDescription.toString() + H.resolveCharacterDescription.toString()));

  // repeated tags resolve once in the report but replace at every position
  const repeated = H.hardenFlowPrompt({
    prompt: 'A: #BGD-01-ARJUN-ROOM-WIDE\nB: #BGD-01-ARJUN-ROOM-WIDE\nC: @CHAR-01-ARJUN', backgrounds: CANON_BGS, characters: CANON_CHARS,
  });
  check('PH17 a repeated tag is replaced at EVERY position and reported once',
    repeated.ok === true && repeated.resolved.length === 2
    && (repeated.hardenedPrompt.match(/Arjun's Bedroom \(Wide\)/g) ?? []).length === 2, repeated);
  const punct = H.hardenFlowPrompt({ prompt: 'env=(#BGD-01-ARJUN-ROOM-WIDE); char=@CHAR-01-ARJUN.', backgrounds: CANON_BGS, characters: CANON_CHARS });
  // The canonical look_summary itself ends in '.', so the source's own trailing '.' survives as an
  // extra final period. What matters is that it was NOT absorbed into the identifier.
  check('PH18 a tag adjacent to punctuation resolves and the source punctuation survives',
    punct.ok === true
    && punct.hardenedPrompt.endsWith(`${CANON_CHARS[0].look_summary}.`)
    && punct.hardenedPrompt.includes('env=(Arjun\'s Bedroom (Wide) — Simple Indian bedroom')
    && punct.resolved.every((x) => !x.tag.endsWith('.')), punct);
}

// ============ TASK 3: scene-scoped dependency resolution ============
console.log('--- scene dependency resolution ---');
{
  const d = H.resolveSceneAssetDependencies(SCENE1);
  check('SD1 Scene 1 resolves to exactly one background and one character',
    d.ok === true && d.backgroundTags.length === 1 && d.characterTags.length === 1
    && d.backgroundTags[0] === '#BGD-01-ARJUN-ROOM-WIDE' && d.characterTags[0] === '@CHAR-01-ARJUN', d);
  const dedup = H.resolveSceneAssetDependencies({ scene_number: 1, background_tag: '#BGD-01-ARJUN-ROOM-WIDE', character_tags: ['@CHAR-01-ARJUN', '@CHAR-01-ARJUN', ' @CHAR-01-ARJUN '] });
  check('SD2 duplicate / whitespace-padded scene character tags are de-duplicated',
    dedup.ok === true && dedup.characterTags.length === 1, dedup);
  check('SD3 an unknown but well-formed tag still resolves as a DEPENDENCY (the lock then fails, not the resolver)',
    H.resolveSceneAssetDependencies({ scene_number: 1, background_tag: '#BGD-99-NOPE', character_tags: [] }).ok === true);
  check('SD4 a malformed character tag fails closed',
    H.resolveSceneAssetDependencies({ scene_number: 1, background_tag: '#BGD-01-ARJUN-ROOM-WIDE', character_tags: ['Arjun'] }).code === 'SCENE_TAG_MALFORMED');
  check('SD5 a malformed background tag fails closed',
    H.resolveSceneAssetDependencies({ scene_number: 1, background_tag: 'bedroom', character_tags: [] }).code === 'SCENE_TAG_MALFORMED');
  check('SD6 a scene with no declared tags fails closed (never infers a dependency)',
    H.resolveSceneAssetDependencies({ scene_number: 1, background_tag: '', character_tags: [] }).code === 'SCENE_TAGS_MISSING');
  check('SD7 a non-positive / non-integer scene number fails closed',
    H.resolveSceneAssetDependencies({ scene_number: 0, background_tag: '#BGD-01-ARJUN-ROOM-WIDE' }).code === 'SCENE_NUMBER_INVALID'
    && H.resolveSceneAssetDependencies({ scene_number: 1.5, background_tag: '#BGD-01-ARJUN-ROOM-WIDE' }).code === 'SCENE_NUMBER_INVALID');
  check('SD8 a missing scene object fails closed',
    H.resolveSceneAssetDependencies(null).code === 'SCENE_TAGS_MISSING');
}

// ============ TASK 3: scene-scoped asset locks ============
console.log('--- scene required asset locks ---');
{
  const INV_B = ['#BGD-01-ARJUN-ROOM-WIDE', '#BGD-02-ARJUN-ROOM-WINDOW-CLOSE'];
  const INV_C = ['@CHAR-01-ARJUN', '@CHAR-02-MAA'];
  const ok = H.verifySceneAssetLocks({
    requiredBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'], requiredCharacters: ['@CHAR-01-ARJUN'],
    availableBackgrounds: INV_B, availableCharacters: INV_C,
  });
  check('SL1 the scene lock passes on the scene\'s own 1 background + 1 character', ok.ok === true, ok);
  check('SL2 unrelated project assets (BGD-02, CHAR-02) do NOT cause a failure',
    ok.ok === true && INV_B.length === 2 && INV_C.length === 2);
  check('SL3 a scene needing ONLY BGD-01 passes even when BGD-02..07 are absent',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'], requiredCharacters: ['@CHAR-01-ARJUN'], availableBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'], availableCharacters: ['@CHAR-01-ARJUN'] }).ok === true);
  check('SL4 a missing required background fails closed',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-09-ABSENT'], requiredCharacters: [], availableBackgrounds: INV_B, availableCharacters: INV_C }).code === 'SCENE_REQUIRED_BACKGROUND_MISSING');
  check('SL5 a missing required character fails closed',
    H.verifySceneAssetLocks({ requiredBackgrounds: [], requiredCharacters: ['@CHAR-09-ABSENT'], availableBackgrounds: INV_B, availableCharacters: INV_C }).code === 'SCENE_REQUIRED_CHARACTER_MISSING');
  check('SL6 an unknown asset id fails closed (never assumed present)',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-77-GHOST'], requiredCharacters: ['@CHAR-01-ARJUN'], availableBackgrounds: INV_B, availableCharacters: INV_C }).ok === false);
  check('SL7 a near-miss identity (suffix/case) does NOT satisfy the lock',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE-COPY'], requiredCharacters: [], availableBackgrounds: INV_B }).ok === false
    && H.verifySceneAssetLocks({ requiredBackgrounds: ['#bgd-01-arjun-room-wide'], requiredCharacters: [], availableBackgrounds: INV_B }).ok === false);
  check('SL8 an empty inventory fails closed rather than vacuously passing a non-empty requirement',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'], requiredCharacters: [], availableBackgrounds: [], availableCharacters: [] }).ok === false);
  check('SL9 a malformed required tag fails closed',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['bedroom'], requiredCharacters: [], availableBackgrounds: INV_B }).code === 'SCENE_REQUIRED_BACKGROUND_MISSING'
    && H.verifySceneAssetLocks({ requiredBackgrounds: [], requiredCharacters: ['Arjun'], availableCharacters: INV_C }).code === 'SCENE_REQUIRED_CHARACTER_MISSING');
  check('SL10 a sigil-variant duplicate in the inventory is ONE asset, not ambiguous',
    H.verifySceneAssetLocks({ requiredBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE'], requiredCharacters: [], availableBackgrounds: ['#BGD-01-ARJUN-ROOM-WIDE', 'BGD-01-ARJUN-ROOM-WIDE'] }).ok === true);
  check('SL11 the lock is PURE and deterministic',
    !/page|locator|await\b|fs\./.test(H.verifySceneAssetLocks.toString()));
}

// ============ TASK 4: prompt / asset correspondence ============
console.log('--- prompt and asset correspondence ---');
{
  const deps = H.resolveSceneAssetDependencies(SCENE1);
  const hardened = H.hardenFlowPrompt({ prompt: SCENE1.animation_prompt_NARRATOR_ONLY, backgrounds: CANON_BGS, characters: CANON_CHARS });
  check('PC1 the hardened prompt corresponds exactly to the scene\'s declared background',
    hardened.ok && hardened.resolved.some((x) => x.kind === 'background' && x.tag === deps.backgroundTags[0]));
  check('PC2 the hardened prompt corresponds exactly to the scene\'s declared characters',
    hardened.ok && deps.characterTags.every((t) => hardened.resolved.some((x) => x.kind === 'character' && x.tag === t)));
  check('PC3 no residual machine identifier survives', hardened.ok && H.findResidualMachineIds(hardened.hardenedPrompt).length === 0);
  check('PC4 every resolved description is non-empty (no blank replacement)',
    hardened.ok && hardened.resolved.every((x) => x.description.trim().length > 0));
  // A second declared background that has NO canonical metadata entry must stop the run before the
  // composer is ever touched.
  const sceneWithUnresolvable = { ...SCENE1, animation_prompt_NARRATOR_ONLY: 'ACTIVE ENVIRONMENT: #BGD-01-ARJUN-ROOM-WIDE\nSECOND: #BGD-99-NO-METADATA' };
  check('PC5 a scene declaring an asset with NO canonical metadata fails closed before generation',
    H.resolveSceneAssetDependencies(sceneWithUnresolvable).ok === true
    && H.hardenFlowPrompt({ prompt: sceneWithUnresolvable.animation_prompt_NARRATOR_ONLY, backgrounds: CANON_BGS, characters: CANON_CHARS }).ok === false);
  check('PC5b a resolvable second background hardens cleanly',
    H.hardenFlowPrompt({ prompt: 'A: #BGD-01-ARJUN-ROOM-WIDE\nB: #BGD-02-ARJUN-ROOM-WINDOW-CLOSE', backgrounds: CANON_BGS, characters: CANON_CHARS }).ok === true);
}

// ============ TASK 1/6: Flow staging protects the existing local artifact ============
console.log('--- flow staging path protection ---');
{
  const existingLocal = path.join(path.resolve(OUT_ROOT), PID, 'scene-0001.mp4');
  const staging = ST.flowStagingClipFilename(1);
  check('FS1 the staging filename is distinct from the local filename',
    staging === 'flow-scene-0001.mp4' && ST.localSceneClipFilename(1) === 'scene-0001.mp4' && staging !== ST.localSceneClipFilename(1));
  const p = ST.resolveSceneArtifactPaths({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, authority: 'FLOW_GENERATED' });
  check('FS2 a Flow download lands ONLY on the staging path, never on scene-0001.mp4',
    p.ok === true && p.flowStagingPath.endsWith(path.join(PID, 'flow-scene-0001.mp4'))
    && p.flowStagingPath !== existingLocal && p.localPath === existingLocal && p.localPathIsProtected === true, p);
  check('FS3 the same holds when the authority is LOCAL_SYNTHESIS',
    ST.resolveSceneArtifactPaths({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, authority: 'LOCAL_SYNTHESIS' }).flowStagingPath === p.flowStagingPath);
  check('FS4 an unknown authority defaults to LOCAL_SYNTHESIS and still stages to the Flow path',
    ST.resolveSceneArtifactPaths({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1 }).authority === 'LOCAL_SYNTHESIS');
  check('FS5 the download target guard accepts the staging filename',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: 'flow-scene-0001.mp4' }).ok === true);
  check('FS6 the download target guard REFUSES scene-0001.mp4 outright',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: 'scene-0001.mp4' }).code === 'FLOW_DOWNLOAD_TARGET_PROTECTED');
  check('FS7 the guard refuses ANY local scene- prefix, not just the exact name',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 7, proposedFilename: 'scene-0007.mp4' }).code === 'FLOW_DOWNLOAD_TARGET_PROTECTED');
  check('FS8 the guard refuses any path whose basename is the protected local artifact',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: '.\\scene-0001.mp4' }).code === 'FLOW_DOWNLOAD_TARGET_PROTECTED'
    && ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: `./scene-0001.mp4` }).code === 'FLOW_DOWNLOAD_TARGET_PROTECTED'
    && ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: `${PID}/scene-0001.mp4` }).code === 'FLOW_DOWNLOAD_TARGET_PROTECTED');
  check('FS9 the guard refuses any other wrong filename',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1, proposedFilename: 'final-title.mp4' }).code === 'FLOW_DOWNLOAD_TARGET_INVALID');
  check('FS10 the guard defaults to the staging filename when none is proposed',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 1 }).path === p.flowStagingPath);
  check('FS11 an invalid scene number is rejected by both helpers',
    ST.resolveFlowDownloadTarget({ outputsDir: OUT_ROOT, projectId: PID, sceneNumber: 0 }).code === 'FLOW_DOWNLOAD_TARGET_INVALID'
    && ST.resolveSceneArtifactPaths({ outputsDir: '', sceneNumber: 1 }).ok === false);
  check('FS12 the staging module exposes NO function that writes, copies, renames or deletes anything',
    !/writeFile|rename|copyFile|unlink|rm\(|mkdir|fsp|fs\./.test(
      ST.localSceneClipFilename.toString() + ST.flowStagingClipFilename.toString()
      + ST.resolveSceneArtifactPaths.toString() + ST.resolveFlowDownloadTarget.toString()));
  const promo = ST.promoteFlowStagingToLocalArtifact({});
  check('FS13 promotion is explicit and NOT implemented by default',
    promo.ok === false && promo.status === 'NOT_IMPLEMENTED' && promo.unmet.length === 5, promo);
  check('FS14 promotion stays blocked even when every non-authorization precondition is met',
    ST.promoteFlowStagingToLocalArtifact({
      stagingPath: 'x', localPath: 'y', identityVerified: true, persistenceVerified: true,
      downloadVerified: true, mediaValidated: true, explicitUserAuthorization: false,
    }).ok === false);
  check('FS15 promotion is blocked with an explicit authorization flag alone (still unimplemented)',
    ST.promoteFlowStagingToLocalArtifact({
      stagingPath: 'x', localPath: 'y', identityVerified: true, persistenceVerified: true,
      downloadVerified: true, mediaValidated: true, explicitUserAuthorization: true,
    }).status === 'NOT_IMPLEMENTED');
}

// ============ TASK 6: source-level safety audits ============
console.log('--- existing artifact safety audits ---');
{
  const stagingSrc = await fs.readFile(`${SRC}/flowStaging.ts`, 'utf8');
  const stagingCode = stagingSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const lifecycleSrc = await fs.readFile(`${SRC}/firstClipLifecycle.ts`, 'utf8');
  // Comments are stripped before the I/O audit so prose about what the module REFUSES to do is not
  // mistaken for the module doing it.
  check('SA1 the staging module contains no filesystem write/rename/delete call (comments excluded)',
    !/\b(?:writeFile|copyFile|rename|unlink|rm|mkdir|appendFile|createWriteStream|fsp\.)\s*\(/.test(stagingCode)
    && !/from 'node:fs/.test(stagingCode));
  check('SA2 the staging module never names state.json or final-title.mp4',
    !/state\.json|final-title\.mp4/.test(stagingCode));
  check('SA3 the lifecycle does not write the local scene artifact during Flow staging',
    !/scene-\$\{.*\}\.mp4/.test(lifecycleSrc) && /destinationPath/.test(lifecycleSrc));
  check('SA4 the lifecycle runs the scene lock + hardening BEFORE the credit-consuming port call',
    lifecycleSrc.indexOf("phases.push('PROMPT_HARDENING')") < lifecycleSrc.indexOf('port.generateProjectFirstClip('));
  check('SA5 the lifecycle hands the BUILT prompt to the port, not the raw scene prompt',
    /port\.generateProjectFirstClip\(promptToFill\)/.test(lifecycleSrc)
    && /promptToFill = input\.scene \? built\.prompt/.test(lifecycleSrc)
    && /const scenePrompt = input\.scene\s*\n\s*\? selectFirstClipScenePrompt\(input\.scene\)/.test(lifecycleSrc));
  check('SA6 the lifecycle exposes a PROMPT_HARDENING_FAILED code',
    /'PROMPT_HARDENING_FAILED'/.test(lifecycleSrc));
  check('SA7 the preflight phases are declared separately from the frozen nine-phase order',
    FCL.FIRST_CLIP_LIFECYCLE_PHASES.join(',') === 'PROJECT_SETTINGS,ASSET_LOCKS,RESTORE_PROJECT_ROUTE,FIRST_CLIP_PROJECT_GENERATION,FIRST_CLIP_RESULT,SCENE_RESOLUTION,PERSIST_FIRST_CLIP_CHECKPOINT,DOWNLOAD,VALIDATE'
    && FCL.FIRST_CLIP_PREFLIGHT_PHASES.join(',') === 'SCENE_REQUIRED_ASSET_LOCKS,PROMPT_HARDENING');
  check('SA8 the hardening module has no browser/Playwright dependency',
    !/playwright|\.page\b|locator|chromium/i.test(await fs.readFile(`${SRC}/flowPromptHardening.ts`, 'utf8')));
  // The protected artifact itself must still be intact and unmodified.
  //
  // BASELINE HISTORY: this guard originally pinned the 22 s LOCAL_SYNTHESIS render
  // (2,770,756 bytes). Scene 1 was subsequently PROMOTED, under explicit user authorisation,
  // to its genuine Flow-produced clip through the existing SUPPLIED_VIDEO path, so the authorized
  // artifact is now that Flow clip. The guard's purpose is UNCHANGED - it still proves the
  // protected Scene 1 output is byte-for-byte the authorized one and was not silently rewritten.
  // It is now strictly STRONGER: it pins size AND sha256, so a same-size substitution is caught.
  const SCENE_1_AUTHORIZED = { size: 2964630, sha256: '1DB70F2B7897849A2A735AFACEB105B18EAF7E5B19728B3D758D34FBB7E4FE8A' };
  const mp4 = path.join(OUT_ROOT, PID, 'scene-0001.mp4');
  let exists = true; let size = 0; let sha256 = '';
  try { size = (await fs.stat(mp4)).size; } catch { exists = false; }
  if (exists) { sha256 = createHash('sha256').update(await fs.readFile(mp4)).digest('hex').toUpperCase(); }
  check('SA9 the existing scene-0001.mp4 is still present at its authorized size and sha256', exists === true && size === SCENE_1_AUTHORIZED.size, { exists, size });
  check('SA9b the authorized scene-0001.mp4 is byte-for-byte unmodified (sha256)', exists === true && sha256 === SCENE_1_AUTHORIZED.sha256, { sha256 });
  // BASELINE HISTORY: this guard originally pinned the pre-promotion project state -
  // `AWAITING_APPROVAL` with scene 1 rendered by `LOCAL_SYNTHESIS`. Scenes 1 and 2 were then
  // PROMOTED, under explicit user authorisation, to their genuine Flow-produced clips through the
  // existing SUPPLIED_VIDEO path. The project then completed its downstream EDIT/MIX/BED/TITLE run
  // to `COMPLETED_TO_APPROVAL`, so the state is now `AWAITING_APPROVAL`.
  //
  // The `WAITING_FOR_INPUTS` pin that briefly sat here was STALE, not a regression: it described a
  // state the project legitimately passed through on its way to the approval gate. Rather than
  // re-pin a stage number that is expected to move again, the guard now asserts the invariant it
  // exists to protect — the project has reached the approval gate and has NOT been approved — by
  // pairing `AWAITING_APPROVAL` with the ABSENCE of this project's own approval.json. A silent
  // re-render of scene 1, a regression of scene 1's render provenance, or an implicit/improper
  // approval are all still caught. Nothing was weakened: the scene-1 conjuncts are untouched, and
  // the state check is strictly harder to satisfy than a bare state string, because it now also
  // requires that no approval record exists for this exact project directory.
  const st = JSON.parse(await fs.readFile(path.join(OUT_ROOT, PID, 'state.json'), 'utf8'));
  // Project-scoped: <outputs>/<PID>/approval.json for THIS project, never a shared/other directory.
  const approvalFile = path.join(OUT_ROOT, PID, 'approval.json');
  let approvalExists = true;
  try { await fs.stat(approvalFile); } catch { approvalExists = false; }
  check('SA10 project is at the approval gate and is NOT approved: AWAITING_APPROVAL, no approval.json',
    st.state === 'AWAITING_APPROVAL' && approvalExists === false,
    { state: st.state, approvalFile, approvalExists });
  check('SA10b scene 1 is still CURRENT via SUPPLIED_VIDEO (render provenance unchanged)',
    st.scenes['1'].output_state === 'CURRENT' && st.scenes['1'].render_mode === 'SUPPLIED_VIDEO',
    { output_state: st.scenes['1'].output_state, render_mode: st.scenes['1'].render_mode });
}

console.log(`\n${passed} prompt-hardening / staging checks passed (fully offline).`);
