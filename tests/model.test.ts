import test from 'node:test';
import assert from 'node:assert/strict';
import { distribute, balances, transfers, seedTrips, parseMoney, confirmPendingSettlement, personalSummary } from '../src/lib/model';
test('100 рублей на троих: ни одна копейка не теряется', () => {
  assert.deepEqual(distribute(10000, ['a', 'b', 'c'], 'equal'), { a: 3334, b: 3333, c: 3333 });
});
test('проценты, доли и точные суммы', () => {
  assert.deepEqual(distribute(10001, ['a', 'b'], 'percent', { a: '25', b: '75' }), { a: 2500, b: 7501 });
  assert.deepEqual(distribute(10000, ['a', 'b'], 'shares', { a: '1', b: '3' }), { a: 2500, b: 7500 });
  assert.deepEqual(distribute(10000, ['a', 'b'], 'exact', { a: '30', b: '70' }), { a: 3000, b: 7000 });
  assert.deepEqual(distribute(10000, ['a', 'b'], 'exact', { a: '0,00', b: '100' }), { a: 0, b: 10000 });
  assert.throws(() => distribute(10000, ['a', 'b'], 'percent', { a: '20', b: '20' }));
  assert.throws(() => distribute(10000, ['a', 'b'], 'exact', { a: '20', b: '20' }));
});
test('балансы сходятся и все предложенные погашения обнуляют долги', () => {
  const trip = seedTrips()[0];
  assert.equal(Object.values(balances(trip)).reduce((a, b) => a + b, 0), 0);
  for (const [i, move] of transfers(trip).entries()) trip.settlements.push({ ...move, id: String(i), date: '2026-09-27' });
  assert.ok(Object.values(balances(trip)).every(v => v === 0));
});
test('частичный возврат уменьшает долг на точную сумму', () => {
  const trip = seedTrips()[0], before = balances(trip);
  trip.settlements.push({ id: 'partial', from: 'nikita', to: 'me', amount: 10000, date: '2026-09-27' });
  assert.equal(balances(trip).nikita, before.nikita + 10000);
  assert.equal(balances(trip).me, before.me - 10000);
});
test('отправленный перевод ждёт подтверждения получателя и не меняет баланс раньше времени', () => {
  const trip = seedTrips()[1];
  const move = transfers(trip).find(item => item.from === 'me');
  assert.ok(move);
  const before = balances(trip);
  trip.settlements.push({ ...move, id: 'pending', date: '2026-09-29', status: 'pending' });
  assert.deepEqual(balances(trip), before);
  assert.ok(!transfers(trip, true).some(item => item.from === move.from && item.to === move.to));
  assert.throws(() => confirmPendingSettlement(trip, 'pending', 'me'));
  const confirmed = confirmPendingSettlement(trip, 'pending', move.to);
  assert.equal(confirmed.settlements.find(item => item.id === 'pending')?.confirmedBy, move.to);
  assert.equal(balances(confirmed).me, before.me + move.amount);
  assert.ok(!transfers(confirmed).some(item => item.from === move.from && item.to === move.to));
});
test('частично отправленный перевод не предлагается повторно целиком', () => {
  const trip = seedTrips()[1];
  trip.settlements.push({ id: 'partial-pending', from: 'me', to: 'anya', amount: 100000, date: '2026-09-29', status: 'pending' });
  assert.equal(balances(trip).me, -260000);
  assert.deepEqual(transfers(trip, true).find(item => item.from === 'me'), { from: 'me', to: 'anya', amount: 160000 });
});
test('сводка отделяет подтверждённые возвраты от ожидающих и сходится с балансом', () => {
  const trip = seedTrips()[0];
  trip.settlements.push(
    { id: 'received', from: 'max', to: 'me', amount: 200000, date: '2026-09-29', status: 'confirmed' },
    { id: 'returned', from: 'me', to: 'anya', amount: 50000, date: '2026-09-29', status: 'confirmed' },
    { id: 'pending-in', from: 'nikita', to: 'me', amount: 100000, date: '2026-09-29', status: 'pending' },
    { id: 'pending-out', from: 'me', to: 'anya', amount: 25000, date: '2026-09-29', status: 'pending' },
  );
  const summary = personalSummary(trip, 'me');
  assert.equal(summary.received, 200000);
  assert.equal(summary.returned, 50000);
  assert.equal(summary.pendingIncoming, 100000);
  assert.equal(summary.pendingOutgoing, 25000);
  assert.equal(summary.balance, summary.paid - summary.share - summary.received + summary.returned);
  assert.equal(summary.balance, balances(trip).me);
  assert.equal(summary.balance - summary.pendingIncoming + summary.pendingOutgoing, balances(trip, true).me);
});
test('ввод копеек и запрет некорректных сумм', () => {
  assert.equal(parseMoney('1 234,56'), 123456);
  for (const input of ['0', '-5', '2.345', '1e3', 'abc']) assert.throws(() => parseMoney(input));
});
