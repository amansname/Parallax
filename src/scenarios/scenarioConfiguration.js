import { LONGRUN_INFLATION, defaultPlan as plan } from '../../engine.js';
import { SCENARIO_ALLOCATION_OPTIONS, applyScenarioPlanInputs, resolveCurrentScenarioAllocation } from './scenarioPlanInputs.js';
/* The three scenario columns. Each holds lever values + its last engine result.
   lever values are the ACTUAL planning values (age, $, etc.), not slider ticks. */
// Essentials is a pre-loaded goal now, not a plan.expenses field. One reader so
// the Scenarios lever, the Summary metric and the wizard cannot drift apart.
function essentialsGoalAmount(p) {
  const goal = (Array.isArray(p?.goals) ? p.goals : []).find(g => g?.system === 'essentials');
  return Number(goal?.amount) || 0;
}
export function defaultLevers() {
  const spouse = plan.household.spouse;
  const L = {
    retireAge: plan.household.primary.retirementAge,
    ssAge: plan.income.socialSecurity.primary.claimAge,
    ...(spouse ? {
      spouseRetireAge: spouse.retirementAge,
      spouseSsAge: plan.income.socialSecurity.spouse.claimAge
    } : {}),
    spend: essentialsGoalAmount(plan),
    eventAmt: 0,
    eventAge: 70,
    allocationPresetId: resolveCurrentScenarioAllocation(plan),
    risk: plan.portfolio.riskProfile,
    savings: plan.savings.annual,
    // pensionAge tracks retirement by DEFAULT (most people switch on a pension
    // when they retire — no reason to take taxable fixed income while still
    // earning). pensionAuto stays true until the advisor grabs the pension
    // slider, which frees it to hold any quoted age independently.
    pensionAuto: true,
    pensionAge: plan.income.pension && plan.income.pension.startAge || 65
  };
  syncPension(L);
  return L;
}

// If pension is still auto-linked, snap its claim age to the retirement age,
// clamped into the household's quoted pension range. No-op once the advisor has
// taken manual control of the pension lever (pensionAuto=false).
export function syncPension(L) {
  if (!L.pensionAuto) return;
  const a = pensionAges();
  const lo = a.length ? a[0] : 62,
    hi = a.length ? a[a.length - 1] : 65;
  L.pensionAge = Math.max(lo, Math.min(hi, L.retireAge));
}

// Scenarios are NAMED, SAVEABLE objects (the household-centric data root). They
// start identical; the advisor moves levers to show each decision's effect, and
// can rename / add / remove them. Both tabs read this shared set.
// The first-run scenario set tells a story: B delays the plan's retirement
// (drawdown) age 2 years, C goes aggressive (wealth line jumps, success does
// NOT — volatility drag). Deltas are relative to the ACTIVE household's base
// levers so the set is meaningful for any household, not just the demo.
export function defaultScenarios() {
  const s = [{
    name: 'Baseline',
    base: true,
    lev: defaultLevers(),
    res: null
  }, {
    name: 'Scenario B',
    base: false,
    lev: defaultLevers(),
    res: null
  }, {
    name: 'Aggressive',
    base: false,
    lev: defaultLevers(),
    res: null
  }];
  // Scenario B contrast. Pre-retirement: "retire 2 years later" (the core lever
  // when testing a feasible retirement date). Already retired: that
  // lever is inert, so retain the legacy risk marker without rewriting the
  // household's account-level model until the advisor chooses one explicitly.
  if (hhAlreadyRetired()) {
    s[1].lev.risk = Math.max(1, (plan.portfolio && plan.portfolio.riskProfile || 3) - 1);
  } else {
    const baseRetire = plan.household && plan.household.primary && plan.household.primary.retirementAge || 65;
    s[1].lev.retireAge = baseRetire + 2;
  }
  s[2].lev.risk = 5;
  return s;
}

/* A household is ALREADY RETIRED when every principal is at or past their own
   retirement age — there is no future retirement transition to plan for. In that
   state retirement age is a satisfied input: it may still show in the banner, but
   it must not drive any lever or engine result (like a one-time goal that has
   already happened). Retirement age stays a LIVE lever whenever anyone is still
   pre-retirement (the household retires when the LAST earner does). */
function hhAlreadyRetired() {
  const pr = plan.household && plan.household.primary;
  if (!pr || pr.currentAge == null || pr.retirementAge == null) return false;
  if (pr.currentAge < pr.retirementAge) return false; // primary still working
  const sp = plan.household && plan.household.spouse;
  if (sp) {
    if (sp.currentAge == null || sp.retirementAge == null) return false;
    if (sp.currentAge < sp.retirementAge) return false; // co-client still working
  }
  return true;
}

/* Map a scenario's levers -> engine override object. */
export function leversToOverrides(L) {
  const ov = {};
  // Essentials is an absolute dollar figure, so the scenario sets it directly
  // rather than as a percentage swing off the base. A percentage would also
  // drag every other discretionary goal along with it, which is not what an
  // "Essentials" input should mean — and it has no meaning at all from a $0
  // base, which is where every new household starts.
  const scenarioSpend = Number(L.spend);
  if (!Number.isFinite(scenarioSpend) || scenarioSpend < 0) {
    throw new TypeError('Scenario spending must be a finite non-negative number');
  }
  ov.livingAnnual = scenarioSpend;
  if (L.eventAmt > 0) {
    ov.lumpSum = L.eventAmt;
    ov.lumpSumYear = Math.max(0, L.eventAge - plan.household.primary.currentAge);
  }
  const baseSavings = Number(plan.savings.annual);
  const scenarioSavings = Number(L.savings);
  if (!Number.isFinite(baseSavings) || baseSavings < 0 || !Number.isFinite(scenarioSavings) || scenarioSavings < 0) {
    throw new TypeError('Scenario savings must be a finite non-negative number');
  }
  if (baseSavings > 0 && scenarioSavings !== baseSavings) {
    ov.savingsBump = (scenarioSavings - baseSavings) / baseSavings;
  } else if (baseSavings === 0 && scenarioSavings > 0) {
    ov.savingsAnnual = scenarioSavings;
    const savedSplit = plan.savings.split;
    const traditionalShare = savedSplit ? Number(savedSplit.traditional) || 0 : 1;
    if (plan.household.spouse && traditionalShare > 0) {
      // Generic household savings has no contributor owner. Keep a zero-base
      // couple scenario in taxable savings instead of inventing an IRA owner.
      ov.savingsSplit = {
        taxable: 1
      };
    }
  }
  // Pension: always pass the chosen age as an absolute override so the engine
  // looks up the entered benefit for THAT exact age (or pays 0 if no entry).
  ov.pensionStartAge = L.pensionAge;
  return ov;
}

/* Person ages and the allocation model belong on the scenario plan clone so
   the Projection Engine receives each person's exact facts and the selected
   account-level asset model without a second UI-side calculation authority.
   A gift/education goal injects a time-limited recurring outflow (a liability
   with start/end age). colaPct = inflation so it stays real-constant — the
   advisor enters today's dollars. No-op for normal scenarios (no giftAmt). */
export function planForScenario(L) {
  const p = applyScenarioPlanInputs(plan, L);
  // Per-scenario goal overrides (Compare-editable): amount / startAge / endAge keyed
  // by the goal's index in the base inventory. Applied to the CLONE only, so the base
  // plan.goals (Goals-page source of truth) and every other scenario are untouched.
  if (L.goalOv && Array.isArray(p.goals)) {
    p.goals = p.goals.map((g, i) => {
      const ov = L.goalOv[i];
      if (!ov) return g;
      return {
        ...g,
        amount: ov.amount != null ? ov.amount : g.amount,
        startAge: ov.startAge != null ? ov.startAge : g.startAge,
        endAge: ov.endAge != null ? ov.endAge : g.endAge
      };
    });
  }
  if (L.giftAmt > 0 && L.giftEndAge) {
    p.liabilities = (p.liabilities || []).concat([{
      amount: L.giftAmt,
      startAge: plan.household.primary.currentAge,
      endAge: L.giftEndAge,
      colaPct: LONGRUN_INFLATION * 100
    }]);
  }
  return p;
}

// Pension slider range is PER-HOUSEHOLD: it spans only the ages the advisor has
// actually quoted a benefit for (the keys of benefitByAge). This means the
// slider can never wander onto an age with no number — so it can't silently pay
// $0. Enter a new quote (e.g. age 67) and the slider grows to include it on the
// next render. Falls back to a sane window if nothing is entered yet.
function pensionAges() {
  const m = plan.income.pension && plan.income.pension.benefitByAge || {};
  return Object.keys(m).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
}

// Effective slider range for a lever. Pension is dynamic; everything else is
// the min/max declared by the current household's lever configuration.
export function levRange(cfg) {
  if (cfg.key === 'pensionAge') {
    const a = pensionAges();
    if (a.length) return {
      min: a[0],
      max: a[a.length - 1],
      step: 1
    };
    return {
      min: 62,
      max: 65,
      step: 1
    };
  }
  return {
    min: cfg.min,
    max: cfg.max,
    step: cfg.step
  };
}

/* ── lever display config (label, formatter, slider range→value & back) ── */
export function leverConfigs() {
  const hasSpouse = Boolean(plan.household.spouse);
  const configs = [{
    key: 'retireAge',
    name: hasSpouse ? 'Client 1 Retirement' : 'Retirement Age',
    min: 55,
    max: 72,
    step: 1,
    fmt: v => [v, '']
  }, ...(hasSpouse ? [{
    key: 'spouseRetireAge',
    name: 'Client 2 Retirement',
    min: 55,
    max: 72,
    step: 1,
    fmt: v => [v, '']
  }] : []), {
    key: 'ssAge',
    name: hasSpouse ? 'Client 1 SS Age' : 'SS Start Age',
    min: 62,
    max: 70,
    step: 1,
    fmt: v => [v, '']
  }, ...(hasSpouse ? [{
    key: 'spouseSsAge',
    name: 'Client 2 SS Age',
    min: 62,
    max: 70,
    step: 1,
    fmt: v => [v, '']
  }] : []),
  // All dollar levers render full digits with comma grouping — no abbreviations.
  // The advisor wants to see the exact number they're proposing, not a rounded
  // shorthand. Step values stay round so the slider snaps cleanly.
  // Spending is stored ANNUAL (the engine's unit) but shown/edited MONTHLY —
  // clients know their monthly number off-hand. edit:'monthly' wires the box.
  {
    key: 'spend',
    name: 'Essentials',
    min: 80000,
    max: 360000,
    step: 1200,
    edit: 'monthly',
    fmt: v => ['$' + Math.round(v / 12).toLocaleString('en-US'), '/mo']
  },
  // One-time event carries BOTH an amount and an age; edit:'event' renders the
  // two type-in boxes (amount + age) alongside the amount slider.
  {
    key: 'eventAmt',
    name: 'One-Time Event',
    min: 0,
    max: 500000,
    step: 5000,
    edit: 'event',
    fmt: (v, L) => ['$' + (v || 0).toLocaleString('en-US'), '@ ' + L.eventAge]
  }, {
    key: 'allocationPresetId',
    name: 'Allocation',
    control: 'select',
    options: SCENARIO_ALLOCATION_OPTIONS,
    fmt: v => [(SCENARIO_ALLOCATION_OPTIONS.find(option => option.value === v) || {}).label || 'Unavailable', '']
  }, {
    key: 'savings',
    name: 'Savings / yr',
    min: 0,
    max: 200000,
    step: 1000,
    edit: 'money',
    fmt: v => ['$' + v.toLocaleString('en-US'), '/yr']
  },
  // Pension snaps between the ages that actually have entered amounts (62, 65).
  // Label shows the dollar value the engine will pay for that age — if no entry
  // exists for that age, it shows "—" (and the engine pays 0).
  // Pension claim age. Range spans the realistic window; the displayed dollar
  // amount comes from whatever the advisor has entered for that exact age.
  // No entry yet → the value spot becomes an inline input (handled in
  // the Scenarios view layer, not here). This is the truth-source contract surfacing
  // naturally as a UI affordance: "we don't have a number for this age, give
  // us one." Not an error — just the next input.
  {
    key: 'pensionAge',
    name: 'Pension',
    min: 55,
    max: 70,
    step: 1,
    fmt: v => {
      const m = plan.income.pension && plan.income.pension.benefitByAge || {};
      const amt = m[v];
      return amt && amt > 0 ? ['$' + amt.toLocaleString('en-US'), '@ ' + v] : ['__needs__', v];
    }
  }];
  return configs;
}
