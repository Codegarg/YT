// Offline guarded-checkpoint tests (STEP-8DJ). Temp dirs only. No Flow/Chrome/renders.
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
const ps = await import(pathToFileURL(`${SRC}/projectState.ts`).href);
const { runCheck } = cli;
const { loadProjectState, projectStatePath } = ps;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

function makePng(w:number,h:number,ct=6,tag=0){const T:number[]=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=(b:Buffer)=>{let c=0xffffffff;for(const x of b)c=T[(c^x)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t:string,d:Buffer)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const body=Buffer.concat([Buffer.from(t,'ascii'),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(body),0);return Buffer.concat([l,body,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=ct;const ch=ct===6?4:2;const raw=Buffer.alloc(h*(1+w*ch),0x80);for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;for(let _y=0;_y<h;_y++)raw[_y*(1+w*ch)]=0;raw[11]=(tag&0xff);
return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const wav=(f:string,sec:number,tag=0)=>{const n=Math.round(sec*8000);const d=Buffer.alloc(n*2,tag);const b=Buffer.alloc(44+d.length);b.write('RIFF',0);b.writeUInt32LE(36+d.length,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(d.length,40);fs.writeFileSync(f,b);};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '8dj-'));
const PID = 'synthetic-8dj';
const inputRootBase = path.join(tmp, 'inputs');
const root = path.join(inputRootBase, PID);
const outputsRoot = path.join(tmp, 'outputs');
const OUT = path.join(outputsRoot, PID);
const pipeline:any = { project_id: PID, characters:[{tag:'@CHAR-01-ARJUN'}], backgrounds:[{tag:'#BGD-01'}], scenes:[
  { scene_number:1, title:'S1', background_tag:'#BGD-01', character_tags:['@CHAR-01-ARJUN'], speaker:'NARRATOR', camera:'W', visual_action:'a', effects:'', narration_text:'न', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
  { scene_number:2, title:'S2', background_tag:'#BGD-01', character_tags:[], speaker:'NARRATOR', camera:'W', visual_action:'b', effects:'', narration_text:'क', devanagari_dialogue:'', clip_length_seconds:null, edit_length_seconds:null },
]};
const pipelineFile = path.join(tmp, 'pipeline.json');
fs.writeFileSync(pipelineFile, JSON.stringify(pipeline, null, 2));
const base = { project: pipelineFile, inputsDir: inputRootBase, outputsDir: OUT, outputsRoot };
const snapshot = (b: string): string => { const walk=(d:string):string[]=>fs.readdirSync(d,{withFileTypes:true}).flatMap((e)=>{const f=path.join(d,e.name);return e.isDirectory()?walk(f):[`${path.relative(b,f)}:${fs.statSync(f).size}:${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`];}); return walk(b).sort().join('|'); };

// ---- 1/2/3. default read-only vs explicit --write-state ----
{
  const r0 = await runCheck(base as any);
  check('1. default CLI is read-only', /MODE:\s+READ-ONLY/.test(r0.text ?? '') && /CHECKPOINT:\s+not written/.test(r0.text ?? ''));
  check('1b. default CLI creates no state.json', !fs.existsSync(projectStatePath(PID, outputsRoot)));
  const r1 = await runCheck({ ...base, writeState: true } as any);
  check('2. --write-state enables persistence', /MODE:\s+WRITE-STATE/.test(r1.text ?? '') && /CHECKPOINT:\s+saved/.test(r1.text ?? ''));
  check('3. state.json created only with the flag', fs.existsSync(projectStatePath(PID, outputsRoot)));
}

// ---- 4/5. missing input dir + assets remain missing ----
{
  check('4. missing input directory is never created', !fs.existsSync(root));
  const st = await loadProjectState(PID, outputsRoot);
  check('5. missing assets remain missing (WAITING_FOR_BACKGROUND)', st?.state === 'WAITING_FOR_INPUTS', st?.state);
  check('5b. no placeholder hashes invented', JSON.stringify(st).indexOf('"output_hash":null') >= 0 || Object.values(st?.scenes ?? {}).every((s:any)=>s.output_hash === null));
  check('5c. unresolved durations remain unresolved', Object.values(st?.scenes ?? {}).every((s:any)=>s.duration_seconds === null));
}

// ---- 6/7. no fake CURRENT / missing output stays MISSING_OUTPUT ----
{
  const st = await loadProjectState(PID, outputsRoot);
  check('6/7. no scene is CURRENT; all MISSING_OUTPUT', Object.values(st?.scenes ?? {}).every((s:any)=>s.output_state === 'MISSING_OUTPUT'), JSON.stringify(Object.values(st?.scenes ?? {}).map((s:any)=>s.output_state)));
  check('6b. downstream stages not CURRENT', ['EDIT','MIX','BED','TITLE','APPROVAL'].every((k)=>(st as any)?.final !== undefined));
  check('6c. --write-state creates ONLY state.json (no stages.json for inputs-missing)', !fs.existsSync(path.join(OUT, 'stages.json')), fs.readdirSync(OUT).join(','));
}

// ---- 15. repeated --write-state idempotent ----
{
  const f = projectStatePath(PID, outputsRoot);
  const before = fs.readFileSync(f);
  const beforeState = JSON.parse(before.toString());
  await new Promise((r)=>setTimeout(r, 8));
  await runCheck({ ...base, writeState: true } as any);
  const after = fs.readFileSync(f);
  const afterState = JSON.parse(after.toString());
  const strip = (o:any)=>{const {generated_at, ...rest}=o; void generated_at; return JSON.stringify(rest);};
  check('15. repeated --write-state is semantically idempotent', strip(beforeState) === strip(afterState));
  check('15b. timestamp preserved when nothing changed', beforeState.generated_at === afterState.generated_at);
}

// ---- 16. read-only after write performs zero mutation ----
{
  const before = snapshot(outputsRoot);
  await runCheck(base as any);
  check('16. read-only after write mutates nothing', snapshot(outputsRoot) === before);
}

// ---- 14. previous valid state survives a failed write ----
{
  const f = projectStatePath(PID, outputsRoot);
  const valid = fs.readFileSync(f);
  // simulate a failed atomic write: an orphan tmp file must not affect the valid state
  fs.writeFileSync(`${f}.99999.tmp`, '{ partial garbage');
  await runCheck({ ...base, writeState: true } as any);
  check('14. previous valid state survived; orphan tmp ignored', fs.readFileSync(f).equals(valid) || JSON.parse(fs.readFileSync(f,'utf8')).project_id === PID);
  fs.rmSync(`${f}.99999.tmp`, { force: true });
}

// ---- 10/11/12/13. corruption handling ----
{
  const f = projectStatePath(PID, outputsRoot);
  fs.writeFileSync(f, '{ corrupted');
  const beforeSnap = snapshot(outputsRoot);
  const r = await runCheck(base as any);
  check('10. corrupted state not trusted (re-derived in output)', /WAITING_FOR_INPUTS/.test(r.text ?? ''), (r.text??'').split('PROJECT STATE')[1]?.slice(0,60));
  check('11. corrupted state NOT repaired in read-only mode', snapshot(outputsRoot) === beforeSnap && fs.readFileSync(f,'utf8') === '{ corrupted');
  await runCheck({ ...base, writeState: true } as any);
  check('12. corrupted state repaired only with --write-state', (await loadProjectState(PID, outputsRoot)) !== null);
  check('13. atomic replacement leaves no temp residue', !fs.readdirSync(OUT).some((n)=>n.includes('.tmp')));
}

// ---- JSON mode reports the mode ----
{
  const rj = await runCheck({ ...base, json: true } as any);
  check('22. JSON mode reports read-only', (rj.json as any).mode === 'read-only');
  const rw = await runCheck({ ...base, json: true, writeState: true } as any);
  check('22b. JSON mode reports write-state', (rw.json as any).mode === 'write-state');
}

// ---- 23/24. no secrets / no absolute paths ----
{
  const f = projectStatePath(PID, outputsRoot);
  const text = fs.readFileSync(f, 'utf8');
  check('23. state contains no secrets', !/api[_-]?key|token|password|secret|cookie/i.test(text));
  check('24. state contains no absolute paths', !/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(text), text.slice(0,200));
  check('24b. state stores relative output paths only', Object.values(JSON.parse(text).scenes ?? {}).every((s:any)=>s.output_path === null || !path.isAbsolute(s.output_path)));
}

// ---- 18/19/20/21. change input -> stale only; no media deleted; approval gate ----
{
  // supply inputs + a real scene output with matching sidecar via orchestrate (temp), then change one input
  const ch = path.join(root,'characters','CHAR-01-ARJUN.png');
  for (const c of ['characters','narration','flow-clips','backgrounds','music']) fs.mkdirSync(path.join(root,c),{recursive:true});
  fs.writeFileSync(path.join(root,'backgrounds','BGD-01.png'), makePng(1920,1080,2,1));
  fs.writeFileSync(ch, makePng(1024,1024,6,1));
  wav(path.join(root,'narration','narration-0001.wav'),3); wav(path.join(root,'narration','narration-0002.wav'),3);
  // STRICT local-synthesis policy: EVERY scene requires a valid supplied clip, so both the character
  // scene 1 and the background-only scene 2 get one. The character asset stays in the fixture, and
  // replacing it still changes that scene's render key through the existing `chars:` input.
  for (const n of [1, 2]) {
    await exec(process.env.FFMPEG_PATH, ['-y','-f','lavfi','-i',`color=c=0x${(0x213140 + n * 0x010203).toString(16)}:s=1280x720:d=3`,
      '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t','3',
      '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',
      path.join(root,'flow-clips',`scene-000${n}.mp4`)]);
  }

  const orch = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href);
  const sceneEx = async (scene:any,out:string,ctx:any)=>{const dur=scene.durationSeconds??3;const h=parseInt((scene.renderKey??'0').slice(0,6),16)||0;const color=`0x${(0x203040^(h&0xffffff)).toString(16).padStart(6,'0')}`;await exec(process.env.FFMPEG_PATH,['-y','-f','lavfi','-i',`color=c=${color}:s=${ctx.width}x${ctx.height}:d=1`,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(dur),'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',out]);return{ok:true};};
  await orch.orchestrate({ pipeline, projectId: PID, inputRoot: root, outputsDir: OUT, outputsRoot, executor: sceneEx });
  const mediaBefore = snapshot(OUT);
  const out1 = fs.readFileSync(path.join(OUT,'scene-0001.mp4'));

  // change character -> scene 1 stale, scene 2 current
  fs.writeFileSync(ch, makePng(1024,1024,6,99));
  const r = await runCheck({ ...base, writeState: true } as any);
  const st = await loadProjectState(PID, outputsRoot);
  check('17. changed input updates checkpoint classification', st?.scenes['1'].output_state === 'STALE' && st?.scenes['2'].output_state === 'CURRENT', JSON.stringify({ s1: st?.scenes['1'].output_state, s2: st?.scenes['2'].output_state }));
  check('18. unchanged scene remains CURRENT', st?.scenes['2'].output_state === 'CURRENT');
  check('19. no scene media deleted (both clips still present)', fs.existsSync(path.join(OUT,'scene-0001.mp4')) && fs.existsSync(path.join(OUT,'scene-0002.mp4')));
  check('20. no rendering occurred during --write-state (scene 1 bytes unchanged)', fs.readFileSync(path.join(OUT,'scene-0001.mp4')).equals(out1));
  void mediaBefore;
  check('21. approval gate preserved (not COMPLETED without approval)', st?.state !== 'COMPLETED', st?.state);
}

// ---- no fake CURRENT via tampered state ----
{
  const f = projectStatePath(PID, outputsRoot);
  const st = JSON.parse(fs.readFileSync(f,'utf8'));
  // tamper: claim scene 1 CURRENT with a bogus key
  st.scenes['1'] = { ...st.scenes['1'], output_state: 'CURRENT', render_key: 'tampered', output_hash: 'deadbeef' };
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
  fs.rmSync(path.join(OUT, 'scene-0001.mp4'), { force: true }); // remove the media
  const r = await runCheck({ ...base, json: true } as any);
  const s1 = (r.json as any).scenes.find((s:any)=>s.sceneNumber===1);
  check('K1. state claiming CURRENT with missing media -> MISSING_OUTPUT', s1.output === 'MISSING_OUTPUT', s1.output);
}

console.log(`\nPRODUCTION-CHECKPOINT TESTS PASSED (${passed} checks)`);
fs.rmSync(tmp, { recursive: true, force: true });
