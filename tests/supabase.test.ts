import assert from 'node:assert/strict';
import test from 'node:test';
import { rpc } from '../src/lib/server/supabase';

test('Supabase secret keys use apikey without a JWT Authorization header', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.SUPABASE_URL;
  const originalSecret = process.env.SUPABASE_SECRET_KEY;
  const originalLegacy = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const requests: Headers[] = [];
  try {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy-jwt';
    globalThis.fetch = async (_input, init) => {
      requests.push(new Headers(init?.headers));
      return Response.json({ ok: true });
    };
    await rpc('app_snapshot', { p_actor: 'test' });
    assert.equal(requests[0].get('apikey'), 'sb_secret_test');
    assert.equal(requests[0].get('Authorization'), null);

    delete process.env.SUPABASE_SECRET_KEY;
    await rpc('app_snapshot', { p_actor: 'test' });
    assert.equal(requests[1].get('apikey'), 'legacy-jwt');
    assert.equal(requests[1].get('Authorization'), 'Bearer legacy-jwt');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = originalSecret;
    if (originalLegacy === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalLegacy;
  }
});
