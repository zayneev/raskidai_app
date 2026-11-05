import { telegramApi, webhookSecret } from '../src/lib/server/telegram.ts';

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(arg => !['--check', '--replace', '--help'].includes(arg))) throw new Error('Допустимы только --check, --replace и --help');
  if (args.has('--help')) {
    console.log('pnpm telegram:webhook [--check] [--replace]\nНастройка webhook после публикации приложения. --check только проверяет состояние; --replace разрешает заменить другой webhook.');
    return;
  }
  const origin = new URL(process.env.APP_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('APP_ORIGIN должен быть публичным HTTPS origin без пути');
  const expected = `${origin.origin}/api/telegram/webhook`;
  const info = await telegramApi('getWebhookInfo', {});
  if (args.has('--check')) {
    console.log(JSON.stringify({ configured: info.url === expected, expectedUrl: expected, hasExistingWebhook: !!info.url, pendingUpdates: info.pending_update_count, hasDeliveryError: !!info.last_error_date }, null, 2));
    return;
  }
  if (info.url && info.url !== expected && !args.has('--replace')) throw new Error('У бота уже настроен другой webhook. Проверьте его назначение; для явной замены используйте --replace.');
  const secret = webhookSecret();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('TELEGRAM_WEBHOOK_SECRET должен содержать 1–256 символов A–Z, a–z, 0–9, _ или -');
  // Verify the deployed endpoint and matching secret before redirecting Telegram updates.
  const check = await fetch(expected, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: '{}', signal: AbortSignal.timeout(10000) });
  if (!check.ok || !(await check.json().catch(() => null))?.ok) throw new Error('Webhook не готов: сначала опубликуйте приложение и проверьте одинаковые секреты на сервере и в локальном окружении.');
  await telegramApi('setWebhook', { url: expected, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
  const confirmed = await telegramApi('getWebhookInfo', {});
  if (confirmed.url !== expected) throw new Error('Telegram не подтвердил URL webhook');
  console.log(`Webhook подключён: ${expected}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
