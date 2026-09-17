import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioWorkerClient } from './createScenarioWorkerClient.js';

function fixture() {
  const workers = [];
  const client = createScenarioWorkerClient({ createWorker: () => {
    const worker = {
      terminated: false,
      postMessage(message) { this.request = message; },
      terminate() { this.terminated = true; },
      send(data) { this.onmessage({ data: { requestId: this.request.requestId, ...data } }); },
    };
    workers.push(worker);
    return worker;
  } });
  return { client, workers };
}

test('worker results preserve scenario order and release the worker on completion', async () => {
  const { client, workers } = fixture();
  const progress = [];
  const result = client.run({ entries: [{}, {}] }, (...values) => progress.push(values));
  const worker = workers[0];
  worker.send({ kind: 'scenario', index: 1, result: { successRate: .7 } });
  worker.send({ kind: 'scenario', index: 0, result: { successRate: .8 } });
  worker.send({ kind: 'complete' });
  assert.deepEqual((await result).map(response => response.result.successRate), [.8, .7]);
  assert.equal(worker.terminated, true);
  assert.equal(worker.onmessage, null);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('explicit cancellation terminates computation and detaches every handler', async () => {
  const { client, workers } = fixture();
  const run = client.run({ entries: [{}] });
  const cancelled = assert.rejects(run, { code: 'SCENARIO_RUN_SUPERSEDED' });
  client.cancel();
  await cancelled;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].onmessage, null);
  assert.equal(workers[0].onerror, null);
  assert.equal(workers[0].onmessageerror, null);
});

test('superseding a run terminates it and ignores already queued stale replies', async () => {
  const { client, workers } = fixture();
  const oldRun = client.run({ entries: [{}] });
  const oldFailure = assert.rejects(oldRun, { code: 'SCENARIO_RUN_SUPERSEDED' });
  const staleHandler = workers[0].onmessage;
  const nextRun = client.run({ entries: [{}] });
  assert.equal(workers[0].terminated, true);
  staleHandler({ data: { kind: 'error', requestId: 1, error: { message: 'old failure' } } });
  workers[1].send({ kind: 'scenario', index: 0, result: { household: 'new' } });
  workers[1].send({ kind: 'complete' });
  assert.equal((await nextRun)[0].result.household, 'new');
  await oldFailure;
});

test('incomplete and duplicate responses fail explicitly and clean up', async () => {
  for (const duplicate of [false, true]) {
    const { client, workers } = fixture();
    const run = client.run({ entries: [{}, {}] });
    const failure = assert.rejects(run, /Calculation worker returned an (invalid|incomplete)/);
    workers[0].send({ kind: 'scenario', index: 0, result: {} });
    workers[0].send(duplicate ? { kind: 'scenario', index: 0, result: {} } : { kind: 'complete' });
    await failure;
    assert.equal(workers[0].terminated, true);
  }
});

test('worker load and decoding errors remain failures without a synchronous fallback', async () => {
  for (const event of ['onerror', 'onmessageerror']) {
    const { client, workers } = fixture();
    const run = client.run({ entries: [{}] });
    const failure = assert.rejects(run, /Calculation worker/);
    workers[0][event]({ message: 'module unavailable' });
    await failure;
    assert.equal(workers[0].terminated, true);
  }
});

test('worker creation, input cloning and malformed results produce explicit failures', async () => {
  const unavailable = createScenarioWorkerClient({ createWorker() { throw new Error('Worker unavailable'); } });
  await assert.rejects(unavailable.run({ entries: [{}] }), /Calculation worker could not start: Worker unavailable/);
  let terminated = false;
  const unclonable = createScenarioWorkerClient({ createWorker: () => ({
    postMessage() { throw new Error('DataCloneError'); }, terminate() { terminated = true; },
  }) });
  await assert.rejects(unclonable.run({ entries: [{}] }), /Calculation worker inputs could not be sent: DataCloneError/);
  assert.equal(terminated, true);
  const { client, workers } = fixture();
  const run = client.run({ entries: [{}] });
  const failure = assert.rejects(run, /invalid scenario response/);
  workers[0].send({ kind: 'scenario', index: 0 });
  await failure;
  assert.equal(workers[0].terminated, true);
});
