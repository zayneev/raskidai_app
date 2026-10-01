import test from 'node:test';
import assert from 'node:assert/strict';
import { activeMembers, balances, expenseHasRemovedMember, memberRemovalReason, removeTripMember, seedTrips } from '../src/lib/model';

test('only the creator can remove an active participant; the creator cannot be removed', () => {
  const trip = { ...seedTrips()[0], expenses: [] };
  assert.throws(() => removeTripMember(trip, 'anya', 'max'), /только создатель/);
  assert.throws(() => removeTripMember(trip, 'me', 'me'), /нельзя удалить/);
  assert.throws(() => removeTripMember({ ...trip, archived: true }, 'me', 'max'), /из архива/);
  assert.throws(() => removeTripMember(trip, 'me', 'outsider'), /уже удалён/);
});

test('removal requires a zero balance and no pending transfers in either direction', () => {
  const trip = seedTrips()[0];
  assert.throws(() => removeTripMember(trip, 'me', 'anya'), /завершите расчёты/);
  for (const direction of [{ from: 'anya', to: 'me' }, { from: 'me', to: 'anya' }]) {
    const balanced = { ...trip, expenses: [], settlements: [{ id: 'pending', ...direction, amount: 100, date: '2026-10-01', status: 'pending' as const }] };
    assert.equal(balances(balanced).anya, 0);
    assert.match(memberRemovalReason(balanced, 'me', 'anya')!, /подтвердите/);
  }
});

test('settled participant loses active status while history and balances remain intact', () => {
  const trip = seedTrips()[2];
  trip.archived = false;
  const before = balances(trip);
  const removed = removeTripMember(trip, 'me', 'anya');
  assert.deepEqual(activeMembers(removed).map(member => member.id), ['me']);
  assert.equal(removed.members.find(member => member.id === 'anya')?.removed, true);
  assert.deepEqual(removed.expenses, trip.expenses);
  assert.deepEqual(removed.settlements, trip.settlements);
  assert.deepEqual(balances(removed), before);
  assert.ok(expenseHasRemovedMember(removed, removed.expenses[0]));
  assert.equal(trip.members.find(member => member.id === 'anya')?.removed, undefined);
});

test('an unrelated participant can be removed without freezing existing expenses', () => {
  const trip = seedTrips()[1];
  trip.members = [...trip.members, seedTrips()[0].members.find(member => member.id === 'nikita')!];
  const removed = removeTripMember(trip, 'me', 'nikita');
  assert.equal(activeMembers(removed).length, 3);
  assert.ok(removed.expenses.every(expense => !expenseHasRemovedMember(removed, expense)));
  assert.deepEqual(balances(removed), balances(trip));
});
