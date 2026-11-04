// Offline `production:check` CLI tests (STEP-8DI). Temp dirs only. No Flow/Chrome/renders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const cli = await import(pathToFileURL(`${SRC}/prodCheck.ts`).href);
const { readPipeline, deriveNextAction, runCheck } = cli;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w:number,h:number,ct=6,tag=0){const T:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const body=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body),0);return Buffer.concat([l,body,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=ct;const ch=ct===6?4:2;const raw=Buffer.alloc(h*(1+w*ch),0x80);for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;raw[11]=(tag&0xff);
return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const wav=(f:string,sec:number,tag=0)=>{const n=Math.round(sec*8000);const d=Buffer.alloc(n*2,tag);const b=Buffer.alloc(44+d.length);b.write('RIFF',0);b.writeUInt32LE(36+d.length,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(d.length,40);fs.writeFileSync(f,b);};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8di-'));
const PID = 'synthetic-8di';
const inputRootBase = path.join(tmp, 'inputs');
const root = path.join(inputRootBase, PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
for (const c of ['characters','narration','flow-clips','backgrounds','music']) fs.mkdirSync(path.join(root,c),{recursive:true});
fs.mkdirSync(OUT,{recursive:true});
fs.writeFileSync(path.join(root,'backgrounds','BGD-01.png'), makePng(1920,1080,2,1));
fs.writeFileSync(path.join(root,'characters','CHAR-01-ARJUN.png'), makePng(1024,1024,6,1));
wav(path.join(root,'narration','narration-0001.wav'),3);
const pipeline:any = { project_id: PID, characters:[{tag:'@CHAR-01-ARJUN'}], backgrounds:[{tag:'#BGD-01'}], scenes:[
  { scene_number:1, title:'S1', background_tag:'#BGD-01', character_tags:['@CHAR-01-ARJUN'], speaker:'NARRATOR', camera:'W', visual_action:'a', effects:'', narration_text:'न', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
  { scene_number:2, title:'S2', background_tag:'#BGD-01', character_tags:[], speaker:'NARRATOR', camera:'W', visual_action:'b', effects:'', narration_text:'क', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
]};
const pipelineFile = path.join(tmp, 'pipeline.json');
fs.writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2));
wav(path.join(root,'narration','narration-0002.wav'),3);
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so the character scene
// (1) AND the background-only scene (2) both get one. Scene 2 is no longer exempt.
for (const n of [1, 2]) {
  await exec(process.env.FFMPEG_PATH, ['-y','-f','lavfi','-i',`color=c=0x${(0x223344 + n * 0x010203).toString(16)}:s=1280x720:d=3`,
    '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','3',
    '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',
    path.join(root,'flow-clips',`scene-000${n}.mp4`)]);
}

const baseOpts = { project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot };

// ---- 18. project path validation ----
check('18. missing pipeline path rejected', (await readPipeline(path.join(tmp,'nope.json'))).ok === false);
check('18b. non-json extension rejected', (await readPipeline(path.join(tmp,'pipeline.txt'))).ok === false);
fs.writeFileSync(path.join(tmp,'bad.json'), '{ broken');
check('18c. malformed pipeline JSON rejected', (await readPipeline(path.join(tmp,'bad.json'))).ok === false);
fs.writeFileSync(path.join(tmp,'nonseq.json'), JSON.stringify({ project_id:'x', scenes:[{scene_number:1,character_tags:[]},{scene_number:3,character_tags:[]}] }));
check('18d. non-sequential scene numbers rejected', (await readPipeline(path.join(tmp,'nonseq.json'))).ok === false);
fs.writeFileSync(path.join(tmp,'few.json'), JSON.stringify({ project_id:'x', scenes:[{scene_number:1,character_tags:[]}] }));
check('18e. too few scenes rejected', (await readPipeline(path.join(tmp,'few.json'))).ok === false);
check('18f. valid pipeline accepted', (await readPipeline(pipelineFile)).ok === true);

// ---- 1. missing input directory ----
{
  const r = await runCheck({ ...baseOpts, inputsDir: path.join(tmp, 'inputs-missing') } as any);
  check('1. missing input dir is reported (not created)', r.exitCode === 0 && /MISSING/.test(r.text ?? ''));
  check('1b. missing input dir was NOT created', !fs.existsSync(path.join(tmp,'inputs-missing',PID)));
}

// ---- 2. empty input directory ----
{
  const emptyBase = path.join(tmp, 'inputs-empty');
  fs.mkdirSync(path.join(emptyBase, PID), { recursive: true });
  const r = await runCheck({ ...baseOpts, inputsDir: emptyBase } as any);
  // With an empty input root nothing is INVALID. Under STRICT every scene type is gated on the
  // supplied clip, so BOTH the character scene and the background-only scene report as waiting for a
  // video clip -- the clip requirement dominates the missing local assets.
  check('2. empty input dir yields waiting states', /WAITING_FOR_VIDEO_CLIP:\s+2/.test(r.text ?? '')
    && /INVALID:\s+0/.test(r.text ?? ''), r.text?.split('\n').filter((l:string)=>/WAITING|INVALID/.test(l)).join(' | '));
}

// ---- 3. valid complete synthetic set ----
{
  const r = await runCheck(baseOpts as any);
  check('3. complete inputs -> READY scenes', /READY:\s+2/.test(r.text ?? ''), r.text?.split('\n').filter((l:string)=>/READY/.test(l)).join(' | '));
  check('3b. durations resolved', /Duration resolved:\s+2 \/ unresolved 0/.test(r.text ?? ''));
  check('3c. outputs MISSING -> next action is render', /NEXT ACTION\nRender 2 scene\(s\)/.test(r.text ?? ''), (r.text ?? '').split('NEXT ACTION')[1]);
}

// ---- 4. missing background ----
{
  const mv = path.join(root,'backgrounds','BGD-01.png.bak'); fs.renameSync(path.join(root,'backgrounds','BGD-01.png'), mv);
  const r = await runCheck(baseOpts as any);
  // Both scenes now hold a valid supplied clip, which IS their visual and audio. A missing local
  // background plate must therefore neither block them nor invalidate the project.
  // (WAITING_FOR_BACKGROUND remains reachable only under the ALLOW_LOCAL dev/emergency opt-in, which
  // is covered by scene_state_test -- it is unreachable while STRICT gates every scene on a clip.)
  check('4. missing background with a valid clip -> still renderable, not invalid',
    /WAITING_FOR_BACKGROUND:\s+0/.test(r.text ?? '') && /INVALID:\s+0/.test(r.text ?? '')
    && /READY:\s+2/.test(r.text ?? ''), (r.text??'').split('SUMMARY')[1]?.slice(0,160));
  fs.renameSync(mv, path.join(root,'backgrounds','BGD-01.png'));
}

// ---- 5. missing character ----
{
  const mv = path.join(root,'characters','CHAR-01-ARJUN.png.bak'); fs.renameSync(path.join(root,'characters','CHAR-01-ARJUN.png'), mv);
  const r = await runCheck(baseOpts as any);
  // STRICT local-synthesis policy: a character scene may only be visualised from an authoritative
  // supplied clip, so scene 1 renders as SUPPLIED_VIDEO and the missing character plate is simply
  // unused. The missing asset must NOT falsely invalidate or block the project.
  // (WAITING_FOR_CHARACTER_ASSET is unreachable for character scenes while STRICT is in force: the
  // policy branch precedes the character-MISSING branch. See the local_synthesis_policy_test suite.)
  check('5. missing character on a supplied-video scene -> no false wait, no false INVALID',
    /WAITING_FOR_CHARACTER:\s+0/.test(r.text ?? '') && /INVALID:\s+0/.test(r.text ?? ''),
    (r.text??'').split('SUMMARY')[1]?.slice(0,160));
  check('5b. scene still renders from its supplied clip (SUPPLIED_VIDEO)', /001\s+READY\s+mode=SUPPLIED_VIDEO/.test(r.text ?? '')
    && /Render 2 scene\(s\)/.test(r.text ?? ''), (r.text??'').split('NEXT ACTION')[1]?.slice(0,120));
  fs.renameSync(mv, path.join(root,'characters','CHAR-01-ARJUN.png'));
}

// ---- 6. missing narration ----
{
  // Scene 2 is background-only but still holds a valid supplied clip, which carries the scene's audio.
  // A missing local narrator file must not block or invalidate it.
  // (WAITING_FOR_NARRATION is likewise reachable only under ALLOW_LOCAL -- covered by scene_state_test.)
  const mv = path.join(root,'narration','narration-0002.wav.bak'); fs.renameSync(path.join(root,'narration','narration-0002.wav'), mv);
  const r = await runCheck(baseOpts as any);
  check('6. missing narration with a valid clip -> still renderable, not invalid',
    /WAITING_FOR_NARRATION:\s+0/.test(r.text ?? '') && /INVALID:\s+0/.test(r.text ?? '')
    && /READY:\s+2/.test(r.text ?? ''), (r.text??'').split('SUMMARY')[1]?.slice(0,160));
  fs.renameSync(mv, path.join(root,'narration','narration-0002.wav'));
}

// ---- 7. invalid input ----
{
  const op = makePng(1024,1024,6); op[25]=2; // opaque
  const mv = path.join(root,'characters','CHAR-01-ARJUN.png.bak'); fs.renameSync(path.join(root,'characters','CHAR-01-ARJUN.png'), mv);
  fs.writeFileSync(path.join(root,'characters','CHAR-01-ARJUN.png'), op);
  const r = await runCheck(baseOpts as any);
  check('7. invalid input -> INVALID count and fix action', /INVALID:\s+[1-9]/.test(r.text ?? '') && /Fix \d+ invalid scene input/.test(r.text ?? ''), (r.text??'').split('NEXT ACTION')[1]);
  fs.rmSync(path.join(root,'characters','CHAR-01-ARJUN.png')); fs.renameSync(mv, path.join(root,'characters','CHAR-01-ARJUN.png'));
}

// ---- 8. supplied video ----
{
  const clip = path.join(root,'flow-clips','scene-0001.mp4');
  await exec(process.env.FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=1920x1080:rate=30:duration=3','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',clip]);
  const r = await runCheck({ ...baseOpts, json: true } as any);
  const j:any = r.json;
  const s1 = j.scenes.find((s:any)=>s.sceneNumber===1);
  check('8. supplied video reflected in JSON scene report', s1.suppliedVideo === 'VALID' && s1.renderMode === 'SUPPLIED_VIDEO', JSON.stringify(s1));
  // The clip stays in place: under STRICT, scene 1 has no render mode other than its supplied clip,
  // so every later scenario in this suite depends on it remaining VALID.
}

// ---- 9/10. stale vs current output ----
{
  // No recorded key anywhere (clear prior checkpoint) -> STALE_UNKNOWN.
  fs.rmSync(path.join(OUT, 'state.json'), { force: true });
  fs.rmSync(path.join(OUT, 'scene-0001.json'), { force: true });
  const out1 = path.join(OUT,'scene-0001.mp4');
  await exec(process.env.FFMPEG_PATH,['-y','-f','lavfi','-i','testsrc=size=1920x1080:rate=30:duration=3','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',out1]);
  const r = await runCheck({ ...baseOpts, json: true } as any);
  const s1 = (r.json as any).scenes.find((s:any)=>s.sceneNumber===1);
  check('9. output without a trustworthy key -> STALE_UNKNOWN', s1.output === 'STALE_UNKNOWN', JSON.stringify(s1));
  fs.rmSync(out1);
}

// ---- 11. downstream blocked ----
{
  const r = await runCheck(baseOpts as any);
  check('11. downstream EDIT BLOCKED while scenes not CURRENT', /EDIT: (STALE|NOT_STARTED|BLOCKED)/.test(r.text ?? '') && /Reason:/.test(r.text ?? ''), (r.text??'').split('DOWNSTREAM')[1]?.slice(0,240));
}

// ---- 12/13/14. JSON validity / human output / nextAction ----
{
  const rj = await runCheck({ ...baseOpts, json: true } as any);
  const j:any = rj.json;
  check('12. --json emits valid structured JSON only', rj.text === undefined && j.projectId === PID && Array.isArray(j.scenes) && j.stages && typeof j.nextAction === 'string', JSON.stringify(Object.keys(j)));
  check('12b. JSON has all five downstream stages', ['edit','mix','bed','title','approval'].every((k)=>k in j.stages));
  const rh = await runCheck(baseOpts as any);
  check('13. human-readable output has required sections', /PRODUCTION CHECK/.test(rh.text??'') && /SCENES/.test(rh.text??'') && /SUMMARY/.test(rh.text??'') && /DOWNSTREAM/.test(rh.text??'') && /PROJECT STATE/.test(rh.text??'') && /NEXT ACTION/.test(rh.text??''));
  check('14. nextAction correctness for waiting-on-nothing-but-render case', /Render 2 scene/.test(j.nextAction), j.nextAction);
}

// ---- 14b. nextAction priority checks (pure) ----
check('14b. invalid beats everything', /Fix/.test(deriveNextAction({ counts:{ready:0,waitingBackground:1,waitingCharacter:0,waitingNarration:0,waitingVideo:0,invalid:2}, duration:{resolved:0,unresolved:0}, sceneOutputs:{current:0,stale:0,staleUnknown:0,missing:0,invalid:0}, stages:{}, approved:false, total:2 } as any)));
check('14c. approval required when all CURRENT and not approved', /Human approval required/.test(deriveNextAction({ counts:{ready:2,waitingBackground:0,waitingCharacter:0,waitingNarration:0,waitingVideo:0,invalid:0}, duration:{resolved:2,unresolved:0}, sceneOutputs:{current:2,stale:0,staleUnknown:0,missing:0,invalid:0}, stages:{EDIT:'CURRENT',MIX:'CURRENT',BED:'CURRENT',TITLE:'CURRENT',APPROVAL:'NOT_STARTED'}, approved:false, total:2 } as any)));
check('14d. complete when approved', /complete/i.test(deriveNextAction({ counts:{ready:2,waitingBackground:0,waitingCharacter:0,waitingNarration:0,waitingVideo:0,invalid:0}, duration:{resolved:2,unresolved:0}, sceneOutputs:{current:2,stale:0,staleUnknown:0,missing:0,invalid:0}, stages:{EDIT:'CURRENT',MIX:'CURRENT',BED:'CURRENT',TITLE:'CURRENT',APPROVAL:'CURRENT'}, approved:true, total:2 } as any)));

// ---- 19. --inputs-dir override ----
{
  const alt = path.join(tmp,'alt-inputs',PID);
  for (const c of ['characters','narration','backgrounds','flow-clips','music']) fs.mkdirSync(path.join(alt,c),{recursive:true});
  fs.writeFileSync(path.join(alt,'backgrounds','BGD-01.png'), makePng(1920,1080,2,1));
  const r = await runCheck({ project: pipelineFile, inputsDir: path.join(tmp,'alt-inputs'), outputsDir: OUT, outputsRoot } as any);
  check('19. --inputs-dir override is honored', (r.text??'').includes('alt-inputs') || /WAITING_FOR_CHARACTER/.test(r.text??''), (r.text??'').slice(0,300));
}

// ---- 15. zero filesystem mutation ----
{
  const snapshot = (base: string): string => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const f = path.join(d, e.name); return e.isDirectory() ? walk(f) : [`${path.relative(base, f)}:${fs.statSync(f).size}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`];
    });
    return walk(base).sort().join('|');
  };
  const before = snapshot(tmp);
  await runCheck(baseOpts as any);
  await runCheck({ ...baseOpts, json: true } as any);
  check('15. CLI performs ZERO filesystem mutation (hash+listing identical)', snapshot(tmp) === before);
}

// ---- 20. no secrets / no absolute paths in JSON ----
{
  const r = await runCheck({ ...baseOpts, json: true } as any);
  const text = JSON.stringify(r.json);
  check('20. JSON contains no secrets', !/api[_-]?key|token|password|secret/i.test(text));
  check('20b. JSON paths are relative (no drive letters)', !/[A-Za-z]:\\\\/.test(text), text.slice(0,200));
}

// ---- projectState present ----
{
  const r = await runCheck({ ...baseOpts, json: true } as any);
  check('project state derived and present in JSON', typeof (r.json as any).projectState === 'string' && (r.json as any).projectState.length > 0);
}

// ---- 16/17. no rendering / no Flow ----
const srcText = fs.readFileSync(`${SRC}/prodCheck.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');
check('16. prodCheck performs no rendering', !/renderScene|execFile|ffmpeg/.test(srcText));
check('17. prodCheck has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));
// 8DK added a write, but ONLY inside the guarded `--execute-stages` block. Assert the default
// (inspection) path contains no write: every write must appear after `if (executeStages)`.
{
  const firstWrite = srcText.search(/writeFile|appendFile|rename\(|mkdir/);
  const executeGate = srcText.indexOf('if (executeStages)');
  check('17b. prodCheck writes only inside the guarded execute-stages block', firstWrite === -1 || (executeGate !== -1 && firstWrite > executeGate), `write@${firstWrite} gate@${executeGate}`);
}

console.log(`\nPRODUCTION-CHECK CLI TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
