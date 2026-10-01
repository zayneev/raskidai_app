import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/app/route';
import { createSession, sessionName } from '../src/lib/server/auth';

test('removal API uses the signed session actor, validates IDs, and propagates the database permission check', async () => {
  const env = { ...process.env };
  const originalFetch = globalThis.fetch;
  const actor = '11111111-1111-4111-8111-111111111111';
  const member = '22222222-2222-4222-8222-222222222222';
  const event = '33333333-3333-4333-8333-333333333333';
  const calls: { url: string; args: unknown }[] = [];
  let forbidden = false;
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.APP_SESSION_SECRET = 'local-test-secret-of-at-least-thirty-two-bytes';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), args: JSON.parse(String(options?.body)) });
    return Response.json(forbidden ? { message: 'Forbidden' } : true, { status: forbidden ? 400 : 200 });
  };
  function request(values: Record<string, unknown>, authenticated = true, origin = 'http://localhost:3000') {
    return new NextRequest('http://localhost:3000/api/app', { method: 'POST', headers: {
      origin, 'Content-Type': 'application/json',
      ...(authenticated ? { cookie: `${sessionName}=${createSession(actor)}` } : {}),
    }, body: JSON.stringify({ action: 'removeMember', eventId: event, memberId: member, ...values }) });
  }
  try {
    assert.equal((await POST(request({}, false))).status, 401);
    assert.equal((await POST(request({}, true, 'https://outsider.example'))).status, 403);
    assert.equal((await POST(request({ memberId: 'not-a-uuid' }))).status, 400);
    assert.equal((await POST(request({ eventId: undefined }))).status, 400);
    assert.equal(calls.length, 0);
    const success = await POST(request({ actorId: member }));
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });
    assert.deepEqual(calls[0], { url: 'https://example.supabase.co/rest/v1/rpc/app_remove_participant', args: { p_actor: actor, p_event: event, p_member: member } });
    forbidden = true;
    assert.equal((await POST(request({}))).status, 403);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of ['APP_ORIGIN', 'APP_SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
      if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    }
  }
});
