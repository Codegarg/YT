/**
 * Google Flow project-entry navigation.
 *
 * Flow opens on a project-list/home screen (flow.google.com); the generation
 * runner expects a project editor to be already open (it starts by clicking
 * `S.addMedia`). This module bridges that gap with a small, state-driven and
 * unit-testable decision, plus a thin glue layer for the real page.
 *
 * For an existing project we navigate DIRECTLY to the project's URL extracted
 * from the matching card container's `a[href*="/project/"]` (never clicking a
 * text node and assuming the editor opened). If the card exposes no usable Flow
 * project URL we stop with a clear diagnostic instead of guessing.
 */
import { S } from './selectors.js';

export interface ProjectCardLookup {
  found: boolean;
  url: string | null;
}

/** One candidate card container, annotated with what it contains. */
export interface ProjectCardCandidate {
  /** True when this container holds the requested project title. */
  titleMatches: boolean;
  /** The raw href of the container's project anchor, or null if absent. */
  href: string | null;
}

export interface ProjectListState {
  /** True when a Flow project editor is already open (S.addMedia visible). */
  editorOpen: boolean;
  /** True when the project-list/home screen was detected (New project visible). */
  listReady: boolean;
  /** True when a card matching the requested project name was found. */
  cardFound: boolean;
  /** The matching card's absolute project URL, or null if it could not be read. */
  cardUrl: string | null;
  /**
   * Explicit project URL (e.g. `https://flow.google.com/project/<uuid>`). When set it is
   * AUTHORITATIVE: the runner enters that exact project instead of matching a card by name.
   * This makes entry independent of project-title scraping, which drifts when Flow re-renders
   * or when the manifest title and the Flow title disagree.
   */
  directUrl?: string | null;
}

export type ProjectEntryAction =
  | { kind: 'already-open' }
  | { kind: 'navigate'; url: string; name: string }
  | { kind: 'create' }
  | { kind: 'unresolved'; reason: string };

const FLOW_PROJECT_HOSTS = new Set(['flow.google.com', 'labs.google']);

/**
 * A valid Flow project URL is on a Flow host and points at /project/<id>.
 * The Google multi-account prefix /u/<n>/ is accepted too: it is how a signed-in
 * profile selects WHICH Google account (and therefore whose projects) Flow uses.
 */
export function isFlowProjectUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(String(raw));
    return FLOW_PROJECT_HOSTS.has(url.hostname.toLowerCase()) && /^(?:\/u\/\d+)?\/project\/[^/]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Pick the project URL from candidate card containers.
 * Only containers that actually hold the requested title are considered, so a
 * different project's card is never used. Returns found:true with url:null when
 * a matching card exists but exposes no valid Flow project URL.
 */
export function resolveCardLookup(candidates: ProjectCardCandidate[], baseUrl: string): ProjectCardLookup {
  const titled = (candidates ?? []).filter((candidate) => candidate.titleMatches);
  if (titled.length === 0) return { found: false, url: null };
  for (const candidate of titled) {
    if (!candidate.href) continue;
    let url: string | null = null;
    try { url = new URL(candidate.href, baseUrl).href; } catch { url = null; }
    if (url && isFlowProjectUrl(url)) return { found: true, url };
  }
  return { found: true, url: null };
}

/** Options controlling how `resolveProjectEntry` may reach the project editor. */
export interface ProjectEntryOptions {
  /**
   * Explicitly permit CREATING a new project when no matching card exists.
   *
   * Defaults to FALSE. A title mismatch, a renamed Flow project or DOM drift must never
   * silently become a duplicate project: that splits assets across projects and wastes
   * Flow credits. Creating is only safe when a human has actually asked for a new project.
   */
  allowCreate?: boolean;
}

/**
 * Pure decision: what to do to reach the project editor.
 *
 * Order matters: an already-open editor wins, then an explicit `directUrl` (authoritative),
 * then DOM card matching. `create` is reachable ONLY with an explicit opt-in.
 */
export function resolveProjectEntry(state: ProjectListState, targetName: string, options: ProjectEntryOptions = {}): ProjectEntryAction {
  const target = String(targetName ?? '').trim();
  if (state.editorOpen) return { kind: 'already-open' };

  const direct = String(state.directUrl ?? '').trim();
  if (direct) {
    if (!isFlowProjectUrl(direct)) return { kind: 'unresolved', reason: `The configured Flow project URL is not a valid Flow project URL: "${direct}".` };
    return { kind: 'navigate', url: direct, name: target };
  }

  if (!state.listReady) {
    return { kind: 'unresolved', reason: `Flow editor is not open and the project list was not detected (target: "${target}").` };
  }
  if (!state.cardFound) {
    if (options.allowCreate === true) return { kind: 'create' };
    return { kind: 'unresolved', reason: `No Flow project card matching "${target}" was found. Refusing to create a new project (duplicate-project guard); set FLOW_PROJECT_URL to enter a known project directly, or pass an explicit create opt-in for a genuinely new project.` };
  }
  if (!state.cardUrl) {
    return { kind: 'unresolved', reason: `Found a project card for "${target}" but its project URL could not be extracted from the DOM.` };
  }
  if (!isFlowProjectUrl(state.cardUrl)) {
    return { kind: 'unresolved', reason: `Project card URL is not a valid Flow project URL: "${state.cardUrl}".` };
  }
  return { kind: 'navigate', url: state.cardUrl, name: target };
}

export interface ProjectEntryDeps {
  isEditorOpen(): Promise<boolean>;
  isProjectListReady(): Promise<boolean>;
  findProjectCard(targetName: string): Promise<ProjectCardLookup>;
  navigate(url: string): Promise<void>;
  createProject(): Promise<void>;
  waitForEditor(): Promise<void>;
  log(event: string, data?: Record<string, unknown>): Promise<void> | void;
}

/**
 * Drive the browser to the project editor. Throws a clear diagnostic (without
 * starting generation) if the state cannot be resolved.
 *
 * Never creates a project unless `allowCreate` is explicitly enabled: a missing/renamed
 * card is a fail-closed condition, not an instruction to duplicate the project.
 */
export async function ensureProjectOpen(deps: ProjectEntryDeps, targetName: string, options: ProjectEntryOptions & { directUrl?: string | null } = {}): Promise<ProjectEntryAction> {
  const target = String(targetName ?? '').trim();
  const directUrl = String(options.directUrl ?? '').trim();
  const editorOpen = await deps.isEditorOpen();
  let listReady = false;
  let card: ProjectCardLookup = { found: false, url: null };
  if (!editorOpen && !directUrl) {
    listReady = await deps.isProjectListReady();
    if (listReady) card = await deps.findProjectCard(target);
  }

  const action = resolveProjectEntry({ editorOpen, listReady, cardFound: card.found, cardUrl: card.url, directUrl: directUrl || null }, target, options);
  await deps.log('project_entry', {
    action: action.kind,
    target,
    ...(directUrl ? { directUrl } : {}),
    ...(action.kind === 'navigate' ? { url: action.url } : {}),
  });

  switch (action.kind) {
    case 'already-open':
      return action;
    case 'navigate':
      await deps.navigate(action.url);
      await deps.waitForEditor();
      return action;
    case 'create':
      await deps.createProject();
      await deps.waitForEditor();
      return action;
    case 'unresolved':
      throw new Error(`Could not resolve Flow project state: ${action.reason} Refusing to start generation.`);
  }
}

/** Real-browser glue. Kept separate from the decision so tests need no Playwright. */
export function projectEntryDeps(
  page: any,
  flow: { first(candidates: readonly string[], timeout?: number): Promise<unknown>; click(candidates: readonly string[]): Promise<void> },
  log: (event: string, data?: Record<string, unknown>) => void,
): ProjectEntryDeps {
  return {
    async isEditorOpen() {
      try { await flow.first(S.addMedia, 3000); return true; } catch { return false; }
    },
    async isProjectListReady() {
      try { await flow.first(S.newProject, 5000); return true; } catch { return false; }
    },
    async findProjectCard(targetName: string): Promise<ProjectCardLookup> {
      if (!targetName) return { found: false, url: null };
      try {
        const titleExists = (await page.getByText(targetName, { exact: false }).count()) > 0;
        const candidates: ProjectCardCandidate[] = [];
        // Prefer the observed custom element; fall back to its inner class if needed.
        for (const selector of ['flow-project-card', '.project-card']) {
          const containers = page.locator(selector);
          const count = await containers.count();
          if (count === 0) continue;
          for (let index = 0; index < count; index++) {
            const container = containers.nth(index);
            const titleMatches = (await container.getByText(targetName, { exact: false }).count()) > 0;
            let href: string | null = null;
            const anchor = container.locator('a[href*="/project/"]').first();
            if ((await anchor.count()) > 0) { try { href = await anchor.getAttribute('href'); } catch { href = null; } }
            candidates.push({ titleMatches, href });
          }
          if (candidates.some((candidate) => candidate.titleMatches)) break;
        }
        const lookup = resolveCardLookup(candidates, page.url());
        // A title is visible but no recognized card container resolved: treat as
        // found-but-unresolved so we never accidentally create a duplicate project.
        if (!lookup.found && titleExists) return { found: true, url: null };
        return lookup;
      } catch {
        return { found: false, url: null };
      }
    },
    async navigate(url: string) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    async createProject() {
      await flow.click(S.newProject);
    },
    async waitForEditor() {
      await flow.first(S.addMedia, 60000);
    },
    log,
  };
}
