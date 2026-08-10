import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThresholdColumns, formatWithdrawalMoney } from './taxAwareWithdrawalColumns.js';
import {
  applyAttribution,
  applyThresholdColumns,
  updateSliderCaps,
} from './taxAwareWithdrawalDom.js';

function sliderRefs(keys) {
  return {
    sliders: Object.fromEntries(keys.map(key => {
      return [key, {
        input: {
          max: '', min: '', disabled: false,
          attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          removeAttribute(name) { delete this.attributes[name]; },
        },
        issue: { textContent: '', hidden: true },
      }];
    })),
  };
}

test('formatWithdrawalMoney renders dash for non-finite values', () => {
  assert.equal(formatWithdrawalMoney(null), '—');
  assert.equal(formatWithdrawalMoney(12000), '$12,000');
});

test('threshold headlines and bar labels use the tax-engine contract', () => {
  const cols = buildThresholdColumns({
    result: {
      ordinary: { rate: 0.22, income: 100000, roomToNext: 5000, ceiling: 105000 },
      ltcg: { rate: 0.15, stackedOn: 100000, gains: 10000, roomToZeroCeiling: 2000 },
      socialSecurity: { taxablePct: 0.85, provisionalIncome: 80000, roomToNext: 1000 },
      baseline: { ordinaryIncome: 80000, provisionalIncome: 60000 },
      thresholdTaxDollars: {
        ordinaryIncomeTax: 1234.25,
        preferentialIncomeTax: 2345.50,
        irmaaPremium: null,
        socialSecurityIncrementalModeledFederalIncomeTax: 3456.75,
      },
      ladders: {
        ordinary: [{ rate: 0.1, upTo: 10000 }, { rate: 0.22, upTo: 100000 }],
        ltcg: {
          zeroRateMax: 90000,
          fifteenRateMax: 500000,
          rates: { zero: 0, middle: 0.17, top: 0.23 },
        },
        socialSecurity: {
          tier1: 32000,
          tier2: 44000,
          rates: { lowerTier: 0.51, upperTier: 0.86 },
        },
      },
    },
    hoverMark: null,
  });
  assert.equal(cols.length, 4);
  assert.equal(cols[0].name, 'Income Tax');
  assert.equal(cols[0].current, '$1,234');
  assert.equal(cols[0].footLabel, '22%');
  assert.equal(cols[1].footLabel, 'Next $ at 15%');
  assert.ok(cols[0].marks.length >= 1);
  assert.deepEqual(cols.map(col => col.value), ['$1,234', '$2,346', '—', '$3,457']);
  assert.deepEqual(cols[1].marks.map(mark => mark.label), ['17%', '23%']);
  assert.deepEqual(cols[3].marks.map(mark => mark.label), ['51%', '86%']);

  const refs = {
    columns: Object.fromEntries(cols.map(col => [col.id, {
      rate: { textContent: '', style: {} },
      footLabel: { textContent: '' },
      footVal: { textContent: '' },
      base: { style: {} },
      fill: { style: {} },
      gap: { style: {} },
      edge: { style: {} },
      edgeVal: { textContent: '' },
      marks: [],
    }])),
  };
  applyThresholdColumns(refs, cols);
  assert.equal(refs.columns.ord.rate.textContent, '$1,234');
  assert.equal(refs.columns.ord.edgeVal.textContent, '$1,234');
  assert.equal(refs.columns.ltcg.edgeVal.textContent, '$2,346');
  assert.equal(refs.columns.irmaa.edgeVal.textContent, '—');
  assert.equal(refs.columns.ss.edgeVal.textContent, '$3,457');
});

test('slider caps use the smaller of engine-approved limits and the $500,000 display ceiling', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'taxableWithdrawal',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { max: 70_000 },
      rothWithdrawal: { max: 750_000 },
      qcd: { max: 10_000 },
      deferredWithdrawal: { max: 40_000 },
      taxableWithdrawal: { max: 1_200_000 },
    },
  });
  assert.strictEqual(refs.sliders.rothConversion.input.max, '70000');
  assert.strictEqual(refs.sliders.qcd.input.max, '10000');
  assert.strictEqual(refs.sliders.deferredWithdrawal.input.max, '40000');
  assert.strictEqual(refs.sliders.rothWithdrawal.input.max, '500000');
  assert.strictEqual(refs.sliders.taxableWithdrawal.input.max, '500000');
  assert.strictEqual(refs.sliders.taxableWithdrawal.input.disabled, false);
});

test('zero engine-approved limit disables its slider', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'taxableWithdrawal',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: Object.fromEntries(keys.map(key => [key, { min: 0, max: 0 }])),
  });
  assert.ok(keys.every(key => refs.sliders[key].input.disabled === true));
});

test('missing Brokerage basis keeps the control enabled at the engine-approved display cap', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'taxableWithdrawal',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { min: 0, max: 0 },
      rothWithdrawal: { min: 0, max: 0 },
      qcd: { min: 0, max: 0 },
      deferredWithdrawal: { min: 0, max: 0 },
      taxableWithdrawal: { min: 0, max: 670_000 },
    },
    taxableBasis: {
      assumption: {
        code: 'WITHDRAWAL_PLANNER_TAXABLE_50_50_ASSUMPTION',
        principalFraction: 0.5,
        gainFraction: 0.5,
      },
    },
  });

  const slot = refs.sliders.taxableWithdrawal;
  assert.equal(slot.input.max, '500000');
  assert.equal(slot.input.disabled, false);
  assert.equal(slot.issue.hidden, true);
  assert.equal(slot.issue.textContent, '');
  assert.equal(slot.input.attributes['aria-describedby'], undefined);
});

test('confirmed Brokerage loss disables its slider and renders the required unavailable reason', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'taxableWithdrawal',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { min: 0, max: 0 },
      rothWithdrawal: { min: 0, max: 0 },
      qcd: { min: 0, max: 0 },
      deferredWithdrawal: { min: 0, max: 0 },
      taxableWithdrawal: {
        min: 0,
        max: null,
        available: false,
        reason: 'TAXABLE_LOSS_TREATMENT_PENDING',
      },
    },
  });

  const slot = refs.sliders.taxableWithdrawal;
  assert.equal(slot.input.disabled, true);
  assert.equal(slot.issue.hidden, false);
  assert.equal(
    slot.issue.textContent,
    'Brokerage withdrawals are unavailable because confirmed losses are not modeled yet.',
  );
  assert.equal(slot.input.attributes['aria-describedby'], 'taw-taxableWithdrawal-issue');
});

test('unavailable attribution clears prior sleeve values', () => {
  const refs = {
    taxCaused: {
      roth: { textContent: '$1' },
      traditional: { textContent: '$2' },
      taxable: { textContent: '$3' },
    },
    attNote: { textContent: 'prior' },
  };
  applyAttribution(refs, null, null);
  assert.strictEqual(refs.taxCaused.roth.textContent, '\u2014');
  assert.strictEqual(refs.taxCaused.traditional.textContent, '\u2014');
  assert.strictEqual(refs.taxCaused.taxable.textContent, '\u2014');
  assert.strictEqual(refs.attNote.textContent, '');
});

test('coded engine failures render unavailable threshold columns', () => {
  const cols = buildThresholdColumns({
    result: { code: 'WITHDRAWAL_ACCOUNT_LIMIT_EXCEEDED' },
    hoverMark: null,
  });
  assert.equal(cols.length, 4);
  assert.ok(cols.every(col => col.current === '\u2014'));
  assert.ok(cols.every(col => col.value === '\u2014'));
});
