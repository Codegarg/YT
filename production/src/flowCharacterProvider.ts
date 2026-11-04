/**
 * FlowCharacterProvider — concrete browser implementation of the Flow-native character lifecycle
 * (PRIMARY provider). All selectors are the ones PROVEN in the live character discovery run.
 *
 * Identity: the authoritative Flow-native identity is the character-detail route segment
 * `/project/<projectId>/character/<characterId>`. The picker row exposes only the tag text; tag
 * selection is acceptable because pipeline tags are controlled/uniquely named, but the route id is
 * the authoritative identity (never DOM position/order).
 *
 * Safety: `generateCharacter` requires `mode: 'REAL_GENERATION'`; lookup/verify/find/rename never
 * click Start generation. No automatic retries. Flow failures fail closed (no auto fallback to
 * OpenAI — that is a separate, explicitly-requested operation).
 *
 * This module is browser-only (Playwright page + FlowClient). It performs no network calls of its
 * own beyond the page it drives. It is NOT imported by pure tests.
 */
import { S } from './selectors.js';
import { buildFlowCharacterPrompt, type CharacterGenerationProvider, type CharacterOperationOptions, type ProviderCapability, type ProviderCharacterResult } from './characterProvider.js';
import { generationActionAllowed, resolveFlowCharacterIdFromUrl, type CharacterOperationMode } from './flowCharacterState.js';
import type { CharacterGenerationSpec } from './characterGenerationSpec.js';

/** Minimal structural view of the pieces of FlowClient this provider uses (avoids a hard import). */
export interface FlowCharacterPage {
  page: any;
  flow: {
    first(candidates: readonly string[], timeout?: number): Promise<any>;
    click(candidates: readonly string[]): Promise<void>;
    fill(candidates: readonly string[], text: string): Promise<void>;
    returnToProjectGrid(): Promise<void>;
  };
}

export class FlowCharacterProvider implements CharacterGenerationProvider {
  readonly name = 'flow';

  constructor(private readonly ctx: FlowCharacterPage, private readonly log: (e: string, d?: Record<string, unknown>) => void = () => {}) {}

  private get page() { return this.ctx.page; }
  private assertNoGenerationDuring(mode: CharacterOperationMode, control: string) {
    if (!generationActionAllowed(mode, control)) {
      throw new Error(`Refusing to click generation control "${control}" in mode ${mode}.`);
    }
  }

  isCapable(_spec: CharacterGenerationSpec): ProviderCapability {
    return { ok: true, produces: 'flow-native' };
  }

  /** Explicit generation. `mode` MUST be REAL_GENERATION or this fails closed. */
  async generateCharacter(spec: CharacterGenerationSpec, options: CharacterOperationOptions): Promise<ProviderCharacterResult> {
    const tag = String(spec?.tag ?? '');
    if (options.mode !== 'REAL_GENERATION') {
      return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_GENERATION_FAILED', reason: 'generateCharacter requires mode=REAL_GENERATION (generation is an explicit operation).' };
    }
    if (!options.flowProjectId) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_GENERATION_FAILED', reason: 'generateCharacter requires flowProjectId.' };

    const prompt = buildFlowCharacterPrompt(spec);
    // Open the character surface and wait for the standard composer (no generation yet).
    // Preserve the Google multi-account prefix (`/u/<n>`) from FLOW_URL: on a profile signed
    // into several accounts the bare host would address the WRONG account's project.
    const flowRoot = String(process.env.FLOW_URL ?? 'https://flow.google.com').trim().replace(/\/+$/, '');
    const origin = (flowRoot.match(/^(https?:\/\/[^/?#]+(?:\/u\/\d+)?)/) ?? [flowRoot, 'https://flow.google.com'])[1];
    await this.page.goto(`${origin}/project/${options.flowProjectId}/character`, { waitUntil: 'domcontentloaded' });
    await this.ctx.flow.first([...S.characterPage], 60000);
    const editor = await this.ctx.flow.first([...S.characterPromptEditor], 30000);
    await editor.click().catch(() => {});
    await editor.fill(prompt);
    // The ONLY generation click in this provider.
    this.assertNoGenerationDuring(options.mode, 'Start generation');
    await this.ctx.flow.click([...S.characterStartGeneration]);
    const characterId = await this.waitForCharacterComplete();
    if (!characterId) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_GENERATION_FAILED', reason: 'Character generation did not yield a character-detail route id within the timeout.' };
    return { ok: true, tag, provider: this.name, produces: 'flow-native', flowCharacterUuid: characterId };
  }

  /** Wait for the character-detail route to appear; returns the route characterId or null. No retry. */
  async waitForCharacterComplete(timeoutMs = 300000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const id = resolveFlowCharacterIdFromUrl(this.page.url());
      if (id) return id;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  /** Read-only: resolve the characterId of the currently-open character detail, or null. */
  async currentCharacterId(): Promise<string | null> {
    return resolveFlowCharacterIdFromUrl(this.page.url());
  }

  /** Read-only: find a character by exact tag among existing character tiles. Never generates. */
  async findCharacter(tag: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult> {
    this.assertNoGenerationDuring(options.mode, 'Lookup');
    await this.ctx.flow.returnToProjectGrid();
    const tiles = this.page.locator(S.characterTile[0]);
    const count = await tiles.count().catch(() => 0);
    const matches: { tag: string; characterId: string | null }[] = [];
    for (let i = 0; i < count; i++) {
      const name = String(await tiles.nth(i).locator(S.characterTileName[0]).innerText().catch(() => '')).trim();
      if (name === String(tag).trim()) matches.push({ tag: name, characterId: null });
    }
    if (matches.length === 0) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_NOT_FOUND', reason: `No Flow character tile named "${tag}".` };
    if (matches.length > 1) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_AMBIGUOUS', reason: `Multiple Flow character tiles named "${tag}".` };
    return { ok: true, tag, provider: this.name, produces: 'flow-native', displayName: tag };
  }

  /** Read-only: verify a character exists by opening its detail route and reading the name. */
  async verifyCharacter(tag: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult> {
    this.assertNoGenerationDuring(options.mode, 'Verify');
    if (!options.flowProjectId) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_NOT_FOUND', reason: 'verifyCharacter requires flowProjectId.' };
    if (!this.currentCharacterId()) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_NOT_FOUND', reason: 'No character detail route is open to verify.' };
    const name = String(await this.page.locator(S.characterDetailNameInput[0]).first().inputValue().catch(() => '')).trim();
    if (name !== String(tag).trim()) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_INVALID', reason: `Character detail name "${name}" does not match "${tag}".` };
    return { ok: true, tag, provider: this.name, produces: 'flow-native', flowCharacterUuid: await this.currentCharacterId(), displayName: name };
  }

  /**
   * Rename an open character detail to the exact tag, then verify.
   *
   * PROVEN COMMIT MECHANISM (live, twice-verified): the name input is inside an Angular form
   * (`form.character-form`). The reliable commit sequence is:
   *   focus → select-all (Ctrl+A) → delete → real keyboard `type` events → leave the field with
   *   `Tab` → click outside to blur.
   * `fill()` alone does NOT drive Angular's change handling (value reverts on navigation/reload),
   * and a click-outside blur without a focus-leave is not always enough. Never uses force-clicks and
   * never triggers generation.
   *
   * TARGETING: this provider method permits the generated "Untitled character" detail (the normal
   * post-generation path) or a detail already named exactly `tag`. A named asset with a DIFFERENT
   * current title must use the exact-current FlowClient method, never an untitled/first fallback.
   */
  async renameCharacter(tag: string, displayName: string, options: CharacterOperationOptions): Promise<ProviderCharacterResult> {
    this.assertNoGenerationDuring(options.mode, 'Rename');
    const expectedCurrent = String(tag).trim();
    const targetName = String(displayName).trim();
    if (!expectedCurrent) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_INVALID', reason: 'Rename requires the exact current character name.' };
    if (!targetName) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_INVALID', reason: 'Rename requires a non-empty target character name.' };
    const characterId = await this.currentCharacterId();
    if (!characterId) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_NOT_FOUND', reason: 'No character detail route is open to rename.' };
    const input = this.page.locator(S.characterDetailNameInput[0]).first();
    // FAIL CLOSED BEFORE MUTATION: an open detail page is not, by itself, proof that it is the
    // intended character. A freshly generated detail is allowed only while it still carries the
    // exact generated label; any OTHER named detail must match the caller's exact current name.
    const currentName = String(await input.inputValue().catch(() => '')).trim();
    const isUntitledDetail = /^untitled character$/i.test(currentName);
    if (!isUntitledDetail && currentName !== expectedCurrent) {
      return {
        ok: false,
        tag,
        provider: this.name,
        state: 'FLOW_CHARACTER_INVALID',
        reason: `Rename refused: open character detail name "${currentName}" does not match expected current name "${expectedCurrent}".`,
      };
    }
    await input.click({ timeout: 8000 });
    await input.press('Control+A').catch(() => {});
    await input.press('Delete').catch(() => {});
    await input.type(targetName, { delay: 60 });            // real key events → input/change
    await input.press('Tab').catch(() => {});               // leave the field (fires blur)
    await this.page.mouse.click(5, 5).catch(() => {});       // click outside (extra blur safety)
    // The save is debounced; navigating immediately can drop the commit (observed live). Allow the
    // debounce to settle before the caller navigates away.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const observed = String(await input.inputValue().catch(() => '')).trim();
    if (observed !== targetName) return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_INVALID', reason: `Rename verification failed: expected "${targetName}", saw "${observed}".` };
    // The detail route id is the strongest Flow-native identity this surface exposes. Refuse to
    // report success if the rename somehow moved to a different character detail.
    const afterId = await this.currentCharacterId();
    if (!afterId || afterId !== characterId) {
      return { ok: false, tag, provider: this.name, state: 'FLOW_CHARACTER_INVALID', reason: 'Rename verification failed: character detail identity changed during rename.' };
    }
    return { ok: true, tag, provider: this.name, produces: 'flow-native', flowCharacterUuid: afterId, displayName: observed };
  }
}
