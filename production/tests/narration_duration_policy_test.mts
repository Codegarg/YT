// Focused OFFLINE tests for the narration-preservation duration policy (pure, no browser/IO).
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const M: any = await import(pathToFileURL(`${SRC}/narrationDurationPolicy.ts`).href);
const { planSceneVideoChain }: any = await import(pathToFileURL(`${SRC}/mixFilterGraph.ts`).href);
const {
  decideNarrationPreservation, narrationPreservingOutputDuration, narrationExceedsClip,
  NARRATION_TAIL_SECONDS, MAX_NARRATION_VIDEO_STRETCH, DURATION_CONFLICT_TOLERANCE_SECONDS,
} = M;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};
const near = (a: unknown, b: unknown, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;

// ===== constants =====
check('constants: tail is 0.25s', NARRATION_TAIL_SECONDS === 0.25, NARRATION_TAIL_SECONDS);
check('constants: max stretch is 2.0', MAX_NARRATION_VIDEO_STRETCH === 2.0, MAX_NARRATION_VIDEO_STRETCH);
check('constants: conflict tolerance is 0.05s', DURATION_CONFLICT_TOLERANCE_SECONDS === 0.05, DURATION_CONFLICT_TOLERANCE_SECONDS);

// ===== CASE 1: narration shorter than clip =====
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 7.0 });
  check('CASE 1: 8.0 video / 7.0 narration -> ok', d.ok === true, d);
  check('CASE 1: requiredOutputDuration === 8.0', near(d.requiredOutputDuration, 8.0), d.requiredOutputDuration);
  check('CASE 1: stretchFactor === 1.0', near(d.stretchFactor, 1.0), d.stretchFactor);
  check('CASE 1: withinLimit true, no extension needed', d.withinLimit === true && d.needsPictureExtension === false, d);
  check('CASE 1: reason is NARRATION_FITS_CLIP', d.reason === 'NARRATION_FITS_CLIP', d.reason);
}

// ===== CASE 2: narration exactly equals clip; the TAIL forces a small extension =====
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 8.0 });
  check('CASE 2: 8.0 / 8.0 + 0.25 tail -> ok', d.ok === true, d);
  check('CASE 2: requiredOutputDuration === 8.25', near(d.requiredOutputDuration, 8.25), d.requiredOutputDuration);
  check('CASE 2: stretchFactor === 1.03125', near(d.stretchFactor, 1.03125), d.stretchFactor);
  check('CASE 2: allowed and extension required', d.withinLimit === true && d.needsPictureExtension === true, d);
  check('CASE 2: reason is NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', d.reason === 'NARRATION_EXCEEDS_CLIP_WITHIN_LIMIT', d.reason);
}

// ===== CASE 3: the Scene 15 shape (8.0 video / 12.76 narration) =====
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 12.76 });
  check('CASE 3: 8.0 / 12.76 -> ok (allowed)', d.ok === true, d);
  check('CASE 3: requiredOutputDuration === 13.01', near(d.requiredOutputDuration, 13.01), d.requiredOutputDuration);
  check('CASE 3: stretchFactor === 1.62625', near(d.stretchFactor, 1.62625), d.stretchFactor);
  check('CASE 3: within the 2.0 limit', d.withinLimit === true && near(d.stretchFactor, 1.62625) && d.stretchFactor <= MAX_NARRATION_VIDEO_STRETCH, d);
  check('CASE 3: picture extension required', d.needsPictureExtension === true, d);
  check('CASE 3: narration is NOT modified (still 12.76)', near(d.narrationDuration, 12.76), d.narrationDuration);
  check('CASE 3: source video is NOT modified (still 8.0)', near(d.sourceVideoDuration, 8.0), d.sourceVideoDuration);
}

// ===== CASE 4: exact boundary — exactly 2.0x must be ALLOWED =====
{
  // 2.0x of 8.0 => requiredOutputDuration 16.0 => narration 16.0 - 0.25 = 15.75
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 15.75 });
  check('CASE 4: 8.0 / 15.75 yields EXACTLY 2.0x', near(d.stretchFactor, 2.0, 1e-9), d.stretchFactor);
  check('CASE 4: the exact boundary is ALLOWED (ok + withinLimit)', d.ok === true && d.withinLimit === true, d);
  check('CASE 4: requiredOutputDuration === 16.0', near(d.requiredOutputDuration, 16.0), d.requiredOutputDuration);
}
// a second exact-boundary shape to prove it is not input-specific
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 5.0, narrationDuration: 9.75 });
  check('CASE 4b: 5.0 / 9.75 also yields EXACTLY 2.0x and is allowed',
    near(d.stretchFactor, 2.0, 1e-9) && d.ok === true && d.withinLimit === true, d);
}

// ===== CASE 5: over the boundary must be REJECTED =====
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: 15.751 });
  check('CASE 5: just over 2.0x -> ok === false', d.ok === false, d);
  check('CASE 5: reason is NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED', d.reason === 'NARRATION_EXCEEDS_CLIP_LIMIT_EXCEEDED', d.reason);
  check('CASE 5: withinLimit false, needsPictureExtension false', d.withinLimit === false && d.needsPictureExtension === false, d);
  check('CASE 5: detail explains the limit', /slowdown/.test(String(d.detail)) && /2x|maximum/.test(String(d.detail)), d.detail);
  check('CASE 5: the over-limit stretch factor is still reported', d.stretchFactor !== null && d.stretchFactor > MAX_NARRATION_VIDEO_STRETCH, d.stretchFactor);
}

// ===== CASE 6: invalid / non-positive durations fail closed =====
for (const [label, input] of [
  ['zero video', { sourceVideoDuration: 0, narrationDuration: 5 }],
  ['negative video', { sourceVideoDuration: -8, narrationDuration: 5 }],
  ['NaN video', { sourceVideoDuration: Number.NaN, narrationDuration: 5 }],
  ['Infinity video', { sourceVideoDuration: Number.POSITIVE_INFINITY, narrationDuration: 5 }],
  ['null video', { sourceVideoDuration: null, narrationDuration: 5 }],
  ['string video', { sourceVideoDuration: '8', narrationDuration: 5 }],
  ['zero narration', { sourceVideoDuration: 8, narrationDuration: 0 }],
  ['negative narration', { sourceVideoDuration: 8, narrationDuration: -3 }],
  ['NaN narration', { sourceVideoDuration: 8, narrationDuration: Number.NaN }],
  ['both invalid', { sourceVideoDuration: Number.NaN, narrationDuration: Number.NaN }],
] as Array<[string, any]>) {
  const d = decideNarrationPreservation(input);
  check(`CASE 6: ${label} fails closed`, d.ok === false && d.withinLimit === false, d);
  check(`CASE 6: ${label} reports INVALID_DURATIONS`, d.reason === 'INVALID_DURATIONS', d.reason);
}

// invalid policy overrides also fail closed
check('CASE 6: negative tailSeconds fails closed',
  decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12, tailSeconds: -1 }).ok === false);
check('CASE 6: maxStretch < 1 fails closed',
  decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12, maxStretch: 0.5 }).ok === false);
check('CASE 6: a valid custom maxStretch is honoured (1.5 rejects the Scene 15 shape)',
  decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12.76, maxStretch: 1.5 }).ok === false);
check('CASE 6: a valid custom maxStretch is honoured (1.7 accepts it)',
  decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12.76, maxStretch: 1.7 }).ok === true);

// ===== CASE 7: absent narration never touches the picture =====
{
  const d = decideNarrationPreservation({ sourceVideoDuration: 8.0 });
  check('CASE 7: no narration -> picture keeps 8.0', d.ok === true && near(d.requiredOutputDuration, 8.0), d);
  check('CASE 7: no narration -> stretch 1.0, no extension', near(d.stretchFactor, 1.0) && d.needsPictureExtension === false, d);
  check('CASE 7: explicit null narration behaves the same',
    near(decideNarrationPreservation({ sourceVideoDuration: 8.0, narrationDuration: null }).requiredOutputDuration, 8.0));
}

// ===== narrationPreservingOutputDuration wrapper =====
check('wrapper: returns 8.25 for the equal-duration case', near(narrationPreservingOutputDuration({ sourceVideoDuration: 8, narrationDuration: 8 }), 8.25));
check('wrapper: returns 13.01 for the Scene 15 shape', near(narrationPreservingOutputDuration({ sourceVideoDuration: 8, narrationDuration: 12.76 }), 13.01));
check('wrapper: FAIL-CLOSED — over-limit returns the untouched source length (8.0), never a stretched value',
  near(narrationPreservingOutputDuration({ sourceVideoDuration: 8, narrationDuration: 15.751 }), 8.0),
  narrationPreservingOutputDuration({ sourceVideoDuration: 8, narrationDuration: 15.751 }));
check('wrapper: FAIL-CLOSED — invalid input returns 0 rather than a fabricated duration',
  narrationPreservingOutputDuration({ sourceVideoDuration: Number.NaN, narrationDuration: 5 }) === 0);

// ===== narrationExceedsClip tolerance =====
check('tolerance: narration clearly longer -> true', narrationExceedsClip(8, 12.76) === true);
check('tolerance: narration clearly shorter -> false', narrationExceedsClip(8, 7) === false);
check('tolerance: narration longer by <= 0.05 -> false', narrationExceedsClip(8, 8.05) === false);
check('tolerance: narration longer by > 0.05 -> true', narrationExceedsClip(8, 8.051) === true);
check('tolerance: invalid inputs -> false (never raises a conflict on bad data)', narrationExceedsClip(Number.NaN, 8) === false);

// ===== purity: identical inputs give identical outputs; nothing is mutated =====
{
  const a = decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12.76 });
  const b = decideNarrationPreservation({ sourceVideoDuration: 8, narrationDuration: 12.76 });
  check('purity: same inputs -> identical decision', JSON.stringify(a) === JSON.stringify(b));
  const input = { sourceVideoDuration: 8, narrationDuration: 12.76 };
  const before = JSON.stringify(input);
  decideNarrationPreservation(input);
  check('purity: the input object is not mutated', JSON.stringify(input) === before);
}

// ===== source guards: the policy is real, bounded, and NOT scene-15-specific =====
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(`${SRC}/narrationDurationPolicy.ts`, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('source: the helper is PURE — no fs/child_process/browser/ffprobe/flow imports',
    !/from 'node:fs|node:child_process|playwright|ffprobe|flowClient|axios|fetch\(/.test(code), code.slice(0, 200));
  check('source: the helper hardcodes NO scene number',
    !/scene[-_ ]?15\b|sceneNumber\s*===|\b15\b\s*===/.test(code));
  check('source: it introduces no tpad/loop/freeze/concat',
    !/tpad|aloop|tconcat|loop=image|freezedump/.test(code));
  check('source: it never scales audio (no asetrate/atempo/stretch on audio)',
    !/asetrate|atempo|aresample/.test(code));
  check('source: the bound is a named exported constant used in the comparison',
    /MAX_NARRATION_VIDEO_STRETCH\s*=\s*2\.0/.test(src) && /stretchFactor\s*<=\s*maxStretch/.test(code));

  const ss = fs.readFileSync(`${SRC}/sceneState.ts`, 'utf8');
  const ssCode = ss.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('source: sceneState imports the SHARED helper (no duplicated arithmetic)',
    /decideNarrationPreservation/.test(ss) && /narrationExceedsClip/.test(ss));
  check('source: sceneState still emits DURATION_CONFLICT on the over-limit path',
    /!preservation\.ok\)\s*reasons\.push\('DURATION_CONFLICT'\)/.test(ssCode.replace(/\s+/g, ' ')));
  check('source: sceneState no longer compares durations inline against 0.05',
    !/narrationAsset\.durationSeconds\s*>\s*suppliedClip\.durationSeconds\s*\+/.test(ssCode));
  check('source: sceneState keeps durationSeconds/supplied-video semantics untouched',
    /durationProvenance\s*=\s*'supplied-video'/.test(ssCode));
  // CONTRACT CHANGED (deliberate): the gate used to be MIXED-only, which let a NARRATOR_ONLY scene
  // with over-limit narration be marked CURRENT and fail only later inside MIX. It now covers
  // NARRATOR_ONLY as well, and excludes the mixer's documented legacy scene so that exception is
  // not regressed. The mixer branch itself is still asserted verbatim further below.
  check('source: the gate now covers NARRATOR_ONLY as well as MIXED',
    /narration\s*===\s*'NARRATOR_ONLY'\s*\|\|\s*narration\s*===\s*'MIXED'/.test(ssCode.replace(/\s+/g, ' ')));
  check('source: the gate excludes the mixer legacy-exempt scenes so that exception is preserved',
    /NARRATION_LEGACY_EXEMPT_SCENES\.has\(sceneNumber\)/.test(ssCode));

  const mx = fs.readFileSync(`${SRC}/mixNarration.ts`, 'utf8');
  const mxCode = mx.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('source: mixNarration imports the SHARED helper',
    /decideNarrationPreservation/.test(mx) && /NARRATION_TAIL_SECONDS/.test(mx));
  check('source: mixNarration drives outputDurations from the helper, not copied arithmetic',
    /decideNarrationPreservation\(\{ sourceVideoDuration: clipDuration, narrationDuration/.test(mxCode.replace(/\s+/g, ' ')));
  // "Fails closed" used to mean `return clipDuration` — which is precisely the silent truncation
  // this guard exists to prevent: MIX exited 0, the artefact validated, a CURRENT sidecar was
  // written, and the filter graph quietly `atrim`-ed the narration to the shorter clip. For a
  // NARRATOR_ONLY scene nothing upstream raised DURATION_CONFLICT (the sceneState gate only covers
  // `narration === 'MIXED'`), so over-limit narration reached MIX READY and was lost. Truncating
  // narration is forbidden, so the only correct closed state here is an explicit failure.
  const mxFlat = mxCode.replace(/\s+/g, ' ');
  check('source: mixNarration FAILS CLOSED on an over-limit stretch (throws, never truncates)',
    /if\s*\(!preservation\.ok\)\s*\{[\s\S]{0,2500}?throw new Error\(/.test(mxCode)
    && !/if\s*\(!preservation\.ok\)\s*return clipDuration;/.test(mxFlat));
  check('source: the over-limit failure names the scene, the required stretch and the configured limit',
    /Scene \$\{scene\}:/.test(mxFlat)
    && /clip=\$\{clipDuration\.toFixed\(3\)\}s narration=\$\{narrationDuration\.toFixed\(3\)\}s/.test(mxFlat)
    && /MAX_NARRATION_VIDEO_STRETCH of \$\{MAX_NARRATION_VIDEO_STRETCH\}x/.test(mxFlat));
  check('source: scene identity is taken from the filename, not the array position',
    /sceneNumbers\[index\]/.test(mxCode) && !/const scene = index \+ 1;/.test(mxCode));
  check('source: the Scene 2 legacy exception is preserved verbatim',
    /if \(scene === 2\) return Math\.max\(clipDuration, narrationDuration \+ narrationTail\);/.test(mxCode));
  check('source: scenes with no narration are still untouched',
    /if \(narrationDuration === undefined\) return clipDuration;/.test(mxCode));
  // The filter-graph/argv builders were moved VERBATIM into the pure, side-effect-free
  // `mixFilterGraph.ts` so the project-wide MIX and the isolated scene-MIX validation path share
  // ONE implementation (mixNarration.ts re-exports them). The graph invariants therefore must be
  // asserted against that module, and mixNarration must be shown to actually consume it.
  const mg = fs.readFileSync(`${SRC}/mixFilterGraph.ts`, 'utf8');
  const mgCode = mg.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('source: mixNarration consumes the shared pure graph/argv builders',
    /from '\.\/mixFilterGraph\.js'/.test(mx) && /buildMixFilterGraph\(\{/.test(mxCode) && /buildMixOutputArgs\(\{/.test(mxCode));
  check('source: mixNarration still re-exports them so existing importers are unaffected',
    /export \{[^}]*buildMixFilterGraph[^}]*\}\s*from '\.\/mixFilterGraph\.js';/.test(mxCode));
  // The setpts stretch itself now lives in `planSceneVideoChain()`; assert it BEHAVIOURALLY on a
  // real built graph rather than grepping the source text, so the invariant is pinned to behaviour.
  const chain15 = planSceneVideoChain({ sourceDurationSeconds: 8, outputDurationSeconds: 13.01 });
  check('source: the existing setpts stretch path in the graph is UNCHANGED',
    chain15.retimeFactor !== null && Math.abs(chain15.retimeFactor - 1.62625) < 1e-9
    && chain15.chain.includes('setpts=1.626250*PTS'), chain15.chain);
  check('source: no audio time-stretch filter was introduced anywhere',
    !/asetrate|atempo/.test(mxCode) && !/asetrate|atempo/.test(mgCode) && !/asetrate|atempo/.test(chain15.chain));
}

console.log(`\nALL PASS  (${passed} checks)`);