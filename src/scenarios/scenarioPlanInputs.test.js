import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHouseholdTimeline } from '../../engine.js';
import { resolvePortfolioAccounts } from '../household/resolvePortfolioAccounts.js';
import {
  resolveCashOnlyAllocation,
  snapshotPresetAllocation,
} from '../household/investmentAllocation.js';
import {
  SCENARIO_ALLOCATION_OPTIONS,
  applyScenarioPlanInputs,
  resolveCurrentScenarioAllocation,
} from './scenarioPlanInputs.js';
import { withoutRemovedScenarioLevers } from './scenarioLevers.js';

function account(id, typeId, balance, investmentAllocation){
  return { id, typeId, balance, investmentAllocation };
}

function couplePlan(){
  return {
    meta: { planningAsOfYear: 2026 },
    household: {
      primary: { currentAge: 60, retirementAge: 65, planEndAge: 95 },
      spouse: { currentAge: 58, retirementAge: 64, planEndAge: 97 },
    },
    income: {
      socialSecurity: {
        primary: { pia: 30_000, claimAge: 67 },
        spouse: { pia: 24_000, claimAge: 66 },
      },
    },
    portfolio: {
      riskProfile: 3,
      accounts: {
        taxable: account('base-taxable', null, 200_000, snapshotPresetAllocation('balanced')),
        traditional: account('base-traditional', null, 400_000, snapshotPresetAllocation('balanced')),
        roth: account('base-roth', null, 100_000, snapshotPresetAllocation('balanced')),
      },
      extraAccounts: [
        account('client-ira', 'traditional_ira', 75_000, snapshotPresetAllocation('balanced')),
        account('cash', 'checking', 25_000, resolveCashOnlyAllocation()),
      ],
    },
  };
}

test('Scenario allocation choices use the canonical asset-class model labels', () => {
  assert.deepEqual(SCENARIO_ALLOCATION_OPTIONS.map(option => option.label), [
    'Current mix',
    'Defensive',
    'Conservative',
    'Balanced',
    'Growth',
    'Aggressive',
    'All Equity',
  ]);
});

test('removed Scenarios decisions are stripped without mutating retained levers', () => {
  const saved = {
    retireAge: 68,
    spouseRetireAge: 66,
    allocationPresetId: 'balanced',
    sellAge: 72,
    goalOv: { 0: { amount: 150_000 } },
  };

  const clean = withoutRemovedScenarioLevers(saved);

  assert.deepEqual(clean, {
    retireAge: 68,
    spouseRetireAge: 66,
    allocationPresetId: 'balanced',
    goalOv: { 0: { amount: 150_000 } },
  });
  assert.equal(saved.sellAge, 72);
  assert.deepEqual(withoutRemovedScenarioLevers(null), {});
  assert.deepEqual(withoutRemovedScenarioLevers([]), {});
});

test('Scenario allocation selection reports one shared preset and preserves a mixed current plan', () => {
  const plan = couplePlan();
  assert.equal(resolveCurrentScenarioAllocation(plan), 'balanced');

  plan.portfolio.extraAccounts[0].investmentAllocation = snapshotPresetAllocation('growth');
  assert.equal(resolveCurrentScenarioAllocation(plan), 'current');

  plan.portfolio.extraAccounts[0].balance = 0;
  assert.equal(resolveCurrentScenarioAllocation(plan), 'current');

  plan.portfolio.extraAccounts[0].investmentAllocation = undefined;
  assert.equal(resolveCurrentScenarioAllocation(plan), 'current');
});

test('zero-balance legacy scaffolds do not hide the funded current allocation', () => {
  const plan = couplePlan();
  for(const accountRecord of Object.values(plan.portfolio.accounts)){
    accountRecord.balance = 0;
    accountRecord.investmentAllocation = snapshotPresetAllocation('balanced');
  }
  plan.portfolio.extraAccounts[0].investmentAllocation = snapshotPresetAllocation('defensive');
  plan.portfolio.extraAccounts[1].balance = 0;

  assert.equal(resolveCurrentScenarioAllocation(plan), 'defensive');
});

test('Scenario inputs wire each person independently and apply the selected model to investable accounts', () => {
  const plan = couplePlan();
  const scenario = applyScenarioPlanInputs(plan, {
    retireAge: 68,
    spouseRetireAge: 63,
    ssAge: 70,
    spouseSsAge: 62,
    allocationPresetId: 'aggressive',
  });

  assert.equal(plan.household.primary.retirementAge, 65);
  assert.equal(plan.household.spouse.retirementAge, 64);
  assert.equal(plan.income.socialSecurity.primary.claimAge, 67);
  assert.equal(plan.income.socialSecurity.spouse.claimAge, 66);

  const timeline = resolveHouseholdTimeline(scenario);
  assert.equal(timeline.people.client.retirementAge, 68);
  assert.equal(timeline.people.spouse.retirementAge, 63);
  assert.equal(timeline.people.client.socialSecurityClaimAge, 70);
  assert.equal(timeline.people.spouse.socialSecurityClaimAge, 62);

  const aggressive = snapshotPresetAllocation('aggressive');
  const projectionAccounts = new Map(
    resolvePortfolioAccounts(scenario).accounts.map(accountRecord => [accountRecord.id, accountRecord]),
  );
  assert.deepEqual(projectionAccounts.get('base-taxable').investmentAllocation, aggressive);
  assert.deepEqual(projectionAccounts.get('base-traditional').investmentAllocation, aggressive);
  assert.deepEqual(projectionAccounts.get('base-roth').investmentAllocation, aggressive);
  assert.deepEqual(projectionAccounts.get('client-ira').investmentAllocation, aggressive);
  assert.deepEqual(
    scenario.portfolio.accounts.taxable.investmentAllocation,
    snapshotPresetAllocation('balanced'),
    'scenario execution must not rewrite saved account provenance',
  );
  assert.deepEqual(scenario.portfolio.extraAccounts[1].investmentAllocation, resolveCashOnlyAllocation());
  assert.equal(scenario.portfolio.riskProfile, 5);
});

test('Current mix leaves every saved account allocation byte-stable in the scenario clone', () => {
  const plan = couplePlan();
  plan.portfolio.extraAccounts[0].investmentAllocation = snapshotPresetAllocation('growth');
  const before = JSON.stringify(plan.portfolio);

  const scenario = applyScenarioPlanInputs(plan, {
    retireAge: 65,
    spouseRetireAge: 64,
    ssAge: 67,
    spouseSsAge: 66,
    allocationPresetId: 'current',
  });

  assert.equal(JSON.stringify(scenario.portfolio), before);
});

test('Current mix preserves the legacy numeric scenario lever for old account schemas', () => {
  const plan = couplePlan();
  const scenario = applyScenarioPlanInputs(plan, {
    retireAge: 65,
    spouseRetireAge: 64,
    ssAge: 67,
    spouseSsAge: 66,
    allocationPresetId: 'current',
    risk: 4,
  });

  assert.equal(scenario.portfolio.riskProfile, 4);
});

test('current account schemas do not route scenarios through the legacy numeric risk profile', () => {
  const plan = couplePlan();
  plan.meta.accountSchemaVersion = 2;
  const scenario = applyScenarioPlanInputs(plan, {
    retireAge: 65,
    spouseRetireAge: 64,
    ssAge: 67,
    spouseSsAge: 66,
    allocationPresetId: 'current',
    risk: 6,
  });

  assert.equal(scenario.portfolio.riskProfile, plan.portfolio.riskProfile);
});
