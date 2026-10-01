
export class DatabaseError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new DatabaseError('Supabase is not configured', 503);
  const headers: Record<string, string> = {
    apikey: key, 'Content-Type': 'application/json', Accept: 'application/json',
  };
  // New sb_secret keys are not JWTs and must only be sent in the apikey header.
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST', cache: 'no-store',
    headers,
    body: JSON.stringify(args),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data?.message === 'string' ? data.message : 'Database request failed';
    const status = /Forbidden|outsider/i.test(message) ? 403 : /conflict|reused/i.test(message) ? 409 : response.status === 404 ? 503 : 400;
    throw new DatabaseError(message, status);
  }
  return data as T;
}
