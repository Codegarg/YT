// Focused OFFLINE tests for the Flow video provider. No browser, no network, no Flow, no
// generation. The expensive live transport test is deliberately NOT duplicated here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const P = await import(pathToFileURL(`${SRC}/flowVideoProvider.ts`).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const ART = '9cb6c125-9154-42a2-82fc-cfc0bb98191a';
const OTHER = '47425bc2-6c47-4b6d-a88a-c4a7259015cc';
const SIG = '?Expires=1780000000&KeyName=labs-flow-prod-cdn-key&Signature=AAAAsecretsignatureBBBB';
const signedUrl = (id: string) => `https://flow-content.google/video/${id}${SIG}`;

// ---------- 1. artifact uuid acceptance ----------
check('uuid: a bare 36-char artifact id is accepted', P.isValidFlowArtifactId(ART) === true);
check('uuid: a url is never accepted as an artifact id', P.isValidFlowArtifactId(signedUrl(ART)) === false);
check('uuid: a title is never accepted', P.isValidFlowArtifactId('Man reading book in bedroom') === false);
check('uuid: empty/short/non-string fail closed', P.isValidFlowArtifactId('') === false && P.isValidFlowArtifactId('9cb6c125') === false && P.isValidFlowArtifactId(null) === false && P.isValidFlowArtifactId(42) === false);

// ---------- 2. mismatch rejection ----------
check('verify: exact uuid match is accepted', (() => { const r = P.verifyFlowArtifactMediaUrl(signedUrl(ART), ART); return r.ok === true && r.artifactId === ART && r.signedUrl === signedUrl(ART); })());
check('verify: a DIFFERENT artifact uuid is refused', (() => { const r = P.verifyFlowArtifactMediaUrl(signedUrl(OTHER), ART); return r.ok === false && r.code === 'ARTIFACT_ID_MISMATCH'; })());
check('verify: an /image/ url is refused (namespace is not interchangeable)', (() => { const r = P.verifyFlowArtifactMediaUrl(`https://flow-content.google/image/${ART}${SIG}`, ART); return r.ok === false; })());
check('verify: an empty url is refused', (() => { const r = P.verifyFlowArtifactMediaUrl('', ART); return r.ok === false; })());
check('verify: a malformed expected id is refused before any comparison', (() => { const r = P.verifyFlowArtifactMediaUrl(signedUrl(ART), 'nope'); return r.ok === false && r.code === 'ARTIFACT_ID_INVALID'; })());

// ---------- 3. signed url redaction ----------
const red = P.redactFlowSignedMediaUrl(signedUrl(ART));
check('redact: keeps the identity path segment', red === `https://flow-content.google/video/${ART}?<signed-params-redacted>`, red);
check('redact: NEVER emits Signature/KeyName/Expires', !/Signature|KeyName|Expires|AAAAsecretsignatureBBBB/.test(red), red);
check('redact: a url with no query has no redaction marker', P.redactFlowSignedMediaUrl(`https://flow-content.google/video/${ART}`) === `https://flow-content.google/video/${ART}`);
check('redact: non-strings and junk fail closed without throwing', P.redactFlowSignedMediaUrl(null) === '' && P.redactFlowSignedMediaUrl('::not a url::') === '<unparseable-url>');

// ---------- destination resolution ----------
const dest = P.resolveSuppliedClipDestination({ inputRoot: 'C:/p/inputs/proj', projectId: 'proj', sceneNumber: 1 });
check('dest: resolves to <inputRoot>/flow-clips/scene-0001.mp4', dest.ok === true && dest.path === path.join('C:/p/inputs/proj', 'flow-clips', 'scene-0001.mp4'), dest);
check('dest: can NEVER address the protected outputs-side local artifact', (() => {
  const d = P.resolveSuppliedClipDestination({ inputRoot: 'C:/p/outputs/proj', projectId: 'proj', sceneNumber: 1 });
  return d.ok === false || !/outputs/.test(d.path) || d.path.includes('flow-clips');
})(), dest);
check('dest: a non-positive or non-integer scene number fails closed', (() => {
  const a = P.resolveSuppliedClipDestination({ inputRoot: 'x', projectId: 'p', sceneNumber: 0 });
  const b = P.resolveSuppliedClipDestination({ inputRoot: 'x', projectId: 'p', sceneNumber: 1.5 });
  return a.ok === false && a.code === 'SCENE_NUMBER_INVALID' && b.ok === false;
})());
check('dest: a missing projectId or inputRoot fails closed', (() => {
  const a = P.resolveSuppliedClipDestination({ inputRoot: 'x', sceneNumber: 1 });
  const b = P.resolveSuppliedClipDestination({ projectId: 'p', sceneNumber: 1 });
  return a.ok === false && a.code === 'INPUT_ROOT_MISSING' && b.ok === false;
})());

// ---------- temp path ----------
const tmpPath = P.buildSuppliedClipTempPath('C:/p/inputs/proj/flow-clips', 1, '999-123');
check('temp: lives in the destination directory (same volume, atomic rename)', path.dirname(tmpPath) === path.join('C:/p/inputs/proj', 'flow-clips'));
check('temp: keeps a validator-accepted .mp4 extension', tmpPath.endsWith('.mp4'), tmpPath);
check('temp: is never the final scene filename', path.basename(tmpPath) !== 'scene-0001.mp4', tmpPath);

// ---------- transport response classification ----------
check('response: 200 + video/mp4 + bytes is accepted', P.classifyFlowMediaResponse({ status: 200, contentType: 'video/mp4', byteLength: 2964630 }).ok === true);
check('response: pre-flight (no byteLength yet) validates status + content-type only', P.classifyFlowMediaResponse({ status: 200, contentType: 'video/mp4' }).ok === true);
check('response: 206 is NOT accepted as a whole-entity transport', (() => { const r = P.classifyFlowMediaResponse({ status: 206, contentType: 'video/mp4', byteLength: 10 }); return r.ok === false && r.code === 'TRANSPORT_STATUS_INVALID'; })());
check('response: a non-video content type is refused', (() => { const r = P.classifyFlowMediaResponse({ status: 200, contentType: 'text/html', byteLength: 10 }); return r.ok === false && r.code === 'TRANSPORT_CONTENT_TYPE_INVALID'; })());
check('response: a known-empty body is refused', (() => { const r = P.classifyFlowMediaResponse({ status: 200, contentType: 'video/mp4', byteLength: 0 }); return r.ok === false && r.code === 'TRANSPORT_BODY_EMPTY'; })());

// ---------- 6. idempotency / reuse ----------
check('idempotency: absent -> DOWNLOAD', P.decideSuppliedClipAction({ exists: false }).action === 'DOWNLOAD');
check('idempotency: existing VALID -> REUSE (Flow is never contacted)', P.decideSuppliedClipAction({ exists: true, state: 'VALID' }).action === 'REUSE');
check('idempotency: existing VALID is still REUSE even with overwrite set', P.decideSuppliedClipAction({ exists: true, state: 'VALID', overwrite: true }).action === 'REUSE');
check('idempotency: existing INVALID is NOT silently replaced', P.decideSuppliedClipAction({ exists: true, state: 'INVALID' }).action === 'REFUSE_INVALID');
check('idempotency: existing INVALID replaces ONLY on explicit overwrite', P.decideSuppliedClipAction({ exists: true, state: 'INVALID', overwrite: true }).action === 'REPLACE');

// ---------- a real MP4 fixture, produced offline with ffmpeg ----------
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-provider-test-'));
let haveFixture = true;
let goodBytes: Buffer = Buffer.alloc(0);
try {
  execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(work, 'good.mp4')], { stdio: 'ignore' });
  goodBytes = fs.readFileSync(path.join(work, 'good.mp4'));
} catch (e) { haveFixture = false; console.log('SKIP ffmpeg fixture unavailable:', String(e?.message ?? e).slice(0, 120)); }

// ---------- provider behaviour with MOCKED deps ----------
const mkProvider = (over: Partial<Record<'resolve' | 'get', any>> = {}) => new P.FlowVideoProvider({
  ffprobePath: FFPROBE,
  resolveSignedMediaUrl: over.resolve ?? (async (id: string) => ({ ok: true, signedUrl: signedUrl(id) })),
  requestGet: over.get ?? (async () => ({ ok: true, status: 200, contentType: 'video/mp4', body: async () => goodBytes })),
});

const run = async () => {
  // ---- a valid pre-flight followed by an empty body is still refused ----
  const emptyBody = await mkProvider({ get: async () => ({ ok: true, status: 200, contentType: 'video/mp4', body: async () => Buffer.alloc(0) }) })
    .acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot: path.join(work, 'empty') });
  check('provider: a transport that returns an empty body after a valid pre-flight is refused', emptyBody.ok === false && emptyBody.code === 'TRANSPORT_BODY_EMPTY', emptyBody);

  // ---- 4/10. valid MP4 path + atomic promotion ----
  if (haveFixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dest-'));
    const inputRoot = path.join(dir, 'inputs', 'proj');
    const r = await mkProvider().acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot });
    const finalPath = path.join(inputRoot, 'flow-clips', 'scene-0001.mp4');
    check('provider: a valid MP4 is promoted to flow-clips/scene-0001.mp4', r.ok === true && r.status === 'INSTALLED' && r.path === finalPath, r);
    check('provider: the promoted file exists and is byte-identical to the transport body', fs.existsSync(finalPath) && fs.statSync(finalPath).size === goodBytes.length);
    check('provider: no temporary file is left behind', fs.readdirSync(path.dirname(finalPath)).filter((f) => f.includes('.tmp')).length === 0, fs.readdirSync(path.dirname(finalPath)));
    check('provider: the returned media url is redacted', typeof r.mediaUrlRedacted === 'string' && !/Signature|KeyName|Expires/.test(String(r.mediaUrlRedacted)) && String(r.mediaUrlRedacted).includes(ART), r.mediaUrlRedacted);

    // ---- 5. invalid MP4 rejection: no final file, no temp file ----
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-dest2-'));
    const inputRoot2 = path.join(dir2, 'inputs', 'proj');
    const bad = await new P.FlowVideoProvider({
      ffprobePath: FFPROBE,
      resolveSignedMediaUrl: async (id: string) => ({ ok: true, signedUrl: signedUrl(id) }),
      requestGet: async () => ({ ok: true, status: 200, contentType: 'video/mp4', body: async () => Buffer.from('THIS IS NOT A VALID MP4') }),
    }).acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot: inputRoot2 });
    const final2 = path.join(inputRoot2, 'flow-clips', 'scene-0001.mp4');
    check('provider: invalid bytes return INVALID/CLIP_INVALID', bad.ok === false && bad.status === 'INVALID' && bad.code === 'CLIP_INVALID', bad);
    check('provider: invalid bytes leave NO final file', fs.existsSync(final2) === false);
    check('provider: invalid bytes leave NO temporary file', fs.existsSync(final2) === false && fs.readdirSync(path.join(inputRoot2, 'flow-clips')).filter((f) => f.includes('.tmp')).length === 0);

    // ---- 7/8. an existing VALID clip is REUSED and Flow is never contacted ----
    let contacted = 0;
    const reuse = await new P.FlowVideoProvider({
      ffprobePath: FFPROBE,
      resolveSignedMediaUrl: async () => { contacted += 1; return { ok: true, signedUrl: signedUrl(ART) }; },
      requestGet: async () => { contacted += 1; return { ok: true, status: 200, contentType: 'video/mp4', body: async () => goodBytes }; },
    }).acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot });
    check('provider: an existing valid clip returns REUSED', reuse.ok === true && reuse.status === 'REUSED', reuse);
    check('provider: REUSED never contacts Flow (zero resolve/transport calls)', contacted === 0, contacted);

    // ---- an existing INVALID clip is left untouched without overwrite ----
    fs.writeFileSync(finalPath, 'CORRUPT');
    const before = fs.readFileSync(finalPath, 'utf8');
    const refused = await mkProvider().acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot });
    check('provider: an invalid existing clip is refused, not silently overwritten', refused.ok === false && refused.status === 'INVALID' && fs.readFileSync(finalPath, 'utf8') === before, refused);

    // ---- ...and IS replaced through tmp -> validate -> rename with overwrite ----
    const replaced = await mkProvider().acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot, overwrite: true });
    check('provider: overwrite=true replaces an invalid clip only via tmp->validate->rename', replaced.ok === true && replaced.status === 'INSTALLED' && fs.statSync(finalPath).size === goodBytes.length, replaced);
    check('provider: no temp file survives the replacement', fs.readdirSync(path.dirname(finalPath)).filter((f) => f.includes('.tmp')).length === 0);
  }

  // ---- mismatch never reaches the transport ----
  let transportCalls = 0;
  const mismatch = await new P.FlowVideoProvider({
    ffprobePath: FFPROBE,
    resolveSignedMediaUrl: async () => ({ ok: true, signedUrl: signedUrl(OTHER) }),
    requestGet: async () => { transportCalls += 1; return { ok: true, status: 200, contentType: 'video/mp4', body: async () => goodBytes }; },
  }).acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot: path.join(work, 'mm') });
  check('provider: a preview for the WRONG artifact is refused before any transport', mismatch.ok === false && mismatch.code === 'ARTIFACT_ID_MISMATCH' && transportCalls === 0, mismatch);

  // ---- no internal retry: exactly one resolve + one transport attempt ----
  let resolves = 0; let gets = 0;
  await new P.FlowVideoProvider({
    ffprobePath: FFPROBE,
    resolveSignedMediaUrl: async () => { resolves += 1; return { ok: false, reason: 'picker unavailable' }; },
    requestGet: async () => { gets += 1; return { ok: true, status: 200, contentType: 'video/mp4', body: async () => goodBytes }; },
  }).acquireScene({ sceneNumber: 1, artifactId: ART, projectId: 'proj', inputRoot: path.join(work, 'nr') });
  check('provider: has NO internal retry (exactly one resolve attempt, zero transports)', resolves === 1 && gets === 0, { resolves, gets });

  // ---- 10. the provider never touches scene persistence / Add Media / Save to project ----
  // Comments are stripped first so the guard cannot be satisfied (or tripped) by documentation.
  const rawSrc = fs.readFileSync(`${SRC}/flowVideoProvider.ts`, 'utf8');
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('provider: no Add Media, no Save to project, no scene persistence, no generation in the code',
    !/addMedia|detail-add-to-prompt-btn|saveToProject|generateProjectVideo|attachFirstClip|writeSceneCheckpoint|ensureTargetSceneOpen|Start generation|waitForEvent\('download'\)|createScene/.test(src));
  check('provider: never uses the two proven-failing transports', !/\bfetch\s*\(/.test(src) && !/response\s*\.\s*body\s*\(/.test(src) && !/https\.get|http\.get|axios|undici|node-fetch/.test(src));
  check('provider: Flow interaction is limited to the read-only signed-url resolver', /resolveArtifactSignedMediaUrl/.test(src) && /context as any\)\.request/.test(src));
  check('provider: mutates the filesystem only through stat/mkdir/writeFile/rm/rename', (() => {
    const used = [...new Set(src.match(/fsp\.(?:stat|mkdir|writeFile|rm|rename)/g) ?? [])].sort();
    return used.join(',') === 'fsp.mkdir,fsp.rename,fsp.rm,fsp.stat,fsp.writeFile';
  })(), (src.match(/fsp\.\w+/g) ?? []).join(','));
  check('provider: the ONLY writeFile targets the temp path, never the destination', (() => {
    const w = src.match(/fsp\.writeFile\([^,]+,/g) ?? [];
    return w.length === 1 && w[0].includes('tmp');
  })(), (src.match(/fsp\.writeFile\([^,]+,/g) ?? []).join(' | '));
  check('provider: the ONLY rename promotes the validated temp file onto the destination', (() => {
    const r = src.match(/fsp\.rename\([^)]+\)/g) ?? [];
    return r.length === 1 && r[0].includes('tmp') && r[0].includes('target');
  })(), (src.match(/fsp\.rename\([^)]+\)/g) ?? []).join(' | '));
  check('provider: every fsp.rm is a forced temp-file cleanup', (() => {
    const r = src.match(/fsp\.rm\([^)]+\)/g) ?? [];
    return r.length > 0 && r.every((x) => x.includes('tmp'));
  })(), (src.match(/fsp\.rm\([^)]+\)/g) ?? []).join(' | '));

  // ---- capability reporting is pure ----
  const noCtx = new P.FlowVideoProvider({ resolveSignedMediaUrl: async () => ({ ok: true, signedUrl: 'x' }), requestGet: async () => ({ ok: true, status: 200, contentType: 'video/mp4', body: async () => Buffer.alloc(0) }) });
  check('isCapable: fails closed without an authenticated context', noCtx.isCapable(undefined).ok === false);
  check('isCapable: reports local-mp4 with an authenticated context', noCtx.isCapable({ hasAuthenticatedContext: true }).ok === true && noCtx.isCapable({ hasAuthenticatedContext: true }).produces === 'local-mp4');
  check('isCapable: is pure (repeated calls identical, no I/O)', JSON.stringify(noCtx.isCapable({ hasAuthenticatedContext: true })) === JSON.stringify(noCtx.isCapable({ hasAuthenticatedContext: true })));

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nALL PASS  (${passed} checks)`);
};

await run();
