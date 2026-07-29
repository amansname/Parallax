import { test } from 'node:test';
import assert from 'node:assert';
import { scheduleDClassification, meta, WORKSHEET_TYPES } from './scheduleDClassification.js';
import { TaxInputError } from '../../core/errors.js';

const ctx = (taxYear = 2025) => ({
  calculatedAt: '2026-07-10T12:00:00.000Z',
  runId: 'sched_d_test',
  scenarioId: 'sched_d_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
});

test('meta contract', () => {
  assert.strictEqual(meta.ruleId, 'FED_SCHEDULE_D_CLASSIFICATION');
  assert.ok(meta.triggerTags.includes('capital_gains'));
  assert.deepStrictEqual(meta.supportedTaxYears, [2025, 2026]);
  assert.ok(meta.dataSourcesRequired.includes('IRS_2025_SCHEDULE_D_v1.0'));
  assert.ok(meta.dataSourcesRequired.includes(
    'IRC_SIMPLE_SCHEDULE_D_2026_v1.0'
  ));
});

test('annual-08 loss case: line 7 capped at $3,000 and no preferential Schedule D gain', () => {
  const { result } = scheduleDClassification.calculate({
    filingStatus: 'marriedFilingJointly',
    line7: -7668,
    line15: 12,
    line16: -7656,
    line18: 0,
    line19: 0,
  }, ctx());

  assert.strictEqual(result.form1040Line7, -3000);
  assert.strictEqual(result.preferentialScheduleDGain, 0);
  assert.strictEqual(result.netLongTermCapitalGains, 0);
  assert.strictEqual(result.worksheetType, WORKSHEET_TYPES.QUALIFIED_DIVIDENDS_AND_CAPITAL_GAIN);
  assert.deepStrictEqual(result.capitalLossCarryforward, {
    status: 'WORKSHEET_REQUIRED',
    exactAmount: null,
    minimumAmount: 4656,
    reasonCode: 'CAPITAL_LOSS_CARRYFORWARD_WORKSHEET_REQUIRED',
  });
});

test('short-term gain only: line 7 increases income but receives no preferential rate', () => {
  const { result } = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: 5000,
    line15: 0,
    line16: 5000,
    line18: 0,
    line19: 0,
  }, ctx());

  assert.strictEqual(result.form1040Line7, 5000);
  assert.strictEqual(result.preferentialScheduleDGain, 0);
});

test('long-term gain partially offset by short-term loss', () => {
  const { result } = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: -5000,
    line15: 3000,
    line16: -2000,
    line18: 0,
    line19: 0,
  }, ctx());

  assert.strictEqual(result.form1040Line7, -2000);
  assert.strictEqual(result.preferentialScheduleDGain, 0);
});

test('capital-loss limitation uses $1,500 for married filing separately', () => {
  const { result } = scheduleDClassification.calculate({
    filingStatus: 'marriedFilingSeparately',
    line7: -4000,
    line15: 0,
    line16: -4000,
    line18: 0,
    line19: 0,
  }, ctx());

  assert.strictEqual(result.form1040Line7, -1500);
  assert.strictEqual(result.capitalLossLimitApplied, 1500);
});

test('both Schedule D lines 15 and 16 positive use the smaller preferential amount', () => {
  const { result } = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: 1000,
    line15: 800,
    line16: 1800,
    line18: 0,
    line19: 0,
  }, ctx());

  assert.strictEqual(result.form1040Line7, 1800);
  assert.strictEqual(result.preferentialScheduleDGain, 800);
});

test('inconsistent Schedule D line 16 is rejected', () => {
  assert.throws(
    () => scheduleDClassification.calculate({
      filingStatus: 'single',
      line7: 1000,
      line15: 500,
      line16: 1200,
      line18: 0,
      line19: 0,
    }, ctx()),
    TaxInputError
  );
});

test('positive Schedule D lines 18 or 19 require the Schedule D Tax Worksheet', () => {
  assert.throws(
    () => scheduleDClassification.calculate({
      filingStatus: 'single',
      line7: 1000,
      line15: 1000,
      line16: 2000,
      line18: 100,
      line19: 0,
    }, ctx()),
    /Schedule D Tax Worksheet/
  );
  assert.throws(
    () => scheduleDClassification.calculate({
      filingStatus: 'single',
      line7: 1000,
      line15: 1000,
      line16: 2000,
      line18: 0,
      line19: 50,
    }, ctx()),
    /Schedule D Tax Worksheet/
  );
});

test('audit is serializable', () => {
  const { audit } = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: -1000,
    line15: 0,
    line16: -1000,
    line18: 0,
    line19: 0,
  }, ctx());
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.deepStrictEqual(audit.dataSourcesUsed, ['IRS_2025_SCHEDULE_D_v1.0']);
});

test('2026 simple path carries a year-matched statutory source receipt', () => {
  const { audit } = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: 0,
    line15: 5000,
    line16: 5000,
    line18: 0,
    line19: 0,
  }, ctx(2026));
  assert.deepStrictEqual(
    audit.dataSourcesUsed,
    ['IRC_SIMPLE_SCHEDULE_D_2026_v1.0']
  );
  assert.deepStrictEqual(
    audit.authority,
    ['IRC sections 1211(b), 1212(b), and 1222']
  );
});

test('Form 4952 line 4g requires the Schedule D Tax Worksheet', () => {
  assert.throws(
    () => scheduleDClassification.calculate({
      filingStatus: 'single',
      line7: 0,
      line15: 5000,
      line16: 5000,
      line18: 0,
      line19: 0,
      form4952Line4g: 1,
    }, ctx()),
    /Schedule D Tax Worksheet/
  );
});

test('every net loss keeps carryforward worksheet readiness, even below the annual cap', () => {
  const belowCap = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: 0,
    line15: -1000,
    line16: -1000,
    line18: 0,
    line19: 0,
    form4952Line4g: 0,
  }, ctx()).result;
  assert.deepStrictEqual(belowCap.capitalLossCarryforward, {
    status: 'WORKSHEET_REQUIRED',
    exactAmount: null,
    minimumAmount: 0,
    reasonCode: 'CAPITAL_LOSS_CARRYFORWARD_WORKSHEET_REQUIRED',
  });

  const gain = scheduleDClassification.calculate({
    filingStatus: 'single',
    line7: 0,
    line15: 1000,
    line16: 1000,
    line18: 0,
    line19: 0,
    form4952Line4g: 0,
  }, ctx()).result;
  assert.deepStrictEqual(gain.capitalLossCarryforward, {
    status: 'NONE',
    exactAmount: 0,
    minimumAmount: 0,
  });
});

test('manual net long-term input preserves signed treatment without synthetic Schedule D facts', () => {
  for(const [amount, line7, preferential] of [
    [-5000, -3000, 0],
    [0, 0, 0],
    [5000, 5000, 5000],
  ]){
    const { result, audit } = scheduleDClassification.calculateManualNetLongTerm({
      filingStatus: 'single',
      netLongTermGainOrLoss: amount,
    }, ctx());
    assert.strictEqual(result.form1040Line7, line7);
    assert.strictEqual(result.preferentialScheduleDGain, preferential);
    assert.strictEqual(result.scheduleDLine16, amount);
    assert.deepStrictEqual(audit.inputsUsed, {
      inputMode: 'MANUAL_NET_LONG_TERM',
      filingStatus: 'single',
      netLongTermGainOrLoss: amount,
    });
    assert.deepStrictEqual(audit.dataSourcesUsed, ['IRS_2025_SCHEDULE_D_v1.0']);
    assert.strictEqual(Object.hasOwn(audit.inputsUsed, 'line7'), false);
    assert.strictEqual(Object.hasOwn(audit.inputsUsed, 'confirmations'), false);
  }
});

test('manual net long-term loss uses the filing-status cap and honest carryforward readiness', () => {
  const { result } = scheduleDClassification.calculateManualNetLongTerm({
    filingStatus: 'marriedFilingSeparately',
    netLongTermGainOrLoss: -4000,
  }, ctx(2026));
  assert.strictEqual(result.form1040Line7, -1500);
  assert.strictEqual(result.capitalLossLimitApplied, 1500);
  assert.deepStrictEqual(result.capitalLossCarryforward, {
    status: 'WORKSHEET_REQUIRED',
    exactAmount: null,
    minimumAmount: 2500,
    reasonCode: 'CAPITAL_LOSS_CARRYFORWARD_WORKSHEET_REQUIRED',
  });
});

test('manual net long-term input rejects missing, non-finite, and competing facts', () => {
  for(const invalid of [undefined, null, '5000', Number.NaN, Infinity]){
    assert.throws(
      () => scheduleDClassification.calculateManualNetLongTerm({
        filingStatus: 'single',
        netLongTermGainOrLoss: invalid,
      }, ctx()),
      TaxInputError
    );
  }
  assert.throws(
    () => scheduleDClassification.calculateManualNetLongTerm({
      filingStatus: 'single',
      netLongTermGainOrLoss: 5000,
      line15: 5000,
    }, ctx()),
    /unsupported fields/
  );
});
