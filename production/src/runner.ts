import fs from 'node:fs/promises'; import path from 'node:path'; import { Pipeline, Item, RunOptions, RunSelection } from './types.js'; import { FlowClient } from './flowClient.js'; import { S } from './selectors.js';
import { getCachedBackground, safeTagStem, readPngDimensions, isAspectCompatible, meetsMinimumResolution } from './assetCache.js';
import { inputCategoryDir } from './inputManifest.js';
import {
  classifyBackgroundGeneration,
  currentFlowImageGenerationCapability,
  flowImageGenerationUnknown,
  WAITING_FOR_EXTERNAL_BACKGROUND_INPUT,
  EXTERNAL_BACKGROUND_READINESS,
  type BackgroundInputSource,
  type FlowImageGenerationCapability,
} from './flowCapabilities.js';
import { deriveRoutesFromMountedSceneUrl, resolveSceneAttachmentTarget } from './videoDecisions.js';
import { buildFlowScenePrompt } from './sceneFlowWorkflow.js';
import { detectWardrobeMode } from './characterWardrobe.js';
import {
  beginBoundedGeneration,
  finishBoundedGeneration,
  resolveLegacyGenerationLedgerPath,
  resolveGenerationPolicy,
  policyFromEnv,
  approvalFromEnv,
  type BoundedAttempt,
  type GenerationApproval,
  type GenerationPolicy,
  type GenerationSubject,
} from './generationAttempts.js';

const isLocked = (item:any): boolean => item?.locked === true;

/** Throw a clear, actionable error before any Flow action if a scene's assets are not locked. */
export function assertSceneAssetsLocked(p:Pipeline, scene:any): void {
  const characters:any[] = p.characters ?? [];
  const backgrounds:any[] = p.backgrounds ?? [];
  const sceneNumber = Number(scene?.scene_number);
  const bgTag = String(scene?.background_tag ?? scene?.assets?.background_tag ?? '');
  const bg = backgrounds.find((b)=>String(b.tag)===bgTag);
  if (!bgTag) throw new Error(`Scene ${sceneNumber} blocked: no background_tag defined.`);
  if (!bg) throw new Error(`Scene ${sceneNumber} blocked: background ${bgTag} does not exist in the pipeline.`);
  if (!isLocked(bg)) throw new Error(`Scene ${sceneNumber} blocked: background ${bgTag} is not locked. Confirm the background is empty before scene generation.`);
  for (const tag of (scene?.character_tags ?? scene?.assets?.character_tags ?? [])) {
    const character = characters.find((c)=>String(c.tag)===String(tag));
    if (!character) throw new Error(`Scene ${sceneNumber} blocked: character ${tag} does not exist in the pipeline.`);
    if (!isLocked(character)) throw new Error(`Scene ${sceneNumber} blocked: character ${tag} is not locked.`);
  }
}

/**
 * Background-generation boundary dependencies (all optional; production defaults apply).
 * Injected in tests so no browser/network/credits are needed.
 */
export interface RunDependencies {
  /** Resolve whether a background is already satisfied locally (asset cache or supplied input). */
  backgroundLocalState?: (item: Item) => BackgroundInputSource | Promise<BackgroundInputSource>;
  /** Classify the current Flow still-image generation capability (defaults to the current UI verdict). */
  imageGenerationCapability?: () => FlowImageGenerationCapability;
  /** Input root containing `<project-id>/backgrounds/` (defaults to `inputs`). */
  inputsRoot?: string;
  /** Directory holding cached background PNGs (defaults to `assets/backgrounds`). */
  backgroundsDir?: string;
  /** Bounded paid-submission policy override (defaults to the environment/defaults). */
  generationPolicy?: Partial<GenerationPolicy>;
  /** Explicit operator approval for one automatic recovery attempt. */
  generationApproval?: GenerationApproval;
  /** Test seam: an explicit ledger file (defaults to the project's output tree). */
  generationLedgerFile?: string;
}

/**
 * A bounded-attempt refusal. It is NOT a normal failure: `once()` records it as an explicit
 * `blocked` state so the CLI stops instead of retrying a submission the budget refused.
 */
export class GenerationBlockedError extends Error {
  readonly code = 'FLOW_GENERATION_BLOCKED';
  constructor(readonly denialCode: string, readonly detailReason: string) {
    super(`${denialCode}: ${detailReason}`);
    this.name = 'GenerationBlockedError';
  }
}

/**
 * Reserve exactly ONE paid submission for a legacy asset (character/background/scene) against the
 * shared persistent ledger. Credit-free validation must already have run; a refusal throws before
 * any browser action, so no credits are spent.
 */
async function beginBoundedAsset(input: {
  projectId: string;
  out: string;
  subject: GenerationSubject;
  deps: RunDependencies;
}): Promise<BoundedAttempt> {
  if (!input.projectId) {
    throw new GenerationBlockedError('GENERATION_LEDGER_UNRESOLVED', 'the pipeline has no project_id, so no attempt budget can be located.');
  }
  const policy = resolveGenerationPolicy({ ...policyFromEnv(), ...(input.deps.generationPolicy ?? {}) });
  const result = await beginBoundedGeneration({
    ledgerFile: input.deps.generationLedgerFile ?? resolveLegacyGenerationLedgerPath({ projectId: input.projectId, outputDir: input.out }),
    projectId: input.projectId,
    subject: input.subject,
    policy,
    approval: input.deps.generationApproval ?? approvalFromEnv(),
  });
  if (!result.ok) throw new GenerationBlockedError(result.code, result.reason);
  return result.handle;
}

/** Close a reserved legacy attempt; best-effort so persistence can never mask generation truth. */
async function finishBoundedAsset(handle: BoundedAttempt): Promise<void> {
  try {
    await finishBoundedGeneration({ handle, outcome: 'SUCCEEDED', submission: 'SUBMITTED_CONFIRMED' });
  } catch { /* the attempt stays IN_PROGRESS, which fails closed */ }
}

/**
 * Best-effort, read-only local availability resolution for one background:
 *   1. an existing cached background PNG (asset cache), else
 *   2. a valid locally supplied background input PNG.
 * Never generates, downloads, or contacts Flow. Any error fails closed to NONE.
 */
async function resolveLocalBackgroundDefault(item: Item, options: { projectId: string; inputsRoot: string; backgroundsDir: string }): Promise<BackgroundInputSource> {
  const tag = String((item as any).tag ?? (item as any).location_name ?? '').trim();
  if (!tag) return 'NONE';

  // 1) Cached background (previously validated Flow still image).
  try {
    const cache = await getCachedBackground(tag, { backgroundsDir: options.backgroundsDir });
    if (cache.ok) return 'CACHED';
  } catch { /* cache is best-effort; fall through to supplied input */ }

  // 2) Locally supplied background input.
  try {
    if (!options.projectId) return 'NONE';
    const stem = safeTagStem(tag);
    if (!stem) return 'NONE';
    const dir = inputCategoryDir(options.projectId, 'backgrounds', options.inputsRoot);
    const file = path.join(dir, `${stem}.png`);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile() || stat.size <= 0) return 'NONE';
    const buffer = await fs.readFile(file);
    const dims = readPngDimensions(buffer);
    if (dims.ok && meetsMinimumResolution(dims.width, dims.height) && isAspectCompatible(dims.width, dims.height)) return 'SUPPLIED';
  } catch { /* supplied check is best-effort; fall through */ }
  return 'NONE';
}

async function save(file:string,p:Pipeline){ const tmp=file+'.tmp'; await fs.writeFile(tmp,JSON.stringify(p,null,2),'utf8'); await fs.rename(tmp,file); }
function retryable(item:Item){ return item.status!=='done'; }
function mark(item:Item,status:'done'|'failed',error?:unknown){ item.status=status; item.error=status==='failed'?String(error):null; if(status==='done') (item as any).blocked=null; item.updated_at=new Date().toISOString(); }
/**
 * Explicit, non-failure blocked state for assets that depend on an EXTERNAL capability that
 * is currently absent (see flowCapabilities.ts). Mirrors the existing per-scene
 * `WAITING_FOR_BACKGROUND` readiness so no parallel state machine is introduced.
 */
function markBlocked(item:Item,code:string,reason:string|null,detail:string){ item.status='blocked'; item.error=null; (item as any).blocked={ code, reason, detail, readiness:EXTERNAL_BACKGROUND_READINESS }; item.updated_at=new Date().toISOString(); }
/**
 * Explicit, NON-FAILURE blocked state for a paid submission the attempt budget refused. It is
 * distinct from a generation failure: nothing was submitted, no credit was spent, and only a human
 * (or a deliberate policy change) can unblock it.
 */
function markGenerationBlocked(item:Item,denialCode:string,reason:string){ item.status='blocked'; item.error=null; (item as any).blocked={ code:'FLOW_GENERATION_BLOCKED', denial_code:denialCode, reason, detail:reason, readiness:'MANUAL_APPROVAL_REQUIRED' }; item.updated_at=new Date().toISOString(); }
async function once(label:string,item:Item,fn:()=>Promise<void>,p:Pipeline,file:string,log:(e:string,d?:any)=>void,failFast=false){
  if(!retryable(item)) return;
  try { log('start',{label}); await fn(); mark(item,'done'); log('done',{label}); await save(file,p); }
  catch(e) {
    if (e instanceof GenerationBlockedError) {
      markGenerationBlocked(item, e.denialCode, e.detailReason);
      log('generation_blocked',{label,code:e.denialCode,reason:e.detailReason,hint:'Inspect "npm run video -- flow-attempts --project-id <id>"; set FLOW_APPROVE_GENERATION_RECOVERY=1 (or FLOW_APPROVE_GENERATION_RECOVERY_SCENES=<n>) only after checking Flow.'});
      await save(file,p);
      if(failFast) throw e;
      return;
    }
    mark(item,'failed',e); log('failed',{label,error:String(e)}); await save(file,p);
    if(failFast) throw e;
  }
}

/**
 * Resolve which assets to process.
 * With no `limit`/`only`, returns everything (existing behavior unchanged).
 * With a scene filter, also returns just the characters/backgrounds those
 * scenes depend on, so a subset run does not create unused assets.
 */
export function selectWork(p:Pipeline, options:RunOptions = {}): RunSelection {
  const allScenes=[...(p.scenes??[])].sort((a,b)=>Number(a.scene_number)-Number(b.scene_number));
  if (options.only===undefined && options.limit===undefined) return { characters:p.characters??[], backgrounds:p.backgrounds??[], scenes:allScenes };
  let scenes=allScenes;
  if (options.only!==undefined) { const wanted=new Set(options.only.map(Number)); scenes=scenes.filter((s)=>wanted.has(Number(s.scene_number))); }
  if (options.limit!==undefined) scenes=scenes.filter((s)=>s.status!=='done').slice(0,options.limit);
  const bgTags=new Set<string>(); const charTags=new Set<string>();
  for (const s of scenes) {
    const assets:any=(s as any).assets??{};
    const bg=String(assets.background_tag ?? (s as any).background_tag ?? ''); if(bg) bgTags.add(bg);
    for (const t of (assets.character_tags ?? (s as any).character_tags ?? [])) charTags.add(String(t));
  }
  return {
    characters:(p.characters??[]).filter((c)=>charTags.has(String(c.tag))),
    backgrounds:(p.backgrounds??[]).filter((b)=>bgTags.has(String(b.tag))),
    scenes,
  };
}

export async function run(flow:FlowClient,page:any,p:Pipeline,file:string,out:string,log:(e:string,d?:any)=>void,selection:RunSelection,failFast=false,deps:RunDependencies={}){
  await fs.mkdir(out,{recursive:true});

  // ---- background boundary: fail closed on an unavailable external capability ----
  const projectId = String((p as any).project_id ?? '');
  const inputsRoot = deps.inputsRoot ?? 'inputs';
  const backgroundsDir = deps.backgroundsDir ?? path.resolve('assets','backgrounds');
  const capabilityOf = deps.imageGenerationCapability ?? currentFlowImageGenerationCapability;
  const localOf = deps.backgroundLocalState ?? ((item: Item) => resolveLocalBackgroundDefault(item, { projectId, inputsRoot, backgroundsDir }));

  // ---- characters (unchanged) ----
  for(const [i,c] of selection.characters.entries()) await once(`character:${i+1}`,c,async()=>{ const tileName=String(c.tag??c.name); const generationAttempt=await beginBoundedAsset({projectId,out,subject:{kind:'character',id:tileName},deps}); await flow.click(S.addMedia); await flow.click(S.addCharacter); await flow.prompt(String(c.full_prompt)); await flow.generate(); await flow.renameGeneratedCharacter(tileName); await flow.openCharacterDetail(tileName); const look=String(c.look_summary??''); const voice=(c.voice??{}) as any; const gender=voice.gender??(look.match(/\b(female|woman|girl|स्त्री|महिला)\b/i)?'female':'male'); const age=String(voice.age??(look.match(/\b\d{2}\s*(?:year|yr|वर्ष)/i)?.[0]??'')); const descriptor=String(voice.descriptor??(look.match(/(?:region|accent|लहजा|क्षेत्र)[^,.;]*/i)?.[0]??'उत्तर भारतीय लहजा')); await flow.configureVoice({gender,age,descriptor,name:String(c.name??c.tag),voiceName:String(voice.voiceName??c.name??c.tag)}); if (await flow.verifyVoiceApplied(String(voice.voiceName??''))) { (c as any).locked = true; } else { throw new Error(`Character ${tileName} voice verification failed; not locking.`); } await finishBoundedAsset(generationAttempt); },p,file,log,failFast);

  // ---- backgrounds (capability-gated) ----
  // NEVER drive the Agentic composer and NEVER call the obsolete ensureImageGenerationMode()
  // unless a deterministic image-generation capability is actually available.
  for(const [i,b] of selection.backgrounds.entries()) {
    if(!retryable(b)) continue; // already satisfied (e.g. previously generated)
    const tag=String((b as any).tag ?? (b as any).location_name ?? `background:${i+1}`);
    const local=await localOf(b);
    const capability=capabilityOf();
    const plan=classifyBackgroundGeneration({ local, capability });
    if(plan.action==='REUSE_LOCAL'){
      // Existing cached / supplied local asset: keep using it; no Flow capability required.
      mark(b,'done'); (b as any).reuse=plan.code;
      log('background_reuse_local',{tag,code:plan.code,source:local});
      await save(file,p);
      continue;
    }
    if(plan.action==='WAITING_EXTERNAL_INPUT'){
      // Missing background + no deterministic Flow still-image path: explicit external dependency.
      markBlocked(b,plan.code,plan.reason,plan.detail);
      log('background_generation_blocked',{tag,code:plan.code,reason:plan.reason,capability:capability.state});
      await save(file,p);
      continue;
    }
    // Deterministic Flow still-image generation is available: run the EXISTING sequence.
    await once(`background:${i+1}`,b,async()=>{ const generationAttempt=await beginBoundedAsset({projectId,out,subject:{kind:'background',id:tag},deps}); await flow.returnToProjectGrid(); await flow.ensureImageGenerationMode(); await flow.prompt(String(b.full_prompt)); await flow.click(S.aspect16x9); await flow.generateBackground(); await flow.renameGeneratedBackground(String(b.tag??b.location_name)); await finishBoundedAsset(generationAttempt); },p,file,log,failFast);
  }

  // ---- scenes (unchanged) ----
  for(const s of selection.scenes) await once(`scene:${s.scene_number}`,s,async()=>{
    // Lock gate FIRST (unchanged): no generation/attachment happens for unlocked assets.
    assertSceneAssetsLocked(p,s);
    const speaker=String(s.speaker??'').trim();
    const upper=speaker.toUpperCase();
    const narrator=speaker===''||upper==='NARRATOR'||upper==='NONE'||upper==='NOBODY';
    let rawPrompt: unknown = narrator?s.animation_prompt_NARRATOR_ONLY:(s as any).animation_prompt_WITH_lipsync;
    if(!rawPrompt && !speaker) rawPrompt = narrator?(s as any).animation_prompt_WITH_lipsync:s.animation_prompt_NARRATOR_ONLY;
    if(!rawPrompt) throw new Error(`Scene ${s.scene_number} has no ${narrator?'animation_prompt_NARRATOR_ONLY':'animation_prompt_WITH_lipsync'} prompt for speaker ${JSON.stringify(speaker||'(missing)')}.`);
    const built=buildFlowScenePrompt({
      prompt:rawPrompt,
      backgrounds:p.backgrounds as any,
      characters:p.characters as any,
      scene:s,
      wardrobeMode:detectWardrobeMode(p),
    });
    if(!built.ok) throw new Error(`Scene ${s.scene_number} prompt hardening failed: ${built.reason}`);
    const assets=s.assets as any;

    // 1. RESOLVE THE TARGET SCENE BEFORE GENERATING (fail closed, zero credits).
    //    Attachment identity is a stable scene id only. The manifest title is NOT an
    //    identity: Flow scenes are commonly auto-named ("Untitled Scene 10-06 08:27:47")
    //    while the manifest holds an English working title, so a title lookup can
    //    silently attach this scene's result to an UNRELATED scene. Generation spends
    //    Flow credits and cannot be undone, so an unresolvable target stops here.
    const mounted=deriveRoutesFromMountedSceneUrl(page.url());
    const target=resolveSceneAttachmentTarget({
      flowSceneId:(s as any).flow_scene_id,
      mountedRouteSceneId:mounted.ok?mounted.sceneId:null,
    });
    if(target.kind==='unresolved') throw new Error(`Scene ${s.scene_number} attachment target is not identifiable: ${target.reason}.`);

    // CREDIT GATE: exactly ONE bounded, persistently-tracked paid submission for this scene.
    // It is the LAST check before the click, so nothing that can fail for free consumes budget.
    const generationAttempt=await beginBoundedAsset({projectId,out,subject:{kind:'scene',id:String(s.scene_number),sceneNumber:Number(s.scene_number)},deps});

    // 2. Project-level video generation from the scene prompt. x1 is enforced inside
    // generateProjectVideo(); it clicks Start exactly once and the title is read from
    // the actual generated video tile - never predicted from the prompt here.
    const generated=await flow.generateProjectVideo(String(built.prompt));

    // 3. Open the scene by its stable id (never by title).
    const opened=await flow.openSceneEditor(target.sceneId);
    if (opened && opened.url) (s as any).flow_scene_url = opened.url;

    // 4. Reconcile the generated video with the scene Flow opened (evidence-backed):
    //   · 0 clips  → Add Clip → Select media → Videos, matching the EXACT generated
    //                artifact uuid (STEP-8AC). Empty scenes get the real dialog.
    //   · 1 clip   → verify the navigation rail's single aria-current current media
    //                by EXACT uuid equality (STEP-8AA).
    //   · >1 clips → SceneContainsMultipleClipsError (multi-clip is unproven).
    // Identity is always the artifact UUID — never the title, never DOM order.
    await flow.reconcileGeneratedVideoWithScene(generated.title, generated.artifactId);
    // The paid submission is now proven complete: close the bounded attempt as SUCCEEDED.
    await finishBoundedAsset(generationAttempt);

    // 5. Continue the existing scene pipeline: background/character ingredients are
    // attached through the scene editor picker.
    await flow.selectAsset(String(assets?.background_tag));
    for(const tag of (assets?.character_tags??[])) await flow.selectAsset(String(tag));

    // NOTE: the obsolete image-generation download (flow.download(out, `scene-NNNN.mp4`))
    // belonged to the removed in-scene image path and is intentionally removed. The
    // intended output name scene-NNNN.mp4 is preserved and no replacement download
    // mechanism is invented here.
  },p,file,log,failFast);
}
