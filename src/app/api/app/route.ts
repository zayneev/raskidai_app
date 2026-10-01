import { NextRequest, NextResponse } from 'next/server';
import { createSession, readSession, sessionMaxAge, sessionName, TelegramAuthError, verifyTelegramInitData } from '@/lib/server/auth';
import { actorId, joinInvite, newInvite, normalizeExpense, snapshot, telegramInviteUrl, validUuid } from '@/lib/server/operations';
import { DatabaseError, rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
const noStore = { 'Cache-Control': 'private, no-store' };
function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: noStore }); }
function fail(error: unknown) {
  const status = error instanceof DatabaseError ? error.status : error instanceof TelegramAuthError ? 401 : error instanceof Error && error.message.startsWith('Invalid') ? 400 : 500;
  return json({ error: error instanceof Error ? error.message : 'Request failed' }, status);
}
function session(request: NextRequest) { return readSession(request.cookies.get(sessionName)?.value); }
function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN) return false;
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  return origin === expected;
}
function uuid(value: unknown) { if (!validUuid(value)) throw new Error('Invalid ID'); return value; }

export async function GET(request: NextRequest) {
  try {
    const actor = session(request);
    if (!actor) return json({ error: 'Unauthorized' }, 401);
    return json({ trips: await snapshot(actor) });
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return json({ error: 'Invalid origin' }, 403);
  try {
    const text = await request.text();
    if (text.length > 32768) return json({ error: 'Request too large' }, 413);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.action === 'login') {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) return json({ error: 'Telegram bot is not configured' }, 503);
      const identity = verifyTelegramInitData(String(body.initData || ''), botToken);
      const actor = await rpc<string>('app_login', {
        p_telegram_id: identity.id, p_first_name: identity.first_name,
        p_last_name: identity.last_name || '', p_username: identity.username || '',
      });
      const response = json({ trips: await snapshot(actor), user: { id: actor, firstName: identity.first_name, lastName: identity.last_name || '', username: identity.username || '' } });
      response.cookies.set(sessionName, createSession(actor), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: sessionMaxAge });
      return response;
    }
    const actor = session(request);
    if (!actor) return json({ error: 'Unauthorized' }, 401);
    const event = body.eventId === undefined ? undefined : uuid(body.eventId);
    switch (body.action) {
      case 'createEvent': {
        const id = uuid(body.id);
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 60 || typeof body.cover !== 'string') throw new Error('Invalid event');
        await rpc('app_create_event', { p_actor: actor, p_id: id, p_name: body.name, p_cover: body.cover });
        return json({ id });
      }
      case 'invite': {
        const shortName = process.env.TELEGRAM_APP_SHORT_NAME;
        const botName = process.env.TELEGRAM_BOT_USERNAME;
        if (!botName) return json({ error: 'Telegram app link is not configured' }, 503);
        const token = await newInvite(actor, event!);
        return json({ url: telegramInviteUrl(botName, token, shortName) });
      }
      case 'join': {
        const id = await joinInvite(actor, String(body.token || ''));
        return json({ id });
      }
      case 'removeMember': {
        await rpc('app_remove_participant', { p_actor: actor, p_event: uuid(body.eventId), p_member: uuid(actorId(String(body.memberId), actor)) });
        return json({ ok: true });
      }
      case 'saveExpense': {
        const data = normalizeExpense(body.expense, actor);
        const requestId = uuid(body.requestId);
        const version = body.expectedVersion === null || body.expectedVersion === undefined ? null : Number(body.expectedVersion);
        if (version !== null && (!Number.isSafeInteger(version) || version < 1)) throw new Error('Invalid version');
        const result = await rpc('app_save_expense', { p_actor: actor, p_event: event, p_data: data, p_request: requestId, p_expected_version: version });
        return json(result);
      }
      case 'deleteExpense': {
        const version = Number(body.version);
        if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid version');
        await rpc('app_delete_expense', { p_actor: actor, p_event: event, p_expense: uuid(body.id), p_version: version });
        return json({ ok: true });
      }
      case 'createTransfer': {
        const amount = Number(body.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0 || typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw new Error('Invalid transfer');
        await rpc('app_create_transfer', { p_actor: actor, p_event: event, p_id: uuid(body.id), p_recipient: uuid(actorId(String(body.to), actor)), p_amount: amount, p_date: body.date });
        return json({ ok: true });
      }
      case 'confirmTransfer': {
        await rpc('app_confirm_transfer', { p_actor: actor, p_event: event, p_id: uuid(body.id) });
        return json({ ok: true });
      }
      case 'archive': {
        if (typeof body.archived !== 'boolean') throw new Error('Invalid archive status');
        await rpc('app_set_archived', { p_actor: actor, p_event: event, p_archived: body.archived });
        return json({ ok: true });
      }
      default: return json({ error: 'Unknown action' }, 400);
    }
  } catch (error) { return fail(error); }
}
