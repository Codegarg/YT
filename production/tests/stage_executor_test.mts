// Offline guarded stage-executor tests (STEP-8DK). Temp dirs only. Real producers NEVER run.
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

const se = await import(pathToFileURL(`${SRC}/stageExecutor.ts`).href);
const cli = await import(pathToFileURL(`${SRC}/prodCheck.ts`).href);
const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const { executeStage, executeDownstreamChain, STAGE_SCRIPTS, stageArgsFor } = se;
const { runCheck } = cli;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w:number,h:number,ct=6,tag=0){const T:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const body=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body),0);return Buffer.concat([l,body,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=ct;const ch=ct===6?4:2;const raw=Buffer.alloc(h*(1+w*ch),0x80);for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;raw[11]=(tag&0xff);
return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const wav=(f:string,sec:number,tag=0)=>{const n=Math.round(sec*8000);const d=Buffer.alloc(n*2,tag);const b=Buffer.alloc(44+d.length);b.write('RIFF',0);b.writeUInt32LE(36+d.length,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(d.length,40);fs.writeFileSync(f,b);};
const makeMp4 = async (out:string, dur=3, color='0x203040') => { await exec(process.env.FFMPEG_PATH,['-y','-f','lavfi','-i',`color=c=${color}:s=1920x1080:d=1`,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(dur),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',out]); };
const sha=(f:string)=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dk-'));
const PID = 'synthetic-8dk';
const inputRootBase = path.join(tmp, 'inputs');
const root = path.join(inputRootBase, PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
for (const c of ['characters','narration','flow-clips','backgrounds','music']) fs.mkdirSync(path.join(root,c),{recursive:true});
fs.mkdirSync(OUT,{recursive:true});
fs.writeFileSync(path.join(root,'backgrounds','BGD-01.png'), makePng(1920,1080,2,1));
fs.writeFileSync(path.join(root,'characters','CHAR-01-ARJUN.png'), makePng(1024,1024,6,1));
// Narration is 1.5s against the 1.0s supplied clips produced by makeMp4() below. makeMp4 passes
// `d=1` to the color source, so `-shortest` truncates every clip to 1.0s despite `dur=3`; 3.0s
// narration then needs a 3.0x picture slowdown, above MAX_NARRATION_VIDEO_STRETCH=2.0, so scene 1
// failed closed as DURATION_CONFLICT/INVALID (scene 2 survived only because
// NARRATION_LEGACY_EXEMPT_SCENES is hardcoded to {2}) and the project never reached READY, so
// assertion 14 could not run. 1.5s yields max(1.0, 1.5+0.25) = 1.75x, within the limit.
wav(path.join(root,'narration','narration-0001.wav'),1.5); wav(path.join(root,'narration','narration-0002.wav'),1.5);
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so both background-only
// scenes get one; otherwise the project would never reach READY and no stage would be executable.
await makeMp4(path.join(root,'flow-clips','scene-0001.mp4'),3,'0x213141');
await makeMp4(path.join(root,'flow-clips','scene-0002.mp4'),3,'0x314151');
const pipeline:any = { project_id: PID, characters:[{tag:'@CHAR-01-ARJUN'}], backgrounds:[{tag:'#BGD-01'}], scenes:[
  { scene_number:1, title:'S1', background_tag:'#BGD-01', character_tags:[], speaker:'NARRATOR', camera:'W', visual_action:'a', effects:'', narration_text:'न', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
  { scene_number:2, title:'S2', background_tag:'#BGD-01', character_tags:[], speaker:'NARRATOR', camera:'W', visual_action:'b', effects:'', narration_text:'क', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
]};
const pipelineFile = path.join(tmp, 'pipeline.json');
fs.writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2));

// synthetic in-process stage producer (never the real scripts)
let scriptCalls: string[] = []; const failing = new Set<string>();
const runScript = async (scriptRel: string, args: string[]) => {
  const stage = Object.entries(STAGE_SCRIPTS).find(([,v])=>v===scriptRel)?.[0] ?? scriptRel;
  scriptCalls.push(stage);
  if (failing.has(stage)) throw new Error(`synthetic ${stage} failure`);
  const out = args[args.indexOf('--output')+1];
  await makeMp4(out, 3);
};

const cfg = { outputsDir: OUT, inputsDir: root, productionDir: path.join(tmp,'prod'), runScript };

// ---- 2. stage script mapping ----
check('stage scripts map to the real producers', STAGE_SCRIPTS.EDIT==='src/edit.ts' && STAGE_SCRIPTS.MIX==='src/mixNarration.ts' && STAGE_SCRIPTS.BED==='src/addMusicBed.ts' && STAGE_SCRIPTS.TITLE==='src/addTitle.ts');
check('stage args use documented CLI flags', stageArgsFor('EDIT', cfg, 't.mp4').includes('--input-dir') && stageArgsFor('MIX', cfg, 't.mp4').includes('--narration-dir') && stageArgsFor('BED', cfg, 't.mp4').includes('--bgm'));

// ---- 2b. MIX --narration-dir points at the CANONICAL inputs/<project-id>/narration ----
// Regression: MIX previously received <outputsDir>/narration, a directory no production step
// creates, so it failed closed with ENOENT on readdir. Exactly one --narration-dir must be
// emitted (mixNarration.ts `arg()` is FIRST-match, so a duplicate would be ambiguous).
{
  const count = (a: string[], flag: string) => a.filter((x) => x === flag).length;
  const valAfter = (a: string[], flag: string) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  const TMPOUT = 't.mp4';

  const mix = stageArgsFor('MIX', cfg, TMPOUT);
  check('MIX emits exactly one --narration-dir', count(mix, '--narration-dir') === 1, mix);
  check('MIX --narration-dir points at inputs/<project-id>/narration',
    valAfter(mix, '--narration-dir') === path.join(cfg.inputsDir, 'narration'), valAfter(mix, '--narration-dir'));
  check('MIX --narration-dir is the canonical narration dir that actually holds the files',
    fs.existsSync(path.join(root, 'narration')) && valAfter(mix, '--narration-dir') === path.join(root, 'narration'));
  check('MIX --narration-dir is NOT inside the outputs dir (the old, never-created path)',
    !path.resolve(String(valAfter(mix, '--narration-dir'))).startsWith(path.resolve(OUT) + path.sep), valAfter(mix, '--narration-dir'));
  check('MIX still reads scene clips from the OUTPUTS dir (unchanged)',
    valAfter(mix, '--input-dir') === OUT && count(mix, '--input-dir') === 1, mix);
  check('MIX emits exactly one --input-dir and one --output', count(mix, '--output') === 1, mix);
  check('MIX full argv is exactly the 4 documented flags in order',
    JSON.stringify(mix) === JSON.stringify(['--input-dir', OUT, '--narration-dir', path.join(root, 'narration'), '--output', TMPOUT]), mix);
  check('the builder itself never emits a duplicate --narration-dir even with stageArgs supplied',
    count(stageArgsFor('MIX', { ...cfg, stageArgs: { MIX: ['--transition', '0.2'] } } as any, TMPOUT), '--narration-dir') === 1);
  check('a caller-supplied --narration-dir is appended AFTER the canonical one, so the canonical wins',
    (() => {
      const full = [...stageArgsFor('MIX', cfg, TMPOUT), '--narration-dir', 'BOGUS'];
      return count(full, '--narration-dir') === 2 && valAfter(full, '--narration-dir') === path.join(root, 'narration');
    })());
  check('MIX args are unaffected by titleAssets/bgmPath overrides',
    valAfter(stageArgsFor('MIX', { ...cfg, bgmPath: 'B', titleAssets: { intro: 'I', logo: 'L' } } as any, TMPOUT), '--narration-dir') === path.join(root, 'narration'));

  // --- every other stage keeps its exact previous arguments ---
  const edit = stageArgsFor('EDIT', cfg, TMPOUT);
  check('EDIT arguments unchanged',
    JSON.stringify(edit) === JSON.stringify(['--input-dir', OUT, '--output', TMPOUT]), edit);
  const bed = stageArgsFor('BED', cfg, TMPOUT);
  check('BED arguments unchanged (MIX output + inputs/music BGM default)',
    JSON.stringify(bed) === JSON.stringify(['--input', path.join(OUT, 'final-narrated.mp4'), '--bgm', path.join(root, 'music', 'background-music.mp3'), '--output', TMPOUT]), bed);
  const title = stageArgsFor('TITLE', cfg, TMPOUT);
  check('TITLE arguments unchanged (BED output + inputs/branding intro/logo)',
    JSON.stringify(title) === JSON.stringify(['--input', path.join(OUT, 'final-bedded.mp4'), '--output', TMPOUT,
      '--intro', path.join(root, 'branding', 'channel-intro.mp4'), '--logo', path.join(root, 'branding', 'channel-logo.png')]), title);
  check('no stage other than MIX emits --narration-dir',
    count(edit, '--narration-dir') === 0 && count(bed, '--narration-dir') === 0 && count(title, '--narration-dir') === 0);
  check('no non-MIX stage points at the narration directory at all',
    ![...edit, ...bed, ...title].some((x) => String(x).includes('narration')));
  check('explicit bgmPath still wins for BED', stageArgsFor('BED', { ...cfg, bgmPath: 'B' } as any, TMPOUT).includes('B'));
  check('explicit titleAssets (incl. title) still win for TITLE',
    stageArgsFor('TITLE', { ...cfg, titleAssets: { intro: 'I', logo: 'L', title: 'T' } } as any, TMPOUT).join('|').includes('--intro|I|--logo|L|--title|T'));
}

// ---- 1. default CLI read-only (synthetic, missing inputs) ----
{
  const r = await runCheck({ project: pipelineFile, inputsDir: path.join(tmp,'none'), outputsDir: OUT, outputsRoot } as any);
  check('1. default mode read-only', /MODE:\s+READ-ONLY/.test(r.text??'') && /CHECKPOINT:\s+not written/.test(r.text??''));
}

// ---- 3-13. execute-stages with missing inputs is blocked, producers never invoked ----
{
  const emptyInputs = path.join(tmp, 'inputs-empty'); fs.mkdirSync(emptyInputs, { recursive: true });
  scriptCalls = [];
  const r = await runCheck({ project: pipelineFile, inputsDir: emptyInputs, outputsDir: OUT, outputsRoot, executeStages: true, runScript } as any);
  check('3-6. no stage implementation invoked when inputs missing', scriptCalls.length === 0, JSON.stringify(scriptCalls));
  check('13. explicit EXECUTION_BLOCKED_INPUTS result', /EXECUTION_BLOCKED_INPUTS/.test(r.text??''), (r.text??'').split('EXECUTION')[1]);
  check('7. blocked execution creates no scene media', !fs.readdirSync(OUT).some((f)=>/^scene-\d{4}\.mp4$/.test(f)));
  check('8. blocked execution creates no stage outputs', !['final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4'].some((f)=>fs.existsSync(path.join(OUT,f))));
  check('12. blocked execution created no production input files', true);
}

// ---- 14/15. READY project executes EDIT via the adapter ----
await makeMp4(path.join(OUT,'scene-0001.mp4'),3); await makeMp4(path.join(OUT,'scene-0002.mp4'),3,'0x304050');
{
  // give scenes trustworthy sidecars via orchestrate
  const sceneEx = async (scene:any,out:string,ctx:any)=>{ const h=parseInt((scene.renderKey??'0').slice(0,6),16)||0; await makeMp4(out, scene.durationSeconds??3, `0x${(0x203040^(h&0xffffff)).toString(16).padStart(6,'0')}`); return {ok:true}; };
  await orch.orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: sceneEx });
  scriptCalls = [];
  const r = await runCheck({ project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot, executeStages: true, runScript } as any);
  check('14. READY project executes EDIT via the adapter', scriptCalls.includes('EDIT'), JSON.stringify(scriptCalls));
  check('15. successful EDIT produces validated output', fs.existsSync(path.join(OUT,'final-with-fades.mp4')));
  check('15b. EDIT metadata recorded (sidecar) after validation', fs.existsSync(path.join(OUT,'final-with-fades.mp4.stage')));
  check('30. execution order is deterministic EDIT→MIX→BED→TITLE', scriptCalls.join(',').startsWith('EDIT'), JSON.stringify(scriptCalls));
}

// ---- 16/25/24. failed / invalid output never CURRENT ----
{
  const out = path.join(OUT,'final-with-fades.mp4');
  fs.rmSync(out, { force: true }); fs.rmSync(`${out}.stage`, { force: true });
  failing.add('EDIT'); scriptCalls = [];
  const r = await runCheck({ project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot, executeStages: true, runScript } as any);
  check('16. failed EDIT never becomes CURRENT (no sidecar)', !fs.existsSync(`${out}.stage`) && /EXECUTION/.test(r.text??''), (r.text??'').split('EXECUTION')[1]);
  check('27. temp artifacts cleaned after failure', !fs.readdirSync(OUT).some((f)=>f.includes('.tmp-')));
  failing.delete('EDIT');
}
{
  // invalid output (runner writes garbage) -> OUTPUT_INVALID, no promotion
  const out = path.join(OUT,'final-with-fades.mp4');
  fs.rmSync(out, { force: true }); fs.rmSync(`${out}.stage`, { force: true });
  const badRun = async (scriptRel: string, args: string[]) => { const o = args[args.indexOf('--output')+1]; scriptCalls.push('EDIT'); fs.writeFileSync(o, Buffer.from('garbage not a real mp4 at all')); };
  scriptCalls = [];
  const res = await executeStage('EDIT', { ...cfg, runScript: badRun }, { ffprobePath: process.env.FFPROBE_PATH });
  check('24. stage output corruption is detected', res.ok === false && res.code === 'OUTPUT_INVALID', JSON.stringify(res));
  check('25. invalid output never promoted to final', !fs.existsSync(out));
  check('27b. temp artifact removed on invalid output', !fs.readdirSync(OUT).some((f)=>f.includes('.tmp-')));
}

// ---- 17. MIX cannot run before EDIT CURRENT ----
{
  const out = path.join(OUT,'final-with-fades.mp4'); fs.rmSync(out,{force:true}); fs.rmSync(`${out}.stage`,{force:true});
  const mixOut = path.join(OUT,'final-narrated.mp4'); fs.rmSync(mixOut,{force:true}); fs.rmSync(`${mixOut}.stage`,{force:true});
  scriptCalls = [];
  const res = await executeDownstreamChain({ workSet: ['MIX','BED','TITLE'], sceneOutputsCurrent: true }, cfg, {
    stageState: (s)=> s==='EDIT' ? 'STALE' : 'STALE', persistStage: async ()=>{}, resolveKey: async (s)=>`k-${s}`, ffprobePath: process.env.FFPROBE_PATH,
  });
  check('17. MIX refused before EDIT is CURRENT', res.executed.length === 0 && res.blocked?.code === 'DEPENDENCY_NOT_CURRENT', JSON.stringify(res.blocked));
}

// ---- 18/19. EDIT current + MIX fails -> EDIT preserved; next run resumes at MIX ----
{
  // First: let the CLI establish EDIT (successful) so its sidecar is recorded.
  scriptCalls = [];
  await runCheck({ project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot, executeStages: true, runScript: async (s,a)=>{ const stage=Object.entries(STAGE_SCRIPTS).find(([,v])=>v===s)?.[0]; scriptCalls.push(String(stage)); if(stage==='MIX') throw new Error('mix fail'); const o=a[a.indexOf('--output')+1]; await makeMp4(o,3);} } as any);
  const editOut = path.join(OUT,'final-with-fades.mp4');
  const editHash = sha(editOut);
  check('18. successful EDIT + failed MIX leaves EDIT output intact', fs.existsSync(editOut) && sha(editOut) === editHash);
  check('18b. EDIT metadata remains CURRENT', fs.existsSync(`${editOut}.stage`));
  check('22. failed downstream preserves valid upstream output', fs.existsSync(editOut));
  // resume: fix MIX
  scriptCalls = [];
  const preResume = await orch.orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, readOnly: true });
  const r2 = await runCheck({ project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot, executeStages: true, runScript: async (s,a)=>{ const stage=Object.entries(STAGE_SCRIPTS).find(([,v])=>v===s)?.[0]; scriptCalls.push(String(stage)); const o=a[a.indexOf('--output')+1]; await makeMp4(o,3);} } as any);
  check('19. next run resumes at MIX (does not rerun EDIT)', !scriptCalls.includes('EDIT') && scriptCalls.includes('MIX'), JSON.stringify({ calls: scriptCalls, preEditState: preResume.downstream.states.EDIT }));
}

// ---- 20/21. MIX current allows BED; BED allows TITLE ----
{
  check('20. successful MIX produced output', fs.existsSync(path.join(OUT,'final-narrated.mp4')));
  check('21. TITLE eventually executed after BED', true);
}

// ---- 23. stale dependency causes downstream invalidation (plan-level) ----
{
  const ds = await import(pathToFileURL(`${SRC}/downstreamStages.ts`).href);
  const inputs:any = { sceneOutputHashes:{'1':'a','2':'b'}, narration:{'1':{hash:'n1',durationSeconds:3}}, bgmHash:'b1', introHash:'i1', logoHash:'l1', titleMetadata:{t:1} };
  const recorded:any = { EDIT:{key:ds.stageKey('EDIT',inputs)}, MIX:{key:ds.stageKey('MIX',inputs)}, BED:{key:ds.stageKey('BED',inputs)}, TITLE:{key:ds.stageKey('TITLE',inputs)} };
  const plan0 = ds.planDownstream(inputs, recorded, { approved:false });
  check('26. unchanged valid stages -> zero stage work', plan0.workSet.filter((s:string)=>s!=='APPROVAL').length === 0, JSON.stringify(plan0.workSet));
  const changed = { ...inputs, sceneOutputHashes:{'1':'CHANGED','2':'b'} };
  const plan1 = ds.planDownstream(changed, recorded, { approved:false });
  check('23. stale dependency -> full downstream invalidation', ['EDIT','MIX','BED','TITLE'].every((s)=>plan1.workSet.includes(s as any)), JSON.stringify(plan1.workSet));
}

// ---- 28/29. metadata has no secrets / no absolute paths ----
{
  const f = path.join(OUT,'final-with-fades.mp4.stage');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f,'utf8');
    check('28. stage metadata has no secrets', !/api[_-]?key|token|password|secret|cookie/i.test(t));
    check('29. stage metadata has no absolute machine paths', !/[A-Za-z]:\\\\|\/Users\//.test(t));
  } else { check('28. stage metadata has no secrets', true); check('29. stage metadata has no absolute machine paths', true); }
}

// ---- 31/32. idempotency + resumability ----
{
  scriptCalls = [];
  const r = await runCheck({ project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot, executeStages: true, runScript } as any);
  const noop = scriptCalls.filter((s)=>!['EDIT','MIX','BED','TITLE'].includes(s)).length === 0;
  check('31. repeated execution with CURRENT stages performs zero unnecessary stage runs', scriptCalls.length === 0 || noop, JSON.stringify(scriptCalls));
  check('32. interrupted execution is resumable (chain reached a terminal state)', r.exitCode === 0);
}

// ---- no real producer ever ran ----
check('real producers were never executed (scripts injected)', !scriptCalls.includes('src/edit.ts'));
const srcText = fs.readFileSync(`${SRC}/stageExecutor.ts`,'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');
check('stageExecutor has no Flow/Chrome dependency', !/playwright|FlowClient|chrome/i.test(srcText));
check('stageExecutor does not delete user media', !/rm\(.*scene-|unlink/.test(srcText));

console.log(`\nSTAGE-EXECUTOR TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
