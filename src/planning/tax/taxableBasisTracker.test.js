import { test } from 'node:test';
import assert from 'node:assert';
import { defaultPlan, runHistoricalPath, resolveInputs } from '../../../engine.js';
import {
  capitalGainFromRow,
  gainFractionFromRow,
  buildRowTaxableGainPlanMeta,
} from './taxableBasisTracker.js';
import { buildPlanMetaFromEngineParams } from './buildPlanMetaFromEngineParams.js';
import { attachTypicalPathFederalTax } from './attachTypicalPathFederalTax.js';
import { mapSimulationRowToYearFacts } from '../../tax/adapters/engineYearTo1040Input.js';

function impliedGainFraction(row, capGainsRate){
  const withdrawal = row.accountBreakdown?.taxable ?? 0;
  const tax = row.taxBySource?.taxable ?? 0;
  if(!(withdrawal > 0) || !(capGainsRate > 0)) return undefined;
  return tax / (withdrawal * capGainsRate);
}

test('engine rows expose taxableGainFraction matching taxBySource implied gain', () => {
  const plan = JSON.parse(JSON.stringify(defaultPlan));
  const params = resolveInputs(plan, {});
  const path = runHistoricalPath(plan, 1995, 'taxable-first');
  const capGains = params.taxRates.capitalGains;

  const taxableRows = path.rows.filter(
    (row) => (row.accountBreakdown?.taxable ?? 0) > 0 && row.source != null
  );
  assert.ok(taxableRows.length > 0, 'expected taxable withdrawals on historical path');

  for(const row of taxableRows){
    assert.strictEqual(typeof row.taxableGainFraction, 'number');
    const implied = impliedGainFraction(row, capGains);
    assert.ok(
      Math.abs(row.taxableGainFraction - implied) < 1e-9,
      `year ${row.year} age ${row.age}: row fact ${row.taxableGainFraction} vs implied ${implied}`
    );
  }
});

test('RMD-funded taxable uses zero gain fraction on the following withdrawal year', () => {
  const plan = JSON.parse(JSON.stringify(defaultPlan));
  plan.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  plan.portfolio.accounts.taxable = { balance: 0, basisPct: 1 };
  plan.portfolio.accounts.traditional.balance = 10000000;
  plan.portfolio.accounts.roth.balance = 0;

  const params = resolveInputs(plan, {});
  const path = runHistoricalPath(plan, 1995, 'taxable-first');
  const capGains = params.taxRates.capitalGains;

  const rmdRows = path.rows.filter((row) => row.age >= 73 && (row.rmd ?? 0) > 0);
  assert.ok(rmdRows.length > 0, 'expected RMD rows');

  const firstRmd = rmdRows[0];
  assert.strictEqual(firstRmd.taxableGainFraction, undefined,
    'RMD year should not pair a taxable withdrawal with pre-RMD zero balance');

  const afterRmd = path.rows.find(
    (row) => row.year > firstRmd.year
      && (row.accountBreakdown?.taxable ?? 0) > 0
      && row.taxableGainFraction !== undefined
  );
  assert.ok(afterRmd, 'expected a later taxable withdrawal after RMD funding');
  assert.strictEqual(afterRmd.taxableGainFraction, 0);

  const implied = impliedGainFraction(afterRmd, capGains);
  assert.strictEqual(implied, 0);
});

test('buildPlanMetaFromEngineParams keeps explicit taxableGainFraction override only', () => {
  const planMeta = buildPlanMetaFromEngineParams({
    accounts: { taxable: { balance: 1000000, basis: 600000 } },
  }, { filingStatus: 'marriedFilingJointly', taxableGainFraction: 0.25 });

  assert.strictEqual(planMeta.taxableGainFraction, 0.25);

  const derived = buildPlanMetaFromEngineParams({
    accounts: { taxable: { balance: 1000000, basis: 600000 } },
  }, { filingStatus: 'marriedFilingJointly' });

  assert.strictEqual(derived.taxableGainFraction, undefined);
});

test('buildRowTaxableGainPlanMeta passes engine row taxableGainFraction into planMeta', () => {
  const row = {
    year: 6,
    taxableGainFraction: 0.35,
    accountBreakdown: { taxable: 20000, traditional: 0, roth: 0 },
  };
  const rowPlanMeta = buildRowTaxableGainPlanMeta();

  assert.strictEqual(gainFractionFromRow(row), 0.35);
  assert.strictEqual(rowPlanMeta(row, 0).taxableGainFraction, 0.35);
  assert.strictEqual(rowPlanMeta({ year: 1, accountBreakdown: { taxable: 0 } }, 1), null);
});

test('exact taxable capital gain takes precedence over the legacy fraction', () => {
  const row = {
    taxableCapitalGain: 12345.67,
    taxableGainFraction: 0.9,
    accountBreakdown: { taxable: 20000, traditional: 0, roth: 0 },
  };
  assert.equal(capitalGainFromRow(row), 12345.67);
  assert.deepEqual(buildRowTaxableGainPlanMeta()(row, 0), {
    capitalGain: 12345.67,
  });
});

test('attachTypicalPathFederalTax completes when taxable starts empty and RMD funds it', () => {
  const plan = JSON.parse(JSON.stringify(defaultPlan));
  plan.household.primary = { currentAge: 58, retirementAge: 65, planEndAge: 95 };
  plan.portfolio.accounts.taxable = { balance: 0, basisPct: 1 };
  plan.portfolio.accounts.traditional.balance = 10000000;
  plan.portfolio.accounts.roth.balance = 0;
  plan.meta = { filingStatus: 'marriedFilingJointly' };

  const path = runHistoricalPath(plan, 1995, 'taxable-first');
  const analysis = {
    params: resolveInputs(plan, {}),
    paths: { p50: path },
  };

  const summary = attachTypicalPathFederalTax(analysis, {
    baseTaxYear: 2025,
    filingStatus: 'marriedFilingJointly',
  });

  assert.ok(summary.years.length > 0);
  assert.ok(path.rows.some((row) => row.age >= 73 && row.accountBalances.taxable > 1));
});

test('mapSimulationRowToYearFacts accepts zero gain fraction without throwing', () => {
  const facts = mapSimulationRowToYearFacts(
    { accountBreakdown: { taxable: 50000, traditional: 0, roth: 0 } },
    { filingStatus: 'single', taxableGainFraction: 0 }
  );
  assert.deepStrictEqual(facts.scheduleD, {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 0,
  });
});
