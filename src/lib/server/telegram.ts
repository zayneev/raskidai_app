import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { rpc } from './supabase';
import { newInvite, telegramInviteUrl } from './operations';

export class TelegramApiError extends Error {
  constructor(message: string, public status = 502, public code = 0) { super(message); }
}

export function webhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new TelegramApiError('Не настроен секрет приложения', 503);
  return createHmac('sha256', secret).update('raskidai:telegram-webhook:v1').digest('hex');
}

export function validWebhookSecret(value: string | null) {
  const expected = Buffer.from(webhookSecret());
  const actual = Buffer.from(value || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function telegramApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramApiError('Telegram-бот не настроен', 503);
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
  } catch { throw new TelegramApiError('Не удалось связаться с Telegram. Попробуйте ещё раз.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new TelegramApiError('Telegram не смог выполнить действие. Попробуйте ещё раз.', 502, data?.error_code || response.status);
  return data.result as T;
}

export type SharedTelegramUser = { user_id: number; first_name: string; last_name: string; username: string };
export function sharedTelegramUsers(value: unknown): SharedTelegramUser[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error('Invalid shared users');
  const users = value.map(user => {
    if (!user || !Number.isSafeInteger(user.user_id) || user.user_id <= 0 || user.user_id > 4503599627370495) throw new Error('Invalid Telegram ID');
    const field = (key: string) => typeof user[key] === 'string' ? user[key].trim().slice(0, 100) : '';
    return { user_id: user.user_id, first_name: field('first_name') || 'Участник Telegram', last_name: field('last_name'), username: field('username') };
  });
  if (new Set(users.map(user => user.user_id)).size !== users.length) throw new Error('Invalid duplicate Telegram ID');
  return users;
}

export async function prepareMemberSelection(actor: string, event: string) {
  const requestId = randomInt(1, 2147483647);
  // The database binds the request to both the event owner and their Telegram ID.
  const telegramId = await rpc<number>('app_create_member_request', { p_actor: actor, p_event: event, p_request: requestId });
  // Configure delivery from the deployed server, where the bot credentials live.
  // Run only after the owner check; never redirect another integration's webhook.
  const origin = new URL(process.env.APP_ORIGIN || '');
  if (origin.protocol === 'https:') {
    const url = `${origin.origin}/api/telegram/webhook`;
    const info = await telegramApi<{ url: string }>('getWebhookInfo', {});
    if (info.url && info.url !== url) throw new TelegramApiError('У бота уже подключён другой обработчик. Сначала проверьте настройку webhook.', 503);
    await telegramApi('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'], drop_pending_updates: false });
  }
  const prepared = await telegramApi<{ id: string }>('savePreparedKeyboardButton', {
    user_id: telegramId,
    button: { text: 'Добавить участников', request_users: { request_id: requestId, user_is_bot: false, max_quantity: 10, request_name: true, request_username: true } },
  });
  return { requestId, preparedId: prepared.id };
}

type InviteContext = { telegramId: number; eventName: string; members: { id: string; name: string; telegramId: number; canMessage: boolean }[] };
export async function prepareParticipantInvitation(actor: string, event: string, memberIds: string[], delivery: 'personal' | 'group' | 'any') {
  const context = await rpc<InviteContext>('app_participant_invite_context', { p_actor: actor, p_event: event, p_members: memberIds });
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  if (!bot) throw new TelegramApiError('Ссылка Telegram-приложения не настроена', 503);
  const token = await newInvite(actor, event);
  const url = telegramInviteUrl(bot, token, process.env.TELEGRAM_APP_SHORT_NAME);
  const personal = delivery === 'personal' && context.members.length === 1;
  const text = personal
    ? `${context.members[0].name}, присоединяйтесь к мероприятию «${context.eventName}» в Раскидай. Вы уже добавлены в расчёты.`
    : `Присоединяйтесь к мероприятию «${context.eventName}» в Раскидай — здесь будем делить общие расходы.`;
  const replyMarkup = { inline_keyboard: [[{ text: 'Присоединиться', url }]] };
  if (personal && context.members[0].canMessage) {
    try {
      await telegramApi('sendMessage', { chat_id: context.members[0].telegramId, text, reply_markup: replyMarkup });
      return { mode: 'sent' as const, url };
    } catch (error) {
      // Blocking a bot or never starting it is normal: offer sharing from the inviter.
      if (!(error instanceof TelegramApiError) || ![400, 403].includes(error.code)) throw error;
      await rpc('app_set_telegram_write_access', { p_actor: context.members[0].id, p_allowed: false });
    }
  }
  const prepared = await telegramApi<{ id: string }>('savePreparedInlineMessage', {
    user_id: context.telegramId,
    result: { type: 'article', id: randomUUID(), title: `Приглашение: ${context.eventName}`, input_message_content: { message_text: text }, reply_markup: replyMarkup },
    allow_user_chats: delivery !== 'group', allow_group_chats: delivery !== 'personal', allow_bot_chats: false, allow_channel_chats: false,
  });
  return { mode: 'share' as const, preparedId: prepared.id, url };
}
