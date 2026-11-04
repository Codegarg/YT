/**
 * `npm run project` — thin CLI over the STEP-8GJ runProject boundary.
 *
 *   npm run project -- new    --title "..."            → allocate a collision-free project id
 *   npm run project -- status --project <pipeline.json>→ read-only status (no lock, no writes)
 *   npm run project -- resume --project <pipeline.json>→ run/resume (locks; no Flow/OpenAI/network)
 *
 * This wrapper does NOT replace or remove any existing command, and does not break
 * start-video.ps1. It NEVER generates Flow content, NEVER approves, NEVER publishes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { allocateProjectId, runProject, projectStatus, resolveProjectPaths } from './projectOrchestrator.js';

function arg(name: string, fallback?: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; }
function jsonFlag(): boolean { return process.argv.includes('--json'); }

const REPO_ROOT = path.resolve(process.cwd(), '..');
const PROJECTS_ROOT = process.env.PROJECTS_ROOT ?? path.join(REPO_ROOT, 'scripting', 'projects');
const INPUTS_ROOT = process.env.INPUTS_ROOT ?? path.join(process.cwd(), 'inputs');
const OUTPUTS_ROOT = process.env.OUTPUTS_ROOT ?? path.join(process.cwd(), 'outputs');

async function main(): Promise<number> {
  const command = String(process.argv[2] ?? '').trim();

  if (command === 'new') {
    const title = arg('--title');
    if (!title) { console.error('project new requires --title "<story title>".'); return 2; }
    const r = await allocateProjectId({ title, projectsRoot: PROJECTS_ROOT, inputsRoot: INPUTS_ROOT, outputsRoot: OUTPUTS_ROOT });
    if (jsonFlag()) console.log(JSON.stringify(r, null, 2));
    else if (r.ok) console.log(`projectId: ${r.projectId}\npipeline:  ${r.paths?.pipelineFile}`);
    else console.error(`FAILED: ${r.reason}`);
    return r.ok ? 0 : 2;
  }

  if (command === 'status' || command === 'resume') {
    const projectFile = arg('--project');
    if (!projectFile) { console.error(`project ${command} requires --project <pipeline.json>.`); return 2; }
    // Derive projectId from the pipeline path's parent dir name (canonical layout).
    const abs = path.resolve(String(projectFile));
    const projectId = path.basename(path.dirname(abs));
    const cfg = { projectId, projectsRoot: PROJECTS_ROOT, inputsRoot: INPUTS_ROOT, outputsRoot: OUTPUTS_ROOT, ffprobePath: process.env.FFPROBE_PATH };
    const r = command === 'status' ? await projectStatus(cfg) : await runProject({ ...cfg, host: undefined });
    if (jsonFlag()) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`project:     ${r.projectId}`);
      console.log(`status:      ${r.status}`);
      console.log(`resumable:   ${r.resumable}`);
      console.log(`completed:   ${r.completed.join('; ') || '-'}`);
      console.log(`nextAction:  ${r.nextAction}`);
      for (const b of r.blockers) console.log(`  blocker [${b.category}]: ${b.detail}`);
    }
    return r.status === 'COMPLETED_TO_APPROVAL' || r.status === 'WAITING_FOR_INPUTS' ? 0 : 1;
  }

  console.error('Usage: npm run project -- <new|status|resume> [--title ...] [--project <pipeline.json>] [--json]');
  return 2;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; });
