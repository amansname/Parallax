import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan } from '../../../engine.js';
import { buildDefaultTaxContext } from '../../tax/annual1040.js';
import { CAPITAL_GAINS_THRESHOLDS } from '../../tax/core/constants.js';
import { capitalGainsStacking } from '../../tax/federal/rules/capitalGainsStacking.js';
import { evaluateProjectedYearFacts } from './taxEngineAdapter.js';
import { buildThresholdColumns } from '../../../ui/taxAwareWithdrawalColumns.js';

test('next-dollar cue agrees with the actual tax on an additional $1,000 gain when existing gains are zero', async () => {
  const plan = structuredClone(defaultPlan);
  plan.meta.filingStatus = 'single';
  plan.household.spouse = null;
  plan.household.primary.age = 60;
  plan.portfolio.accounts.taxable.balance = 200_000;
  const facts = {
    filingStatus: 'single', livedWithSpouse: false,
    wages: 100_000, otherIncome: 0, socialSecurityBenefits: 0,
  };
  const evaluate = realizedGain => evaluateProjectedYearFacts({
    plan, taxYear: 2026, facts,
    levers: { realizedGain, deferredWithdrawal: 0, rothConversion: 0, rothWithdrawal: 0, qcd: 0 },
  });
  const before = await evaluate(0);
  const after = await evaluate(1_000);
  assert.equal(before.error, undefined);
  assert.equal(after.error, undefined);
  assert.equal(after.modeledFederalIncomeTax.selected - before.modeledFederalIncomeTax.selected, 150);
  const columns = buildThresholdColumns({ result: before, hoverMark: null });
  assert.deepEqual(columns.map(column => column.name), [
    'Income Tax', 'Long-term gains', 'Medicare IRMAA', 'Social Security',
  ]);
  assert.equal(columns[1].footLabel, 'Next $ at 15%');
  assert.equal(before.ltcg.rate, 0.15);
  // Review regression: the added gain also makes $0.85 more Social Security
  // taxable, crossing the $49,450 zero-rate boundary from $49,449.98.
  facts.wages = 41_729.72;
  facts.socialSecurityBenefits = 30_000;
  const boundary = await evaluate(0);
  const nextDollar = await evaluate(1);
  assert.equal(boundary.totals.taxableIncome, 49_449.98);
  assert.equal(nextDollar.totals.taxableIncome, 49_451.83);
  assert.equal(Math.round((nextDollar.modeledFederalIncomeTax.selected
    - boundary.modeledFederalIncomeTax.selected) * 100), 25);
  assert.equal(boundary.ltcg.rate, 0.15);
  assert.equal(buildThresholdColumns({ result: boundary, hoverMark: null })[1].footLabel,
    'Next $ at 15%');
  facts.wages -= 1;
  assert.equal((await evaluate(0)).ltcg.rate, 0,
    'Schedule D gain must enter the Social Security worksheet only once');
});

test('unknown next-dollar rate is not replaced with the zero-band rate', () => {
  const columns = buildThresholdColumns({
    result: { ltcg: { rate: null }, ladders: { ltcg: { rates: { zero: 0 } } } },
    hoverMark: null,
  });
  assert.equal(columns[1].footLabel, '—');
});

test('next preferential rate uses the open bracket at both boundaries for each supported tax year and filing status', () => {
  for (const [lawVersion, filings] of Object.entries(CAPITAL_GAINS_THRESHOLDS)) {
    const context = buildDefaultTaxContext({ taxYear: Number(lawVersion.slice(0, 4)) });
    for (const [filingStatus, thresholds] of Object.entries(filings)) {
      for (const [stack, expected] of [
        [0, 0], [thresholds.zeroRateMax - 1, 0],
        [thresholds.zeroRateMax, 0.15], [thresholds.zeroRateMax + 1, 0.15],
        [thresholds.fifteenRateMax - 1, 0.15],
        [thresholds.fifteenRateMax, 0.20], [thresholds.fifteenRateMax + 1, 0.20],
      ]) {
        // The same stack must give the same cue with no gains, gains, or qualified dividends.
        for (const preferred of [0, Math.min(stack, 1_000)]) {
          const { result } = capitalGainsStacking.calculate({
            filingStatus, ordinaryTaxableIncome: stack - preferred,
            netLongTermCapitalGains: preferred / 2, qualifiedDividends: preferred / 2,
          }, context);
          assert.equal(result.nextDollarPreferentialRate, expected,
            `${lawVersion} ${filingStatus}, stack ${stack}, preferred ${preferred}`);
        }
      }
    }
  }
});

test('at an exact boundary, last taxed dollar and next dollar remain distinct', () => {
  const { result } = capitalGainsStacking.calculate({
    filingStatus: 'single', ordinaryTaxableIncome: 48_450,
    netLongTermCapitalGains: 1_000, qualifiedDividends: 0,
  }, buildDefaultTaxContext({ taxYear: 2026 }));
  assert.equal(result.preferentialIncomeTax, 0);
  assert.equal(result.marginalPreferentialRate, 0);
  assert.equal(result.nextDollarPreferentialRate, 0.15);
});
