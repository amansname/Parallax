import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSET_KEYS as ENGINE_ASSET_KEYS, ASSET_META as ENGINE_ASSET_META, RISK_PROFILES } from '../../engine.js';
import {
  ASSET_ALLOCATION_PRESET_CATALOG_ID,
  ASSET_ALLOCATION_PRESETS,
  ASSET_KEYS,
  ASSET_META,
  INVALID_ASSET_WEIGHTS,
  calculateBalanceWeightedAllocation,
  identifyInvestmentAllocation,
  resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
  validateAssetWeights,
  validateInvestmentAllocation,
  withCustomAssetWeights,
} from './investmentAllocation.js';

test('canonical asset order and sleeve classifications match the Projection Engine', () => {
  assert.deepEqual(ASSET_KEYS, ENGINE_ASSET_KEYS);
  assert.deepEqual(
    Object.fromEntries(ASSET_KEYS.map(key => [key, ASSET_META[key].bucket])),
    Object.fromEntries(ENGINE_ASSET_KEYS.map(key => [key, ENGINE_ASSET_META[key].bucket])),
  );
});

test('locked preset catalog stores the six exact decimal weight snapshots', () => {
  assert.equal(ASSET_ALLOCATION_PRESET_CATALOG_ID, 'asset-allocation-presets-v1');
  assert.deepEqual(ASSET_ALLOCATION_PRESETS.map(preset => ({
    id: preset.id,
    label: preset.label,
    weights: ASSET_KEYS.map(key => preset.weights[key]),
  })), [
    { id: 'defensive', label: 'Defensive', weights: [0.10, 0.02, 0.05, 0.02, 0.64, 0.10, 0.01, 0.06] },
    { id: 'conservative', label: 'Conservative', weights: [0.19, 0.05, 0.11, 0.03, 0.48, 0.07, 0.02, 0.05] },
    { id: 'balanced', label: 'Balanced', weights: [0.29, 0.07, 0.17, 0.04, 0.32, 0.04, 0.03, 0.04] },
    { id: 'growth', label: 'Growth', weights: [0.36, 0.09, 0.21, 0.05, 0.20, 0.02, 0.04, 0.03] },
    { id: 'aggressive', label: 'Aggressive', weights: [0.43, 0.11, 0.25, 0.07, 0.07, 0, 0.04, 0.03] },
    { id: 'all-equity', label: 'All Equity', weights: [0.48, 0.12, 0.28, 0.07, 0, 0, 0.05, 0] },
  ]);
  for(const preset of ASSET_ALLOCATION_PRESETS){
    assert.equal(validateAssetWeights(preset.weights), true);
    assert.equal(Object.isFrozen(preset.weights), true);
  }
});

test('weight validation is strict, exact-key, finite, nonnegative, and total-one', () => {
  const valid = structuredClone(snapshotPresetAllocation('balanced').weights);
  const failures = [
    null,
    [],
    { ...valid, unknown: 0 },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'gold')),
    { ...valid, gold: -0.01, cash: valid.cash + 0.01 },
    { ...valid, gold: NaN },
    { ...valid, gold: Infinity },
    { ...valid, gold: valid.gold + 2e-9 },
  ];
  for(const value of failures){
    assert.throws(
      () => validateAssetWeights(value),
      error => error?.code === INVALID_ASSET_WEIGHTS,
    );
  }
  assert.doesNotThrow(() => validateAssetWeights({ ...valid, gold: valid.gold + 5e-10, cash: valid.cash - 5e-10 }));
});

test('saved weights remain authoritative while preset provenance identifies Custom edits', () => {
  const balanced = snapshotPresetAllocation('balanced');
  assert.deepEqual(identifyInvestmentAllocation(balanced), { id: 'balanced', label: 'Balanced', basedOn: null });
  const editedWeights = { ...balanced.weights, usLarge: 0.30, cash: 0.03 };
  const custom = withCustomAssetWeights(balanced, editedWeights);
  assert.equal(validateInvestmentAllocation(custom), true);
  assert.deepEqual(identifyInvestmentAllocation(custom), { id: 'custom', label: 'Custom', basedOn: 'Balanced' });
  assert.equal(custom.presetId, 'balanced');
  assert.equal(custom.presetVersion, ASSET_ALLOCATION_PRESET_CATALOG_ID);
  assert.deepEqual(custom.weights, editedWeights);

  const legacy = snapshotLegacyRiskProfileAllocation(3);
  const legacyEditedWeights = { ...legacy.weights, usLarge: legacy.weights.usLarge + 0.01, cash: legacy.weights.cash - 0.01 };
  const legacyCustom = withCustomAssetWeights(legacy, legacyEditedWeights);
  assert.equal(validateInvestmentAllocation(legacyCustom), true);
  assert.deepEqual(identifyInvestmentAllocation(legacyCustom), { id: 'custom', label: 'Custom', basedOn: null });
  assert.equal(legacyCustom.legacyRiskProfile, 3);
  assert.equal(legacyCustom.reviewRequired, true);
  assert.deepEqual(legacyCustom.weights, legacyEditedWeights);

  const unbasedCustom = {
    weights: editedWeights,
    source: 'custom',
    presetId: null,
    presetVersion: null,
    legacyRiskProfile: null,
    reviewRequired: false,
  };
  assert.equal(validateInvestmentAllocation(unbasedCustom), true);
});

test('preset and legacy provenance must match their authoritative saved snapshots', () => {
  const mismatchedPreset = structuredClone(snapshotPresetAllocation('balanced'));
  mismatchedPreset.weights.usLarge += 0.01;
  mismatchedPreset.weights.cash -= 0.01;
  assert.throws(
    () => validateInvestmentAllocation(mismatchedPreset),
    error => error?.code === INVALID_ASSET_WEIGHTS && /do not match/i.test(error.message),
  );

  const mismatchedLegacy = structuredClone(snapshotLegacyRiskProfileAllocation(3));
  mismatchedLegacy.weights.usLarge += 0.01;
  mismatchedLegacy.weights.cash -= 0.01;
  assert.throws(
    () => validateInvestmentAllocation(mismatchedLegacy),
    error => error?.code === INVALID_ASSET_WEIGHTS && /migration provenance/i.test(error.message),
  );

  for(const malformed of [
    { ...structuredClone(snapshotLegacyRiskProfileAllocation(3)), legacyRiskProfile: null },
    { ...structuredClone(snapshotLegacyRiskProfileAllocation(3)), reviewRequired: false },
    { ...structuredClone(snapshotLegacyRiskProfileAllocation(3)), presetId: 'balanced', presetVersion: ASSET_ALLOCATION_PRESET_CATALOG_ID },
  ]){
    assert.throws(
      () => validateInvestmentAllocation(malformed),
      error => error?.code === INVALID_ASSET_WEIGHTS,
    );
  }

  const balanced = structuredClone(snapshotPresetAllocation('balanced'));
  for(const malformed of [
    { ...balanced, unexpected: true },
    { ...balanced, source: 'unknown' },
    { ...balanced, presetId: 'missing' },
    { ...balanced, presetVersion: 'asset-allocation-presets-v0' },
  ]){
    assert.throws(
      () => validateInvestmentAllocation(malformed),
      error => error?.code === INVALID_ASSET_WEIGHTS,
    );
  }


  const presetCustom = withCustomAssetWeights(
    snapshotPresetAllocation('balanced'),
    { ...balanced.weights, usLarge: 0.30, cash: 0.03 },
  );
  const legacyCustom = withCustomAssetWeights(
    snapshotLegacyRiskProfileAllocation(3),
    {
      ...snapshotLegacyRiskProfileAllocation(3).weights,
      usLarge: snapshotLegacyRiskProfileAllocation(3).weights.usLarge + 0.01,
      cash: snapshotLegacyRiskProfileAllocation(3).weights.cash - 0.01,
    },
  );
  for(const malformed of [
    { ...legacyCustom, legacyRiskProfile: 7 },
    { ...legacyCustom, legacyRiskProfile: 3.5 },
    { ...legacyCustom, reviewRequired: false },
    { ...legacyCustom, presetId: 'balanced', presetVersion: ASSET_ALLOCATION_PRESET_CATALOG_ID },
    { ...presetCustom, legacyRiskProfile: 3, reviewRequired: true },
    { ...presetCustom, reviewRequired: true },
    { ...presetCustom, unexpectedProvenance: 'not-allowed' },
  ]){
    assert.throws(
      () => validateInvestmentAllocation(malformed),
      error => error?.code === INVALID_ASSET_WEIGHTS,
    );
  }
});

test('cash-only and legacy risk snapshots are explicit and match existing engine weights', () => {
  const cash = resolveCashOnlyAllocation();
  assert.deepEqual(ASSET_KEYS.map(key => cash.weights[key]), [0, 0, 0, 0, 0, 1, 0, 0]);
  assert.equal(cash.source, 'cash-only');
  for(const riskProfile of [1, 2, 3, 4, 5, 6]){
    const legacy = snapshotLegacyRiskProfileAllocation(riskProfile);
    assert.deepEqual(legacy.weights, RISK_PROFILES[riskProfile].weights);
    assert.equal(legacy.source, 'legacy-risk-profile');
    assert.equal(legacy.reviewRequired, true);
  }
});

test('balance-weighted roll-up uses saved account weights and ignores zero balances', () => {
  const balanced = snapshotPresetAllocation('balanced');
  const cash = resolveCashOnlyAllocation();
  const rollup = calculateBalanceWeightedAllocation([
    { id: 'invested', balance: 300, investmentAllocation: balanced },
    { id: 'cash', balance: 100, investmentAllocation: cash },
    { id: 'zero', balance: 0, investmentAllocation: null },
  ]);
  assert.equal(rollup.totalBalance, 400);
  assert.deepEqual(rollup.accountIds, ['invested', 'cash']);
  for(const key of ASSET_KEYS){
    const expected = key === 'cash'
      ? balanced.weights.cash * 0.75 + 0.25
      : balanced.weights[key] * 0.75;
    assert.ok(Math.abs(rollup.weights[key] - expected) <= Number.EPSILON);
  }
  assert.equal(calculateBalanceWeightedAllocation([]), null);
});
