import { NextRequest, NextResponse } from 'next/server';
import { sharedTelegramUsers, validWebhookSecret } from '@/lib/server/telegram';
import { rpc } from '@/lib/server/supabase';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  try {
    if (!validWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
    const raw = await request.text();
    if (raw.length > 32768) return NextResponse.json({ error: 'Request too large' }, { status: 413, headers });
    let update;
    try { update = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
    const message = update?.message;
    if (message?.users_shared) {
      const sender = message.from?.id;
      const requestId = message.users_shared.request_id;
      if (message.chat?.type !== 'private' || message.chat.id !== sender || !Number.isSafeInteger(sender) || sender <= 0 ||
          !Number.isInteger(requestId) || requestId < 1 || requestId > 2147483647) return NextResponse.json({ error: 'Invalid request' }, { status: 400, headers });
      let users;
      try { users = sharedTelegramUsers(message.users_shared.users); } catch { return NextResponse.json({ error: 'Invalid users' }, { status: 400, headers }); }
      await rpc('app_complete_member_request', { p_sender: sender, p_request: requestId, p_users: users });
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    // A retry can safely re-deliver an update: completion is transactional and idempotent.
    return NextResponse.json({ error: 'Не удалось обработать ответ Telegram' }, { status: 503, headers });
  }
}
