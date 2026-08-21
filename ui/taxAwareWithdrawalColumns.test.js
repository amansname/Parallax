import test from 'node:test';
import assert from 'node:assert/strict';

import { buildThresholdColumns, formatWithdrawalMoney } from './taxAwareWithdrawalColumns.js';
import {
  applyAttribution,
  applyThresholdColumns,
  mountWithdrawalPlannerShell,
  updateSliderCaps,
} from './taxAwareWithdrawalDom.js';

function sliderRefs(keys) {
  return {
    sliders: Object.fromEntries(keys.map(key => {
      return [key, {
        input: {
          max: '', min: '', disabled: false,
        },
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

test('IRMAA column renders annual premium, baseline delta, room, and premium year', () => {
  const cols = buildThresholdColumns({
    result: {
      irmaa: {
        magi: 109001,
        baselineMagi: 109000,
        tier: 1,
        nextTier: 2,
        roomToNext: 27999,
        premiumYear: 2028,
        incrementalAnnualHouseholdAdjustment: 1148.40,
      },
      thresholdTaxDollars: { irmaaPremium: 1148.40 },
      ladders: {
        irmaa: [
          { tier: 0, upTo: 109000 },
          { tier: 1, upTo: 137000 },
          { tier: 2, upTo: 171000 },
          { tier: 3, upTo: 205000 },
          { tier: 4, upTo: 500000 },
          { tier: 5, upTo: null },
        ],
      },
    },
    hoverMark: null,
  });
  const irmaa = cols.find(column => column.id === 'irmaa');
  assert.equal(irmaa.current, '$1,148');
  assert.equal(irmaa.value, '$1,148');
  assert.equal(irmaa.footLabel, '$1,148 vs baseline');
  assert.equal(irmaa.foot, '$27,999 to next · 2028');
  assert.deepEqual(
    irmaa.marks.slice(0, 2).map(mark => mark.label),
    ['Tier 1', 'Tier 2'],
  );
});

test('slider caps use the smaller of engine-approved limits and the $500,000 display ceiling', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'realizedGain',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { max: 70_000 },
      rothWithdrawal: { max: 750_000 },
      qcd: { max: 10_000 },
      deferredWithdrawal: { max: 40_000 },
      realizedGain: { max: 1_200_000 },
    },
  });
  assert.strictEqual(refs.sliders.rothConversion.input.max, '70000');
  assert.strictEqual(refs.sliders.qcd.input.max, '10000');
  assert.strictEqual(refs.sliders.deferredWithdrawal.input.max, '40000');
  assert.strictEqual(refs.sliders.rothWithdrawal.input.max, '500000');
  assert.strictEqual(refs.sliders.realizedGain.input.max, '500000');
  assert.strictEqual(refs.sliders.realizedGain.input.disabled, false);
});

test('zero engine-approved limit disables its slider', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'realizedGain',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: Object.fromEntries(keys.map(key => [key, { min: 0, max: 0 }])),
  });
  assert.ok(keys.every(key => refs.sliders[key].input.disabled === true));
});

test('Realized Gain uses the taxable-balance limit supplied by the account contract', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'realizedGain',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { min: 0, max: 0 },
      rothWithdrawal: { min: 0, max: 0 },
      qcd: { min: 0, max: 0 },
      deferredWithdrawal: { min: 0, max: 0 },
      realizedGain: { min: 0, max: 200_000 },
    },
  });

  const slot = refs.sliders.realizedGain;
  assert.equal(slot.input.max, '200000');
  assert.equal(slot.input.disabled, false);
});

test('Realized Gain availability does not require Brokerage basis metadata', () => {
  const keys = [
    'rothConversion', 'rothWithdrawal', 'qcd',
    'deferredWithdrawal', 'realizedGain',
  ];
  const refs = sliderRefs(keys);
  updateSliderCaps(refs, {
    limits: {
      rothConversion: { min: 0, max: 0 },
      rothWithdrawal: { min: 0, max: 0 },
      qcd: { min: 0, max: 0 },
      deferredWithdrawal: { min: 0, max: 0 },
      realizedGain: {
        min: 0,
        max: 670_000,
      },
    },
  });

  const slot = refs.sliders.realizedGain;
  assert.equal(slot.input.max, '500000');
  assert.equal(slot.input.disabled, false);
});

test('Withdrawal Planner shell labels the control Realized gain with no Brokerage-basis copy', () => {
  const emptyColumn = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const root = {
    innerHTML: '',
    querySelector: selector => selector.startsWith('[data-taw-col=') ? emptyColumn : null,
    querySelectorAll: () => [],
  };
  mountWithdrawalPlannerShell(root, {
    caps: {
      limits: {
        rothConversion: { max: 500_000 },
        rothWithdrawal: { max: 400_000 },
        qcd: { max: 500_000 },
        deferredWithdrawal: { max: 500_000 },
        realizedGain: { max: 500_000 },
      },
    },
  });

  assert.match(root.innerHTML, />Realized gain</);
  assert.doesNotMatch(root.innerHTML, /taw-page-head|Current federal baseline/);
  assert.doesNotMatch(root.innerHTML, />Brokerage account</);
  assert.doesNotMatch(root.innerHTML, /taw-slider-issue/);
  assert.doesNotMatch(root.innerHTML, /confirmed losses are not modeled/i);
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
