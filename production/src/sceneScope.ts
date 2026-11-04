/**
 * CLI scene-selection parsing (STEP-8GQ). Pure and side-effect free so it is unit-testable
 * without executing the CLI. Mirrors `validateSceneSelection` (pipeline membership is checked
 * later against the real pipeline).
 */

/** Parse `--only 1,2,3` into a sorted, de-duplicated positive-integer list. Fail closed. */
export function parseOnly(raw: string | undefined): { ok: true; scenes: number[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, scenes: [] };
  const parts = String(raw).split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  if (parts.length === 0) return { ok: false, reason: '--only requires at least one scene number.' };
  const scenes: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { ok: false, reason: `--only value is not a positive integer: "${p}".` };
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) return { ok: false, reason: `--only value must be >= 1: "${p}".` };
    scenes.push(n);
  }
  return { ok: true, scenes: [...new Set(scenes)].sort((a, b) => a - b) };
}

/**
 * Resolve the scene selection from a `--only` string: undefined ⇒ no scoping (full project).
 * An explicit `--only` with no valid list fails closed.
 */
export function resolveOnlyArg(raw: string | undefined): { ok: true; only?: number[] } | { ok: false; reason: string } {
  const parsed = parseOnly(raw);
  if (!parsed.ok) return parsed;
  if (parsed.scenes.length === 0) return { ok: true, only: undefined };
  return { ok: true, only: parsed.scenes };
}
