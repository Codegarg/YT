/** Download one copyright-safe horror music bed from Freesound (CLI). */
import path from 'node:path';
import { DEFAULT_BGM_QUERY, fetchAutoBgm } from './bgm.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

try {
  const output = path.resolve(arg('--output') ?? 'outputs/background-music.mp3');
  const query = arg('--query') ?? DEFAULT_BGM_QUERY;
  const authorizationCode = arg('--authorization-code');
  const result = await fetchAutoBgm({ output, query, authorizationCode });
  console.log(JSON.stringify({
    output: result.output,
    metadata_path: result.metadataPath,
    license_record_path: result.licenseRecordPath,
    metadata: result.metadata,
  }, null, 2));
} catch (error) {
  console.error(String((error as Error)?.message ?? error));
  process.exit(1);
}
