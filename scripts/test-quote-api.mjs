import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import admin from 'firebase-admin';

assert(process.env.FIRESTORE_EMULATOR_HOST, 'Run this test inside Firebase emulators:exec.');
const projectId = process.env.GCLOUD_PROJECT || 'demo-quote-cro';
admin.initializeApp({ projectId });
const db = admin.firestore();
const post = async (route, body, expected = 200) => {
  const response = await fetch(`http://127.0.0.1:5010/api/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
};
const token = () => randomBytes(32).toString('hex');
const body = { vehicle: 'sedan', service: 'full', name: 'Local test', phone: '8285550123', addons: [], update_token: token(), session_id: 'test-session-' + token(), flow_version: '5' };
await post('createLead', { ...body, name: '' }, 400);
await post('createLead', { ...body, vehicle: '__proto__' }, 400);
await post('createLead', { ...body, service: 'constructor' }, 400);
await post('createLead', { ...body, phone: '123' }, 400);
const lead = await post('createLead', body);
assert.equal((await post('createLead', body)).id, lead.id, 'Retries must return the same lead');
const auth = { id: lead.id, token: lead.update_token };
let options = await post('leadOptions', { ...auth, action: 'read' });
assert.equal(options.quoted_total, 300);
assert(!('phone' in options) && !('name' in options) && !('addon_token_hash' in options));
await post('leadOptions', { ...auth, token: token(), action: 'read' }, 403);
await post('leadOptions', { ...auth, action: 'save', addons: ['evil'] }, 400);
options = await post('leadOptions', { ...auth, action: 'save', addons: ['wax', 'pethair'], quoted_total: 1, name: 'attacker' });
assert.equal(options.quoted_total, 355);
const record = (await db.collection('leads').doc(lead.id).get()).data();
assert.deepEqual(record.addons, ['wax', 'pethair']);
assert.equal(record.quoted_total, 355);
assert.equal(record.name, 'Local test');
assert.equal((await post('leadOptions', { ...auth, action: 'save', addons: ['wax', 'wax'] })).quoted_total, 325);
assert.equal((await post('leadOptions', { ...auth, action: 'save', addons: [] })).quoted_total, 300);
assert.equal((await db.collection('quotePageSessions').doc(body.session_id).get()).data().completed, true);
const recovered = await post('createLead', { ...body, name: '', capture_method: 'exit_intent', update_token: token() });
assert.equal((await db.collection('leads').doc(recovered.id).get()).data().capture_method, 'exit_intent');
const interior = await post('createLead', { ...body, service: 'interior_only', update_token: token() });
options = await post('leadOptions', { id: interior.id, token: interior.update_token, action: 'save', addons: ['wax', 'headlights'] });
assert.deepEqual(options.addons, ['headlights']);
assert.equal(options.quoted_total, 275);
assert(!('wax' in options.addon_prices));
const consult = await post('createLead', { ...body, service: 'other', update_token: token() });
assert.equal((await post('leadOptions', { id: consult.id, token: consult.update_token, action: 'save', addons: ['pethair'] })).quoted_total, null);
const ceramicBody = { ...body, service: 'ceramic', paint_condition: 'light_swirls', coating_package: 'single_step', vehicle_details: '<b>2024 Toyota RAV4</b>', flow_version: 'ceramic-1', page: 'ceramic-quote' };
await post('createLead', { ...ceramicBody, coating_package: 'constructor', update_token: token() }, 400);
await post('createLead', { ...ceramicBody, paint_condition: '__proto__', update_token: token() }, 400);
await post('createLead', { ...ceramicBody, paint_condition: null, update_token: token() }, 400);
for (const [vehicle, coating_package, expected] of [
  ['sedan', 'single_step', 1000], ['sedan', 'two_step', 1400],
  ['suv_truck', 'single_step', 1400], ['suv_truck', 'two_step', 1800],
  ['van_3row', 'single_step', null], ['sedan', 'recommend', null],
]) {
  const request = { ...ceramicBody, vehicle, coating_package, quoted_total: 1, addons: ['wax'], update_token: token(), session_id: 'ceramic-session-' + token() };
  const saved = await post('createLead', request);
  assert.equal((await post('createLead', request)).id, saved.id);
  const record = (await db.collection('leads').doc(saved.id).get()).data();
  assert.equal(record.quoted_total, expected);
  assert.equal(record.vehicle_details, '2024 Toyota RAV4');
  assert.equal(record.coating_package, coating_package);
  assert.equal(record.paint_condition, 'light_swirls');
  assert.equal(record.page, 'ceramic-quote');
  assert.equal(record.flow_version, 'ceramic-1');
  assert.deepEqual(record.addons, []);
  const receipt = await post('leadOptions', { id: saved.id, token: saved.update_token, action: 'save', addons: ['wax', 'pethair'] });
  assert.equal(receipt.quoted_total, expected);
  assert.deepEqual(receipt.addon_prices, {});
  assert.deepEqual(receipt.addons, []);
  assert.equal(receipt.coating_package, coating_package);
  assert(!('phone' in receipt) && !('name' in receipt) && !('vehicle_details' in receipt));
  const session = (await db.collection('quotePageSessions').doc(request.session_id).get()).data();
  assert.equal(session.page, 'ceramic-quote');
  assert.equal(session.completed, true);
}
const ceramicSessionId = 'ceramic-progress-' + token();
await post('quoteProgress', { session_id: ceramicSessionId, page: 'ceramic-quote', flow_version: 'ceramic-1', event: 'step_view', step: 4 });
assert.equal((await db.collection('quotePageSessions').doc(ceramicSessionId).get()).data().flow_version, 'ceramic-1');
await db.collection('leads').doc(lead.id).update({ addon_token_expires_at: Date.now() - 1 });
await post('leadOptions', { ...auth, action: 'save', addons: ['wax'] }, 403);
assert.equal((await db.collection('leads').doc(lead.id).get()).data().quoted_total, 300);
console.log('PASS: detail and ceramic lead validation, retry deduplication, private receipts, all ceramic packages and vehicle prices, paint details, separate funnels, add-on persistence/removal, phone-only recovery, consultation, expiry, and server-recorded conversion.');
await admin.app().delete();
