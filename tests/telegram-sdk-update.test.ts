import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sdk = `// ${'official SDK fixture '.repeat(600)}\nvar WebApp = {}; window.Telegram.WebApp = WebApp;\n`;

test('SDK updates preserve source bytes and leave unchanged metadata alone', async () => {
  const { sdkSource, syncTelegramSdk } = await import('../scripts/update-telegram-sdk.mjs');
  const root = await mkdtemp(join(tmpdir(), 'telegram-sdk-'));
  try {
    const fetchImpl = async (url: string | URL | Request) => { assert.equal(url, sdkSource); return new Response(sdk); };
    const first = await syncTelegramSdk({ root, fetchImpl, write: true });
    assert.equal(first.changed, true);
    assert.equal(await readFile(join(root, 'public/vendor/telegram-web-app.js'), 'utf8'), sdk);
    const metadataPath = join(root, 'src/lib/telegram-sdk-version.json');
    const metadata = await readFile(metadataPath, 'utf8');
    assert.equal(JSON.parse(metadata).sha256, first.sha256);
    assert.equal((await syncTelegramSdk({ root, fetchImpl, write: true })).changed, false);
    assert.equal(await readFile(metadataPath, 'utf8'), metadata);
    const newer = sdk + '// upstream fix\n';
    assert.equal((await syncTelegramSdk({ root, fetchImpl: async () => new Response(newer) })).changed, true);
    assert.equal(await readFile(join(root, 'public/vendor/telegram-web-app.js'), 'utf8'), sdk);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTML, broken JavaScript and HTTP errors cannot replace the installed SDK', async () => {
  const { syncTelegramSdk } = await import('../scripts/update-telegram-sdk.mjs');
  const root = await mkdtemp(join(tmpdir(), 'telegram-sdk-'));
  try {
    await syncTelegramSdk({ root, fetchImpl: async () => new Response(sdk), write: true });
    await assert.rejects(syncTelegramSdk({ root, fetchImpl: async () => new Response('<html>unavailable</html>'), write: true }));
    await assert.rejects(syncTelegramSdk({ root, fetchImpl: async () => new Response(sdk + '\nfunction {'), write: true }));
    let attempts = 0;
    await assert.rejects(syncTelegramSdk({ root, fetchImpl: async () => { attempts++; return new Response('unavailable', { status: 503 }); }, write: true }));
    assert.equal(attempts, 3);
    assert.equal(await readFile(join(root, 'public/vendor/telegram-web-app.js'), 'utf8'), sdk);
  } finally { await rm(root, { recursive: true, force: true }); }
});
