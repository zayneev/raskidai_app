export type Member = { id: string; name: string; initials: string; color: string; username: string };
export type Category = 'home' | 'transport' | 'food' | 'fun' | 'other';
export type SplitMode = 'equal' | 'percent' | 'shares' | 'exact';
export type Expense = { id: string; title: string; amount: number; payer: string; splits: Record<string, number>; category: Category; date: string; mode: SplitMode; author: string; history: string[]; version?: number };
export type Settlement = { id: string; from: string; to: string; amount: number; date: string; status?: 'pending' | 'confirmed'; confirmedBy?: string };
export type Trip = { id: string; name: string; subtitle: string; cover: string; dates: string; members: Member[]; expenses: Expense[]; settlements: Settlement[]; archived: boolean; ownerId?: string };
export const ME = 'me';
export const members: Member[] = [
  { id: ME, name: 'Саша Иванов', initials: 'СИ', color: '#dbeaff', username: '@sasha' },
  { id: 'anya', name: 'Аня Петрова', initials: 'АП', color: '#fce3dc', username: '@anyatravel' },
  { id: 'max', name: 'Макс Сидоров', initials: 'МС', color: '#e5e0fc', username: '@maxon' },
  { id: 'nikita', name: 'Никита Орлов', initials: 'НО', color: '#dbeddf', username: '@nikitago' },
];
export const categories: { id: Category; name: string; color: string }[] = [
  { id: 'home', name: 'Жильё', color: '#8974d5' }, { id: 'transport', name: 'Транспорт', color: '#509cef' },
  { id: 'food', name: 'Еда', color: '#efa965' }, { id: 'fun', name: 'Развлечения', color: '#69b6a1' }, { id: 'other', name: 'Другое', color: '#9babc1' },
];
export const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export const uid = () => crypto.randomUUID();
export function plural(count: number, forms: [string, string, string]): string {
  const last = count % 10, lastTwo = count % 100;
  return lastTwo >= 11 && lastTwo <= 14 ? forms[2] : last === 1 ? forms[0] : last >= 2 && last <= 4 ? forms[1] : forms[2];
}
export function parseMoney(value: string, allowZero = false): number {
  const normal = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normal)) throw new Error('Введите сумму с точностью до копеек');
  const [rub, kop = ''] = normal.split('.');
  const amount = Number(rub) * 100 + Number(kop.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 99999999900) throw new Error('Введите сумму от 0,01 до 999 999 999 ₽');
  return amount;
}
export function money(cents: number, sign = false) {
  const result = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: cents % 100 ? 2 : 0, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(Math.abs(cents) / 100);
  return `${sign && cents !== 0 ? (cents > 0 ? '+' : '−') : cents < 0 ? '−' : ''}${result} ₽`;
}
export function distribute(amount: number, ids: string[], mode: SplitMode, values: Record<string, string> = {}): Record<string, number> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Введите корректную сумму');
  if (!ids.length) throw new Error('Выберите хотя бы одного участника');
  if (mode === 'exact') {
    const amounts = ids.map(id => parseMoney(values[id] || '0', true));
    if (amounts.reduce((a, b) => a + b, 0) !== amount) throw new Error('Суммы участников должны совпадать с расходом');
    return Object.fromEntries(ids.map((id, i) => [id, amounts[i]]));
  }
  const weights = ids.map(id => mode === 'equal' ? 1 : Number((values[id] || '0').replace(',', '.')));
  if (weights.some(w => !Number.isFinite(w) || w < 0 || w > 1000000)) throw new Error('Введите неотрицательные значения');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) throw new Error('Укажите значения для участников');
  if (mode === 'percent' && Math.abs(sum - 100) > 0.000001) throw new Error('Проценты должны составлять 100%');
  const exact = weights.map(w => amount * w / sum);
  const rounded = exact.map(Math.floor);
  let remainder = amount - rounded.reduce((a, b) => a + b, 0);
  const order = ids.map((_, i) => i).sort((a, b) => (exact[b] - rounded[b]) - (exact[a] - rounded[a]) || a - b);
  for (const index of order) { if (remainder-- <= 0) break; rounded[index]++; }
  return Object.fromEntries(ids.map((id, i) => [id, rounded[i]]));
}
export function balances(trip: Trip, includePending = false): Record<string, number> {
  const result = Object.fromEntries(trip.members.map(m => [m.id, 0]));
  for (const expense of trip.expenses) {
    result[expense.payer] += expense.amount;
    for (const [id, share] of Object.entries(expense.splits)) result[id] -= share;
  }
  for (const settlement of trip.settlements) {
    if (settlement.status === 'pending' && !includePending) continue;
    result[settlement.from] += settlement.amount;
    result[settlement.to] -= settlement.amount;
  }
  return result;
}
export function personalSummary(trip: Trip, memberId: string) {
  const paid = trip.expenses.reduce((sum, expense) => sum + (expense.payer === memberId ? expense.amount : 0), 0);
  const share = trip.expenses.reduce((sum, expense) => sum + (expense.splits[memberId] || 0), 0);
  const confirmed = trip.settlements.filter(settlement => settlement.status !== 'pending');
  const pending = trip.settlements.filter(settlement => settlement.status === 'pending');
  const received = confirmed.reduce((sum, settlement) => sum + (settlement.to === memberId ? settlement.amount : 0), 0);
  const returned = confirmed.reduce((sum, settlement) => sum + (settlement.from === memberId ? settlement.amount : 0), 0);
  const pendingIncoming = pending.reduce((sum, settlement) => sum + (settlement.to === memberId ? settlement.amount : 0), 0);
  const pendingOutgoing = pending.reduce((sum, settlement) => sum + (settlement.from === memberId ? settlement.amount : 0), 0);
  return { paid, share, received, returned, pendingIncoming, pendingOutgoing, balance: paid - share - received + returned };
}
export function confirmPendingSettlement(trip: Trip, settlementId: string, actorId: string): Trip {
  const settlement = trip.settlements.find(item => item.id === settlementId);
  if (!settlement || settlement.status !== 'pending' || settlement.to !== actorId) throw new Error('Подтвердить получение может только получатель перевода');
  return { ...trip, settlements: trip.settlements.map(item => item.id === settlementId ? { ...item, status: 'confirmed', confirmedBy: actorId } : item) };
}
export function transfers(trip: Trip, includePending = false) {
  const result = balances(trip, includePending);
  const debtors = Object.entries(result).filter(([, a]) => a < 0).map(([id, amount]) => ({ id, amount: -amount })).sort((a, b) => b.amount - a.amount);
  const creditors = Object.entries(result).filter(([, a]) => a > 0).map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount);
  const moves: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount);
    moves.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].amount -= amount; creditors[j].amount -= amount;
    if (!debtors[i].amount) i++; if (!creditors[j].amount) j++;
  }
  return moves;
}
function seedExpense(id: string, title: string, rubles: number, payer: string, category: Category, date: string, ids = members.map(m => m.id)): Expense {
  const payerName = members.find(member => member.id === payer)?.name || 'участником';
  return { id, title, amount: rubles * 100, payer, category, date, splits: distribute(rubles * 100, ids, 'equal'), mode: 'equal', author: payer, history: [`Расход добавлен: ${payerName}`] };
}
export function seedTrips(): Trip[] { return [
  { id: 'altai', name: 'Алтай, мы едем!', subtitle: 'Горы, костёр и свои люди', cover: 'mountains', dates: '24–30 сентября', members, archived: false, settlements: [], expenses: [
    seedExpense('a4', 'Продукты к костру', 2800, ME, 'food', '2026-09-27'),
    seedExpense('a3', 'Ужин в «Чеч Кыш»', 4800, 'anya', 'food', '2026-09-26'),
    seedExpense('a2', 'Аренда машины', 9200, 'max', 'transport', '2026-09-25'),
    seedExpense('a1', 'Домик у реки', 28000, ME, 'home', '2026-09-24'),
  ] },
  { id: 'sea', name: 'Выходные у моря', subtitle: 'Ещё немного лета', cover: 'sea', dates: '12–14 сентября', members: members.slice(0, 3), archived: false, settlements: [], expenses: [seedExpense('s1', 'Апартаменты', 15000, 'anya', 'home', '2026-09-12', [ME, 'anya', 'max']), seedExpense('s2', 'Завтрак у моря', 3600, ME, 'food', '2026-09-13', [ME, 'anya', 'max'])] },
  { id: 'kazan', name: 'Казань на двоих', subtitle: 'Город, в который вернёмся', cover: 'city', dates: '2–5 августа', members: members.slice(0, 2), archived: true, settlements: [{ id: 'ks', from: 'anya', to: ME, amount: 600000, date: '2026-08-05' }], expenses: [seedExpense('k1', 'Отель в центре', 12000, ME, 'home', '2026-08-02', [ME, 'anya'])] },
]; }
export const STORAGE_KEY = 'raskidai:prototype:v1';
