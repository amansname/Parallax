import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileGoalDraft, applyMobileGoalDraft } from './mobileGoalDraft.js';
import { setGoalDisplayAmount, setGoalPer } from './horizonModel.js';

const goal = () => ({ id: 'essentials', name: 'Essentials', system: true, startsAtRetirement: true, endAge: 999, amount: 24001, per: 'yr' });

test('opening and canceling a mobile copy never changes the saved annual amount or retirement sentinel', () => {
  const saved = goal();
  const original = structuredClone(saved);
  const draft = createMobileGoalDraft(saved);
  setGoalPer(draft.value, 'mo');
  setGoalDisplayAmount(draft.value, 2500);
  draft.value.name = 'Edited';
  assert.deepEqual(saved, original);
});

test('cadence-only save preserves exact annual dollars, sentinel timing and protected identity', () => {
  const saved = goal();
  const draft = createMobileGoalDraft(saved);
  setGoalPer(draft.value, 'mo');
  draft.value.id = 'replacement';
  draft.value.system = false;
  saved.notes = 'Unrelated live edit';
  applyMobileGoalDraft(saved, draft);
  assert.deepEqual(saved, { ...goal(), per: 'mo', notes: 'Unrelated live edit' });
});

test('a changed monthly input is saved through the existing annual goal contract', () => {
  const saved = goal();
  const draft = createMobileGoalDraft(saved);
  setGoalPer(draft.value, 'mo');
  setGoalDisplayAmount(draft.value, 2500);
  applyMobileGoalDraft(saved, draft);
  assert.equal(saved.amount, 30000);
  assert.equal(saved.startsAtRetirement, true);
  assert.equal(saved.endAge, 999);
});

test('conflicting timing or amount changes reject atomically instead of stitching inconsistent fields', () => {
  for(const [draftKey, draftValue, liveKey, liveValue] of [
    ['startAge', 70, 'endAge', 68],
    ['per', 'mo', 'amount', 48000],
  ]){
    const saved = { ...goal(), startAge: 66, endAge: 75, startsAtRetirement: false };
    const draft = createMobileGoalDraft(saved);
    draft.value[draftKey] = draftValue;
    draft.value.name = 'Should not partly save';
    saved[liveKey] = liveValue;
    const before = structuredClone(saved);
    assert.throws(() => applyMobileGoalDraft(saved, draft), /changed while you were editing/);
    assert.deepEqual(saved, before);
  }
});
