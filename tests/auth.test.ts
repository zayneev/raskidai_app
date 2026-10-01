import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createSession, readSession, verifyTelegramInitData } from '../src/lib/server/auth';
import { normalizeExpense, telegramInviteUrl } from '../src/lib/server/operations';

const botToken = '123:telegram-bot-secret';
const now = 1_800_000_000;
function signedData(user: object, authDate = now) {
  const fields = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAE', user: JSON.stringify(user) });
  const check = [...fields.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  fields.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return fields.toString();
}
test('Telegram signature, age and duplicate fields are checked', () => {
  const raw = signedData({ id: 12345, first_name: 'Аня' });
  assert.equal(verifyTelegramInitData(raw, botToken, now).id, 12345);
  assert.throws(() => verifyTelegramInitData(raw.replace('12345', '54321'), botToken, now));
  assert.throws(() => verifyTelegramInitData(raw, botToken, now + 3601));
  assert.throws(() => verifyTelegramInitData(`${raw}&user=forged`, botToken, now));
});
test('Session rejects tampering and expiry', () => {
  process.env.APP_SESSION_SECRET = 'local-test-secret-of-at-least-thirty-two-bytes';
  const id = '11111111-1111-4111-8111-111111111111';
  const cookie = createSession(id, now);
  assert.equal(readSession(cookie, now + 1), id);
  assert.equal(readSession(cookie, now + 86400), null);
  assert.equal(readSession(`${cookie}x`, now), null);
});
test('Expense normalization rejects forged payer and malformed shares', () => {
  const actor = '11111111-1111-4111-8111-111111111111';
  const outsider = '22222222-2222-4222-8222-222222222222';
  const basic = { id: '33333333-3333-4333-8333-333333333333', title: 'Такси', amount: 100, payer: outsider,
    category: 'transport', date: '2026-09-29', mode: 'equal', splits: { me: 100 } };
  const normalized = normalizeExpense(basic, actor);
  assert.equal('payer' in normalized, false);
  assert.deepEqual(normalized.splits, { [actor]: 100 });
  assert.throws(() => normalizeExpense({ ...basic, splits: { me: 99 } }, actor));
});
test('Invite links work with a Main Mini App or a Direct Link Mini App', () => {
  const token = 'a'.repeat(32);
  assert.equal(telegramInviteUrl('@raskidai_app_bot', token), `https://t.me/raskidai_app_bot?startapp=${token}&mode=fullscreen`);
  assert.equal(telegramInviteUrl('raskidai_app_bot', token, 'raskidai'), `https://t.me/raskidai_app_bot/raskidai?startapp=${token}&mode=fullscreen`);
});
