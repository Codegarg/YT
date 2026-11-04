// Offline Flow project-entry decision tests. Pure functions only — no Flow, no Chrome,
// no network. Proves the duplicate-project guard and direct-URL entry (STEP-8GQ).
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const pe = await import(pathToFileURL(`${SRC}/projectEntry.ts`).href);
const { isFlowProjectUrl, resolveCardLookup, resolveProjectEntry, ensureProjectOpen } = pe;

let passed = 0;
const check = (label: string, ok: boolean, detail?: any) => { if (ok) { passed++; console.log(`PASS ${label}`); } else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); } };

const TARGET = 'YouTube Automation - raat ke 2 baje shmashan';
const REAL = 'https://flow.google.com/project/c30385ce-bfe4-4177-9730-caf087070f9a';
const BASE = { editorOpen: false, listReady: true, cardFound: true, cardUrl: REAL };

// ---- URL validation ----
check('valid flow project url accepted', isFlowProjectUrl(REAL));
check('relative /project/ path accepted via absolute form', isFlowProjectUrl('https://labs.google/project/abc-def'));
check('non-flow host rejected', !isFlowProjectUrl('https://evil.example.com/project/abc'));
check('flow host without /project/ rejected', !isFlowProjectUrl('https://flow.google.com/'));
check('null rejected', !isFlowProjectUrl(null));
// Google multi-account prefix: /u/<n>/ selects WHICH signed-in account Flow acts as.
check('multi-account url accepted', isFlowProjectUrl('https://flow.google.com/u/1/project/be1f9d68-74b8-4be3-8d4d-40da6e90fcdc'));
check('multi-account url accepted for any index', isFlowProjectUrl('https://flow.google.com/u/0/project/abc-def'));
check('multi-account directUrl navigates', (resolveProjectEntry({ editorOpen: false, listReady: false, cardFound: false, cardUrl: null, directUrl: 'https://flow.google.com/u/1/project/abc-def' }, TARGET) as any).url === 'https://flow.google.com/u/1/project/abc-def');
check('malformed /u/ path rejected', !isFlowProjectUrl('https://flow.google.com/u/abc/project/x'));

// ---- card lookup ----
check('card lookup picks the titled card only', resolveCardLookup(
  [{ titleMatches: false, href: '/project/aaa' }, { titleMatches: true, href: '/project/bbb' }],
  'https://flow.google.com/',
).url === 'https://flow.google.com/project/bbb');
check('titled card without href -> found but url null', (() => {
  const r = resolveCardLookup([{ titleMatches: true, href: null }], 'https://flow.google.com/');
  return r.found === true && r.url === null;
})());
check('no titled card -> not found', resolveCardLookup([{ titleMatches: false, href: '/project/aaa' }], 'https://flow.google.com/').found === false);

// ---- REGRESSION GUARD (the proven live failure) ----
// Live diagnosis: the Flow project title did NOT match the manifest name, so cardFound was
// false and the OLD code returned 'create' -> ensureProjectOpen clicked "New project",
// duplicating the project and burning credits. It must now fail closed.
check('REGRESSION: name mismatch no longer yields create', resolveProjectEntry({ ...BASE, cardFound: false, cardUrl: null }, TARGET).kind === 'unresolved');
check('REGRESSION: unresolved reason mentions duplicate-project guard',
  /duplicate-project guard/.test((resolveProjectEntry({ ...BASE, cardFound: false, cardUrl: null }, TARGET) as any).reason));
check('create still reachable with explicit opt-in',
  resolveProjectEntry({ ...BASE, cardFound: false, cardUrl: null }, TARGET, { allowCreate: true }).kind === 'create');

// ---- direct URL entry ----
check('directUrl navigates without any card lookup', resolveProjectEntry({ editorOpen: false, listReady: false, cardFound: false, cardUrl: null, directUrl: REAL }, TARGET).kind === 'navigate');
check('directUrl wins over a mismatched card state', (resolveProjectEntry({ ...BASE, cardFound: false, cardUrl: null, directUrl: REAL }, TARGET) as any).url === REAL);
check('directUrl bypasses listReady=false', resolveProjectEntry({ editorOpen: false, listReady: false, cardFound: false, cardUrl: null, directUrl: REAL }, TARGET).kind === 'navigate');
check('invalid directUrl -> unresolved, never navigate', resolveProjectEntry({ ...BASE, directUrl: 'https://evil.example.com/project/x' }, TARGET).kind === 'unresolved');
check('already-open editor wins over directUrl', resolveProjectEntry({ ...BASE, editorOpen: true, directUrl: REAL }, TARGET).kind === 'already-open');

// ---- unchanged legacy behaviour ----
check('matching card with url still navigates', (resolveProjectEntry(BASE, TARGET) as any).url === REAL);
check('titled card without url -> unresolved', resolveProjectEntry({ ...BASE, cardUrl: null }, TARGET).kind === 'unresolved');
check('card url not a flow project -> unresolved', resolveProjectEntry({ ...BASE, cardUrl: 'https://evil.example.com/project/x' }, TARGET).kind === 'unresolved');
check('list not detected -> unresolved', resolveProjectEntry({ editorOpen: false, listReady: false, cardFound: false, cardUrl: null }, TARGET).kind === 'unresolved');

// ---- ensureProjectOpen glue: never creates unless opted in ----
function deps(over: any = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      isEditorOpen: async () => over.editorOpen ?? false,
      isProjectListReady: async () => over.listReady ?? true,
      findProjectCard: async () => { calls.push('findProjectCard'); return over.card ?? { found: false, url: null }; },
      navigate: async (u: string) => { calls.push(`navigate:${u}`); },
      createProject: async () => { calls.push('createProject'); },
      waitForEditor: async () => { calls.push('waitForEditor'); },
      log: () => {},
    } as any,
  };
}

{
  const d = deps({ card: { found: false, url: null } });
  let threw = '';
  try { await ensureProjectOpen(d.deps, TARGET); } catch (e: any) { threw = String(e?.message ?? e); }
  check('ensureProjectOpen throws when the project is absent', threw.length > 0);
  check('ensureProjectOpen NEVER called createProject (no duplicate project)', !d.calls.includes('createProject'));
  check('ensureProjectOpen refused to start generation', /Refusing to start generation/.test(threw));
}
{
  const d = deps({ card: { found: false, url: null } });
  let threw = '';
  try { await ensureProjectOpen(d.deps, TARGET, { allowCreate: true }); } catch (e: any) { threw = String(e?.message ?? e); }
  check('explicit opt-in DOES create the project', d.calls.includes('createProject') && threw === '');
}
{
  const d = deps({ listReady: false, card: { found: false, url: null } });
  const action = await ensureProjectOpen(d.deps, TARGET, { directUrl: REAL });
  check('directUrl navigates and waits for the editor', action.kind === 'navigate' && d.calls.includes(`navigate:${REAL}`) && d.calls.includes('waitForEditor'));
  check('directUrl skips the card lookup entirely', !d.calls.includes('findProjectCard'));
}

console.log(`\nproject entry: ${passed} checks passed`);