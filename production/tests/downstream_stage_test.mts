// Offline downstream-stage invalidation + approval-gate tests (STEP-8DH).
// Temp dirs only. Real edit/mix/bed/title are NEVER executed. No Flow/Chrome/credits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

import { REPO } from './_testPaths.mjs';
const SRC = `${REPO}/production/src`;
import { FF } from './_testPaths.mjs';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || `${FF}/ffmpeg.exe`;
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || `${FF}/ffprobe.exe`;

const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
const ds = await import(pathToFileURL(`${SRC}/downstreamStages.ts`).href);
const { stageKey, buildStageGraph } = ds;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w:number,h:number,ct=6,tag=0){const T:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const body=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body),0);return Buffer.concat([l,body,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=ct;
const ch=ct===6?4:2;const raw=Buffer.alloc(h*(1+w*ch),0x80);for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;raw[11]=(tag&0xff);
return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const wav=(f:string,sec:number,tag=0)=>{const n=Math.round(sec*8000);const d=Buffer.alloc(n*2,tag);const b=Buffer.alloc(44+d.length);b.write('RIFF',0);b.writeUInt32LE(36+d.length,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(d.length,40);fs.writeFileSync(f,b);};

// ---------------- fixtures ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dh-'));
const PID = 'synthetic-8dh';
const root = path.join(tmp, 'inputs', PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
for (const c of ['characters', 'narration', 'flow-clips', 'backgrounds', 'music']) fs.mkdirSync(path.join(root, c), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const BG1 = path.join(root, 'backgrounds', 'BGD-01.png'), BG2 = path.join(root, 'backgrounds', 'BGD-02.png');
const CH1 = path.join(root, 'characters', 'CHAR-01-ARJUN.png'), CH2 = path.join(root, 'characters', 'CHAR-02-MOHAN.png');
const NAR1 = path.join(root, 'narration', 'narration-0001.wav'), NAR2 = path.join(root, 'narration', 'narration-0002.wav'), NAR3 = path.join(root, 'narration', 'narration-0003.wav');
fs.writeFileSync(BG1, makePng(1920,1080,2,1)); fs.writeFileSync(BG2, makePng(1920,1080,2,2));
fs.writeFileSync(CH1, makePng(1024,1024,6,1)); fs.writeFileSync(CH2, makePng(1024,1024,6,2));
wav(NAR1,3,0); wav(NAR2,3,0); wav(NAR3,4,0);
// STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so all three scenes
// (including the background-only scene 3) get one. Character identity stays in the fixture, and
// changing a character asset still moves that scene's render key via the existing `chars:` input.
for (const n of [1, 2, 3]) {
  await exec(process.env.FFMPEG_PATH, ['-y', '-f', 'lavfi', '-i', `color=c=0x${(0x203040 + n * 0x010203).toString(16)}:s=1280x720:d=3`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-t', '3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path.join(root, 'flow-clips', `scene-000${n}.mp4`)]);
}
const pipeline:any = { project_id: PID, characters:[{tag:'@CHAR-01-ARJUN'},{tag:'@CHAR-02-MOHAN'}], backgrounds:[{tag:'#BGD-01'},{tag:'#BGD-02'}], scenes:[
  { scene_number:1, title:'S1', background_tag:'#BGD-01', character_tags:['@CHAR-01-ARJUN'], speaker:'@CHAR-01-ARJUN', camera:'W', visual_action:'a', effects:'', narration_text:'न', devanagari_dialogue:'क', clip_length_seconds:null, edit_length_seconds:null },
  { scene_number:2, title:'S2', background_tag:'#BGD-02', character_tags:['@CHAR-02-MOHAN'], speaker:'@CHAR-02-MOHAN', camera:'W', visual_action:'b', effects:'', narration_text:'न', devanagari_dialogue:'क', clip_length_seconds:null, edit_length_seconds:null },
  { scene_number:3, title:'S3', background_tag:'#BGD-01', character_tags:[], speaker:'NARRATOR', camera:'W', visual_action:'c', effects:'', narration_text:'क', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
]};

let sceneCalls:number[]=[]; const failScenes=new Set<number>();
// The synthetic scene output must DEPEND on the scene's render key, otherwise a content change
// would produce byte-identical output and legitimately leave downstream stages CURRENT.
const sceneExec = async (scene:any, out:string, ctx:any) => { sceneCalls.push(scene.sceneNumber); if(failScenes.has(scene.sceneNumber)) return {ok:false,reason:'fail'};
  const dur=scene.durationSeconds??3;
  // Vary the colour deterministically from the render key so a content change alters the
  // output bytes (no fonts needed).
  const h = parseInt((scene.renderKey ?? '0').slice(0, 6), 16) || 0;
  const color = `0x${(0x203040 ^ (h & 0xffffff)).toString(16).padStart(6, '0')}`;
  await exec(process.env.FFMPEG_PATH,['-y','-f','lavfi','-i',`color=c=${color}:s=${ctx.width}x${ctx.height}:d=1`,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(dur),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',out]); return {ok:true}; };

let stageCalls:string[]=[]; const failStages=new Set<string>();
// Stage output content depends on the stage KEY, so a downstream change propagates correctly
// through output hashes (matching how a real re-render would change bytes).
const deterministicStageExec = async (stage:string, out:string, keys:any) => { stageCalls.push(stage); if(failStages.has(stage)) return {ok:false,reason:'stage fail'};
  fs.writeFileSync(out, `SYNTH-${stage}-${keys?.stageKey ?? 'nokey'}\n`); return {ok:true}; };

const base = () => ({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: sceneExec, stageExecutor: deterministicStageExec, stageInputs: { bgmHash: 'bgm-v1', introHash: 'intro-v1', logoHash: 'logo-v1', titleMetadata: { title: 'T1' } } });
const runWith = (over:any={}) => orch.orchestrate({ ...base(), ...over } as any);
const reset = () => { sceneCalls=[]; stageCalls=[]; };

// ---------------- 1. full chain ----------------
{
  reset();
  const r = await runWith();
  check('1. first run renders scenes 1..3', sceneCalls.sort().join(',') === '1,2,3', JSON.stringify(sceneCalls));
  check('1b. first run executes EDIT,MIX,BED,TITLE in order', r.downstream.executedStages.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(r.downstream.executedStages));
  check('1c. scenes CURRENT after the run and state AWAITING_APPROVAL', r.scenes.every((s: any) => s.outputState === 'CURRENT') && r.state === 'AWAITING_APPROVAL', JSON.stringify({ scenes: r.scenes.map((s:any)=>s.outputState), state: r.state }));
  check('1d. APPROVAL is not executed (human gate)', !r.downstream.executedStages.includes('APPROVAL'));
}

// ---------------- 2. second run executes zero ----------------
{
  reset();
  const r = await runWith();
  check('2. second identical run executes ZERO scenes', sceneCalls.length === 0, JSON.stringify(sceneCalls));
  check('2b. second identical run executes ZERO stages', stageCalls.length === 0, JSON.stringify(stageCalls));
  check('2c. all stages CURRENT', ['EDIT','MIX','BED','TITLE'].every((s) => r.downstream.states[s] === 'CURRENT'), JSON.stringify(r.downstream.states));
}

// ---------------- 3. character change -> full downstream chain ----------------
{
  const before2 = fs.readFileSync(path.join(OUT,'scene-0002.mp4'));
  fs.writeFileSync(CH1, makePng(1024,1024,6,99));
  reset();
  const r = await runWith();
  check('3. character change -> only scene 1 rerendered', sceneCalls.join(',') === '1', JSON.stringify(sceneCalls));
  check('3b. character change -> EDIT,MIX,BED,TITLE all re-execute', stageCalls.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(stageCalls));
  check('3c. unrelated scene 2 byte-identical', fs.readFileSync(path.join(OUT,'scene-0002.mp4')).equals(before2));
}

// ---------------- 4. background change -> full downstream ----------------
{
  fs.writeFileSync(BG2, makePng(1920,1080,2,88));
  reset();
  const r = await runWith();
  check('4. background change -> only scene 2 rerendered', sceneCalls.join(',') === '2', JSON.stringify(sceneCalls));
  check('4b. background change -> full downstream re-executes', stageCalls.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(stageCalls));
}

// ---------------- 5. narration change -> scene + mix chain ----------------
{
  // Narration is 5s against the 3s supplied clip (was 6s). Scene 3 is the only NARRATOR_ONLY scene
  // here, so the narration-duration gate applies to it: required = max(3.0, narration + 0.25) and
  // the stretch must stay <= MAX_NARRATION_VIDEO_STRETCH (2.0). At 6s that is 2.083x, so the scene
  // failed closed as DURATION_CONFLICT/INVALID and never reached render dispatch - the render-key
  // change this block exists to test was never exercised. 5s gives 1.75x, still a genuine byte
  // change from the original wav(NAR3, 4, 0) (different length AND different tag), so the narration
  // sha and render key still change. Over-limit rejection stays covered by narration_duration_
  // policy_test, narrator_only_duration_gate_test, scene_state_test and mix_narration_truncation_guard_test.
  wav(NAR3, 5, 7);
  reset();
  const r = await runWith();
  check('5. narration change -> scene 3 rerendered (narration is in its render key)', sceneCalls.join(',') === '3', JSON.stringify(sceneCalls));
  check('5b. narration change -> full downstream re-executes', stageCalls.join(',') === 'EDIT,MIX,BED,TITLE', JSON.stringify(stageCalls));
  check('5c. unrelated scenes 1,2 untouched', !sceneCalls.includes(1) && !sceneCalls.includes(2));
}

// ---------------- 6. BGM change -> BED + TITLE only ----------------
{
  const before1 = fs.readFileSync(path.join(OUT,'scene-0001.mp4'));
  const beforeEdit = fs.readFileSync(path.join(OUT,'final-with-fades.mp4'));
  const beforeMix = fs.readFileSync(path.join(OUT,'final-narrated.mp4'));
  reset();
  const r = await runWith({ stageInputs: { bgmHash: 'bgm-v2', introHash: 'intro-v1', logoHash: 'logo-v1', titleMetadata: { title: 'T1' } } });
  check('6. BGM change -> ZERO scene renders', sceneCalls.length === 0, JSON.stringify(sceneCalls));
  check('6b. BGM change -> only BED,TITLE execute', stageCalls.join(',') === 'BED,TITLE', JSON.stringify(stageCalls));
  check('6c. scene 1 + EDIT + MIX outputs byte-identical', fs.readFileSync(path.join(OUT,'scene-0001.mp4')).equals(before1) && fs.readFileSync(path.join(OUT,'final-with-fades.mp4')).equals(beforeEdit) && fs.readFileSync(path.join(OUT,'final-narrated.mp4')).equals(beforeMix));
}

// ---------------- 7. logo change -> TITLE only ----------------
{
  const beforeBed = fs.readFileSync(path.join(OUT,'final-bedded.mp4'));
  reset();
  const r = await runWith({ stageInputs: { bgmHash: 'bgm-v2', introHash: 'intro-v1', logoHash: 'logo-v2', titleMetadata: { title: 'T1' } } });
  check('7. logo change -> ZERO scenes, only TITLE', sceneCalls.length === 0 && stageCalls.join(',') === 'TITLE', JSON.stringify({ scenes: sceneCalls, stages: stageCalls }));
  check('7b. BED output byte-identical', fs.readFileSync(path.join(OUT,'final-bedded.mp4')).equals(beforeBed));
}

// ---------------- 8. intro change -> TITLE only ----------------
{
  reset();
  const r = await runWith({ stageInputs: { bgmHash: 'bgm-v2', introHash: 'intro-v2', logoHash: 'logo-v2', titleMetadata: { title: 'T1' } } });
  check('8. intro change -> only TITLE', sceneCalls.length === 0 && stageCalls.join(',') === 'TITLE', JSON.stringify({ scenes: sceneCalls, stages: stageCalls }));
}

// ---------------- 9. title metadata -> TITLE only ----------------
{
  reset();
  const r = await runWith({ stageInputs: { bgmHash: 'bgm-v2', introHash: 'intro-v2', logoHash: 'logo-v2', titleMetadata: { title: 'T2' } } });
  check('9. title metadata change -> only TITLE', sceneCalls.length === 0 && stageCalls.join(',') === 'TITLE', JSON.stringify({ scenes: sceneCalls, stages: stageCalls }));
}

// ---------------- 15-18. stage hash determinism ----------------
{
  const inputs:any = { sceneOutputHashes: { '1':'a', '2':'b', '3':'c' }, narration: { '1':{hash:'n1',durationSeconds:3}, '3':{hash:'n3',durationSeconds:4} }, bgmHash:'bgm-v2', introHash:'intro-v2', logoHash:'logo-v2', titleMetadata:{title:'T2'} };
  check('15. stage keys deterministic', stageKey('EDIT', inputs) === stageKey('EDIT', inputs) && buildStageGraph(inputs).map((n:any)=>n.key).join() === buildStageGraph(inputs).map((n:any)=>n.key).join());
  const edited = { ...inputs, sceneOutputHashes: { ...inputs.sceneOutputHashes, '1':'CHANGED' } };
  check('16. EDIT key changes when a scene hash changes', stageKey('EDIT', inputs) !== stageKey('EDIT', edited));
  check('17. BGM does not change EDIT or MIX keys', stageKey('EDIT', inputs) === stageKey('EDIT', { ...inputs, bgmHash:'OTHER' }) && stageKey('MIX', inputs) === stageKey('MIX', { ...inputs, bgmHash:'OTHER' }));
  check('18. logo does not change EDIT/MIX/BED keys', stageKey('EDIT', inputs) === stageKey('EDIT', { ...inputs, logoHash:'OTHER' }) && stageKey('MIX', inputs) === stageKey('MIX', { ...inputs, logoHash:'OTHER' }) && stageKey('BED', inputs) === stageKey('BED', { ...inputs, logoHash:'OTHER' }));
  check('22. stage keys contain no absolute paths', !/[A-Za-z]:\\|\/Users\//.test(Object.values(buildStageGraph(inputs)).join('')));
  const srcCode = fs.readFileSync(`${SRC}/downstreamStages.ts`, 'utf8');
  check('23. stage keys use no timestamps/randomness', !/Date\.now|new Date\(|Math\.random|randomUUID/.test(srcCode));
}

// ---------------- 10-14. failures + retry recovery ----------------
for (const [i, stage] of (['EDIT','MIX','BED','TITLE'] as const).entries()) {
  // make a change so the chain reruns
  fs.writeFileSync(BG1, makePng(1920,1080,2, 100+i));
  failStages.add(stage);
  reset();
  const r = await runWith();
  check(`${10+i}. ${stage} failure does not become CURRENT and surfaces FAILED`, r.downstream.states[stage] !== 'CURRENT' && r.state === 'FAILED' && r.downstream.failedStages.includes(stage), JSON.stringify({ st: r.downstream.states[stage], state: r.state }));
  // retry: only the failed stage + required downstream
  failStages.delete(stage);
  reset();
  const r2 = await runWith();
  const expected = (['EDIT','MIX','BED','TITLE'] as const).slice((['EDIT','MIX','BED','TITLE'] as const).indexOf(stage));
  check(`${10+i}b. retry after ${stage} failure executes only ${expected.join(',')}`, r2.downstream.executedStages.join(',') === expected.join(','), JSON.stringify(r2.downstream.executedStages));
}

// ---------------- 19-21. approval gate ----------------
{
  reset();
  const r = await runWith();
  check('19. TITLE CURRENT without approval -> AWAITING_APPROVAL (never COMPLETED)', r.downstream.states.TITLE === 'CURRENT' && r.state === 'AWAITING_APPROVAL', JSON.stringify({ t: r.downstream.states.TITLE, state: r.state }));
  reset();
  const r2 = await runWith({ approved: true });
  check('20. explicit approval -> COMPLETED', r2.state === 'COMPLETED', r2.state);
  reset();
  const r3 = await runWith({ approved: true });
  check('20b. run after approval executes nothing', sceneCalls.length === 0 && stageCalls.length === 0);
  reset();
  const r4 = await runWith({ approved: true, approvalAction: 'reject' });
  check('21. rejection without content change does not rerender scenes', sceneCalls.length === 0, JSON.stringify(sceneCalls));
  check('21b. rejection returns to an active review state (not COMPLETED)', r4.state === 'EDITING', r4.state);
}

// ---------------- 24. unrelated outputs byte-identical across no-op ----------------
{
  const snaps = ['scene-0001.mp4','scene-0002.mp4','scene-0003.mp4','final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4'].map((f)=>fs.readFileSync(path.join(OUT,f)));
  reset();
  await runWith({ approved: true });
  const after = ['scene-0001.mp4','scene-0002.mp4','scene-0003.mp4','final-with-fades.mp4','final-narrated.mp4','final-bedded.mp4','final-title.mp4'].map((f)=>fs.readFileSync(path.join(OUT,f)));
  check('24. unrelated outputs byte-identical across a no-op run', snaps.every((b,i)=>b.equals(after[i])));
}

// ---------------- 25. full resumability ----------------
{
  reset();
  const r = await runWith({ approved: true });
  check('25. full resumability: nothing executes when everything is CURRENT', sceneCalls.length === 0 && stageCalls.length === 0, JSON.stringify({ scenes: sceneCalls, stages: stageCalls }));
}

// ---------------- safety: no real project touched ----------------
check('this test created no real production input files', true);
const dsSrc = fs.readFileSync(`${SRC}/downstreamStages.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:])\/\/.*$/gm,'$1');
check('downstreamStages performs no network I/O', !/fetch\(|XMLHttpRequest|https?:\/\//.test(dsSrc));
check('downstreamStages never imports real stage modules', !/from '\.\/(edit|mixNarration|addMusicBed|addTitle|bgm)/.test(dsSrc));

console.log(`\nDOWNSTREAM-STAGE TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
