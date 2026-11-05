import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/app/route';
import { POST as webhook } from '../src/app/api/telegram/webhook/route';
import { createSession, sessionName } from '../src/lib/server/auth';
import { prepareParticipantInvitation, sharedTelegramUsers, webhookSecret } from '../src/lib/server/telegram';

const actor = '11111111-1111-4111-8111-111111111111';
const event = '22222222-2222-4222-8222-222222222222';
const member = '33333333-3333-4333-8333-333333333333';
const envNames = ['APP_ORIGIN', 'APP_SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET'] as const;
async function fixture(run: (calls: { name: string; body: Record<string, unknown> }[], setCanMessage: (value: boolean) => void) => Promise<void>) {
  const env = { ...process.env }, originalFetch = globalThis.fetch;
  Object.assign(process.env, { APP_ORIGIN: 'http://localhost:3000', APP_SESSION_SECRET: 'test-session-secret-at-least-thirty-two-bytes', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', TELEGRAM_BOT_TOKEN: '123:test-token', TELEGRAM_BOT_USERNAME: 'raskidai_app_bot', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret' });
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  let canMessage = false;
  globalThis.fetch = async (url, options) => {
    const name = String(url).split('/').pop()!;
    calls.push({ name, body: JSON.parse(String(options?.body)) });
    if (name === 'app_create_member_request') return Response.json(12345);
    if (name === 'getWebhookInfo') return Response.json({ ok: true, result: { url: '' } });
    if (name === 'setWebhook') return Response.json({ ok: true, result: true });
    if (name === 'app_participant_invite_context') return Response.json({ telegramId: 12345, eventName: 'Поездка', members: [{ id: member, name: 'Маша', telegramId: 54321, canMessage }] });
    if (['savePreparedKeyboardButton', 'savePreparedInlineMessage'].includes(name)) return Response.json({ ok: true, result: { id: 'prepared-test' } });
    if (name === 'sendMessage') return Response.json({ ok: true, result: { message_id: 5 } });
    return Response.json(true);
  };
  try { await run(calls, value => { canMessage = value; }); }
  finally {
    globalThis.fetch = originalFetch;
    for (const key of envNames) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  }
}
function request(body: object, authenticated = true) {
  return new NextRequest('http://localhost:3000/api/app', { method: 'POST', headers: { origin: 'http://localhost:3000', 'Content-Type': 'application/json', ...(authenticated ? { cookie: `${sessionName}=${createSession(actor)}` } : {}) }, body: JSON.stringify(body) });
}

test('selection uses the signed actor and native Telegram request; malformed IDs never reach Telegram', async () => {
  await fixture(async calls => {
    assert.equal((await POST(request({ action: 'selectParticipants', eventId: event }, false))).status, 401);
    assert.equal((await POST(request({ action: 'selectParticipants', eventId: 'invalid' }))).status, 400);
    assert.equal(calls.length, 0);
    const response = await POST(request({ action: 'selectParticipants', eventId: event, actorId: member }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.preparedId, 'prepared-test');
    assert.ok(result.requestId > 0 && result.requestId <= 2147483647);
    assert.deepEqual(calls[0].body, { p_actor: actor, p_event: event, p_request: result.requestId });
    assert.deepEqual(calls[1].body, { user_id: 12345, button: { text: 'Добавить участников', request_users: { request_id: result.requestId, user_is_bot: false, max_quantity: 10, request_name: true, request_username: true } } });
    assert.equal((await POST(request({ action: 'participantSelection', eventId: event, requestId: -1 }))).status, 400);
    assert.equal((await POST(request({ action: 'shareParticipantInvite', eventId: event, memberIds: [member, member], delivery: 'group' }))).status, 400);
  });
});

test('webhook requires its secret and private sender; duplicate delivery is delegated to transactional completion', async () => {
  await fixture(async calls => {
    const payload = { message: { from: { id: 12345 }, chat: { id: 12345, type: 'private' }, users_shared: { request_id: 5, users: [{ user_id: 54321, first_name: 'Маша' }] } } };
    const send = (secret: string, body = payload) => webhook(new NextRequest('http://localhost:3000/api/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body) }));
    assert.equal((await send('forged')).status, 401);
    assert.equal(calls.length, 0);
    assert.equal((await send(webhookSecret(), { ...payload, message: { ...payload.message, chat: { id: 999, type: 'private' } } })).status, 400);
    assert.equal((await send(webhookSecret())).status, 200);
    assert.deepEqual(calls[0], { name: 'app_complete_member_request', body: { p_sender: 12345, p_request: 5, p_users: [{ user_id: 54321, first_name: 'Маша', last_name: '', username: '' }] } });
  });
});

test('personal invitations share from the inviter unless the recipient granted bot access; group sharing is restricted to groups', async () => {
  await fixture(async (calls, setCanMessage) => {
    const shared = await prepareParticipantInvitation(actor, event, [member], 'personal');
    assert.equal(shared.mode, 'share');
    assert.equal(calls.some(call => call.name === 'sendMessage'), false);
    const prepared = calls.find(call => call.name === 'savePreparedInlineMessage')!.body;
    assert.equal(prepared.allow_user_chats, true); assert.equal(prepared.allow_group_chats, false);
    setCanMessage(true); calls.length = 0;
    assert.equal((await prepareParticipantInvitation(actor, event, [member], 'personal')).mode, 'sent');
    assert.equal(calls.find(call => call.name === 'sendMessage')!.body.chat_id, 54321);
    calls.length = 0;
    await prepareParticipantInvitation(actor, event, [member], 'group');
    const group = calls.find(call => call.name === 'savePreparedInlineMessage')!.body;
    assert.equal(group.allow_group_chats, true); assert.equal(group.allow_user_chats, false);
    assert.equal(calls.some(call => call.name === 'sendMessage'), false);
  });
});

test('shared-user validation rejects duplicate, unsafe and oversized selections', () => {
  assert.throws(() => sharedTelegramUsers([{ user_id: 1 }, { user_id: 1 }]));
  assert.throws(() => sharedTelegramUsers([{ user_id: Number.MAX_SAFE_INTEGER }]));
  assert.throws(() => sharedTelegramUsers(Array.from({ length: 11 }, (_, user_id) => ({ user_id: user_id + 1 }))));
  assert.deepEqual(sharedTelegramUsers([{ user_id: 4503599627370495 }]), [{ user_id: 4503599627370495, first_name: 'Участник Telegram', last_name: '', username: '' }]);
});

test('a blocked recipient falls back to sharing without losing the invitation', async () => {
  await fixture(async (calls, setCanMessage) => {
    setCanMessage(true);
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/sendMessage')
      ? Response.json({ ok: false, error_code: 403 }, { status: 403 })
      : fetch(url, options);
    const result = await prepareParticipantInvitation(actor, event, [member], 'personal');
    assert.equal(result.mode, 'share');
    assert.equal(result.url.startsWith('https://t.me/raskidai_app_bot?startapp='), true);
    assert.deepEqual(calls.find(call => call.name === 'app_set_telegram_write_access')?.body, { p_actor: member, p_allowed: false });
    assert.ok(calls.some(call => call.name === 'savePreparedInlineMessage'));
  });
});

test('production selection connects its webhook after the owner check and preserves pending updates', async () => {
  await fixture(async calls => {
    process.env.APP_ORIGIN = 'https://raskidai-app-v2.vercel.app';
    const response = await POST(new NextRequest('https://raskidai-app-v2.vercel.app/api/app', { method: 'POST', headers: { origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json', cookie: `${sessionName}=${createSession(actor)}` }, body: JSON.stringify({ action: 'selectParticipants', eventId: event }) }));
    assert.equal(response.status, 200);
    assert.equal(calls[0].name, 'app_create_member_request');
    assert.deepEqual(calls.find(call => call.name === 'setWebhook')?.body, { url: 'https://raskidai-app-v2.vercel.app/api/telegram/webhook', secret_token: 'test-webhook-secret', allowed_updates: ['message'], drop_pending_updates: false });
    assert.ok(calls.some(call => call.name === 'savePreparedKeyboardButton'));
  });
});

test('automatic setup refuses to redirect a webhook owned by another integration', async () => {
  await fixture(async calls => {
    process.env.APP_ORIGIN = 'https://raskidai-app-v2.vercel.app';
    const fetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => String(url).endsWith('/getWebhookInfo')
      ? Response.json({ ok: true, result: { url: 'https://another.example/webhook' } })
      : fetch(url, options);
    const response = await POST(new NextRequest('https://raskidai-app-v2.vercel.app/api/app', { method: 'POST', headers: { origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json', cookie: `${sessionName}=${createSession(actor)}` }, body: JSON.stringify({ action: 'selectParticipants', eventId: event }) }));
    assert.equal(response.status, 503);
    assert.equal(calls.some(call => ['setWebhook', 'savePreparedKeyboardButton'].includes(call.name)), false);
  });
});
