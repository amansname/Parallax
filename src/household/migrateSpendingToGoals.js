/* Spending lives on the Goals page.
 *
 * The engine used to carry two independent spending channels: plan.expenses
 * (living / housing / debt / healthcare / extra[]) rendered as ESSENTIAL, and
 * plan.goals[] rendered as GOALS. Advisors had no reason to expect the first
 * one — it was fed partly by a "Lifestyle Spending" slider on a different page.
 *
 * This converts every plan.expenses channel into a goal, so there is exactly
 * one place spending is entered and exactly one place it is read from. The
 * conversion has to be lossless: anything the engine previously summed must
 * land in a goal, or a saved plan quietly loses spending.
 */

export const SPENDING_SCHEMA_VERSION = 1;

export const ESSENTIALS_GOAL_ID = 'system:essentials';
export const HEALTHCARE_GOAL_ID = 'system:healthcare';

// Per person, per year, in today's dollars.
export const HEALTHCARE_PRELOAD_PER_PERSON = 5500;
// Healthcare rises faster than general inflation. Same rate the engine applied
// to plan.expenses.healthcare before this moved onto the goal.
export const HEALTHCARE_REAL_GROWTH = 0.02;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function healthcarePreloadFor(plan){
  const people = plan?.household?.spouse ? 2 : 1;
  return HEALTHCARE_PRELOAD_PER_PERSON * people;
}

export function makeEssentialsGoal(amount = 0){
  return {
    id: ESSENTIALS_GOAL_ID,
    system: 'essentials',
    name: 'Essentials',
    amount: Math.max(0, num(amount)),
    startsAtRetirement: true,
    endAge: 999,
    realGrowth: 0,              // flat real dollars
    flexesWithSpending: true,   // this is the lifestyle spending the lever moves
  };
}

export function makeHealthcareGoal(amount){
  return {
    id: HEALTHCARE_GOAL_ID,
    system: 'healthcare',
    name: 'Healthcare',
    amount: Math.max(0, num(amount)),
    startsAtRetirement: true,
    endAge: 999,
    realGrowth: HEALTHCARE_REAL_GROWTH,
  };
}

export function isSystemGoal(goal){
  return goal?.system === 'essentials' || goal?.system === 'healthcare';
}

/**
 * The goals a plan's legacy expense channels represent, or null when there are
 * none. Pure — used both by the persistence migration and by the engine, which
 * folds legacy expenses in on the fly so a plan that never got migrated cannot
 * silently lose its spending.
 */
export function goalsFromLegacyExpenses(plan){
  const expenses = plan?.expenses && typeof plan.expenses === 'object' ? plan.expenses : null;
  if(!expenses) return null;

  const essentialsAmount = num(expenses.living) + num(expenses.housing) + num(expenses.debt);
  const healthcareAmount = num(expenses.healthcare);
  const extras = (Array.isArray(expenses.extra) ? expenses.extra : [])
    .filter(row => row && num(row.amount) > 0);
  if(essentialsAmount <= 0 && healthcareAmount <= 0 && extras.length === 0) return null;

  const out = [];
  if(essentialsAmount > 0) out.push(makeEssentialsGoal(essentialsAmount));
  if(healthcareAmount > 0){
    const goal = makeHealthcareGoal(healthcareAmount);
    if(typeof expenses.healthcareRealGrowth === 'number'
      && Number.isFinite(expenses.healthcareRealGrowth)
      && expenses.healthcareRealGrowth >= 0){
      goal.realGrowth = expenses.healthcareRealGrowth;
    }
    out.push(goal);
  }
  extras.forEach((row, index) => {
    out.push({
      id: `migrated:expense-${index}`,
      name: (row.label || '').trim() || 'Expense',
      amount: Math.max(0, num(row.amount)),
      startAge: row.startAge != null ? row.startAge : 0,
      endAge: row.endAge != null ? row.endAge : 999,
      realGrowth: 0,
      flexesWithSpending: true,
    });
  });
  return out;
}

/**
 * Convert a plan's expense channels into goals. Idempotent — a plan already at
 * the current spending schema is returned untouched.
 */
export function migrateSpendingToGoals(plan){
  if(!plan || typeof plan !== 'object' || Array.isArray(plan)){
    throw new Error('Invalid plan');
  }
  const meta = plan.meta && typeof plan.meta === 'object' ? plan.meta : {};
  if(meta.spendingSchemaVersion === SPENDING_SCHEMA_VERSION){
    return { changed: false, plan };
  }

  const next = { ...plan };
  const expenses = plan.expenses && typeof plan.expenses === 'object' ? plan.expenses : {};
  const existing = Array.isArray(plan.goals) ? plan.goals.slice() : [];

  // living + housing + debt were all flat real annual spending with no timing
  // of their own — one Essentials figure is the same money.
  const essentialsAmount = num(expenses.living) + num(expenses.housing) + num(expenses.debt);
  // Healthcare keeps its own escalation, so it stays a separate goal — carrying
  // whatever the plan already recorded, including nothing.
  //
  // Deliberately NOT the per-person preload: that belongs to brand-new
  // households. Applying it here would quietly add spending to a saved client
  // plan and change its result without anyone asking for it.
  const healthcareAmount = num(expenses.healthcare);

  const healthcareGoal = makeHealthcareGoal(healthcareAmount);
  // A plan that recorded its own healthcare growth keeps it; otherwise the
  // standard rate. Preserves any advisor-set figure rather than overwriting it.
  if(typeof expenses.healthcareRealGrowth === 'number'
    && Number.isFinite(expenses.healthcareRealGrowth)
    && expenses.healthcareRealGrowth >= 0){
    healthcareGoal.realGrowth = expenses.healthcareRealGrowth;
  }

  // extra[] already carried label/amount/startAge/endAge — it IS a goal, and
  // becomes one directly rather than being folded into Essentials, so its
  // timing survives.
  const extraGoals = (Array.isArray(expenses.extra) ? expenses.extra : [])
    .filter(row => row && num(row.amount) > 0)
    .map((row, index) => ({
      id: `migrated:expense-${index}`,
      name: (row.label || '').trim() || 'Expense',
      amount: Math.max(0, num(row.amount)),
      startAge: row.startAge != null ? row.startAge : 0,
      endAge: row.endAge != null ? row.endAge : 999,
      realGrowth: 0,
      // extra[] flexed with the spending lever before the move; keep that.
      flexesWithSpending: true,
    }));

  next.goals = [
    makeEssentialsGoal(essentialsAmount),
    healthcareGoal,
    ...extraGoals,
    ...existing.filter(g => !isSystemGoal(g)),
  ];

  // Zero the old channels. The engine no longer reads them, and leaving live
  // figures behind would double-count the moment anything read them again.
  next.expenses = {
    ...expenses,
    living: 0,
    housing: 0,
    debt: 0,
    healthcare: 0,
    extra: [],
  };
  next.meta = { ...meta, spendingSchemaVersion: SPENDING_SCHEMA_VERSION };

  return { changed: true, plan: next };
}

/**
 * Keep the healthcare preload in step with household size when a co-client is
 * added or removed. Only applies while the figure is still the untouched
 * preload — an advisor-entered number is theirs and is left alone.
 */
export function syncHealthcareGoalToHousehold(plan){
  if(!Array.isArray(plan?.goals)) return false;
  const goal = plan.goals.find(g => g?.system === 'healthcare');
  if(!goal) return false;
  const expected = healthcarePreloadFor(plan);
  if(goal.amount === expected) return false;
  const wasPreload = goal.amount === HEALTHCARE_PRELOAD_PER_PERSON
    || goal.amount === HEALTHCARE_PRELOAD_PER_PERSON * 2;
  if(!wasPreload) return false;      // advisor-edited — do not overwrite
  goal.amount = expected;
  return true;
}
