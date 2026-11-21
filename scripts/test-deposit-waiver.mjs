// Checks who skips the online deposit, against an in-memory stand-in for Firestore.
import assert from 'node:assert/strict';
import appointments from '../functions/lib/appointments.js';

const fakeDb = ({ appointments: rows = [], clients = {} }) => {
  const snapshot = docs => ({ docs: docs.map(data => ({ data: () => data, get: key => data[key] })) });
  return {
    collection: name => ({
      where: (field, _op, value) => ({ limit: () => ({ get: async () => snapshot(
        name === 'appointments' ? rows.filter(row => row[field] === value)
          : Object.values(clients).filter(client => client[field] === value)) }) }),
      doc: id => ({ id }),
    }),
    getAll: async (...refs) => refs.map(({ id }) => ({ get: key => clients[id]?.[key] })),
  };
};
const customer = { uid: 'uid-1', email: 'returning@example.test' };
const done = { status: 'completed', paidDeposit: 5000, email: 'returning@example.test', customerUid: null, clientId: null };

assert.equal(await appointments.depositWaived(fakeDb({ appointments: [done] }), null), false, 'Signed-out visitors always pay');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [done] }), customer), true, 'Past paid deposit by email');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [{ ...done, email: 'other@example.test', customerUid: 'uid-1' }] }), customer), true, 'Past paid deposit on the account');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [{ ...done, status: 'no_show' }] }), customer), false, 'Forfeited deposits do not count');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [{ ...done, status: 'cancelled' }] }), customer), false, 'Cancelled bookings do not count');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [{ ...done, paidDeposit: 0 }] }), customer), false, 'A detail without a deposit does not count');
assert.equal(await appointments.depositWaived(fakeDb({ appointments: [{ ...done, email: 'other@example.test' }] }), customer), false, 'Someone else\'s history does not count');
assert.equal(await appointments.depositWaived(fakeDb({ clients: { c1: { email: 'returning@example.test', appointment_deposit_default: 'waived' } } }), customer), true, 'Owner-waived client by email');
assert.equal(await appointments.depositWaived(fakeDb({ clients: { c1: { email: 'returning@example.test', appointment_deposit_default: 'required' } } }), customer), false);
assert.equal(await appointments.depositWaived(fakeDb({
  appointments: [{ status: 'cancelled', email: 'returning@example.test', clientId: 'c2' }],
  clients: { c2: { email: 'different@example.test', appointment_deposit_default: 'waived' } },
}), customer), true, 'Owner-waived client linked through a past appointment');
console.log('PASS: deposit waivers need a verified account with a completed paid detail or an owner-waived client.');
