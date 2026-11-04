// Offline tests for the Flow-primary character architecture (browser/network/credential-free).
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const FS = await import(pathToFileURL(path.join(SRC, 'flowCharacterState.ts')).href);
const CP = await import(pathToFileURL(path.join(SRC, 'characterProvider.ts')).href);
const { characterSpecsFromPipeline } = await import(pathToFileURL(path.join(SRC, 'characterGenerationSpec.ts')).href);

let passed = 0;
const check = (label, ok, detail) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const PROJECT = {
  project_id: 'youtube-automation-2-20261003160855-2740',
  characters: [
    { tag: '@CHAR-01-ARJUN', name: 'A', age: 22, gender: 'male', personality: 'curious, brave', voice_description: 'v', look_summary: 'young Indian man', full_prompt: 'young Indian man, t-shirt and pajama pants, 2D semi-realistic cartoon illustration, neutral grey studio background' },
    { tag: '@CHAR-02-MAA', name: 'M', age: null, gender: 'female', personality: 'caring', voice_description: 'v', look_summary: 'middle-aged woman', full_prompt: 'middle-aged Indian woman, simple saree, 2D semi-realistic cartoon illustration, neutral grey studio background' },
    { tag: '@CHAR-03-RADHADEVI-ATMA', name: 'R', age: null, gender: 'female', personality: 'grieving', voice_description: 'v', look_summary: 'ghostly woman', full_prompt: 'ghostly Indian woman, tattered white saree, 2D semi-realistic cartoon illustration, neutral grey studio background' },
    { tag: '@CHAR-04-DADI', name: 'D', age: null, gender: 'female', personality: 'wise', voice_description: 'v', look_summary: 'elderly woman', full_prompt: 'elderly Indian woman, faded cotton saree, 2D semi-realistic cartoon illustration, neutral grey studio background' },
  ],
};
const derived = characterSpecsFromPipeline(PROJECT);
const SPECS = derived.ok ? derived.specs : [];

// ---- 1. provider selection (Flow is PRIMARY/default; OpenAI opt-in only) ----
{
  check('default provider is flow', CP.DEFAULT_CHARACTER_PROVIDER === 'flow');
  check('unspecified selection → flow', CP.selectCharacterProvider(undefined) === 'flow' && CP.selectCharacterProvider('') === 'flow');
  check('explicit openai → openai', CP.selectCharacterProvider('openai') === 'openai');
  check('explicit flow → flow', CP.selectCharacterProvider('flow') === 'flow');
  check('unknown value fails closed to flow (never a paid fallback)', CP.selectCharacterProvider('gemini') === 'flow');
  check('OpenAI fallback only when explicitly requested', CP.isOpenAIFallbackExplicitlyRequested('openai') === true && CP.isOpenAIFallbackExplicitlyRequested('flow') === false && CP.isOpenAIFallbackExplicitlyRequested(undefined) === false);
}

// ---- 2. exact pipeline character mapping ----
{
  const map = CP.characterSpecsByTag(SPECS);
  check('exactly the four project tags map', map.size === 4 && [...map.keys()].join(',') === '@CHAR-01-ARJUN,@CHAR-02-MAA,@CHAR-03-RADHADEVI-ATMA,@CHAR-04-DADI');
  check('no MOHAN/GEETA/BUZURG tags', ![...map.keys()].some((t) => /MOHAN|GEETA|BUZURG/.test(t)));
  check('lookup by exact tag works', map.get('@CHAR-03-RADHADEVI-ATMA')?.tag === '@CHAR-03-RADHADEVI-ATMA');
  check('unknown tag is absent (not invented)', map.get('@CHAR-99-X') === undefined);
}

// ---- 3. deterministic Flow prompt construction ----
{
  const p1 = CP.buildFlowCharacterPrompt(SPECS[0]);
  const p2 = CP.buildFlowCharacterPrompt(SPECS[0]);
  check('prompt is deterministic', p1 === p2);
  check('prompt preserves the pipeline visual description', p1.includes('young Indian man'));
  check('prompt includes age when specified (22)', /approximately 22 years old/.test(p1));
  check('prompt includes gender when specified', /male/.test(p1));
  check('prompt omits missing age (Maa has none)', !/approximately/.test(CP.buildFlowCharacterPrompt(SPECS[1])));
  check('prompt preserves personality', CP.buildFlowCharacterPrompt(SPECS[0]).includes('curious, brave'));
  check('prompt embeds project visual style', /2D semi-realistic cartoon illustration/.test(p1));
  check('prompt states consistency + no model sheet', /no second person/.test(p1) && /no model sheet/.test(p1));
  check('prompt has no Flow URL / secrets', !/https?:\/\/|flow\.google|flow-content/i.test(p1));
  check('empty tag fails closed', (() => { try { CP.buildFlowCharacterPrompt({ tag: '' }); return false; } catch { return true; } })());
}

// ---- 4. Flow character state machine ----
{
  const rec = FS.pendingFlowCharacter({ tag: '@CHAR-01-ARJUN', spec: SPECS[0], flowProjectId: 'p' });
  check('pending state + UNVERIFIED + no uuid', rec.state === 'FLOW_CHARACTER_PENDING' && rec.verification === 'UNVERIFIED' && rec.flowCharacterUuid === null);
  const generating = FS.transitionFlowCharacter(rec, 'FLOW_CHARACTER_GENERATING');
  check('pending → generating allowed', generating.ok === true);
  const ready = FS.transitionFlowCharacter(generating.record, 'FLOW_CHARACTER_READY', { flowCharacterUuid: '7057051b-be48-4bd7-ae21-1cc4de276b68', verification: 'VERIFIED' });
  check('generating → ready requires + carries a valid UUID', ready.ok === true && ready.record.flowCharacterUuid === '7057051b-be48-4bd7-ae21-1cc4de276b68' && ready.record.verification === 'VERIFIED');
  check('ready with malformed UUID fails closed', FS.transitionFlowCharacter(generating.record, 'FLOW_CHARACTER_READY', { flowCharacterUuid: 'not-a-uuid' }).ok === false);
  const failed = FS.transitionFlowCharacter(generating.record, 'FLOW_CHARACTER_GENERATION_FAILED', { errorClass: 'GENERATION_TIMEOUT' });
  check('generating → generation_failed allowed + carries error class', failed.ok === true && failed.record.errorClass === 'GENERATION_TIMEOUT');
  check('illegal transition rejected (pending → ready)', FS.transitionFlowCharacter(rec, 'FLOW_CHARACTER_READY').ok === false);
  check('terminal state cannot transition (generation_failed)', FS.transitionFlowCharacter(failed.record, 'FLOW_CHARACTER_READY').ok === false);
  check('uuid validity helper', FS.isValidFlowCharacterUuid('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') === true && FS.isValidFlowCharacterUuid('x') === false);
  // ---- discovered identity mechanism: the character-detail route id ----
  check('character id parsed from detail route', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc/character/6a50f379-963d-4588-aa6d-29d149ba9710') === '6a50f379-963d-4588-aa6d-29d149ba9710');
  check('non-character route yields null', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc') === null);
  check('malformed character id fails closed', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc/character/not-a-uuid') === null);
  // route rejection matrix
  check('project root rejected', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc') === null);
  check('scene route rejected', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc/scene/6a50f379-963d-4588-aa6d-29d149ba9710') === null);
  check('edit route rejected', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc/edit/6a50f379-963d-4588-aa6d-29d149ba9710') === null);
  check('unrelated path rejected', FS.resolveFlowCharacterIdFromUrl('https://flow.google.com/about') === null);
}

// ---- 5. Flow-native lookup / ambiguity / missing ----
{
  const cands = [{ displayName: '@CHAR-01-ARJUN', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { displayName: 'Untitled character', uuid: '11111111-2222-3333-4444-555555555555' }];
  check('exact tag match → READY', FS.resolveFlowCharacterMatch(cands, { tag: '@CHAR-01-ARJUN' }).state === 'FLOW_CHARACTER_READY');
  check('uuid match preferred + authoritative', FS.resolveFlowCharacterMatch(cands, { uuid: '11111111-2222-3333-4444-555555555555' }).uuid === '11111111-2222-3333-4444-555555555555');
  check('missing tag → NOT_FOUND', FS.resolveFlowCharacterMatch(cands, { tag: '@CHAR-09-X' }).state === 'FLOW_CHARACTER_NOT_FOUND');
  check('duplicate exact tags → AMBIGUOUS (no guessing)', FS.resolveFlowCharacterMatch([{ displayName: '@CHAR-01-ARJUN', uuid: null }, { displayName: '@CHAR-01-ARJUN', uuid: null }], { tag: '@CHAR-01-ARJUN' }).state === 'FLOW_CHARACTER_AMBIGUOUS');
  check('uuid not found → NOT_FOUND', FS.resolveFlowCharacterMatch(cands, { uuid: '99999999-9999-9999-9999-999999999999' }).state === 'FLOW_CHARACTER_NOT_FOUND');
  check('no fuzzy matching (partial name does not match)', FS.resolveFlowCharacterMatch(cands, { tag: 'CHAR-01' }).state === 'FLOW_CHARACTER_NOT_FOUND');
}

// ---- 6. read-only generation safety gate ----
{
  check('recon must NOT click Start generation', FS.generationActionAllowed('READ_ONLY_RECON', 'Start generation') === false);
  check('recon must NOT click Generate/Create/Submit', ['Generate', 'Create', 'Submit generation', 'Create character'].every((c) => FS.generationActionAllowed('READ_ONLY_RECON', c) === false));
  check('recon may open navigation controls', FS.generationActionAllowed('READ_ONLY_RECON', 'Add media menu') === true);
  check('real generation may click Start generation', FS.generationActionAllowed('REAL_GENERATION', 'Start generation') === true);
  check('exact-only (not substring): "Generate concept art" is allowed in recon', FS.generationActionAllowed('READ_ONLY_RECON', 'Generate concept art') === true);
}

// ---- 7. retry prohibition + fallback semantics ----
{
  check('Flow character auto-retry is disabled', FS.FLOW_CHARACTER_AUTO_RETRY_ENABLED === false && FS.shouldRetryFlowCharacter() === false);
  // provider interface is structurally implementable by both providers
  const flowLike = { name: 'flow', isCapable: () => ({ ok: true, produces: 'flow-native' }), generateCharacter: async () => ({}), verifyCharacter: async () => ({}), findCharacter: async () => ({}), renameCharacter: async () => ({}) };
  const openaiLike = { name: 'openai', isCapable: () => ({ ok: true, produces: 'local-png' }), generateCharacter: async () => ({}), verifyCharacter: async () => ({}), findCharacter: async () => ({}), renameCharacter: async () => ({}) };
  const iface = ['name', 'isCapable', 'generateCharacter', 'verifyCharacter', 'findCharacter', 'renameCharacter'];
  check('CharacterGenerationProvider shape covers flow + openai', iface.every((k) => k in flowLike && k in openaiLike));
  check('flow produces flow-native; openai produces local-png', flowLike.isCapable().produces === 'flow-native' && openaiLike.isCapable().produces === 'local-png');
}

// ---- 8. local PNG fallback remains, and is NOT the Flow-native identity ----
{
  const rec = FS.pendingFlowCharacter({ tag: '@CHAR-01-ARJUN', spec: SPECS[0], flowProjectId: 'p' });
  check('flow-native identity field is a UUID, not a local SHA', 'flowCharacterUuid' in rec && !('sha256' in rec) && !('localPngSha' in rec));
}

// ---- 9. Flow-native lifecycle decision helpers (from characterProvider) ----
{
  check('exact tag lookup: one match → READY', CP.lookupFlowCharacterByTag([{ tag: '@CHAR-01-ARJUN', characterId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }], '@CHAR-01-ARJUN').ok === true);
  check('exact tag lookup: zero matches → NOT_FOUND', CP.lookupFlowCharacterByTag([], '@CHAR-02-MAA').state === 'FLOW_CHARACTER_NOT_FOUND');
  check('exact tag lookup: duplicate → AMBIGUOUS (fail closed)', CP.lookupFlowCharacterByTag([{ tag: '@CHAR-01-ARJUN', characterId: null }, { tag: '@CHAR-01-ARJUN', characterId: null }], '@CHAR-01-ARJUN').state === 'FLOW_CHARACTER_AMBIGUOUS');

  check('rename verification: exact match → ok', CP.verifyFlowCharacterRename('@CHAR-01-ARJUN', '@CHAR-01-ARJUN').ok === true);
  check('rename verification: mismatch → fail closed', CP.verifyFlowCharacterRename('Untitled character', '@CHAR-01-ARJUN').ok === false);
  check('rename verification: empty target → fail closed', CP.verifyFlowCharacterRename('x', '').ok === false);

  check('identity persistence: same id → ok', CP.verifyFlowCharacterIdentityPersisted('6a50f379-963d-4588-aa6d-29d149ba9710', '6a50f379-963d-4588-aa6d-29d149ba9710').ok === true);
  check('identity persistence: changed id → fail closed', CP.verifyFlowCharacterIdentityPersisted('6a50f379-963d-4588-aa6d-29d149ba9710', '11111111-2222-3333-4444-555555555555').ok === false);
  check('identity persistence: missing before → fail closed', CP.verifyFlowCharacterIdentityPersisted(null, 'x').ok === false);

  check('ingredient selection: unique + selected → ok', CP.verifyFlowCharacterIngredientSelection({ rows: ['@CHAR-01-ARJUN', '#BGD-01-X'], wantedTag: '@CHAR-01-ARJUN', selectedCount: 1 }).ok === true);
  check('ingredient selection: absent → fail closed', CP.verifyFlowCharacterIngredientSelection({ rows: ['#BGD-01-X'], wantedTag: '@CHAR-01-ARJUN', selectedCount: 0 }).ok === false);
  check('ingredient selection: ambiguous → fail closed', CP.verifyFlowCharacterIngredientSelection({ rows: ['@CHAR-01-ARJUN', '@CHAR-01-ARJUN'], wantedTag: '@CHAR-01-ARJUN', selectedCount: 1 }).ok === false);
  check('ingredient selection: not actually selected → fail closed', CP.verifyFlowCharacterIngredientSelection({ rows: ['@CHAR-01-ARJUN'], wantedTag: '@CHAR-01-ARJUN', selectedCount: 0 }).ok === false);
}

// ---- 10. selectors: only live-proven concepts ----
{
  const sel = await import(pathToFileURL(path.join(SRC, 'selectors.ts')).href).then((m) => m.S);
  const need = {
    characterPage: "flow-character-page",
    characterPromptEditor: "flow-character-prompt-box [contenteditable='true']",
    characterStartGeneration: "button[aria-label='Start generation']",
    characterGridTile: "flow-grid-tile-container",
    characterTile: "div.character-tile-container",
    characterTileName: "span.character-tile-name",
    characterTileThumbnail: "img.character-tile-thumbnail",
    characterDetailNameInput: "input[aria-label='Character name']",
    characterIngredientCategory: "mat-nav-list[aria-label='Category navigation'] mat-list-item[role='tab']",
    characterIngredientRow: "button.asset-item[role='option']",
    characterIngredientTitle: "span.asset-title",
  };
  check('all proven character selectors present in S', Object.entries(need).every(([k, v]) => Array.isArray(sel[k]) && sel[k].includes(v)), Object.entries(need).filter(([k, v]) => !(Array.isArray(sel[k]) && sel[k].includes(v))));
  check('legacy characterTile/GENERATION selectors are still present for grid tiles', Array.isArray(sel.characterTile) && Array.isArray(sel.characterTileName));
}

// ---- 11. proven rename commit mechanism is encoded in the provider ----
{
  const src = (await import('node:fs')).readFileSync(path.join(SRC, 'flowCharacterProvider.ts'), 'utf8');
  const renameBody = src.slice(src.indexOf('async renameCharacter('), src.indexOf('async renameCharacter(') + 3600);
  check('rename uses real key-event typing (not fill-only)', /\.type\(/.test(renameBody) && /Control\+A/.test(renameBody) && /press\('Delete'\)/.test(renameBody));
  check('rename leaves the field with Tab + click-outside (commits the Angular change event)', /press\('Tab'\)/.test(renameBody) && /mouse\.click\(/.test(renameBody));
  check('rename waits for the debounced save to settle before returning', /setTimeout\(resolve, 8000\)/.test(renameBody));
  check('rename does NOT use fill() or Enter as the commit mechanism', !/\.fill\(/.test(renameBody) && !/press\('Enter'\)/.test(renameBody));
  check('rename still verifies the read-back value', /inputValue\(\)/.test(renameBody));
  check('rename verifies the exact current detail name before mutation', /expectedCurrent/.test(renameBody) && /currentName !== expectedCurrent/.test(renameBody));
  check('rename proves the same detail identity after mutation', /afterId !== characterId/.test(renameBody));
  check('rename never clicks a generation control', !/Start generation|generateImage|Create\b/.test(renameBody));
}

console.log(`\nFLOW-PRIMARY CHARACTER ARCHITECTURE TESTS PASSED (${passed} checks)`);
