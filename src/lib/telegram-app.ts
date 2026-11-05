export type TelegramApp = {
  initData: string; ready: () => void; expand: () => void; close: () => void; colorScheme: string;
  setHeaderColor?: (color: string) => void; setBackgroundColor?: (color: string) => void;
  BackButton: { show: () => void; hide: () => void; onClick: (fn: () => void) => void; offClick: (fn: () => void) => void };
  HapticFeedback?: { impactOccurred: (style: string) => void; notificationOccurred: (style: string) => void };
  onEvent: (name: string, fn: () => void) => void; offEvent: (name: string, fn: () => void) => void;
  isVersionAtLeast?: (version: string) => boolean;
  requestChat?: (preparedId: string, callback: (sent: boolean) => void) => void;
  shareMessage?: (preparedId: string, callback: (sent: boolean) => void) => void;
};
declare global { interface Window { Telegram?: { WebApp?: TelegramApp } } }
