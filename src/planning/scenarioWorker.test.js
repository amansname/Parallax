import test from 'node:test';
import assert from 'node:assert/strict';

test('the scenario worker rejects the parked Focus stress job instead of running projections', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const messages = [];
  const workerScope = { postMessage: message => messages.push(message) };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: workerScope });
  try {
    await import('./scenarioWorker.js');
    workerScope.onmessage({ data: { requestId: 7, batch: { kind: 'stress', entries: [] } } });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'error');
    assert.equal(messages[0].requestId, 7);
    assert.match(messages[0].error.message, /Unsupported scenario batch kind: stress/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else delete globalThis.self;
  }
});
