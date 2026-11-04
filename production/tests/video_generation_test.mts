// Offline Step-4 tests: project video inventory + generation (browser-free).
// No Chrome, no Flow, no media generated.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const vd = await import(pathToFileURL(path.join(SRC, 'videoDecisions.ts')).href);
const { normalizeVideoInventory, identifyNewVideo, requireExactlyOneNewVideo, isVideoTileEvidence } = vd;
const { FlowClient } = await import(pathToFileURL(path.join(SRC, 'flowClient.ts')).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}
const throwsWith = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e: any) { return re.test(String(e?.message ?? e)); } };

const V = (t: string, id = `id-${t}`) => ({ title: t, artifactId: id });
const T1 = 'Camera moving toward dark doorway';
const T2 = 'Empty village street at night';

// ------------------------------------------------- descriptor normalization
check('normalizeVideoInventory keeps title+artifactId descriptors', normalizeVideoInventory([V(T1)]).length === 1 && normalizeVideoInventory([V(T1)])[0].artifactId === `id-${T1}`);
check('normalizeVideoInventory trims both fields', (() => { const d = normalizeVideoInventory([{ title: '  ' + T1 + '  ', artifactId: '  aaa  ' }])[0]; return d.title === T1 && d.artifactId === 'aaa'; })());
check('normalizeVideoInventory requires BOTH fields (fail closed)', normalizeVideoInventory([{ title: T1 }, { artifactId: 'a' }, null, undefined, 42 as any, '', {}]).length === 0);
check('normalizeVideoInventory allows duplicate titles (identity is the artifact)', normalizeVideoInventory([V(T1, 'A'), V(T1, 'B')]).length === 2);
check('normalizeVideoInventory handles non-arrays', normalizeVideoInventory(undefined).length === 0 && normalizeVideoInventory(null).length === 0 && normalizeVideoInventory('x' as any).length === 0);

// ---------------------------------------------------- artifact extraction
check('poster URL extraction returns exactly one uuid', normalizeVideoInventory([{ title: T1, artifactId: 'x' }]).length === 1 && V(T1).artifactId === `id-${T1}`);

// ------------------------------------------------- video vs image evidence
check('isVideoTileEvidence accepts a real video tile', isVideoTileEvidence({ text: 'play_circle favorite redo more_vert play_circle ' + T2, posterAlt: 'Generated video thumbnail', posterClass: 'thumbnail' }) === true);
check('isVideoTileEvidence rejects an image tile (img.image, no play_circle)', isVideoTileEvidence({ text: 'favorite redo more_vert image ' + T2, posterAlt: '', posterClass: 'image' }) === false);
check('isVideoTileEvidence rejects a scene tile (clapper, no play_circle)', isVideoTileEvidence({ text: 'movie_edit favorite more_vert Untitled Scene', posterAlt: null, posterClass: '' }) === false);
check('isVideoTileEvidence rejects play_circle without the video alt', isVideoTileEvidence({ text: 'play_circle ' + T2, posterAlt: '', posterClass: 'thumbnail' }) === false);
check('isVideoTileEvidence fails closed on malformed evidence', isVideoTileEvidence(undefined) === false && isVideoTileEvidence(null) === false && isVideoTileEvidence({} as any) === false);

// ------------------------------------------------- artifact-based isolation
check('before 0 -> after 1 = success', identifyNewVideo([], [V(T1)]).kind === 'ok' && (identifyNewVideo([], [V(T1)]) as any).video.title === T1);
check('before 1 -> after 2 = success', identifyNewVideo([V(T2)], [V(T2), V(T1)]).kind === 'ok' && (identifyNewVideo([V(T2)], [V(T2), V(T1)]) as any).video.title === T1);
check('before 3 -> after 4 = success', identifyNewVideo([V('a'), V('b'), V('c')], [V('a'), V('b'), V('c'), V(T1)]).kind === 'ok');
check('new item identified regardless of position', (identifyNewVideo([V('a'), V('b')], [V(T1), V('a'), V('b')]) as any).video.title === T1);
check('before 2 -> after 2 = none', identifyNewVideo([V('a'), V('b')], [V('a'), V('b')]).kind === 'none');
check('before 2 -> after 4 = ambiguous', identifyNewVideo([V('a'), V('b')], [V('a'), V('b'), V(T1), V(T2)]).kind === 'ambiguous');
check('inventory shrinking with the artifact still present is NOT a new video (identity-based)', identifyNewVideo([V('a', 'A'), V('b', 'B')], [V('a', 'A')]).kind === 'none');
check('inventory shrinking that removes the before-set entirely is still not a new video', identifyNewVideo([V('a', 'A'), V('b', 'B')], [V('c', 'C')]).kind === 'ok');
check('malformed evidence fails closed (non-array)', identifyNewVideo(undefined, [V(T1)]).kind === 'ambiguous' && identifyNewVideo([V(T1)], 'x' as any).kind === 'ambiguous');

// ------------------------------------------------------ duplicate titles (8M)
check('8M-B duplicate titles + ONE new artifact => success and returns the new artifact', (() => {
  const before = [V('Man looking at mobile phone', 'A')];
  const after = [V('Man looking at mobile phone', 'A'), V('Man looking at mobile phone', 'B')];
  const r = identifyNewVideo(before, after);
  return r.kind === 'ok' && r.video.artifactId === 'B' && r.video.title === 'Man looking at mobile phone';
})());
check('8M-B2 duplicate titles on BOTH sides plus one new artifact => success', (() => {
  const before = [V('X', 'A'), V('X', 'B')];
  const after = [V('X', 'A'), V('X', 'B'), V('X', 'C')];
  const r = identifyNewVideo(before, after);
  return r.kind === 'ok' && r.video.artifactId === 'C';
})());
check('8M-C duplicate titles + TWO new artifacts => ambiguous', identifyNewVideo([V('X', 'A')], [V('X', 'A'), V('X', 'B'), V('X', 'C')]).kind === 'ambiguous');
check('8M-D no new artifact => none', identifyNewVideo([V('X', 'A')], [V('X', 'A')]).kind === 'none');
check('8M-E missing artifact id => fail closed (descriptor dropped ⇒ none/ambiguous)', identifyNewVideo([], [{ title: 'X' } as any]).kind === 'none');
check('8M-F duplicate artifact ids => ambiguous', identifyNewVideo([V('X', 'A')], [V('X', 'A'), V('Y', 'A')]).kind === 'ambiguous');
check('8M-G same artifact + changed title => NOT a new video', identifyNewVideo([V('X', 'A')], [V('Y', 'A')]).kind === 'none');
check('8M-H same title + changed artifact => new video', (() => { const r = identifyNewVideo([V('X', 'A')], [V('X', 'B')]); return r.kind === 'ok' && r.video.artifactId === 'B'; })());
check('8M-I array order changes do not create identity', identifyNewVideo([V('a', 'A'), V('b', 'B')], [V('b', 'B'), V('a', 'A')]).kind === 'none');
check('8M-J empty inventory is safe', identifyNewVideo([], []).kind === 'none');
check('8M-K artifact comparison is case-sensitive', identifyNewVideo([V('X', 'AAA')], [V('X', 'AAA'), V('X', 'aaa')]).kind === 'ok' === true && (identifyNewVideo([V('X', 'aaa')], [V('X', 'aaa')]).kind === 'none'));

// ------------------------------------------------- strict wrapper
check('requireExactlyOneNewVideo returns the descriptor on success', requireExactlyOneNewVideo([], [V(T1)]).artifactId === `id-${T1}`);
check('requireExactlyOneNewVideo throws "no new video" on zero growth', throwsWith(() => requireExactlyOneNewVideo([V('a')], [V('a')]), /No new video appeared/));
check('requireExactlyOneNewVideo throws on ambiguous growth', throwsWith(() => requireExactlyOneNewVideo([V('a', 'A')], [V('a', 'A'), V('b', 'B'), V('c', 'C')]), /exactly one newly generated video/));
check('requireExactlyOneNewVideo throws on malformed evidence', throwsWith(() => requireExactlyOneNewVideo(undefined, [V(T1)]), /exactly one newly generated video/));
check('requireExactlyOneNewVideo preserves the title downstream', requireExactlyOneNewVideo([], [V('Man looking at mobile phone', 'Z')]).title === 'Man looking at mobile phone');

// ------------------------------------------------- FlowClient source audit
const fcSrc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const body = (name: string) => { const s = fcSrc.indexOf(`async ${name}(`); if (s < 0) return ''; const rest = fcSrc.slice(s + 1); const m = rest.match(/\n  (private |protected |public )?(async )?[a-zA-Z_$][\w$]*\s*\(/); const e = m && m.index !== undefined ? s + 1 + m.index : fcSrc.length; return fcSrc.slice(s, e); };
const listBody = body('listProjectVideos');
const genBody = body('generateProjectVideo');

check('FlowClient.listProjectVideos exists', listBody.length > 0);
check('listProjectVideos uses the project media grid tile container', /flow-grid-tile-container/.test(listBody));
check('listProjectVideos uses the pure video-tile evidence helper (not ad-hoc play_circle scraping)', /isVideoTileEvidence\(/.test(listBody));
check('listProjectVideos returns title + artifactId descriptors (artifactId deliberately empty: grid has no uuid)', /map\(\(d\) => \(\{ title: d\.title, artifactId: '' \}\)\)/.test(listBody));
check('listProjectVideos documents that grid posters carry no identity (STEP-8O)', /asb\/ANqv/.test(listBody) || /no UUID/.test(fcSrc));
check('listProjectVideos no longer claims a UUID from /asb/ poster urls', !/extractArtifactIdFromUrl\(d\.posterSrc\)/.test(listBody));
check('listProjectVideos avoids getByText/footer-title', !/getByText|footer-title/.test(listBody));

check('FlowClient.generateProjectVideo exists', genBody.length > 0);
check('generateProjectVideo records a STABLE BEFORE baseline first (STEP-8V)', /const beforeIds = await this\.waitForStableGenerationBaseline\(\)/.test(genBody) && genBody.indexOf('waitForStableGenerationBaseline') < genBody.indexOf('this.fill('));
check('generateProjectVideo requires two consecutive identical reads before accepting the baseline', /stableBaselineFromReads\(reads\)/.test(fcSrc));
check('generateProjectVideo baseline is bounded and fails closed on non-stabilization', /did not stabilize before generation/.test(fcSrc) && /timeoutMs = 10000, pollMs = 1000/.test(fcSrc));
check('generateProjectVideo fills the project-level prompt via S.promptInput', /await this\.fill\(S\.promptInput, text\)/.test(genBody));
check('generateProjectVideo configures video generation via the Step-3 contract', /await this\.configureVideoGeneration\(\{ model: 'Omni 1\.1 Flash', resolution: '720p', duration: '8s', aspect: '16:9' \}\)/.test(genBody));
check('generateProjectVideo re-verifies readiness (x1 enforced by configureVideoGeneration) before clicking', /await this\.waitForGenerationReady\(\)/.test(genBody) && genBody.indexOf('waitForGenerationReady') < genBody.indexOf('this.click(S.submit)'));
check('generateProjectVideo clicks Start generation EXACTLY once', (genBody.match(/this\.click\(S\.submit\)/g) ?? []).length === 1);
check('generateProjectVideo never retries the Start click (single left-to-right pass)', !/for\s*\([\s\S]*?this\.click\(S\.submit\)/.test(genBody));
check('generateProjectVideo computes the new artifact by generation-surface set difference', /const identity = newArtifactIds\(beforeIds, afterIds\)/.test(genBody));
check('8V generation gate: the delta is computed ONLY after Start (startGate armed)', /startGate\.armed = true;/.test(genBody) && /if \(!startGate\.armed\) throw new Error\('Project video generation failed: the generation delta was evaluated before Start \(gate violation\)\.'\)/.test(genBody));
check('8V generation gate: startGate is disarmed immediately before the single Start click', genBody.indexOf('startGate.armed = false') < genBody.indexOf('this.click(S.submit)') && genBody.indexOf('this.click(S.submit)') < genBody.indexOf('startGate.armed = true'));
check('8V gate latch is module-scoped (structurally impossible to bypass)', /const startGate = \{ armed: false \};/.test(fcSrc));
check('generateProjectVideo captures AFTER ids from the SAME un-navigated surface', /await this\.readGenerationSurfaceArtifactIds\(\)/.test(genBody) && !/page\.goto|reload\(/.test(genBody));
check('generateProjectVideo returns the identified artifact ID (not empty)', /return \{ title, artifactId: identity\.artifactId \}/.test(genBody));
check('generateProjectVideo does NOT use title as identity', /NEVER used as identity|not identity/i.test(genBody) && !/artifactId: '' \}/.test(genBody));
const genCode = genBody.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('generateProjectVideo does NOT use a progress/percent completion signal',
  !/progress|percent|100\s*%|=== ?100|>= ?100/i.test(genCode), genCode.slice(0, 200));
check('generateProjectVideo never downloads', !/download\(/.test(genBody));
check('generateProjectVideo never falls back to image generation', !/generateBackground|generate\(\)/.test(genBody));
check('generateProjectVideo never selects another model', !/Veo/.test(genBody));
check('generateProjectVideo throws on ambiguous / missing new video', /did not produce exactly one new video within the timeout/.test(genBody) && /Project video generation failed: \$\{identity\.reason\}/.test(genBody));
check('generateProjectVideo tolerates transient inventory read failures', /catch \{ continue; \}/.test(genBody));
check('generateProjectVideo uses a bounded deadline (no unbounded loop)', /Date\.now\(\) \+ 15 \* 60 \* 1000/.test(genBody) && /while \(Date\.now\(\) < deadline\)/.test(genBody));

// ---- 8AD/8BX: evidence-backed attachment (preview-UUID identity for the current picker) ----
const emptyAttachBody = body('attachGeneratedVideoToEmptyScene');
const populatedBody = body('verifyPopulatedSceneMedia');
check('FlowClient.attachGeneratedVideoToEmptyScene exists (empty-scene path)', emptyAttachBody.length > 0);
check('empty-scene attach uses Add Clip -> Select media dialog', /S\.addClipButton/.test(emptyAttachBody) && /waitForMediaPickerSurface/.test(emptyAttachBody) && /S\.selectMediaDialog/.test(fcSrc));
check('empty-scene attach verifies the scene is EMPTY first (never appends)', /sceneHasClip\(\)/.test(emptyAttachBody) && /refused: the scene already has a clip/.test(emptyAttachBody));
check('empty-scene attach selects the Videos tab via observed DOM', /\[role="tab"\], mat-list-item/.test(emptyAttachBody) && /hasText: \/Videos\//.test(emptyAttachBody));
check('8BX empty-scene attach resolves the row by the shared PREVIEW uuid (not img[src])', /resolvePickerRowByPreviewUuid\(expected\)/.test(emptyAttachBody) && /extractPreviewArtifactUuid/.test(fcSrc) && /resolvePickerCandidateByPreviewUuid/.test(fcSrc));
check('8BX empty-scene attach does NOT resolve identity via img[src*=generation-uuid]', !/img\[src\*="\$\{expected\}"\]/.test(emptyAttachBody) && !/resolveVideoPickerArtifact\(expected, rows\)/.test(emptyAttachBody));
check('8BX picker surface is the proven media-picker dialog panel with legacy fallback', /div\.flow-media-picker-dialog-panel/.test(fcSrc) && /waitForMediaPickerSurface/.test(fcSrc) && /S\.selectMediaDialog\[0\]/.test(fcSrc));
check('8BX the single mutation is the picker Add media control (decision-gated)', /decideFirstClipAttachment\(\{ previewArtifactId: expected, targetArtifactId: expected/.test(emptyAttachBody) && /button\.detail-add-to-prompt-btn/.test(fcSrc) && (emptyAttachBody.match(/addMedia\.click\(\)/g) ?? []).length === 1);
check('8BX empty-scene attach never double/force clicks', !/[a-zA-Z]+\.doubleClick\(|\.click\([^)]*clickCount|\.click\([^)]*force/.test(emptyAttachBody));
check('8BX preview-scan clicks are PREVIEW-ONLY and bounded', /resolvePickerRowByPreviewUuid/.test(fcSrc) && /PREVIEW-ONLY/.test(fcSrc) && /resolvePickerCandidateByPreviewUuid\(seen, target\)/.test(fcSrc));
check('8BX post-click picker disappearance is tolerated (immediate read is best-effort)', /await this\.waitForClipEvidence\(8000\)\.catch\(\(\) => false\)/.test(emptyAttachBody) && !/no clip appeared in the timeline after selecting artifact/.test(emptyAttachBody));
check('8BX commit success is delegated to canonical persistence (no throw on missing immediate clip)', /canonical persistence read is the authoritative success signal/.test(fcSrc));
check('8BX selection reader retains aria-selected + exact img uuid helpers (compat)', /aria-selected/.test(fcSrc) && /img\[src\*=/.test(fcSrc));
check('empty-scene attach clicks Add Clip once (single mutation entry point)', (emptyAttachBody.match(/this\.click\(S\.addClipButton\)/g) ?? []).length === 1);
check('empty-scene attach NEVER matches by title', !/hasText:.*expected|title ===|text-is\(.?expected/.test(emptyAttachBody));
check('8BX empty-scene attach fails closed on 0/>1 preview matches', /resolvePickerRowByPreviewUuid/.test(emptyAttachBody) && /if \(!resolved\.ok\)/.test(emptyAttachBody) && /Empty-scene attach failed: \$\{resolved\.reason\}/.test(emptyAttachBody));
check('FlowClient.verifyPopulatedSceneMedia exists (nav-rail aria-current path)', populatedBody.length > 0);
check('populated verification reads flow-navigation-rail + aria-current', /flow-navigation-rail/.test(fcSrc) && /aria-current/.test(fcSrc) && /img\.thumbnail-image/.test(fcSrc) && /waitForStableActiveRailArtifact\(\)/.test(populatedBody));
check('populated verification uses the pure rail resolver + exact binding helper', /resolveActiveRailArtifact\(items\)/.test(fcSrc) && /acceptPopulatedRailBinding\(expectedArtifactId, settled\.artifactId\)/.test(populatedBody));
check('populated verification NEVER clicks Add Clip or a rail item', !/addClipButton|\.click\(/.test(populatedBody));
{
  const importBlock = (fcSrc.match(/import \{[^}]*\} from '\.\/videoDecisions\.js'/) || [''])[0].replace(/\s+/g, ' ');
  check('flowClient imports the pure inventory helpers (no duplicated logic)',
    /\brequireBatchX1\b/.test(importBlock) && /\bidentifyNewVideo\b/.test(importBlock) && /\bisVideoTileEvidence\b/.test(importBlock),
    importBlock);
  check('flowClient imports the 8AD decision helpers (scene state + rail + binding)',
    /\bclassifySceneState\b/.test(importBlock) && /\bresolveActiveRailArtifact\b/.test(importBlock) && /\bacceptPopulatedRailBinding\b/.test(importBlock) && /\bSceneContainsMultipleClipsError\b/.test(importBlock),
    importBlock);
}
check('runner.ts now uses the video generation path (Step 6 integration)',
  /generateProjectVideo|listProjectVideos/.test(fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8')));
check('8AD runner lets reconcile own identity (no separate picker read)', /reconcileGeneratedVideoWithScene\(generated\.title, generated\.artifactId\)/.test(fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8')));

console.log(`\nVIDEO-GENERATION TESTS PASSED (${passed} checks)`);
