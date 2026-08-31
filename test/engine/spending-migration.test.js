// Engine contract: spending migration. Preserve financial expectations.
import { test } from 'node:test';
import assert from 'node:assert';
import { generateReturnPath, runSinglePath, resolveInputs, defaultPlan } from '../../engine.js';
import { migrateSpendingToGoals } from '../../src/household/migrateSpendingToGoals.js';

/* Spending lives on the Goals page.
   plan.expenses is retired: living/housing/debt/healthcare/extra are goals now.
   These lock the conversion being lossless and the healthcare escalation
   surviving the move, because a silent change here alters every saved plan. */
function noLegacyExpenses(p){
  p.expenses = { living: 0, housing: 0, debt: 0, healthcare: 0, healthcareRealGrowth: 0.02, extra: [] };
  return p;
}

test('a healthcare goal reproduces the retired expenses.healthcare curve exactly', () => {
  const mk = () => {
    const p = structuredClone(defaultPlan);
    p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
    noLegacyExpenses(p);
    p.goals = [];
    return p;
  };
  const oldWay = mk();
  oldWay.expenses.healthcare = 11000;        // folded in by the engine
  const newWay = mk();
  newWay.meta.spendingSchemaVersion = 1;     // already migrated
  newWay.goals = [{ name: 'Healthcare', system: 'healthcare', amount: 11000,
                    startsAtRetirement: true, endAge: 999, realGrowth: 0.02 }];

  const a = runSinglePath(resolveInputs(oldWay, {}), generateReturnPath(31));
  const b = runSinglePath(resolveInputs(newWay, {}), generateReturnPath(31));
  for(let i = 0; i < a.rows.length; i++){
    const before = (a.rows[i].expenses || 0) + (a.rows[i].goals || 0);
    const after = (b.rows[i].expenses || 0) + (b.rows[i].goals || 0);
    assert.ok(Math.abs(before - after) < 1e-6, 'age ' + a.rows[i].age);
  }
  // And it really escalates rather than quietly flattening.
  const first = b.rows[0].expenses;
  const last = b.rows[b.rows.length - 1].expenses;
  assert.ok(last > first * 1.7, 'healthcare compounds above CPI across retirement');
});

test('essentials stay flat real while healthcare escalates', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  noLegacyExpenses(p);
  p.meta.spendingSchemaVersion = 1;
  p.goals = [{ name: 'Essentials', system: 'essentials', amount: 100000,
               startsAtRetirement: true, endAge: 999, realGrowth: 0 }];
  const sim = runSinglePath(resolveInputs(p, {}), generateReturnPath(31));
  const first = sim.rows[0].expenses;
  const last = sim.rows[sim.rows.length - 1].expenses;
  assert.ok(Math.abs(first - 100000) < 1e-6, 'essentials start at the entered amount');
  assert.ok(Math.abs(last - first) < 1e-6, 'and never drift, being flat real dollars');
});

test('a system goal starting at retirement follows the retirement-age lever', () => {
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 60, retirementAge: 65, planEndAge: 90 };
  noLegacyExpenses(p);
  p.meta.spendingSchemaVersion = 1;
  p.goals = [{ name: 'Essentials', system: 'essentials', amount: 50000,
               startsAtRetirement: true, endAge: 999, realGrowth: 0 }];

  assert.strictEqual(resolveInputs(p, {}).goals[0].startAge, 65);
  // Retiring two years later must carry essentials with it, not leave them behind.
  assert.strictEqual(resolveInputs(p, { retireDelay: 2 }).goals[0].startAge, 67);
});

test('migrating a legacy plan preserves total spending year by year', () => {
  const legacy = structuredClone(defaultPlan);
  legacy.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 95 };
  legacy.expenses = { living: 120000, housing: 18000, debt: 6000, healthcare: 11000,
                      healthcareRealGrowth: 0.02,
                      extra: [{ label: 'Travel', amount: 9000, startAge: 66, endAge: 75 }] };
  legacy.goals = [{ name: 'Gifts', amount: 5000, startAge: 0, endAge: 999 }];

  const migrated = migrateSpendingToGoals(legacy).plan;
  assert.strictEqual(migrated.expenses.living, 0, 'the retired channel is emptied');
  assert.strictEqual(migrated.meta.spendingSchemaVersion, 1);

  const before = runSinglePath(resolveInputs(legacy, {}), generateReturnPath(31));
  const after = runSinglePath(resolveInputs(migrated, {}), generateReturnPath(31));
  for(let i = 0; i < before.rows.length; i++){
    const b = (before.rows[i].expenses || 0) + (before.rows[i].goals || 0);
    const a = (after.rows[i].expenses || 0) + (after.rows[i].goals || 0);
    assert.ok(Math.abs(a - b) < 1e-6, 'age ' + before.rows[i].age);
  }
});

test('migration converts what a plan has and never invents spending', () => {
  // A saved household with no healthcare figure must not acquire the per-person
  // preload. That would change a plan without anyone asking for it.
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 40000, housing: 0, debt: 0, healthcare: 0,
                 healthcareRealGrowth: 0.02, extra: [] };
  p.goals = [];
  const migrated = migrateSpendingToGoals(p).plan;
  assert.strictEqual(migrated.goals.find(g => g.system === 'healthcare').amount, 0,
    'no invented healthcare spending');
  assert.strictEqual(migrated.goals.find(g => g.system === 'essentials').amount, 40000);
});

test('spending migration is idempotent', () => {
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 40000, housing: 0, debt: 0, healthcare: 5000,
                 healthcareRealGrowth: 0.02, extra: [] };
  const once = migrateSpendingToGoals(p).plan;
  const twice = migrateSpendingToGoals(once);
  assert.strictEqual(twice.changed, false, 'a migrated plan is left alone');
  assert.deepStrictEqual(twice.plan.goals, once.goals);
});

test('the spending lever scales discretionary goals but never healthcare', () => {
  const p = structuredClone(defaultPlan);
  p.expenses = { living: 100000, housing: 0, debt: 0, healthcare: 10000,
                 healthcareRealGrowth: 0.02,
                 extra: [{ label: 'Travel', amount: 10000, startAge: 66, endAge: 75 }] };
  p.goals = [{ name: 'Gifts', amount: 5000, startAge: 0, endAge: 999 }];
  const migrated = migrateSpendingToGoals(p).plan;
  const amounts = ov => Object.fromEntries(
    resolveInputs(migrated, ov).goals.map(g => [g.name, Math.round(g.amount)]));

  assert.deepStrictEqual(amounts({}),
    { Essentials: 100000, Healthcare: 10000, Travel: 10000, Gifts: 5000 });
  assert.deepStrictEqual(amounts({ spendCut: 0.2 }),
    { Essentials: 80000, Healthcare: 10000, Travel: 8000, Gifts: 5000 });
  assert.deepStrictEqual(amounts({ livingAnnual: 60000 }),
    { Essentials: 60000, Healthcare: 10000, Travel: 10000, Gifts: 5000 });
});

test('the essentials override works from a zero base', () => {
  // Every new household starts with Essentials at zero, so a percentage swing
  // has no meaning. The scenario input must still set a real figure.
  const p = structuredClone(defaultPlan);
  p.household.primary = { currentAge: 65, retirementAge: 65, planEndAge: 70 };
  noLegacyExpenses(p);
  p.goals = [];
  const essentials = resolveInputs(p, { livingAnnual: 72000 })
    .goals.find(g => g.system === 'essentials');
  assert.ok(essentials, 'an essentials goal exists for the override to land on');
  assert.strictEqual(essentials.amount, 72000);
});
