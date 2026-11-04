/** Open the persistent profile in real Google Chrome so a human can sign in. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

const url = process.env.FLOW_URL ?? 'https://labs.google/flow';
const profile = path.resolve(arg('--user-data-dir') ?? 'chrome-profile');
// Use the real installed Google Chrome (not Playwright's bundled Chromium) so
// Google accepts the sign-in instead of reporting an insecure browser.
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : undefined,
].filter((value): value is string => Boolean(value));
const chrome = candidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) throw new Error('Google Chrome not found. Set CHROME_PATH to chrome.exe and rerun.');

const child = spawn(chrome, [
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  url,
], { detached: true, stdio: 'ignore' });
child.unref();
log('chrome_open', { chrome, profile, url, hint: 'Sign in with the channel Google account, then close the Chrome window before running Flow.' });
