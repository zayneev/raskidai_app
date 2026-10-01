import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const sdkSource = 'https://telegram.org/js/telegram-web-app.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function syncTelegramSdk({ root, fetchImpl = fetch, write = false }) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetchImpl(sdkSource, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
      if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (bytes.length < 10000 || bytes.length > 2000000 || !code.includes('window.Telegram.WebApp = WebApp')) {
    throw new Error('The downloaded file is not the expected Telegram WebApp SDK');
  }
  new Script(code, { filename: 'telegram-web-app.js' });
  const path = resolve(root, 'public/vendor/telegram-web-app.js');
  const previous = await readFile(path).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; });
  const result = { changed: hash(previous) !== hash(bytes), previous: hash(previous), sha256: hash(bytes) };
  if (write && result.changed) {
    const metadataPath = resolve(root, 'src/lib/telegram-sdk-version.json');
    await mkdir(dirname(path), { recursive: true });
    await mkdir(dirname(metadataPath), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(metadataPath, JSON.stringify({ source: sdkSource, sha256: result.sha256, downloadedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await syncTelegramSdk({ root, write: process.argv.includes('--update') });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Telegram SDK: ${result.changed ? 'upstream changed' : 'up to date'}.\n\nSHA-256: \`${result.sha256}\`\n`);
  console.log(JSON.stringify(result));
}
