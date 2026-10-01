import { createHash, randomBytes } from 'node:crypto';
import { rpc } from './supabase';
import type { Category, Expense, Member, Trip } from '../model';

type RawMember = { id: string; firstName: string; lastName: string; username: string; removed?: boolean };
type RawExpense = Omit<Expense, 'history'> & { version: number; history: string[] };
type RawTrip = { id: string; name: string; cover: string; archived: boolean; ownerId: string; members: RawMember[]; expenses: RawExpense[]; settlements: Trip['settlements'] };
function ownId(value: string, actor: string) { return value === actor ? 'me' : value; }
function member(raw: RawMember, actor: string): Member {
  const name = [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim();
  const initials = [raw.firstName, raw.lastName].filter(Boolean).map(x => Array.from(x)[0]).join('').toUpperCase();
  return { id: ownId(raw.id, actor), name, initials, username: raw.username ? `@${raw.username}` : '', color: '#6695dd', removed: raw.removed === true };
}
export async function snapshot(actor: string) {
  const raw = await rpc<RawTrip[]>('app_snapshot', { p_actor: actor });
  return raw.map(event => ({
    id: event.id, name: event.name, subtitle: '', cover: event.cover, dates: 'Совместное мероприятие',
    ownerId: ownId(event.ownerId, actor), members: event.members.map(m => member(m, actor)), archived: event.archived,
    expenses: event.expenses.map(e => ({ ...e, payer: ownId(e.payer, actor), author: ownId(e.author, actor),
      splits: Object.fromEntries(Object.entries(e.splits).map(([id, amount]) => [ownId(id, actor), amount])) })),
    settlements: event.settlements.map(s => ({ ...s, from: ownId(s.from, actor), to: ownId(s.to, actor), confirmedBy: s.confirmedBy ? ownId(s.confirmedBy, actor) : undefined })),
  })) satisfies Trip[];
}
export function actorId(value: string, actor: string) { return value === 'me' ? actor : value; }
export function validUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function normalizeExpense(input: unknown, actor: string) {
  const e = input as Partial<Expense>;
  if (!e || !validUuid(e.id) || typeof e.title !== 'string' || !e.title.trim() || e.title.length > 80 ||
      !Number.isSafeInteger(e.amount) || (e.amount ?? 0) <= 0 || (e.amount ?? 0) > 100000000000 ||
      !['home','transport','food','fun','other'].includes(e.category as Category) ||
      !['equal','percent','exact','shares'].includes(e.mode || '') ||
      typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) ||
      !e.splits || typeof e.splits !== 'object' || !Object.keys(e.splits).length) throw new Error('Invalid expense');
  const splits = Object.fromEntries(Object.entries(e.splits).map(([id, amount]) => [actorId(id, actor), amount]));
  if (Object.keys(splits).some(id => !validUuid(id)) || Object.values(splits).some(amount => !Number.isSafeInteger(amount) || amount < 0) ||
      Object.values(splits).reduce((a, b) => a + b, 0) !== e.amount) throw new Error('Invalid shares');
  return { id: e.id, title: e.title.trim(), amount: e.amount, category: e.category, date: e.date, mode: e.mode, splits };
}
export async function newInvite(actor: string, event: string) {
  const token = randomBytes(24).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await rpc('app_create_invite', { p_actor: actor, p_event: event, p_hash: hash });
  return token;
}
export async function joinInvite(actor: string, token: string) {
  if (!/^[\w-]{32}$/.test(token)) throw new Error('Invalid invite');
  return rpc<string>('app_join_event', { p_actor: actor, p_hash: createHash('sha256').update(token).digest('hex') });
}
export function telegramInviteUrl(botUsername: string, token: string, shortName?: string) {
  const bot = botUsername.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(bot) || !/^[\w-]{32}$/.test(token) || (shortName && !/^[A-Za-z0-9_]{1,64}$/.test(shortName))) throw new Error('Invalid Telegram app link');
  return `https://t.me/${bot}${shortName ? `/${shortName}` : ''}?startapp=${token}`;
}
