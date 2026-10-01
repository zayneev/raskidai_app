import version from './telegram-sdk-version.json';

const sdkUrl = `/vendor/telegram-web-app.js?v=${version.sha256}`;
let pending: Promise<void> | null = null;
let loadCycle = 0;

function loadAttempt(attempt: number, cycle: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Telegram SDK load timed out')), 5000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); }
      else resolve();
    }
    script.async = true;
    // A removed script can still have an in-flight request in the browser cache.
    script.src = cycle === 1 && attempt === 0 ? sdkUrl : `${sdkUrl}&retry=${cycle}-${attempt}`;
    script.onload = () => finish(window.Telegram?.WebApp ? undefined : new Error('Telegram SDK did not initialize'));
    script.onerror = () => finish(new Error('Telegram SDK could not be loaded'));
    document.head.appendChild(script);
  });
}

async function loadWithRetries(cycle: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (window.Telegram?.WebApp) return;
    try { await loadAttempt(attempt, cycle); return; }
    catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

export function loadTelegramSdk(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Telegram SDK needs a browser'));
  if (window.Telegram?.WebApp) return Promise.resolve();
  if (!pending) pending = loadWithRetries(++loadCycle).finally(() => { pending = null; });
  return pending;
}
