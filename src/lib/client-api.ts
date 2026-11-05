export async function api(action: string, values: Record<string, unknown> = {}, signal?: AbortSignal) {
  const response = await fetch('/api/app', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values }), signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие');
  return result;
}
