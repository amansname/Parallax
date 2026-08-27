import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DELETE_HOUSEHOLD_FAILURE,
  deleteStoredHousehold,
} from './deleteHousehold.js';

const DATABASE_KEY = 'households';
const ACTIVE_KEY = 'active';
const SCENARIO_KEY = 'scenarios.custom';

function createStorage(initial = {}, fail = () => false){
  const values = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    values,
    getItem(key){
      calls.push(['getItem', key]);
      if(fail('getItem', key, calls)) throw new Error('blocked read');
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value){
      calls.push(['setItem', key, value]);
      if(fail('setItem', key, calls)) throw new Error('blocked write');
      values.set(key, String(value));
    },
    removeItem(key){
      calls.push(['removeItem', key]);
      if(fail('removeItem', key, calls)) throw new Error('blocked removal');
      values.delete(key);
    },
  };
}

function request(storage, overrides = {}){
  return deleteStoredHousehold({
    storage,
    householdId: 'custom',
    protectedHouseholdIds: ['shipped'],
    databaseKey: DATABASE_KEY,
    activeHouseholdKey: ACTIVE_KEY,
    scenarioKey: SCENARIO_KEY,
    ...overrides,
  });
}

test('deletes only the requested household and its active and scenario records', () => {
  const shipped = { meta: { name: 'Shipped' } };
  const custom = { meta: { name: 'Custom' } };
  const storage = createStorage({
    [DATABASE_KEY]: JSON.stringify({ shipped, custom }),
    [ACTIVE_KEY]: 'custom',
    [SCENARIO_KEY]: '[{"name":"Baseline"}]',
  });

  const result = request(storage);

  assert.deepEqual(result, { ok: true, database: { shipped } });
  assert.equal(storage.values.get(DATABASE_KEY), JSON.stringify({ shipped }));
  assert.equal(storage.values.has(ACTIVE_KEY), false);
  assert.equal(storage.values.has(SCENARIO_KEY), false);
  assert.deepEqual(custom, { meta: { name: 'Custom' } });
});

test('rejects protected households without reading or writing storage', () => {
  const storage = createStorage();
  const result = request(storage, { householdId: 'shipped' });
  assert.deepEqual(result, { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.PROTECTED });
  assert.deepEqual(storage.calls, []);
});

test('rejects unknown household IDs without mutating storage', () => {
  const bytes = JSON.stringify({ shipped: { meta: { name: 'Shipped' } } });
  const storage = createStorage({ [DATABASE_KEY]: bytes });
  const result = request(storage, { householdId: 'missing' });
  assert.deepEqual(result, { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.NOT_FOUND });
  assert.equal(storage.values.get(DATABASE_KEY), bytes);
  assert.equal(storage.calls.some(([method]) => method !== 'getItem'), false);
});

test('reports read failure before any destructive storage call', () => {
  const storage = createStorage({ [DATABASE_KEY]: '{}' }, (method, key) => method === 'getItem' && key === ACTIVE_KEY);
  const result = request(storage);
  assert.deepEqual(result, { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.READ_FAILED });
  assert.equal(storage.calls.some(([method]) => method !== 'getItem'), false);
});

test('restores exact original bytes when the database commit fails', () => {
  const databaseBytes = '{"custom":{"meta":{"name":"Custom"}},"shipped":{"meta":{"name":"Shipped"}}}';
  const scenarioBytes = ' [ { "name": "Baseline" } ] ';
  let failedCommit = false;
  const storage = createStorage({
    [DATABASE_KEY]: databaseBytes,
    [ACTIVE_KEY]: 'custom',
    [SCENARIO_KEY]: scenarioBytes,
  }, (method, key) => {
    if(method === 'setItem' && key === DATABASE_KEY && !failedCommit){
      failedCommit = true;
      return true;
    }
    return false;
  });

  const result = request(storage);

  assert.deepEqual(result, { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.WRITE_FAILED });
  assert.equal(storage.values.get(DATABASE_KEY), databaseBytes);
  assert.equal(storage.values.get(ACTIVE_KEY), 'custom');
  assert.equal(storage.values.get(SCENARIO_KEY), scenarioBytes);
});

test('reports a failed rollback separately when related data cannot be restored', () => {
  let failedCommit = false;
  const storage = createStorage({
    [DATABASE_KEY]: JSON.stringify({ custom: { meta: { name: 'Custom' } } }),
    [ACTIVE_KEY]: 'custom',
    [SCENARIO_KEY]: 'scenario-bytes',
  }, (method, key) => {
    if(method === 'setItem' && key === DATABASE_KEY && !failedCommit){
      failedCommit = true;
      return true;
    }
    return failedCommit && method === 'setItem' && key === ACTIVE_KEY;
  });

  const result = request(storage);

  assert.deepEqual(result, { ok: false, reason: DELETE_HOUSEHOLD_FAILURE.ROLLBACK_FAILED });
  assert.equal(storage.values.get(SCENARIO_KEY), 'scenario-bytes');
});
