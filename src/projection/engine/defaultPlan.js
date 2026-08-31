// Projection Engine implementation; public consumers import engine.js.


// ─── SECTION 3 — PLAN STATE ──────────────────────────────────────────────
// Portfolio is now a structured account container rather than a single balance.
// Three account types are modeled:
//   • Taxable: standard brokerage. Tracks both balance and cost basis. On
//     withdrawal, only the gain portion (balance minus basis) is taxed, and
//     at the long-term capital gains rate. Returns generate gains but don't
//     change basis, so the gain proportion grows as the account compounds.
//   • Traditional: IRA, 401(k), 403(b), etc. Entire withdrawal is taxed at
//     the ordinary income rate. (RMD modeling deferred to next phase.)
//   • Roth: Roth IRA, Roth 401(k). Withdrawals are tax-free.
//
// Tax rates split into ordinary income (used for traditional IRA withdrawals
// and the 85% taxable portion of Social Security) and long-term capital gains
// (used for the gain portion of taxable account withdrawals).
export const plan = {
  meta: { version: 'v3.0-ledger', name: 'Demo Household', householdId: null, primaryName: '', spouseName: '', spouseAge: null, location: '', familyNotes: '', planningAsOfYear: 2026 },
  household: { primary: { currentAge: 65, planEndAge: 95, retirementAge: 65 }, spouse: null },
  portfolio: {
    riskProfile: 3,
    withdrawalStrategy: 'taxable-first',
    accounts: {
      taxable:     { balance: 2000000, basisPct: 0.50 },  // 50% basis, 50% gain
      traditional: { balance: 2000000 },                   // pre-tax retirement
      roth:        { balance: 1000000 }                     // tax-free
    },
    extraAccounts: []   // typed accounts (401k, SEP, …) that fold into a tax sleeve
  },
  savings: { annual: 0, split: { traditional: 1, roth: 0, taxable: 0 } },   // pre-retirement contribution ($/yr) + sleeve split — only applies when retirementAge > currentAge
  income: {
    // Social Security — per person. pia = the benefit at Full Retirement Age
    // (today's dollars), i.e. the number off the SSA statement. claimAge sets
    // when they file (62–70); the engine actuarially adjusts pia for that age.
    // spouse: null when single; otherwise { pia, claimAge }.
    socialSecurity: { primary: { pia: 36000, claimAge: 67 }, spouse: null },
    // Other income — an ARRAY of variable / time-limited streams (rental, part-time,
    // a fixed-period annuity). Each: { label, amount ($/yr, today's dollars),
    // startAge, endAge, realGrowth, taxablePct }.
    //   realGrowth: per-stream REAL growth/yr from its own startAge. 0 = flat real
    //     (the legacy default). Positive = rises above inflation (rent indexed up);
    //     NEGATIVE = phases down in real terms (part-time wind-down).
    //   taxablePct: share taxed at the ordinary rate. 1 = fully taxable (legacy
    //     default); <1 models partly/fully tax-free income (return of capital,
    //     muni interest, gifts received).
    // Both default to the prior flat-real, fully-taxed behavior, so existing plans
    // are unchanged. A legacy single {amount,startAge,endAge} object is still
    // accepted (wrapped into a one-element array).
    other:          [],
    // Pension: a DISCRETE benefit-by-age map taken straight off the plan statement
    // ({ age: annualBenefit, ... }) — the advisor enters only ages they actually
    // have a number for. The engine NEVER interpolates or extrapolates a missing
    // age (that would invent data we don't have). startAge = the chosen collection
    // age; if it isn't a key in benefitByAge the modeled benefit is 0. COLA =
    // nominal annual escalator (0 = none), modeled like the SS COLA. `base` is kept
    // only as a legacy single-amount fallback.
    pension:        { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 }
  },
  incomeTax: { adjustments: [], deductions: [], deductionMode: 'auto' },
  // expenses: the fixed essential scalars PLUS `extra` — an array of discretionary,
  // time-bounded spending lines ({ label, amount, startAge, endAge }). Discretionary
  // extras flex with the spending lever (spendMult), flat-real otherwise. Empty default.
  // healthcareRealGrowth: annual real growth rate for healthcare above general CPI
  // (historically ~2%/yr; 0 = flat real). Applied from retirement age forward.
  expenses:   { living: 188000, housing: 0, debt: 0, healthcare: 12000, extra: [], healthcareRealGrowth: 0.02 },
  // Recurring time-bounded obligations (a mortgage, a car loan, a tuition plan).
  // Each: { label, amount ($/yr, today's dollars), startAge, endAge, colaPct }.
  // colaPct is the NOMINAL annual escalator like the pension: 0 = a fixed-nominal
  // payment, which the real-dollar engine erodes at −LONGRUN_INFLATION (a fixed
  // mortgage gets cheaper in real terms over its term). Empty by default.
  liabilities: [],
  // Properties — real assets, each with an OPTIONAL engine-native mortgage. The
  // engine amortizes the mortgage ({ balance, rate %, termYears }) into a fixed
  // annual payment that runs as a liability until payoff (startAge + termYears),
  // eroding in real terms like any fixed-nominal debt. `value` (current) and
  // `purchasePrice` (cost basis) stay INERT until a sale is triggered.
  //   commissionPct: total agent commission deducted from gross proceeds (default
  //     5%; set 0 for a business or FSBO sale).
  //   appreciation: real growth/yr of the asset's value until sale (default 0 =
  //     holds today's value in real terms).
  // The SALE itself is never stored here — it's an `assetSale` OVERRIDE applied
  // per scenario ({ asset: <index>, age: <saleAge> }), so the Baseline never
  // carries it and there's nothing to "zero out" to compare sell-vs-keep.
  properties: [],
  ltc:        { amount: 0, onsetAge: 85 },   // flat long-term-care cost ($/yr) from onsetAge onward
  // goals — an ARRAY of spend goals ({ name, amount, startAge, endAge }). A recurring
  // goal spans many years; a ONE-TIME goal is a single-year window (startAge===endAge).
  // Applied flat-real. A legacy { vacation, property, gifts } object is still accepted.
  goals:      [
    { name:'Vacation',         amount:15000, startAge:0, endAge:999 },
    { name:'Home improvements', amount:10000, startAge:0, endAge:999 },
    { name:'Gifts',            amount:5000,  startAge:0, endAge:999 },
  ],
  taxes:      { ordinary: 22, capitalGains: 15 },
  simulation: { iterations: 1000 }
};
