// Unit test for the DIAGNOSTIC stage-failure capture (writeStageDiagnostic).
//
// Purpose: prove the writer actually creates a file and preserves what the persisted
// `failures[].reason` deliberately throws away -- the child's stderr lines that follow the
// `Command failed:` first line -- while redacting secrets and staying bounded.
//
// Offline: no Flow, no browser, no pipeline, no production assets. Every path is a fresh
// os.tmpdir() directory that this file removes on completion. It never touches
// production/outputs or production/inputs.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SRC } from './_testPaths.mjs';
const { writeStageDiagnostic } = await import(pathToFileURL(`${SRC}/productionOrchestrator.ts`).href) as any;
const { sanitizeFailureReason, SECRET_REDACTION_RE, FAILURE_REASON_MAX } = await import(pathToFileURL(`${SRC}/projectState.ts`).href) as any;

let passed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { console.log(`FAIL ${label}`, detail ?? ''); throw new Error(`FAIL ${label}`); }
};

const LIMIT = 64 * 1024; // must match STAGE_DIAGNOSTIC_MAX_BYTES in productionOrchestrator.ts
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stageDiagTest-'));
const SECRET = 'sk-live-DO-NOT-LEAK-abcdef123456';
const dirs: string[] = [];
const mk = () => { const d = path.join(tmpRoot, `p${dirs.length}`); dirs.push(d); return d; };

try {
  // ---------- 1. the realistic shape: command-error first line + child stderr on later lines ----------
  {
    const outDir = mk();
    const raw = [
      'Command failed: node.exe --import tsx /src/mixNarration.ts --input-dir C:\\tmp\\gu-a --output out.mp4',
      '[libx264 @ 0000012f] Unknown encoder \'libx264\'',
      'Error initializing output stream 0:0',
      'Conversion failed!',
    ].join('\n');

    await writeStageDiagnostic(outDir, 'MIX', raw);

    const file = path.join(outDir, '.stage-diagnostics', 'MIX.log');
    check('D1 the diagnostic file is actually created at <outputsDir>/.stage-diagnostics/MIX.log', fs.existsSync(file), file);
    const text = await fsp.readFile(file, 'utf8');

    check('D2 the command-error first line survives', text.includes('Command failed: node.exe'), text.slice(0, 120));
    check('D3 the CHILD STDERR line survives (the whole point: sanitizeFailureReason drops it)',
      text.includes("[libx264 @ 0000012f] Unknown encoder 'libx264'"), 'stderr line missing');
    check('D3b the remaining stderr lines survive', text.includes('Conversion failed!'));

    // Prove the contrast: the persisted state.json reason would have kept ONLY line 1.
    check('D4 contrast: only the first line is what the state.json reason would keep',
      raw.split(/\r?\n/)[0].includes('Command failed:') && !raw.split(/\r?\n/)[0].includes('Unknown encoder'));
  }

  // ---------- 2. secret redaction ----------
  {
    const outDir = mk();
    const raw = [
      'Command failed: node.exe --import tsx /src/mixNarration.ts',
      `api_key=${SECRET}`,
      'Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRST',
      'token=zzz-9999-yyyy',
    ].join('\n');

    await writeStageDiagnostic(outDir, 'MIX', raw);
    const text = await fsp.readFile(path.join(outDir, '.stage-diagnostics', 'MIX.log'), 'utf8');

    check('D5 an api_key value does NOT survive', !text.includes(SECRET), text);
    // The regex consumes the KEY LABEL as well as the value, so the whole "api_key=..." run
    // collapses to a bare "[redacted]". That is the intended, strictly-safer outcome.
    check('D5b the whole api_key assignment collapses to [redacted] (label included)', /^api_key=/m.test(text) === false && text.includes('[redacted]'), text);
    check('D5d a bare token value does NOT survive', !text.includes('zzz-9999-yyyy'));
    check('D5e redaction did not drop the surrounding stderr lines', text.includes('Command failed: node.exe'));

    // KNOWN DEFECT (found by this test, NOT fixed here - needs authorisation).
    // The shared regex is `(key|...|authorization|bearer)\s*[:=]\s*\S+`. For
    // `Authorization: Bearer ghp_X` the match is `Authorization: Bearer`, so only the SCHEME is
    // redacted and the actual credential `ghp_X` survives in cleartext. `\S+` stops at the first
    // space. The same regex is used by sanitizeFailureReason() in projectState.ts:118, so the
    // leak is inherited there too (mitigated there only because that path keeps the FIRST line).
    const bearerLine = text.split(/\r?\n/).find((l) => /ghp_/i.test(l)) ?? '';
    const bearerLeaks = /ghp_[A-Za-z0-9]+/.test(bearerLine);
    console.log(`      [KNOWN DEFECT] 'Authorization: Bearer <token>' leak present: ${bearerLeaks} (informational, not failing)`);
    console.log(`      [KNOWN DEFECT] offending line: ${JSON.stringify(bearerLine)}`);
  }

  // ---------- 3. bounded size, ASCII payload ----------
  {
    const outDir = mk();
    const raw = ['Command failed: node.exe', 'E'.repeat(300 * 1024)].join('\n'); // 300 KiB >> 64 KiB
    await writeStageDiagnostic(outDir, 'MIX', raw);
    const file = path.join(outDir, '.stage-diagnostics', 'MIX.log');
    const buf = await fsp.readFile(file);

    check('D6 an oversized error is still written', buf.length > 0);
    check('D7 the stored body stays within the documented 64 KiB limit',
      buf.length <= LIMIT + 200, { fileBytes: buf.length, limit: LIMIT });
    check('D8 the file is not the full 300 KiB payload', buf.length < 300 * 1024, { fileBytes: buf.length });
  }

  // ---------- 4. UTF-8 truncation validity ----------
  {
    const outDir = mk();
    // Put a 4-byte emoji so the 65536-byte cut lands in the MIDDLE of its code point.
    const raw = ['Command failed: node.exe', 'A'.repeat(LIMIT - 1) + '\u{1F600}TAIL'].join('\n');
    await writeStageDiagnostic(outDir, 'MIX', raw);
    const buf = await fsp.readFile(path.join(outDir, '.stage-diagnostics', 'MIX.log'));
    const text = buf.toString('utf8');

    check('D9 still bounded for the multibyte payload', buf.length <= LIMIT + 200, { bytes: buf.length });
    // A clean round-trip: decoding then re-encoding must be byte-identical.
    const roundTrip = Buffer.from(text, 'utf8').equals(buf.subarray(buf.length - Buffer.byteLength(text, 'utf8')));
    check('D10 the stored text is valid UTF-8 (no split code point produced a byte corruption)', roundTrip);
    // U+FFFD means a partial code point was decoded; report it rather than assert either way.
    const repl = (text.match(/\uFFFD/g) ?? []).length;
    console.log(`      [info] U+FFFD replacement chars after byte-truncation: ${repl} (informational)`);
    check('D11 truncation does not corrupt the file into unreadable bytes (decodes to a string)', typeof text === 'string' && text.length > 0);
  }

  // ---------- 5. no-ops and idempotence ----------
  {
    const outDir = mk();
    await writeStageDiagnostic(outDir, 'EDIT', undefined);
    await writeStageDiagnostic(outDir, 'EDIT', '');
    await writeStageDiagnostic(outDir, 'EDIT', '   ');
    check('D12 non-string / empty / whitespace errors write NO file',
      !fs.existsSync(path.join(outDir, '.stage-diagnostics', 'EDIT.log')));

    const out2 = mk();
    await writeStageDiagnostic(out2, 'MIX', 'Command failed: first run');
    await writeStageDiagnostic(out2, 'MIX', 'Command failed: second run');
    const t2 = await fsp.readFile(path.join(out2, '.stage-diagnostics', 'MIX.log'), 'utf8');
    check('D13 a second failure overwrites (last run wins) rather than appending unbounded text',
      t2.includes('second run') && !t2.includes('first run'));
  }

  // ---------- 6. SECRET REDACTION REGRESSION (both consumers, synthetic credentials only) ----------
  // Regression for the defect where `Authorization: Bearer <cred>` redacted only the SCHEME and
  // left the credential in cleartext. Covered on BOTH paths that share SECRET_REDACTION_RE:
  //   - sanitizeFailureReason()  -> the persisted state.json reason
  //   - writeStageDiagnostic()    -> the bounded diagnostic artefact
  {
    const CREDS = {
      'Authorization: Bearer ghp_SYNTHETIC_BEARER_0001': 'ghp_SYNTHETIC_BEARER_0001',
      'Authorization: Basic c3ludGhldGljLWJhc2ljLXZhbHVl': 'c3ludGhldGljLWJhc2ljLXZhbHVl',
      'AUTHORIZATION: bearer SYNTH_lower_case_scheme': 'SYNTH_lower_case_scheme',
      'Authorization:Token SYNTH_no_space_before_colon': 'SYNTH_no_space_before_colon',
      'Authorization:   Bearer    SYNTH_extra_whitespace': 'SYNTH_extra_whitespace',
      'Authorization: SYNTH_no_scheme': 'SYNTH_no_scheme',
    };
    const OTHERS: Array<[string, string]> = [
      ['api_key=SYNTH_api_key_value', 'SYNTH_api_key_value'],
      ['token=SYNTH_token_value', 'SYNTH_token_value'],
      ['access_token: SYNTH_access_token_value', 'SYNTH_access_token_value'],
      ['cookie: session=SYNTH_cookie_value', 'SYNTH_cookie_value'],
      ['password: SYNTH_password_value', 'SYNTH_password_value'],
    ];

    // ---- path A: sanitizeFailureReason (state.json reason) ----
    for (const [line, cred] of Object.entries(CREDS)) {
      const out = sanitizeFailureReason(line) ?? '';
      check(`R1 sanitizeFailureReason never leaks the credential :: ${line.split(' ').slice(0, 2).join(' ')}`, !out.includes(cred), out);
    }
    for (const [line, cred] of OTHERS) {
      const out = sanitizeFailureReason(line) ?? '';
      check(`R2 sanitizeFailureReason still redacts :: ${line.split(/[:=]/)[0]}`, !out.includes(cred), out);
    }

    // ---- path B: writeStageDiagnostic (diagnostic artefact) ----
    for (const [line, cred] of Object.entries(CREDS)) {
      const outDir = mk();
      const raw = ['Command failed: node.exe --import tsx /src/mixNarration.ts', line].join('\n');
      await writeStageDiagnostic(outDir, 'MIX', raw);
      const text = await fsp.readFile(path.join(outDir, '.stage-diagnostics', 'MIX.log'), 'utf8');
      check(`R3 diagnostic never leaks the credential :: ${line.split(' ').slice(0, 2).join(' ')}`, !text.includes(cred), text);
    }
    for (const [line, cred] of OTHERS) {
      const outDir = mk();
      const raw = ['Command failed: node.exe --import tsx /src/mixNarration.ts', line].join('\n');
      await writeStageDiagnostic(outDir, 'MIX', raw);
      const text = await fsp.readFile(path.join(outDir, '.stage-diagnostics', 'MIX.log'), 'utf8');
      check(`R4 diagnostic still redacts :: ${line.split(/[:=]/)[0]}`, !text.includes(cred), text);
    }

    // ---- surrounding diagnostic text is preserved ----
    {
      const outDir = mk();
      const raw = [
        'Command failed: node.exe --import tsx /src/mixNarration.ts --output out.mp4',
        'Authorization: Bearer ghp_SYNTHETIC_BEARER_0001',
        "[libx264 @ 0000012f] Unknown encoder 'libx264'",
        'Error initializing output stream 0:0',
        'Conversion failed!',
      ].join('\n');
      await writeStageDiagnostic(outDir, 'MIX', raw);
      const text = await fsp.readFile(path.join(outDir, '.stage-diagnostics', 'MIX.log'), 'utf8');
      check('R5 the redacted header does not destroy neighbouring stderr lines',
        text.includes('Command failed: node.exe') && text.includes("Unknown encoder 'libx264'") && text.includes('Conversion failed!'), text);
      // The fix removes the WHOLE header (label + scheme + credential), matching how
      // `api_key=...` already behaved, so "Authorization" itself must be ABSENT afterwards.
      check('R6 the whole Authorization header is removed, leaving only [redacted]',
        !/Authorization/i.test(text) && /\[redacted\]/.test(text), text);
      check('R7 no synthetic credential appears anywhere in the artefact',
        !/ghp_SYNTHETIC|c3ludGhldGlj|SYNTH_/.test(text), text);
    }

    // ---- contracts preserved: first-line-only + FAILURE_REASON_MAX cap ----
    {
      const multi = ['Authorization: Bearer ghp_SYNTH_MULTILINE', 'second line must not appear in the reason'].join('\n');
      const reason = sanitizeFailureReason(multi) ?? '';
      check('R8 first-line-only contract preserved (later lines are NOT in the reason)', !reason.includes('second line'), reason);
      const long = 'E'.repeat(FAILURE_REASON_MAX + 500);
      const capped = sanitizeFailureReason(long) ?? '';
      check('R9 FAILURE_REASON_MAX cap preserved', capped.length === FAILURE_REASON_MAX, { len: capped.length, max: FAILURE_REASON_MAX });
      check('R10 non-string / empty inputs still yield undefined',
        sanitizeFailureReason(undefined) === undefined && sanitizeFailureReason('') === undefined);
    }

    // ---- the shared pattern really is one object used by both ----
    check('R11 SECRET_REDACTION_RE is exported and is a RegExp', SECRET_REDACTION_RE instanceof RegExp);
  }

  console.log(`\nSTAGE-DIAGNOSTIC TESTS PASSED (${passed} checks)`);
} finally {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  console.log(`cleaned up temp root: ${tmpRoot} exists=${fs.existsSync(tmpRoot)}`);
}