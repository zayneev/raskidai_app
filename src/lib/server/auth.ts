import { createHmac, timingSafeEqual } from 'node:crypto';

const sessionName = 'raskidai_session';
const lifetime = 60 * 60 * 24;
export { sessionName };

export type TelegramIdentity = { id: number; first_name: string; last_name?: string; username?: string };
export class TelegramAuthError extends Error {}

export function verifyTelegramInitData(raw: string, botToken: string, now = Math.floor(Date.now() / 1000)): TelegramIdentity {
  if (!raw || raw.length > 8192) throw new TelegramAuthError('Invalid Telegram data');
  const params = new URLSearchParams(raw);
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new TelegramAuthError('Duplicate Telegram field');
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(authDate) || authDate > now + 60 || now - authDate > 3600) throw new TelegramAuthError('Expired Telegram data');
  const check = entries.filter(([key]) => key !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) throw new TelegramAuthError('Invalid Telegram signature');
  let user: unknown;
  try { user = JSON.parse(params.get('user') || ''); } catch { throw new TelegramAuthError('Missing Telegram user'); }
  const u = user as Partial<TelegramIdentity>;
  if (!u || !Number.isSafeInteger(u.id) || !u.id || typeof u.first_name !== 'string' || !u.first_name.trim()) throw new TelegramAuthError('Invalid Telegram user');
  return { id: u.id, first_name: u.first_name.trim(), last_name: typeof u.last_name === 'string' ? u.last_name : '', username: typeof u.username === 'string' ? u.username : '' };
}

function secret() {
  const value = process.env.APP_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('APP_SESSION_SECRET must contain at least 32 characters');
  return value;
}
export function createSession(userId: string, now = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: now + lifetime })).toString('base64url');
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
export function readSession(value: string | undefined, now = Math.floor(Date.now() / 1000)): string | null {
  if (!value) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', secret()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { userId?: string; exp?: number };
    return typeof decoded.userId === 'string' && /^[0-9a-f-]{36}$/i.test(decoded.userId) && typeof decoded.exp === 'number' && decoded.exp > now ? decoded.userId : null;
  } catch { return null; }
}
export const sessionMaxAge = lifetime;
