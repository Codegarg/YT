import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { S } = await import(pathToFileURL(path.join(SRC, 'selectors.ts')).href);
const { FlowClient } = await import(pathToFileURL(path.join(SRC, 'flowClient.ts')).href);
const { diagnosePickerTransition } = await import(pathToFileURL(path.join(SRC, 'pickerDiagnostics.ts')).href);
const { diagnoseCategorySearchTransition } = await import(pathToFileURL(path.join(SRC, 'pickerDiagnostics.ts')).href);
const { diagnosePickerLifecycle } = await import(pathToFileURL(path.join(SRC, 'pickerDiagnostics.ts')).href);

let passed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed += 1; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
}

const fc = fs.readFileSync(path.join(SRC, 'flowClient.ts'), 'utf8');
const sel = fs.readFileSync(path.join(SRC, 'selectors.ts'), 'utf8');
const runner = fs.readFileSync(path.join(SRC, 'runner.ts'), 'utf8');

const bodyOf = (src: string, name: string) => {
  const s = src.indexOf(`async ${name}(`);
  if (s < 0) return '';
  const rest = src.slice(s + 1);
  const m = rest.search(/\n  (private )?async /);
  return m < 0 ? src.slice(s) : src.slice(s, s + 1 + m);
};
const body = bodyOf(fc, 'selectAsset');
// Code-only view (comments stripped) for negative assertions.
const bodyCode = body.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// ---------------------------------------------------------------------------
// Selector additions (additive only; confirmed live DOM)
// ---------------------------------------------------------------------------
check('S.addIngredients confirmed', JSON.stringify(S.addIngredients) === JSON.stringify(["button[aria-label='Add ingredients to the prompt box']"]), S.addIngredients);
check('S.assetPicker confirmed', JSON.stringify(S.assetPicker) === JSON.stringify(['flow-add-menu-popover-content']), S.assetPicker);
check('S.assetList confirmed', JSON.stringify(S.assetList) === JSON.stringify(["cdk-virtual-scroll-viewport[aria-label='Asset list']"]), S.assetList);
check('S.assetRow confirmed', JSON.stringify(S.assetRow) === JSON.stringify(["button.asset-item[role='option']"]), S.assetRow);
check('S.assetTitle confirmed', JSON.stringify(S.assetTitle) === JSON.stringify(['span.asset-title']), S.assetTitle);
check('S.assetSearch confirmed', JSON.stringify(S.assetSearch) === JSON.stringify(['input.search-input']), S.assetSearch);
check('S.assetCategory is an array with the Category navigation tablist', Array.isArray(S.assetCategory) && S.assetCategory[0] === "mat-nav-list[aria-label='Category navigation'] mat-list-item[role='tab']", S.assetCategory);
// unrelated selectors untouched
check('S.promptInput unchanged', JSON.stringify(S.promptInput) === JSON.stringify(["[contenteditable='true']", "div[role='textbox']", "[placeholder*='Describe']"]), S.promptInput);
check('S.addMedia unchanged', JSON.stringify(S.addMedia) === JSON.stringify(["button[aria-label='Add media menu']", "button[aria-label*='Add media']", "button[mattooltip='Add media']"]), S.addMedia);
check('S.submit unchanged', S.submit[0] === "button[aria-label='Start generation']", S.submit);
check('S.picker unchanged', JSON.stringify(S.picker) === JSON.stringify(["[role='listbox']", "[role='menu']"]), S.picker);

// ---------------------------------------------------------------------------
// C. Negative protection — no whole-page getByText(...).last(), no broken shape
// ---------------------------------------------------------------------------
check('C1 selectAsset does not use page.getByText', !/this\.page\.getByText/.test(body), body);
check('C2 selectAsset does not use getByText(...).last()', !/getByText\([^)]*\)\s*\.last\(\)/.test(body), body);
check('C3 flowClient.ts contains no getByText at all', !fc.includes('getByText'), fc.match(/.*getByText.*/g)?.join(' || '));
check('C4 selectAsset never references footer-title', !body.includes('footer-title'), body);
check('C5 selectAsset never references character-tile-name', !body.includes('character-tile-name'), body);
check('C6 row lookup is picker-scoped (assetList + assetRow + assetTitle)', /S\.assetList\[0\]/.test(body) && /S\.assetRow\[0\]/.test(body) && /S\.assetTitle\[0\]/.test(body));
check('C7 asset click uses the normal Playwright click (no evaluate/DOM click)', !/\.evaluate\(/.test(bodyCode) && !/HTMLElement/.test(bodyCode) && /resolveRow\(\)\.click\(\)/.test(bodyCode), bodyCode);
check('C7b normal locator.click() on the row is used exactly once', (bodyCode.match(/\.click\(\)/g) ?? []).length === 1 && (bodyCode.match(/resolveRow\(\)\.click\(\)/g) ?? []).length === 1, bodyCode);
check('C7c no retry loop wraps the click', !/while[\s\S]*?\.click\(\)/.test(bodyCode), bodyCode);
check('C7d scrollIntoViewIfNeeded runs before the single click', bodyCode.indexOf('scrollIntoViewIfNeeded') >= 0 && bodyCode.indexOf('scrollIntoViewIfNeeded') < bodyCode.indexOf('resolveRow().click()'), bodyCode);
check('C7e the settling check runs before the click', /this\.waitForAssetRowToSettle\(resolveRow\)/.test(bodyCode) && bodyCode.indexOf('waitForAssetRowToSettle') < bodyCode.indexOf('resolveRow().click()'), bodyCode);
check('C7f no blind post-click settle sleep remains', !/setTimeout\(resolve,\s*500\)/.test(bodyCode), bodyCode);

const settleBody = bodyOf(fc, 'waitForAssetRowToSettle');
check('C9a settling window is 300-500ms (deterministic, not a blind sleep)', /windowMs\s*=\s*400/.test(settleBody), settleBody);
check('C9b settling samples re-resolve the locator (no cached ElementHandle)', /const row=resolveRow\(\)/.test(settleBody) && !/elementHandle/i.test(settleBody), settleBody);
check('C9c settling checks count/visible/enabled/boundingBox/class', /row\.count\(\)/.test(settleBody) && /isVisible\(\)/.test(settleBody) && /isEnabled\(\)/.test(settleBody) && /boundingBox\(\)/.test(settleBody) && /getAttribute\('class'\)/.test(settleBody), settleBody);
check('C9d settling only fails on overall timeout; the helper never clicks', /never settled before the click/.test(settleBody) && !/disappeared before it could be clicked/.test(settleBody) && !/\.click\(\)/.test(settleBody), settleBody);
check('C9e transient absence resets the window and polling continues (no immediate throw)', /previous=null/.test(settleBody) && /stableSince=0/.test(settleBody) && /current !== previous/.test(settleBody) && /Date\.now\(\)-stableSince >= windowMs/.test(settleBody), settleBody);
check('C9f overall deadline guards the polling loop', /deadline=Date\.now\(\)\+timeoutMs/.test(settleBody) && /while \(Date\.now\(\) < deadline\)/.test(settleBody), settleBody);

const searchBody = bodyOf(fc, 'waitForAssetSearchResultsToSettle');
const searchCode = searchBody.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('C10a search-settle helper is bounded and debounced (not a blind sleep)', /timeoutMs=5000/.test(searchBody) && /intervalMs=\d+/.test(searchBody) && /debounceMs=\d+/.test(searchBody), searchBody);
check('C10b search-settle tolerates absence and resets the debounce', /presentSince=0/.test(searchBody) && /presentSince=Date\.now\(\)/.test(searchBody), searchBody);
check('C10c search-settle never clicks', !/\.click\(\)/.test(searchBody), searchBody);
check('C10d search-settle re-resolves the locator every sample (no cached handle)', /const row=resolveRow\(\)/.test(searchCode) && !/elementHandle/i.test(searchCode), searchCode);
check('C10e search-settle times out with a clear "did not appear" error', /did not appear/.test(searchBody) && /while \(Date\.now\(\) < deadline\)/.test(searchBody), searchBody);
check('C11 selectAsset runs the search-settle phase before the row stability guard', /waitForAssetSearchResultsToSettle\(resolveRow\)/.test(bodyCode) && bodyCode.indexOf('waitForAssetSearchResultsToSettle(resolveRow)') < bodyCode.indexOf('waitForAssetRowToSettle(resolveRow)'), bodyCode);
// Regression: the broken Playwright filter({has}) pattern must be gone.
check('C8 selectAsset does NOT use the broken filter({has: picker.locator(...)}) shape', !/\.filter\(/.test(bodyCode), bodyCode);
check('C9 selectAsset uses CSS :has() + :text-is() for the exact row', /:has\(/.test(body) && /:text-is\(/.test(body), body);
check('C10 the :has() inner is span.asset-title (from S.assetTitle) with exact text', /S\.assetTitle\[0\]\}:text-is\(/.test(body), body);
check('C11 the tag is escaped before interpolation into :text-is()', /replace\(\/\\\\\/g,\s*'\\\\\\\\'\)/.test(body) && /replace\(\/"\/g,\s*'\\\\"'\)/.test(body), body);

// ---------------------------------------------------------------------------
// Branch separation: '#" (background) vs '@' (character)
// ---------------------------------------------------------------------------
const hashIdx = body.indexOf("name.startsWith('#')");
const rowIdx = body.indexOf('const row=');
const branch = body.slice(hashIdx, rowIdx);
const elseIdx = branch.indexOf('} else {');
const bgOnly = branch.slice(0, elseIdx);
const charOnly = branch.slice(elseIdx);

check('branches present', hashIdx >= 0 && rowIdx > hashIdx && elseIdx > 0);

// ---------------------------------------------------------------------------
// B. Background path
// ---------------------------------------------------------------------------
check('B1 background uses the SCENE-EDITOR Add Ingredients button scoped to the scene composer',
  /S\.scenePromptBox\[0\]/.test(body) && /clickWithin\(composer,\s*S\.addIngredients\)/.test(body) && /selectAssetCategory\('Images'\)/.test(bgOnly) && !/this\.click\(S\.addIngredients\)/.test(body), body);
check('B2 picker visibility is required (scene-editor picker must open)', /picker\.waitFor\(\{state:'visible',timeout:15000\}\)/.test(body) && /the scene-editor ingredient picker did not open/.test(body));
check('B3 background selects the Images category', /selectAssetCategory\('Images'\)/.test(bgOnly));
check('B4 background row match is exact via :text-is (not substring/hasText)', /:text-is\(/.test(body) && !/hasText/.test(bodyCode));
check('B5 search input is used when available', /S\.assetSearch\[0\]/.test(body) && /await search\.fill\(name\)/.test(body));
check('B6 background does NOT type the # tag into the composer', !/keyboard\.type/.test(bgOnly), bgOnly);
check('B7 background does NOT click the composer prompt', !/S\.promptInput/.test(bgOnly), bgOnly);
check('B8 background does NOT click any footer-title', !bgOnly.includes('footer-title'));
check('B9 background selects Images and runs the bounded search-settle helper',
  /selectAssetCategory\('Images'\)/.test(bgOnly) && /await this\.waitForAssetSearchResultsToSettle\(resolveRow\);/.test(body), body);

// ---------------------------------------------------------------------------
// A. Character path
// ---------------------------------------------------------------------------
check('A1 character selects the "Characters" category in the scene-editor picker', /selectAssetCategory\('Characters'\)/.test(charOnly), charOnly);
check('A2 character fails clearly if the Characters category is unavailable', /"Characters" category is unavailable/.test(charOnly) && /throw new Error/.test(charOnly), charOnly);
check('A3 character uses the scene composer + scoped scene-editor Add ingredients (shared setup)',
  /S\.scenePromptBox\[0\]/.test(body) && /clickWithin\(composer,\s*S\.addIngredients\)/.test(body));
check('A4 character no longer uses the old promptInput/@ mention path', !/S\.promptInput/.test(body) && !/keyboard\.type/.test(body), body);
check('A5 character uses the SAME corrected picker-scoped row locator', body.indexOf('const row=') > elseIdx);
check('A6 character uses the bounded search/row settle helpers',
  /await this\.waitForAssetSearchResultsToSettle\(resolveRow\);/.test(body) && /await this\.waitForAssetRowToSettle\(resolveRow\);/.test(body));

// ---------------------------------------------------------------------------
// E. runner.ts contract unchanged
// ---------------------------------------------------------------------------
check('E1 selectAsset contract preserved', /async selectAsset\(tag:string\)/.test(fc));
check('E2 runner still calls flow.selectAsset(background_tag)', /flow\.selectAsset\(String\(assets\?\.background_tag\)\)/.test(runner));
check('E3 runner still calls flow.selectAsset(character tag)', /for\(const tag of \(assets\?\.character_tags\?\?\[\]\)\) await flow\.selectAsset\(String\(tag\)\)/.test(runner));
check('E4 runner.ts has no selectAsset-related change (still one-liner pattern)', !/getByText/.test(runner));

// ---------------------------------------------------------------------------
// Behavioral: call ORDER with a fake page (no browser, no Flow)
// ---------------------------------------------------------------------------
const kindOf = (s: string) =>
  s.includes('Add ingredients') ? 'addIngredients'
    : s === 'flow-add-menu-popover-content' ? 'picker'
      : s.includes('Asset list') ? 'assetList'
        : s.includes('asset-item') ? 'row'
          : s.includes('asset-title') ? 'assetTitle'
            : s.includes('search-input') ? 'search'
              : s.includes('Category navigation') ? 'category'
                : s.includes('[contenteditable') ? 'promptInput'
                  : 'other';

function makeFake(tag: string, opts: { failRow?: boolean; stuckPicker?: boolean; rowSelected?: boolean; rowCount?: number; rowEnabled?: boolean; pickerNeverOpens?: boolean } = {}) {
  const calls: string[] = [];
  const state: any = { pickerOpen: true, rowSelected: false };
  const pageGetByTextCalls: string[] = [];

  const make = (s: string, kind: string): any => {
    const node: any = {
      waitFor: async (o: any = {}) => {
        calls.push(`waitFor:${kind}:${o.state ?? 'visible'}`);
        if (kind === 'picker' && o.state === 'visible' && opts.pickerNeverOpens) throw new Error('picker timeout');
        if (kind === 'picker' && o.state === 'hidden') {
          if (opts.stuckPicker) throw new Error('hidden timeout');
          state.pickerOpen = false;
        }
        if (opts.failRow && kind === 'row') throw new Error('row timeout');
      },
      click: async () => { calls.push(`click:${kind}`); if (kind === 'row') state.rowClicked = true; },
      fill: async (v: string) => { calls.push(`fill:${kind}:${v}`); },
      isVisible: async () => { calls.push(`isVisible:${kind}`); return true; },
      getAttribute: async (n: string) => {
        calls.push(`getAttribute:${kind}:${n}`);
        if (n === 'aria-selected') return (state.rowSelected || opts.rowSelected) ? 'true' : 'false';
        return state.rowActive ? 'asset-item-active' : '';
      },
      first: () => node,
      filter: (o: any) => { calls.push(`filter:${kind}${o?.hasText ? ':' + String(o.hasText) : ''}`); return node; },
      locator: (s2: string) => { calls.push(`locator:${s2}`); return make(s2, kindOf(s2)); },
      getByText: (t: string, o: any) => { calls.push(`getByText:${kind}:${t}:${o?.exact}`); return node; },
      scrollIntoViewIfNeeded: async () => { calls.push(`scrollIntoView:${kind}`); },
      evaluate: async (fn: any) => { calls.push(`evaluate:${kind}`); if (typeof fn === 'function') await fn({ click: () => { calls.push(`domClick:${kind}`); } }); },
      isEnabled: async () => { calls.push(`isEnabled:${kind}`); return opts.rowEnabled ?? true; },
      boundingBox: async () => { calls.push(`boundingBox:${kind}`); return { x: 384, y: 71, width: 240, height: 48 }; },
      count: async () => { calls.push(`count:${kind}`); return opts.rowCount ?? 1; },
    };
    return node;
  };

  const page: any = {
    locator: (s: string) => { calls.push(`locator:${s}`); return make(s, kindOf(s)); },
    getByText: (t: string) => { pageGetByTextCalls.push(t); return make(t, 'pageText'); },
    keyboard: { type: async (t: string) => { calls.push(`keyboard.type:${t}`); } },
  };

  const client: any = new FlowClient(page, () => {});
  client.click = async (c: readonly string[]) => { calls.push(`click:${c[0]}`); };
  client.first = async () => ({});
  // Record the two settling phases in call order while keeping their real bodies.
  for (const [label, name] of [['searchSettle', 'waitForAssetSearchResultsToSettle'], ['rowSettle', 'waitForAssetRowToSettle']] as const) {
    const real = client[name].bind(client);
    client[name] = async (...args: any[]) => { calls.push(label); return real(...args); };
  }
  return { client, calls, state, pageGetByTextCalls };
}

// Background: Add ingredients -> Images category -> search -> row -> click row
{
  const tag = '#BGD-01-VILLAGE-STREET-WIDE';
  const { client, calls, state, pageGetByTextCalls } = makeFake(tag);
  await client.selectAsset(tag);
  const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
  const order = calls.join(' | ');
  const firstClick = (cs: string[]) => cs.find((c) => c.startsWith('click:'));
  check('D1 bg: the scene-editor Add ingredients click is the first click action', firstClick(calls) === 'click:addIngredients', order);
  check('D2 bg: picker made visible after the scene-editor Add ingredients click', idx('waitFor:picker:visible') > idx('click:addIngredients'), order);
  check('D3 bg: Images category clicked after picker visible', idx('click:category') > idx('waitFor:picker:visible'), order);
  check('D4 bg: search filled after category', idx('fill:search:' + tag) > idx('click:category'), order);
  check('D5 bg: row waited after search', idx('waitFor:row:visible') > idx('fill:search:' + tag), order);
  check('D6 bg: row-stability (bbox) samples run after the row wait and before the single click', idx('boundingBox:row') > idx('waitFor:row:visible') && idx('click:row') > idx('boundingBox:row') && calls.includes('count:row'), order);
  check('D6b bg: scrollIntoView before the single click', idx('scrollIntoView:row') > idx('waitFor:row:visible') && idx('scrollIntoView:row') < idx('click:row'), order);
  check('D6c bg: no evaluate/DOM click for the row', !calls.includes('evaluate:row') && !calls.includes('domClick:row'), order);
  check('D6d bg: search fill -> search settle -> row stability guard -> scroll -> single click', idx('fill:search:' + tag) < idx('searchSettle') && idx('searchSettle') < idx('rowSettle') && idx('rowSettle') < idx('scrollIntoView:row') && idx('scrollIntoView:row') < idx('click:row'), order);
  check('D7 bg: picker hidden verified', idx('waitFor:picker:hidden') > idx('click:row'), order);
  check('D8 bg: no composer typing of the # tag', !calls.some((c) => c.startsWith('keyboard.type')), order);
  check('D9 bg: no page.getByText used (footer-title protects)', pageGetByTextCalls.length === 0, pageGetByTextCalls);
  check('D10 bg: the corrected row selector uses span.asset-title + :text-is', calls.some((c) => c.startsWith('locator:') && c.includes('span.asset-title') && c.includes(':text-is(')), order);
  check('D11 bg: the normal row click fires exactly once (no retry)', calls.filter((c) => c === 'click:row').length === 1, order);
}

// Character: mention flow preserved -> picker row clicked
{
  const tag = '@CHAR-01-ARJUN';
  const { client, calls, state, pageGetByTextCalls } = makeFake(tag);
  await client.selectAsset(tag);
  const idx = (needle: string) => calls.findIndex((c) => c.includes(needle));
  const order = calls.join(' | ');
  const firstClickChar = (cs: string[]) => cs.find((c) => c.startsWith('click:'));
  check('D12 char: scene-editor Add ingredients is the first click action', firstClickChar(calls) === 'click:addIngredients', order);
  check('D13 char: Characters category clicked after the picker is visible', idx('click:category') > idx('waitFor:picker:visible'), order);
  check('D14 char: search filled after the category click', idx('fill:search:' + tag) > idx('click:category'), order);
  check('D15 char: row clicked once after picker visible', idx('click:row') > idx('waitFor:picker:visible') && calls.filter((c) => c === 'click:row').length === 1, order);
  check('D16 char: scene-editor Add ingredients IS used', calls.includes('click:addIngredients'), order);
  check('D17 char: picker search IS used', calls.some((c) => c.startsWith('fill:search')), order);
  check('D18 char: category IS used', calls.some((c) => c === 'click:category'), order);
  check('D19 char: no page.getByText used', pageGetByTextCalls.length === 0, pageGetByTextCalls);
  check('D20 char: bounded settle phases used', calls.includes('searchSettle') && calls.includes('rowSettle'), order);
}

// Negative: a project-grid footer-title with the same tag must never be selected.
{
  const tag = '#BGD-01-VILLAGE-STREET-WIDE';
  const { client, calls, pageGetByTextCalls } = makeFake(tag);
  await client.selectAsset(tag);
  check('N1 grid footer-title path never invoked', pageGetByTextCalls.length === 0 && !calls.some((c) => c.includes('footer-title')), calls.join(' | '));
}

// Failure propagation: a missing row throws a clear error (no silent continue).
{
  const { client } = makeFake('#BGD-X', { failRow: true });
  let threw = false;
  try { await client.selectAsset('#BGD-X'); } catch (e: any) { threw = /was not found in the Flow ingredient picker/.test(String(e.message)); }
  check('N2 missing asset row throws a clear error', threw);
}
// Verification: picker stays open and the row is not marked selected -> throw.
{
  const { client } = makeFake('#BGD-X', { stuckPicker: true });
  let threw = false;
  try { await client.selectAsset('#BGD-X'); } catch (e: any) { threw = /did not close/.test(String(e.message)); }
  check('N3 unclosed picker + unselected row throws', threw);
}
// Verification: picker stays open but the row IS marked selected -> accepted.
{
  const { client } = makeFake('#BGD-X', { stuckPicker: true, rowSelected: true });
  let threw = false;
  try { await client.selectAsset('#BGD-X'); } catch (e: any) { threw = true; }
  check('N4 unclosed picker + selected row is accepted', !threw);
}

// ===========================================================================
// MOCKED-DOM REGRESSION: Playwright filter({has}) re-rooting vs CSS :has()
// Models Playwright semantics: filter({has}) re-roots the inner locator's WHOLE
// chain under each candidate; a picker-rooted inner chain becomes impossible.
// ===========================================================================
class El {
  tag: string; attrs: Record<string, string>; classes: string[]; text: string; children: El[]; parent: El | null = null;
  constructor(tag: string, opts: { attrs?: Record<string, string>; classes?: string[]; text?: string } = {}) {
    this.tag = tag; this.attrs = opts.attrs ?? {}; this.classes = opts.classes ?? []; this.text = opts.text ?? ''; this.children = [];
  }
  add(c: El) { c.parent = this; this.children.push(c); return c; }
  get descendants(): El[] { const out: El[] = []; const walk = (n: El) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
  get fullText(): string { return [this.text, ...this.children.map((c) => c.fullText)].join(' ').replace(/\s+/g, ' ').trim(); }
}

type Step = { tag?: string; classes: string[]; attrs: [string, string | undefined][]; has?: { step: Step; textIs: string }; textIs?: string };

function parse(sel: string): Step {
  let s = sel.trim();
  let has: Step['has'];
  const hasM = s.match(/:has\((.+)\)$/);
  if (hasM) {
    s = s.slice(0, hasM.index);
    let inner = hasM[1];
    let innerText = '';
    const it = inner.match(/:text-is\(["'](.*)["']\)$/);
    if (it) { innerText = it[1]; inner = inner.slice(0, it.index); }
    has = { step: parse(inner), textIs: innerText };
  }
  let textIs: string | undefined;
  const tm = s.match(/:text-is\(["'](.*)["']\)$/);
  if (tm) { textIs = tm[1]; s = s.slice(0, tm.index); }
  const step: Step = { classes: [], attrs: [], has, textIs };
  const tagM = s.match(/^[a-zA-Z][\w-]*/);
  if (tagM) { step.tag = tagM[0]; s = s.slice(tagM[0].length); }
  const simple = /\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = simple.exec(s))) { if (m[1]) step.classes.push(m[1]); else step.attrs.push([m[2], m[3] ?? m[4]]); }
  return step;
}
function matchesStructural(el: El, st: Step): boolean {
  if (st.tag && el.tag !== st.tag) return false;
  if (!st.classes.every((c) => el.classes.includes(c))) return false;
  for (const [k, v] of st.attrs) { if (v === undefined) { if (!(k in el.attrs)) return false; } else if (el.attrs[k] !== v) return false; }
  return true;
}
function matchesStep(el: El, st: Step): boolean {
  if (!matchesStructural(el, st)) return false;
  if (st.textIs !== undefined && el.fullText !== st.textIs) return false;
  if (st.has) { const ok = el.descendants.some((d) => matchesStructural(d, st.has!.step) && d.fullText === st.has!.textIs); if (!ok) return false; }
  return true;
}
function textMatches(text: string, m: string | RegExp): boolean { return m instanceof RegExp ? m.test(text) : text.includes(m); }

class Loc {
  constructor(public steps: Step[], public filters: any[] = []) {}
  walkFrom(scope: El[]): El[] {
    let cur = scope;
    for (const st of this.steps) { const next: El[] = []; for (const n of cur) for (const d of n.descendants) if (matchesStep(d, st)) next.push(d); cur = next; }
    for (const f of this.filters) {
      if (f.hasText !== undefined) cur = cur.filter((el) => textMatches(el.fullText, f.hasText));
      if (f.has) cur = cur.filter((el) => f.has.walkFrom([el]).length > 0);
    }
    return cur;
  }
  locator(sel: string) { return new Loc([...this.steps, parse(sel)], [...this.filters]); }
  getByText(t: string) { return new Loc([...this.steps, { classes: [], attrs: [], textIs: t }], [...this.filters]); }
  filter(o: any) { return new Loc([...this.steps], [...this.filters, o]); }
  count(root: El) { return this.walkFrom([root]).length; }
  first() { return this; }
}

// Build the live-shaped mock DOM (picker rows + a same-named project-grid tile).
const root = new El('html');
const mockBody = root.add(new El('body'));
const pickerEl = mockBody.add(new El('flow-add-menu-popover-content'));
const listEl = pickerEl.add(new El('cdk-virtual-scroll-viewport', { attrs: { 'aria-label': 'Asset list' }, classes: ['cdk-virtual-scroll-viewport', 'asset-list-viewport'] }));
const addRow = (title: string) => {
  const row = listEl.add(new El('button', { attrs: { role: 'option' }, classes: ['asset-item'] }));
  const item = row.add(new El('flow-add-menu-asset-item'));
  item.add(new El('span', { classes: ['asset-title'], text: title }));
  return row;
};
addRow('#BGD-01-VILLAGE-STREET-WIDE');
addRow('#BGD-01-VILLAGE-STREET-WIDE-EXTRA'); // similar/longer title -> must NOT match
addRow('@CHAR-01-ARJUN');
addRow('Person on rainy village street');
// Project-grid tile with the SAME tag + footer-title (must never be selectable).
const gridTile = mockBody.add(new El('flow-grid-tile-container', { attrs: { 'aria-label': '#BGD-01-VILLAGE-STREET-WIDE' } }));
const footerLeft = gridTile.add(new El('div', { classes: ['footer-left'], attrs: { role: 'button' } }));
footerLeft.add(new El('span', { classes: ['footer-title'], text: '#BGD-01-VILLAGE-STREET-WIDE' }));

const q = (s: string) => new Loc([parse(s)]);
const pickerLoc = q('flow-add-menu-popover-content');
const rowsLoc = pickerLoc.locator("cdk-virtual-scroll-viewport[aria-label='Asset list']").locator("button.asset-item[role='option']");
const titlesLoc = pickerLoc.locator('span.asset-title');

// Build the corrected row locator EXACTLY like production (with the same escaping).
const tag = '#BGD-01-VILLAGE-STREET-WIDE';
const quoted = tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const correctedRow = pickerLoc
  .locator("cdk-virtual-scroll-viewport[aria-label='Asset list']")
  .locator(`button.asset-item[role='option']:has(span.asset-title:text-is("${quoted}"))`);

// 3. Regression: the OLD filter({has: picker-rooted locator}) shape resolves 0.
{
  const exact = new RegExp(`^${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const oldRows = rowsLoc.filter({ has: titlesLoc.filter({ hasText: exact }) });
  check('M1 OLD filter({has: picker.locator(span.asset-title)}) resolves 0 in mocked DOM', oldRows.count(root) === 0, oldRows.count(root));
  // And the page-rooted equivalent (no ancestor chain) DOES re-root correctly.
  const pageRooted = rowsLoc.filter({ has: q('span.asset-title').filter({ hasText: exact }) });
  check('M2 page-rooted inner locator re-roots correctly (count 1)', pageRooted.count(root) === 1, pageRooted.count(root));
}

// 4. New form resolves exactly 1.
check('M3 corrected :has(:text-is) row resolves exactly 1 (background)', correctedRow.count(root) === 1, correctedRow.count(root));

// Character uses the same corrected shape.
{
  const ctag = '@CHAR-01-ARJUN';
  const cquoted = ctag.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cRow = pickerLoc
    .locator("cdk-virtual-scroll-viewport[aria-label='Asset list']")
    .locator(`button.asset-item[role='option']:has(span.asset-title:text-is("${cquoted}"))`);
  check('M4 corrected :has(:text-is) row resolves exactly 1 (character)', cRow.count(root) === 1, cRow.count(root));
}

// 5. Exact matching: a similar/longer title must not match; substring would.
{
  const substringCount = rowsLoc.walkFrom([root]).filter((r) => r.fullText.includes(tag)).length;
  check('M5 similar/longer title is NOT matched by :text-is (exact)', correctedRow.count(root) === 1 && substringCount === 2, { exact: correctedRow.count(root), substring: substringCount });
}

// 6. Project-grid footer-title cannot be selected by the corrected locator.
{
  const pageWideFooter = q('button.asset-item:has(span.footer-title:text-is("#BGD-01-VILLAGE-STREET-WIDE"))');
  check('M6a a footer-title exists in the mocked DOM yet is never matched', q('span.footer-title').count(root) === 1 && pageWideFooter.count(root) === 0 && correctedRow.count(root) === 1);
  check('M6b the corrected lookup is scoped to the picker (titles outside picker ignored)', titlesLoc.count(root) === 4, titlesLoc.count(root));
}

// ===========================================================================
// TIMING / SETTLING: search re-render race is handled before one normal click
// ===========================================================================
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  check('R1 click path runs the settling check (repeated fresh count/bbox samples)', calls.filter((c) => c === 'count:row').length >= 2 && calls.includes('boundingBox:row') && calls.includes('isEnabled:row'), calls.join(' | '));
  check('R2 click path never uses evaluate/DOM click', !calls.includes('evaluate:row') && !calls.includes('domClick:row'), calls.join(' | '));
  check('R3 settling re-resolves the picker-scoped exact row locator', calls.some((c) => c.startsWith('locator:') && c.includes('span.asset-title') && c.includes(':text-is(')), calls.join(' | '));
  check('R4 the normal row click fires exactly once (no retry loop)', calls.filter((c) => c === 'click:row').length === 1, calls.join(' | '));
}
// Settling must FAIL (timeout, no click) when the row never settles.
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  client.waitForAssetRowToSettle = async () => { throw new Error('Asset selection failed: the asset row never settled before the click.'); };
  let threw = false;
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { threw = /never settled before the click/.test(String(e.message)); }
  check('R5 a never-settling row fails with timeout and no click', threw && !calls.includes('click:row'), calls.join(' | '));
}

// ===========================================================================
// SETTLING STATE MACHINE: transient disappearance is tolerated, only the
// overall timeout is fatal. Exercised directly with fast windows.
// ===========================================================================
type SampleKind = 'valid' | 'absent' | 'hidden' | 'disabled' | 'nobox' | 'noclass' | 'moved' | 'reclass';
function sampleRow(kind: SampleKind): any {
  return {
    count: async () => (kind === 'absent' ? 0 : 1),
    isVisible: async () => kind !== 'hidden',
    isEnabled: async () => kind !== 'disabled',
    boundingBox: async () => (kind === 'nobox' ? null : kind === 'moved' ? { x: 400, y: 71, width: 240, height: 48 } : { x: 384, y: 71, width: 240, height: 48 }),
    getAttribute: async () => (kind === 'noclass' ? null : kind === 'reclass' ? 'asset-item active2' : 'asset-item asset-item-active'),
  };
}
function settleHarness(script: SampleKind[]) {
  const samples: SampleKind[] = [];
  let i = 0;
  const client: any = new FlowClient({} as any, () => {});
  const resolveRow = () => { const kind = script[Math.min(i, script.length - 1)]; samples.push(kind); i++; return sampleRow(kind); };
  return { client, resolveRow, samples };
}
const settleOpts = (timeoutMs = 3000) => [60, 10, timeoutMs] as const;
async function runSettle(script: SampleKind[], timeoutMs = 3000) {
  const { client, resolveRow, samples } = settleHarness(script);
  let error = '';
  try { const [w, i, t] = settleOpts(timeoutMs); await client.waitForAssetRowToSettle(resolveRow, w, i, t); }
  catch (e: any) { error = String(e.message); }
  return { error, samples };
}

// A. appears -> disappears -> reappears -> stable: PASS
{
  const { error, samples } = await runSettle(['valid', 'absent', 'valid']);
  check('S-A transient disappearance then reappear+stable settles without error', !error && samples.includes('absent') && samples[samples.length - 1] === 'valid', { error, samples: samples.join(',') });
}
// B. appears -> signature changes -> stable: PASS, timer resets
{
  const { error, samples } = await runSettle(['valid', 'moved']);
  check('S-B signature change resets the window then settles', !error && samples.includes('moved') && samples.filter((s) => s === 'moved').length >= 2, { error, samples: samples.join(',') });
}
// C. repeated absence then stable: PASS
{
  const { error, samples } = await runSettle(['absent', 'absent', 'absent', 'valid']);
  check('S-C repeated absence then stable settles', !error && samples.filter((s) => s === 'absent').length >= 3, { error, samples: samples.join(',') });
}
// C2. each invalid signature form is tolerated as transient
for (const bad of ['hidden', 'disabled', 'nobox', 'noclass'] as SampleKind[]) {
  const { error } = await runSettle([bad, 'valid']);
  check(`S-C2 "${bad}" sample is tolerated as transient (settles after valid)`, !error, error);
}
// D. never valid/stable before timeout: FAIL with clear timeout, no click
{
  const { error } = await runSettle(['absent'], 150);
  check('S-D never-valid row times out with a clear error and no click', /never settled before the click/.test(error), error);
}

// ===========================================================================
// POST-SEARCH SETTLE PHASE (waitForAssetSearchResultsToSettle)
// ===========================================================================
async function runSearchSettle(script: SampleKind[], timeoutMs = 3000) {
  const { client, resolveRow, samples } = settleHarness(script);
  let error = '';
  try { await client.waitForAssetSearchResultsToSettle(resolveRow, 60, 10, timeoutMs); } catch (e: any) { error = String(e.message); }
  return { error, samples };
}
// A. absent -> appears -> remains present for the debounce window: PASS
{
  const { error, samples } = await runSearchSettle(['absent', 'valid']);
  check('P-A target absent then appears and holds -> search settle succeeds', !error && samples[0] === 'absent' && samples[samples.length - 1] === 'valid', { error, samples: samples.join(',') });
}
// B. appears -> disappears -> reappears: debounce resets then succeeds
{
  const { error, samples } = await runSearchSettle(['valid', 'absent', 'valid']);
  check('P-B transient appearance gap resets the debounce then succeeds', !error && samples.includes('absent') && samples.filter((s) => s === 'valid').length >= 2, { error, samples: samples.join(',') });
}
// C. target never appears: timeout, no click
{
  const { error } = await runSearchSettle(['absent'], 120);
  check('P-C target never appears -> clear timeout error (no click)', /did not appear/.test(error), error);
}

// ===========================================================================
// PICKER PHASE DIAGNOSTICS (offline instrumentation; no Flow, no clicks)
// ===========================================================================
const diagSrc = fs.readFileSync(path.join(SRC, 'pickerDiagnostics.ts'), 'utf8');
const diagCode = diagSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const ROW_OK = { count: 1, visible: true, enabled: true };
const ROW_MISSING = { count: 0, visible: false, enabled: false };
const okProbe = async () => ({ ...ROW_OK });
const missingProbe = async () => ({ ...ROW_MISSING });
const fakeClock = () => { const c = { t: 0 }; return { now: () => c.t, sleep: async (ms: number) => { c.t += ms; } }; };
const diagOpts = (clock: any) => ({ windowMs: 100, intervalMs: 50, phaseTimeoutMs: 200, now: clock.now, sleep: clock.sleep });
let diagSampleKeys: string[] = [];

// D-P1: category transition not settled -> target absent -> diagnostic flags 'category'
{
  const clock = fakeClock();
  const specs = [
    { phase: 'picker-open', probe: okProbe },
    { phase: 'category', probe: missingProbe, categoryPresent: () => false },
    { phase: 'search-settle', probe: okProbe },
  ];
  const res: any = await diagnosePickerTransition(specs, missingProbe, diagOpts(clock));
  diagSampleKeys = Object.keys(res.phases[0].samples[0]).sort();
  check('D-P1 diagnostic flags the category phase when the target is absent there',
    res.firstUnavailablePhase === 'category' && res.phases[0].settled === true && res.phases[1].samples.length > 0 && res.phases[1].samples.every((s: any) => s.phase === 'category'),
    JSON.stringify(res.phases.map((p: any) => ({ phase: p.phase, settled: p.settled, n: p.samples.length }))));
}

// D-P2: category settles -> search transition causes target absence -> diagnostic flags search
{
  const clock = fakeClock();
  const specs = [
    { phase: 'picker-open', probe: okProbe },
    { phase: 'category', probe: okProbe, categoryPresent: () => true },
    { phase: 'search-settle', probe: missingProbe },
  ];
  const res: any = await diagnosePickerTransition(specs, missingProbe, diagOpts(clock));
  check('D-P2 diagnostic flags the search phase when the target is absent after search',
    res.firstUnavailablePhase === 'search-settle' && res.phases[1].settled === true,
    String(res.firstUnavailablePhase));
}

// D-P3: target appears and remains valid -> diagnostic reaches row-stability
{
  const clock = fakeClock();
  const specs = ['picker-open', 'category', 'category-settle', 'search', 'search-settle', 'row-stability'].map((phase) => ({ phase, probe: okProbe }));
  const res: any = await diagnosePickerTransition(specs, okProbe, diagOpts(clock));
  check('D-P3 diagnostic reaches row-stability when the target stays valid',
    res.firstUnavailablePhase === null && res.phases.length === 6 && res.phases[5].phase === 'row-stability' && res.phases.every((p: any) => p.settled),
    JSON.stringify(res.phases.map((p: any) => p.phase)));
}

// D-P4: transient absence -> final stable result is NOT misclassified
{
  const clock = fakeClock();
  let n = 0;
  const transientProbe = async () => { n += 1; return n <= 2 ? { ...ROW_MISSING } : { ...ROW_OK }; };
  const specs = [
    { phase: 'picker-open', probe: okProbe },
    { phase: 'search-settle', probe: transientProbe },
  ];
  const res: any = await diagnosePickerTransition(specs, okProbe, diagOpts(clock));
  const searchPhase = res.phases.find((p: any) => p.phase === 'search-settle');
  check('D-P4 transient absence is not misclassified as a final failure',
    res.firstUnavailablePhase === null && searchPhase?.settled === true && searchPhase?.firstUnavailableElapsedMs !== null,
    JSON.stringify({ failed: res.firstUnavailablePhase, settled: searchPhase?.settled, firstUnavailMs: searchPhase?.firstUnavailableElapsedMs }));
}

// D-P5: diagnostic never clicks or launches Flow
check('D-P5 diagnostic helper never clicks or launches Flow',
  !/\.click\(/.test(diagCode) && !/playwright/i.test(diagCode) && !/chromium/i.test(diagCode) && !/flowClient/i.test(diagCode) && !/\blaunch\b/i.test(diagCode),
  diagCode.slice(0, 120));

// D-P6: existing asset-selection execution path remains unchanged
check('D-P6a flowClient does not import the diagnostic helper', !/pickerDiagnostics/.test(fc));
check('D-P6b selectAsset chain unchanged (search-settle -> row-stability -> scroll -> single click)',
  body.indexOf('waitForAssetSearchResultsToSettle') >= 0 &&
  body.indexOf('waitForAssetSearchResultsToSettle') < body.indexOf('waitForAssetRowToSettle') &&
  body.indexOf('waitForAssetRowToSettle') < body.indexOf('scrollIntoViewIfNeeded') &&
  body.indexOf('scrollIntoViewIfNeeded') < body.indexOf('resolveRow().click()') &&
  (body.match(/\.click\(\)/g) ?? []).length === 1);

// D-P7: bounded polling only; no fixed sleep
check('D-P7a diagnostic uses bounded polling with injectable window/interval/timeout',
  /intervalMs \?\? 50/.test(diagSrc) && /windowMs \?\? 300/.test(diagSrc) && /phaseTimeoutMs \?\? 5000/.test(diagSrc) && /while \(now\(\) - phaseStart <= phaseTimeoutMs\)/.test(diagSrc));
check('D-P7b diagnostic introduces no fixed multi-second sleep', !/setTimeout\([^,]*,\s*(?:[1-9]\d{3,})\)/.test(diagCode));
check('D-P7c per-sample shape is {phase, elapsedMs, rowCount, visible, enabled}',
  JSON.stringify(diagSampleKeys) === JSON.stringify(['elapsedMs', 'enabled', 'phase', 'rowCount', 'visible']),
  JSON.stringify(diagSampleKeys));

// ===========================================================================
// CATEGORY-ABSENT INVESTIGATION (offline model only; production NOT changed)
// ===========================================================================
const catBody = bodyOf(fc, 'selectAssetCategory');

// selectAssetCategory now returns a signal (boolean), so selectAsset() can tell
// "category absent but target already available" apart from "category absent and
// target unavailable".
check('F0a selectAssetCategory returns Promise<boolean> with explicit false/true signals',
  /Promise<boolean>/.test(catBody) && /if \(!\(await tab\.isVisible\(\)\.catch\(\(\)=>false\)\)\) return false;/.test(catBody) && /await tab\.click\(\);\s*return true;/.test(catBody), catBody);

// Behavioral proof: absent tab -> no click, returns false.
{
  const calls: string[] = [];
  const fakePage: any = { locator: () => ({ locator: () => ({ filter: () => ({ first: () => ({ isVisible: async () => false, click: async () => { calls.push('category-click'); } }) }) }) }) };
  const client: any = new FlowClient(fakePage, () => {});
  const rv = await client.selectAssetCategory('Images');
  check('F0b absent Images tab -> no click and returns false',
    calls.length === 0 && rv === false, `calls=${calls.join(',')} rv=${String(rv)}`);
}
// Behavioral proof: present tab -> clicks, returns true.
{
  const calls: string[] = [];
  const fakePage: any = { locator: () => ({ locator: () => ({ filter: () => ({ first: () => ({ isVisible: async () => true, click: async () => { calls.push('category-click'); } }) }) }) }) };
  const client: any = new FlowClient(fakePage, () => {});
  const rv = await client.selectAssetCategory('Images');
  check('F0c present Images tab -> clicks and returns true',
    calls.length === 1 && rv === true, `calls=${calls.join(',')} rv=${String(rv)}`);
}

// Pure model of the PROPOSED (not implemented) background decision.
type BgDecision = 'proceed' | 'skip-category-and-proceed' | 'fail-clear';
function decideBackgroundSelection(input: { categoryApplied: boolean; targetAlreadyValid: boolean }): BgDecision {
  if (input.categoryApplied) return 'proceed';
  if (input.targetAlreadyValid) return 'skip-category-and-proceed';
  return 'fail-clear';
}

// F1: category exists -> unchanged Images-category path.
check('F1 category exists -> current Images-category path remains unchanged',
  decideBackgroundSelection({ categoryApplied: true, targetAlreadyValid: false }) === 'proceed');
// F2: category absent but exact target already valid -> skip category, proceed to row.
check('F2 category absent + exact target already valid -> skip category and proceed',
  decideBackgroundSelection({ categoryApplied: false, targetAlreadyValid: true }) === 'skip-category-and-proceed');
// F3: category absent and target absent -> clear failure, never an unrelated asset.
check('F3 category absent + target absent -> fail clearly (never select an unrelated asset)',
  decideBackgroundSelection({ categoryApplied: false, targetAlreadyValid: false }) === 'fail-clear');
// F4: category exists but target not yet present -> category selection remains required.
check('F4 category exists + target not yet present -> category selection remains required (proceed)',
  decideBackgroundSelection({ categoryApplied: true, targetAlreadyValid: false }) === 'proceed');
// Model exhaustiveness: only the three documented decisions, no "pick first row" branch.
{
  const outputs = new Set<string>();
  for (const categoryApplied of [true, false]) for (const targetAlreadyValid of [true, false]) outputs.add(decideBackgroundSelection({ categoryApplied, targetAlreadyValid }));
  check('F3b model only ever yields {proceed, skip-category-and-proceed, fail-clear}',
    [...outputs].sort().join(',') === 'fail-clear,proceed,skip-category-and-proceed', [...outputs].join(','));
}

// F5: character @ path remains completely unchanged.
check('F5a character uses the scene-editor Characters category (no promptInput/mention)',
  /selectAssetCategory\('Characters'\)/.test(charOnly) && !/S\.promptInput/.test(body) && !/keyboard\.type/.test(body), charOnly);
check('F5b character branch switches category explicitly when the picker is sticky',
  /CATEGORY-STICKY/.test(fc) && /selectAssetCategory\('Characters'\)/.test(charOnly));

// F6: proposed model adds no sleep/retry/generation/browser; production not yet changed.
check('F6a proposed decision model has no sleep/retry/loop/browser calls',
  !/setTimeout|sleep|retry|for \(|while \(|chromium|page\.|click/i.test(decideBackgroundSelection.toString()), decideBackgroundSelection.toString());
check('F6b current selectAssetCategory body has no sleep/retry', !/setTimeout|sleep|retry/i.test(catBody), catBody);
check('F6c the scene-editor background lifecycle is implemented (no project-picker fallback)',
  /S\.scenePromptBox\[0\]/.test(body) && /clickWithin\(composer,\s*S\.addIngredients\)/.test(body) && !/categoryApplied/.test(body) && !/Images category was unavailable/.test(body), body);

// ===========================================================================
// FALLBACK IMPLEMENTATION (selectAsset background branch)
// ===========================================================================
// I1: Images category present -> existing search-settle path used.
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  client.selectAssetCategory = async () => true;
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  const order = calls.join(' | ');
  check('I1 category present -> search-settle + row-stability + exactly one click',
    calls.includes('searchSettle') && calls.includes('rowSettle') && calls.filter((c) => c === 'click:row').length === 1, order);
}
// I2: Images category absent + exact target valid -> search-settle skipped, row-stability used.
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  client.selectAssetCategory = async () => false;
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  const order = calls.join(' | ');
  check('I2 category absent is best-effort -> still settles and clicks exactly once',
    calls.includes('searchSettle') && calls.includes('rowSettle') && calls.filter((c) => c === 'click:row').length === 1, order);
}
// I3: Images category absent + target absent -> exact clear error, no click.
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE', { rowCount: 0 });
  client.selectAssetCategory = async () => false;
  let msg = '';
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { msg = String(e.message); }
  check('I3 zero rows -> clear error, no search-settle, no click',
    /expected exactly one row/.test(msg) && !calls.includes('searchSettle') && !calls.includes('click:row'),
    `msg=${msg} | ${calls.join(' | ')}`);
}
// I4: character path uses the scene-editor picker (category + search + settle + one click).
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN');
  await client.selectAsset('@CHAR-01-ARJUN');
  check('I4 character path uses the scene-editor picker (category click + search + settle + exactly one click)',
    calls.some((c) => c === 'click:category') && calls.some((c) => c.startsWith('fill:search')) && calls.includes('searchSettle') && calls.includes('rowSettle') && calls.filter((c) => c === 'click:row').length === 1, calls.join(' | '));
}
// I5: exactly one click is asserted in I1/I2/I4 (no retry loop).
// I6: the fallback adds no sleeps or retries.
check('I6 fallback adds no sleeps or retries', !/setTimeout|sleep|retry/i.test(body) && !/setTimeout|sleep|retry/i.test(catBody), body);

// ===========================================================================
// CATEGORY -> SEARCH -> TARGET TRANSITION DIAGNOSTIC (phases + classifications A–H)
// ===========================================================================
const csState = (over: any = {}) => ({ pickerPresent: true, searchPresent: true, searchVisible: true, searchEnabled: true, rowCount: 1, rowVisible: true, rowEnabled: true, ...over });
const csFixed = (over: any = {}) => async () => csState(over);
const csSeq = (states: any[]) => { let i = 0; return async () => csState(states[Math.min(i++, states.length - 1)]); };
const CS_ORDER = ['category-applied', 'post-category-picker-settle', 'search-ready', 'search-filled', 'post-search-filter', 'target-valid'];
const csRowReq = (s: any) => s.rowCount === 1 && s.rowVisible && s.rowEnabled;
function csRun(overrides: any = {}) {
  const clock = fakeClock();
  const specs = CS_ORDER.map((phase) => ({ phase, probe: overrides[phase]?.probe ?? csFixed({}), required: overrides[phase]?.required }));
  return diagnoseCategorySearchTransition(specs, csFixed({}), { windowMs: 100, intervalMs: 50, phaseTimeoutMs: 200, now: clock.now, sleep: clock.sleep });
}

// H: everything settles.
{
  const r: any = await csRun();
  check('CS-H all phases settle -> H-settled', r.firstFailedPhase === null && r.classification === 'H-settled' && r.phases.length === 6, JSON.stringify(r.classification));
}
// A: picker DOM temporarily rebuilt after the category click (never present).
{
  const r: any = await csRun({ 'category-applied': { probe: csFixed({ pickerPresent: false }) } });
  check('CS-A picker absent after category click -> A-picker-rebuilt', r.firstFailedPhase === 'category-applied' && r.classification === 'A-picker-rebuilt', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// A-transient: picker rebuilt then returns -> tolerated (settles).
{
  const r: any = await csRun({ 'category-applied': { probe: csSeq([{ pickerPresent: false }, { pickerPresent: false }, {}]) } });
  check('CS-A-transient transient picker rebuild is tolerated (no failure)', r.firstFailedPhase === null && r.classification === 'H-settled', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// B: search input not usable after the category change.
for (const [label, over] of [['searchPresent', { searchPresent: false }], ['searchVisible', { searchVisible: false }], ['searchEnabled', { searchEnabled: false }]] as const) {
  const r: any = await csRun({ 'search-ready': { probe: csFixed(over) } });
  check(`CS-B search not ready (${label}) -> B-search-not-ready`, r.firstFailedPhase === 'search-ready' && r.classification === 'B-search-not-ready', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// D: filter settles but exact target row is absent.
{
  const r: any = await csRun({ 'post-search-filter': { probe: csFixed({ rowCount: 0 }), required: csRowReq } });
  check('CS-D filter settled + target absent -> D-target-absent', r.classification === 'D-target-absent', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// E: target exists but invisible.
{
  const r: any = await csRun({ 'post-search-filter': { probe: csFixed({ rowVisible: false }), required: csRowReq } });
  check('CS-E target exists but invisible -> E-target-invisible', r.classification === 'E-target-invisible', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// F: target exists + visible but disabled.
{
  const r: any = await csRun({ 'post-search-filter': { probe: csFixed({ rowEnabled: false }), required: csRowReq } });
  check('CS-F target exists + visible but disabled -> F-target-disabled', r.classification === 'F-target-disabled', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// C: search accepts the value but the filter never settles (row flaps).
{
  const r: any = await csRun({ 'post-search-filter': { probe: csSeq([{ rowCount: 0 }, {}, { rowCount: 0 }, {}, { rowCount: 0 }]), required: csRowReq } });
  check('CS-C filter never settles (row flaps) -> C-filter-not-settled', r.classification === 'C-filter-not-settled', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// G: target becomes valid but not continuously long enough for the debounce.
{
  const r: any = await csRun({ 'target-valid': { probe: csSeq([{}, { rowCount: 0 }, {}, { rowCount: 0 }, { rowCount: 0 }]) } });
  check('CS-G target valid but not continuous -> G-not-continuous', r.firstFailedPhase === 'target-valid' && r.classification === 'G-not-continuous', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// Transient post-search absence that later resolves -> tolerated.
{
  const r: any = await csRun({ 'post-search-filter': { probe: csSeq([{ rowCount: 0 }, { rowCount: 0 }, {}]), required: csRowReq } });
  check('CS-transient post-search absence that resolves is tolerated', r.firstFailedPhase === null && r.classification === 'H-settled', JSON.stringify({ p: r.firstFailedPhase, c: r.classification }));
}
// Per-sample shape.
{
  const r: any = await csRun();
  const expected = ['elapsedMs', 'phase', 'pickerPresent', 'rowCount', 'rowEnabled', 'rowVisible', 'searchEnabled', 'searchPresent', 'searchVisible'].sort();
  check('CS-shape per-sample keys match the required field set',
    JSON.stringify(Object.keys(r.phases[0].samples[0]).sort()) === JSON.stringify(expected),
    JSON.stringify(Object.keys(r.phases[0].samples[0])));
}
// Safety: diagnostic never clicks, launches Flow, or uses a fixed sleep.
{
  const csSrc = fs.readFileSync(path.join(SRC, 'pickerDiagnostics.ts'), 'utf8');
  const csCode = csSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('CS-safety diagnostic never clicks, launches Flow, or uses a fixed multi-second sleep',
    !/\.click\(/.test(csCode) && !/chromium|playwright|flowClient/i.test(csCode) && !/setTimeout\([^,]*,\s*(?:[1-9]\d{3,})\)/.test(csCode));
}

// ===========================================================================
// PICKER LIFECYCLE STATE MACHINE (P0–P7): PICKER_NOT_OPENED
// ===========================================================================
const plState = (over: any = {}) => ({ addIngredientsClicked: true, pickerPresent: true, categoryPresent: true, searchPresent: true, searchVisible: true, searchEnabled: true, rowCount: 1, rowVisible: true, rowEnabled: true, ...over });
const plFixed = (over: any = {}) => async () => plState(over);
const plSeq = (states: any[]) => { let i = 0; return async () => plState(states[Math.min(i++, states.length - 1)]); };
const PL_ORDER = ['add-ingredients-clicked', 'picker-open', 'category-available', 'category-applied', 'post-category-picker-settle', 'search-ready', 'search-filled', 'post-search-filter', 'target-valid'];
const plRowReq = (s: any) => s.rowCount === 1 && s.rowVisible && s.rowEnabled;
function plRun(overrides: any = {}) {
  const clock = fakeClock();
  const specs = PL_ORDER.map((phase) => ({ phase, probe: overrides[phase]?.probe ?? plFixed({}), required: overrides[phase]?.required }));
  return diagnosePickerLifecycle(specs, plFixed({}), { windowMs: 100, intervalMs: 50, phaseTimeoutMs: 200, now: clock.now, sleep: clock.sleep });
}

// P0: picker appears immediately -> proceed.
{
  const r: any = await plRun();
  check('P0 picker appears immediately -> all phases settle, pickerOpenElapsedMs = 0',
    r.firstFailedPhase === null && r.classification === 'H-settled' && r.pickerOpenElapsedMs === 0 && r.phases.length === 9,
    JSON.stringify({ c: r.classification, t: r.pickerOpenElapsedMs, n: r.phases.length }));
}
// P1: picker appears after transient absence -> proceed.
{
  const r: any = await plRun({ 'picker-open': { probe: plSeq([{ pickerPresent: false }, { pickerPresent: false }, {}]) } });
  check('P1 picker appears after transient absence -> proceeds, pickerOpenElapsedMs > 0',
    r.firstFailedPhase === null && r.classification === 'H-settled' && typeof r.pickerOpenElapsedMs === 'number' && r.pickerOpenElapsedMs > 0,
    JSON.stringify({ c: r.classification, t: r.pickerOpenElapsedMs }));
}
// P2: picker never appears -> PICKER_NOT_OPENED, stop before category/search/target.
{
  const r: any = await plRun({ 'picker-open': { probe: plFixed({ pickerPresent: false }) } });
  check('P2 picker never appears -> PICKER_NOT_OPENED and diagnostic stops at picker-open',
    r.classification === 'PICKER_NOT_OPENED' && r.firstFailedPhase === 'picker-open' && r.phases.length === 2 && r.phases[1].samples.every((s: any) => !s.pickerPresent),
    JSON.stringify({ c: r.classification, p: r.firstFailedPhase, n: r.phases.length }));
}
// P3: picker present -> Images absent -> CATEGORY_UNAVAILABLE (not a picker failure).
{
  const r: any = await plRun({ 'category-available': { probe: plFixed({ categoryPresent: false }) } });
  check('P3 picker present + Images absent -> CATEGORY_UNAVAILABLE (not PICKER_NOT_OPENED)',
    r.classification === 'CATEGORY_UNAVAILABLE' && r.firstFailedPhase === 'category-available' && r.pickerOpenElapsedMs !== null,
    JSON.stringify({ c: r.classification, p: r.firstFailedPhase }));
}
// P4: picker + Images present -> category transition proceeds.
{
  const r: any = await plRun();
  check('P4 picker + Images present -> proceeds through the category phases',
    r.firstFailedPhase === null && r.phases.length === 9 && r.phases[1].settled && r.phases[2].settled,
    JSON.stringify({ n: r.phases.length }));
}
// P5: category click -> persistent picker loss -> A-picker-rebuilt.
{
  const r: any = await plRun({ 'category-applied': { probe: plFixed({ pickerPresent: false }) } });
  check('P5 category click -> persistent picker loss -> A-picker-rebuilt',
    r.classification === 'A-picker-rebuilt' && r.firstFailedPhase === 'category-applied',
    JSON.stringify({ c: r.classification, p: r.firstFailedPhase }));
}
// P5b: transient picker rebuild after category click -> tolerated.
{
  const r: any = await plRun({ 'category-applied': { probe: plSeq([{ pickerPresent: false }, { pickerPresent: false }, {}]) } });
  check('P5b transient picker rebuild after category click is tolerated',
    r.firstFailedPhase === null && r.classification === 'H-settled', JSON.stringify({ c: r.classification }));
}
// P6: existing A–H classifications remain valid after the state-machine correction.
{
  const cases: Array<[string, any, string]> = [
    ['target-valid', { rowCount: 0 }, 'D-target-absent'],
    ['target-valid', { rowVisible: false }, 'E-target-invisible'],
    ['target-valid', { rowEnabled: false }, 'F-target-disabled'],
    ['search-ready', { searchVisible: false }, 'B-search-not-ready'],
  ];
  let ok = true;
  const detail: any = {};
  for (const [phase, over, expected] of cases) {
    const r: any = await plRun({ [phase]: { probe: plFixed(over) } });
    detail[`${phase}:${JSON.stringify(over)}`] = r.classification;
    if (r.classification !== expected) ok = false;
  }
  const rg: any = await plRun({ 'target-valid': { probe: plSeq([{}, { rowCount: 0 }, {}, { rowCount: 0 }, { rowCount: 0 }]) } });
  detail.G = rg.classification;
  if (rg.classification !== 'G-not-continuous') ok = false;
  const rc: any = await plRun({ 'post-search-filter': { probe: plSeq([{ rowCount: 0 }, {}, { rowCount: 0 }, {}, { rowCount: 0 }]), required: plRowReq } });
  detail.C = rc.classification;
  if (rc.classification !== 'C-filter-not-settled') ok = false;
  check('P6 existing A–H classifications remain valid via the lifecycle', ok, JSON.stringify(detail));
}
// P7: lifecycle diagnostic never clicks an asset row / launches Flow; no fixed sleep.
{
  const src = fs.readFileSync(path.join(SRC, 'pickerDiagnostics.ts'), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  check('P7 lifecycle diagnostic never clicks / launches Flow / uses a fixed multi-second sleep',
    !/\.click\(/.test(code) && !/chromium|playwright|flowClient/i.test(code) && !/setTimeout\([^,]*,\s*(?:[1-9]\d{3,})\)/.test(code));
}
// P-shape: per-sample keys.
{
  const r: any = await plRun();
  const expected = ['elapsedMs', 'phase', 'addIngredientsClicked', 'pickerPresent', 'categoryPresent', 'searchPresent', 'searchVisible', 'searchEnabled', 'rowCount', 'rowVisible', 'rowEnabled'].sort();
  check('P-shape per-sample keys match the lifecycle field set',
    JSON.stringify(Object.keys(r.phases[0].samples[0]).sort()) === JSON.stringify(expected),
    JSON.stringify(Object.keys(r.phases[0].samples[0])));
}

// ===========================================================================
// SCENE-EDITOR BACKGROUND LIFECYCLE (L1–L8)
// ===========================================================================
// L1 zero rows -> fail
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE', { rowCount: 0 });
  let msg = '';
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { msg = String(e.message); }
  check('L1 zero matching rows -> fails clearly, no click', /expected exactly one row/.test(msg) && !calls.includes('click:row'), `msg=${msg}`);
}
// L2 multiple rows -> fail
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE', { rowCount: 2 });
  let msg = '';
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { msg = String(e.message); }
  check('L2 multiple matching rows -> fails clearly, no click', /expected exactly one row/.test(msg) && !calls.includes('click:row'), `msg=${msg}`);
}
// L3 disabled row -> fail
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE', { rowEnabled: false });
  let msg = '';
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { msg = String(e.message); }
  check('L3 disabled matching row -> fails clearly, no click', /is disabled in the scene-editor picker/.test(msg) && !calls.includes('click:row'), `msg=${msg}`);
}
// L4 picker missing -> fail
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE', { pickerNeverOpens: true });
  let msg = '';
  try { await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE'); } catch (e: any) { msg = String(e.message); }
  check('L4 picker never opens -> fails clearly, no click', /scene-editor ingredient picker did not open/.test(msg) && !calls.includes('click:row'), `msg=${msg}`);
}
// L5 the scene composer is resolved and the click is scoped within it
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  check('L5 background resolves the scene composer (flow-base-prompt-box) before clicking Add ingredients',
    calls.includes('locator:flow-base-prompt-box') && calls.indexOf('locator:flow-base-prompt-box') < calls.indexOf('click:addIngredients'),
    calls.join(' | '));
}
// L6 the unscoped/project-level Add ingredients control is never clicked
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  check('L6 the unscoped project-level Add ingredients control is never clicked',
    !calls.some((c) => c.startsWith("click:button[aria-label='Add ingredients")), calls.join(' | '));
}
// L7 verification after selection (picker closed after exactly one click)
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  check('L7 selection verified (picker hidden after exactly one row click)',
    calls.includes('waitFor:picker:hidden') && calls.filter((c) => c === 'click:row').length === 1, calls.join(' | '));
}
// L8 static: picker root required; asset list picker-scoped; no page-wide getByText / footer-title
check('L8 picker root required + asset list picker-scoped + no getByText/footer-title',
  /picker\.waitFor\(\{state:'visible'/.test(body) && /const resolveRow=\(\)=>picker\.locator\(S\.assetList\[0\]\)/.test(body) && !/getByText/.test(bodyCode) && !/footer-title/.test(body), bodyCode);

// ===========================================================================
// SCENE-EDITOR CHARACTER LIFECYCLE (C1–C17)
// ===========================================================================
// C1 scene editor composer required
check('C1 character requires the scene editor composer (flow-base-prompt-box)', /S\.scenePromptBox\[0\]/.test(body) && /the scene editor was not open/.test(body));
// C2 scene-editor Add Ingredients used (scoped)
check('C2 character uses the scene-editor Add Ingredients scoped to the composer', /clickWithin\(composer,\s*S\.addIngredients\)/.test(body));
// C3 old promptInput never used
check('C3 old promptInput/@-mention path is never used', !/S\.promptInput/.test(body) && !/keyboard\.type/.test(body) && !/\[contenteditable='true'\]/.test(body), bodyCode);
// C4 Characters category selected
check('C4 character selects the Characters category', /selectAssetCategory\('Characters'\)/.test(charOnly), charOnly);
// C5 category-sticky Images handled (explicit switch away from any sticky category)
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  const bgCategoryAt = calls.indexOf('click:category');
  const { client: c2, calls: calls2 } = makeFake('@CHAR-01-ARJUN');
  await c2.selectAsset('@CHAR-01-ARJUN');
  check('C5 category-sticky state is handled: background clicks a category, then the character path explicitly clicks again',
    bgCategoryAt >= 0 && calls2.indexOf('click:category') >= 0 && /CATEGORY-STICKY/.test(fc), JSON.stringify({ bgCalls: calls.length, charCategory: calls2.indexOf('click:category') }));
}
// C6 missing Characters category fails clearly
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN');
  client.selectAssetCategory = async () => false;
  let msg = '';
  try { await client.selectAsset('@CHAR-01-ARJUN'); } catch (e: any) { msg = String(e.message); }
  check('C6 missing/unclickable Characters category fails clearly (no click)', /"Characters" category is unavailable/.test(msg) && !calls.includes('click:row'), `msg=${msg}`);
}
// C7 category transition is bounded (no fixed sleep)
check('C7 category/asset-list transition is bounded (settle helpers, no fixed sleep)',
  /waitForAssetSearchResultsToSettle\(resolveRow\)/.test(body) && /waitForAssetRowToSettle\(resolveRow\)/.test(body) && !/setTimeout/.test(bodyCode), bodyCode);
// C8 exact @CHAR-01-ARJUN row selected
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN');
  await client.selectAsset('@CHAR-01-ARJUN');
  check('C8 exact @CHAR-01-ARJUN is searched and the exact row is clicked', calls.includes('fill:search:@CHAR-01-ARJUN') && calls.includes('click:row'), calls.join(' | '));
}
// C9 zero matching rows fails
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN', { rowCount: 0 });
  let msg = ''; try { await client.selectAsset('@CHAR-01-ARJUN'); } catch (e: any) { msg = String(e.message); }
  check('C9 zero character rows -> fails clearly, no click', /expected exactly one row/.test(msg) && !calls.includes('click:row'), msg);
}
// C10 multiple matching rows fails
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN', { rowCount: 3 });
  let msg = ''; try { await client.selectAsset('@CHAR-01-ARJUN'); } catch (e: any) { msg = String(e.message); }
  check('C10 multiple character rows -> fails clearly, no click', /expected exactly one row/.test(msg) && !calls.includes('click:row'), msg);
}
// C11 disabled row fails
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN', { rowEnabled: false });
  let msg = ''; try { await client.selectAsset('@CHAR-01-ARJUN'); } catch (e: any) { msg = String(e.message); }
  check('C11 disabled character row -> fails clearly, no click', /is disabled in the scene-editor picker/.test(msg) && !calls.includes('click:row'), msg);
}
// C12 picker missing fails
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN', { pickerNeverOpens: true });
  let msg = ''; try { await client.selectAsset('@CHAR-01-ARJUN'); } catch (e: any) { msg = String(e.message); }
  check('C12 picker never opens -> fails clearly, no click', /scene-editor ingredient picker did not open/.test(msg) && !calls.includes('click:row'), msg);
}
// C13 exactly one row click
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN');
  await client.selectAsset('@CHAR-01-ARJUN');
  check('C13 exactly one character-row click', calls.filter((c) => c === 'click:row').length === 1, calls.join(' | '));
}
// C14 selection verification
{
  const { client, calls } = makeFake('@CHAR-01-ARJUN');
  await client.selectAsset('@CHAR-01-ARJUN');
  check('C14 character selection verified (picker hidden after the click)', calls.includes('waitFor:picker:hidden'), calls.join(' | '));
}
// C15 background path unchanged
{
  const { client, calls } = makeFake('#BGD-01-VILLAGE-STREET-WIDE');
  await client.selectAsset('#BGD-01-VILLAGE-STREET-WIDE');
  check('C15 background path unchanged (Images category + settle + exactly one click)',
    /selectAssetCategory\('Images'\)/.test(bgOnly) && calls.some((c) => c === 'click:category') && calls.includes('searchSettle') && calls.includes('rowSettle') && calls.filter((c) => c === 'click:row').length === 1, calls.join(' | '));
}
// C16 no page-wide getByText
check('C16 no page-wide getByText anywhere in selectAsset', !/getByText/.test(bodyCode), bodyCode);
// C17 no footer-title lookup
check('C17 no footer-title lookup anywhere in selectAsset', !/footer-title/.test(body), body);

console.log(`\nASSET-SELECT TESTS PASSED (${passed} checks)`);
