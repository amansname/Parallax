/* =============================================================================
   taxEngineAdapter.js — binding seam for the Tax-Aware Withdrawal module.

   THIS FILE CONTAINS NO TAX MATH AND NO TAX DATA.
   Pipeline: facts+levers → runEngineYearTax → annual1040Result + rule audits
   ========================================================================== */

const PATHS = {
  annual1040: '../../tax/annual1040.js',
  constants: '../../tax/core/constants.js',
  accounts: '../../household/resolvePortfolioAccounts.js',
  attribution: '../tax/attributeWithdrawalTaxByBucket.js',
  engine: '../../../engine.js',
};

let mods = null;
let loadError = null;

async function load() {
  if (mods) return mods;
  if (loadError) throw loadError;
  try {
    const [annual1040, constants, accounts, attribution] = await Promise.all([
      import(PATHS.annual1040),
      import(PATHS.constants),
      import(PATHS.accounts),
      import(PATHS.attribution),
    ]);
    mods = { annual1040, constants, accounts, attribution };
    return mods;
  } catch (e) {
    loadError = e;
    throw e;
  }
}

export function loadFailure() {
  return loadError ? String(loadError.message || loadError) : null;
}

export const NOT_MODELED = Object.freeze({
  irmaa: 'No IRMAA table in src/tax/',
  niit: 'NIIT_NOT_MODELED',
});

export function supportedYears() {
  return mods ? mods.annual1040.supportedTaxYears() : [];
}

export async function sleeveBalances(plan) {
  if (!plan) return { taxable: null, traditional: null, roth: null };
  try {
    const { accounts } = await load();
    const fold = accounts.resolvePortfolioAccounts(plan);
    const s = fold?.engineBuckets;
    const read = k => (typeof s?.[k]?.balance === 'number' ? s[k].balance : null);
    return { taxable: read('taxable'), traditional: read('traditional'), roth: read('roth') };
  } catch (e) {
    const a = plan?.portfolio?.accounts;
    const read = k => (typeof a?.[k]?.balance === 'number' ? a[k].balance : null);
    return { taxable: read('taxable'), traditional: read('traditional'), roth: read('roth') };
  }
}

export async function householdIncome(plan, taxYear) {
  const out = { filingStatus: null, socialSecurityBenefits: null, otherIncome: null, age: null };
  if (!plan) return out;
  out.filingStatus = plan?.meta?.filingStatus ?? null;
  try {
    const eng = await import(PATHS.engine);
    const ri = eng.resolveInputs(plan, {});
    const age = ri.currentAge + (taxYear - new Date().getFullYear());
    const running = s => s && typeof s.startAge === 'number'
      && age >= s.startAge && (s.endAge == null || age <= s.endAge);
    out.age = age;
    out.socialSecurityBenefits = (ri.ss || []).reduce((t, s) => t + (running(s) ? (s.amount || 0) : 0), 0);
    out.otherIncome = (ri.otherIncome || []).reduce((t, s) => t + (running(s) ? (s.amount || 0) : 0), 0);
  } catch (e) { /* plan cannot resolve */ }
  return out;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sub = (a, b) => (num(a) === null || num(b) === null ? null : a - b);

function auditFor(audits, ruleId) {
  return (audits || []).find(a => a && a.ruleId === ruleId) || null;
}

function bandFrom(brackets, income) {
  if (!Array.isArray(brackets) || num(income) === null) return { floor: null, ceiling: null, rate: null, nextRate: null };
  let floor = 0;
  for (let i = 0; i < brackets.length; i++) {
    const { rate, upTo } = brackets[i];
    if (income < upTo || i === brackets.length - 1) {
      return { floor, ceiling: Number.isFinite(upTo) ? upTo : null, rate, nextRate: brackets[i + 1]?.rate ?? null };
    }
    floor = upTo;
  }
  return { floor: null, ceiling: null, rate: null, nextRate: null };
}

function toYearFacts({ facts, levers, gainFraction, taxYear }) {
  const income = {};
  const put = (k, v) => { if (num(v) !== null && v !== 0) income[k] = v; };
  put('wages', facts.wages);
  put('taxableInterest', facts.taxableInterest);
  put('ordinaryDividends', facts.ordinaryDividends);
  put('qualifiedDividends', facts.qualifiedDividends);
  put('socialSecurityBenefits', facts.socialSecurityBenefits);
  put('otherIncome', facts.otherIncome);

  const iraGross = Math.max(0, (levers.deferredWithdrawal || 0) + (levers.rothConversion || 0));
  put('iraDistributions', iraGross);

  if ((levers.taxableWithdrawal || 0) > 0 && num(gainFraction) !== null) {
    put('capitalGain', levers.taxableWithdrawal * gainFraction);
  }

  const resolved = {};
  if (iraGross > 0) resolved.taxableIra = iraGross;

  const out = {
    filingStatus: facts.filingStatus,
    taxYear,
    income,
    deductions: { useStandard: true },
  };
  if (facts.filingStatus === 'marriedFilingSeparately') {
    out.socialSecurityWorksheet = { livedWithSpouse: facts.livedWithSpouse === true };
  }
  if (Object.keys(resolved).length) out.resolved = resolved;
  return out;
}

export async function evaluateYear({ plan, taxYear, facts, levers }) {
  const { annual1040, constants } = await load();
  if (!facts || !facts.filingStatus) return null;

  const basisPct = num(plan?.portfolio?.accounts?.taxable?.basisPct);
  const gainFraction = basisPct === null ? null : 1 - basisPct;

  const context = annual1040.buildDefaultTaxContext({ taxYear, runId: 'tax_aware_withdrawal', scenarioId: 'focus_year' });
  const lawVersion = context.lawVersion;
  const fs = facts.filingStatus;

  const run = lv => annual1040.runEngineYearTax(toYearFacts({ facts, levers: lv, gainFraction, taxYear }), context);

  let main;
  try { main = run(levers); } catch (e) { return { error: String(e.message || e) }; }

  const res = main.annual1040Result;
  const sum = res.federalSummary;
  const audits = main.audits;

  const ordAudit = auditFor(audits, 'FED_ORDINARY_INCOME_TAX');
  const gainAudit = auditFor(audits, 'FED_CAPITAL_GAINS_STACKING');
  const ssAudit = auditFor(audits, 'FED_TAXABLE_SOCIAL_SECURITY');

  const taxableOrdinary = num(ordAudit?.inputsUsed?.taxableOrdinaryIncome);
  const brackets = constants.ORDINARY_BRACKETS?.[lawVersion]?.[fs];
  const band = bandFrom(brackets, taxableOrdinary ?? 0);
  const cgT = constants.CAPITAL_GAINS_THRESHOLDS?.[lawVersion]?.[fs] || {};
  const preferential = num(sum.preferentialIncome);

  let zero = null;
  try {
    zero = run({ taxableWithdrawal: 0, deferredWithdrawal: 0, rothConversion: 0, rothWithdrawal: 0, qcd: 0 });
  } catch (e) { zero = null; }
  const zeroOrd = num(auditFor(zero?.audits, 'FED_ORDINARY_INCOME_TAX')?.inputsUsed?.taxableOrdinaryIncome);
  const zeroSsSteps = auditFor(zero?.audits, 'FED_TAXABLE_SOCIAL_SECURITY')?.calculationSteps || [];
  const zeroStep = line => {
    const st = zeroSsSteps.find(x => x && x.line === line);
    return st ? num(st.amount) : null;
  };
  const zeroProvisional = zeroStep('worksheetIncome') ?? zeroStep('combinedIncomeBeforeAdjustments');

  const gross = (levers.taxableWithdrawal || 0) + (levers.deferredWithdrawal || 0) + (levers.rothWithdrawal || 0);

  const form = main.result?.form1040 || {};
  const ssBenefit = num(form.line6a?.value) ?? num(facts.socialSecurityBenefits);
  const ssTaxable = num(form.line6b?.value);
  const ssSteps = ssAudit?.calculationSteps || [];
  const stepAmount = line => {
    const st = ssSteps.find(x => x && x.line === line);
    return st ? num(st.amount) : null;
  };
  const ssProvisional = stepAmount('worksheetIncome') ?? stepAmount('combinedIncomeBeforeAdjustments');
  const ssKey = fs === 'marriedFilingSeparately'
    ? (ssAudit?.inputsUsed?.livedWithSpouse ? 'marriedFilingSeparatelyLivedTogether' : 'marriedFilingSeparatelyLivedApart')
    : fs;
  const ssT = constants.SOCIAL_SECURITY_TAXATION_THRESHOLDS?.[lawVersion]?.[ssKey] || {};
  const ssTier1 = num(ssT.baseAmount);
  const ssAdditional = num(ssT.additionalAmount);
  const ssTier2 = ssTier1 === null || ssAdditional === null ? null : ssTier1 + ssAdditional;
  const ssNextAt = ssProvisional === null ? ssTier1
    : (ssProvisional < ssTier1 ? ssTier1 : (ssTier2 !== null && ssProvisional < ssTier2 ? ssTier2 : null));

  return {
    lawVersion,
    taxYear: res.taxYear,
    baseline: { ordinaryIncome: zeroOrd, provisionalIncome: zeroProvisional },
    totals: {
      ordinaryIncome: taxableOrdinary,
      qualifiedIncome: preferential,
      agi: num(sum.adjustedGrossIncome),
      magi: num(sum.adjustedGrossIncome),
      taxableIncome: num(sum.taxableIncome),
      federalTax: num(sum.federalTaxLiability),
      marginalRate: num(sum.marginalRate),
      effectiveRate: num(sum.effectiveRate),
      netCash: sub(gross, num(sum.federalTaxLiability)),
    },
    ordinary: {
      rate: num(sum.marginalRate) ?? band.rate, ceiling: band.ceiling,
      income: taxableOrdinary, roomToNext: sub(band.ceiling, taxableOrdinary),
    },
    ltcg: {
      rate: num(gainAudit?.calculationSteps?.[gainAudit.calculationSteps.length - 1]?.rate),
      zeroCeiling: num(cgT.zeroRateMax),
      stackedOn: taxableOrdinary,
      stackTop: taxableOrdinary === null || preferential === null ? null : taxableOrdinary + preferential,
      roomToZeroCeiling: taxableOrdinary === null || num(cgT.zeroRateMax) === null
        ? null
        : Math.max(0, cgT.zeroRateMax - taxableOrdinary - (preferential || 0)),
      gains: preferential,
    },
    socialSecurity: {
      benefit: ssBenefit,
      taxableAmount: ssTaxable,
      taxablePct: ssBenefit && ssTaxable !== null ? ssTaxable / ssBenefit : null,
      provisionalIncome: ssProvisional,
      nextTierAt: ssNextAt,
      roomToNext: sub(ssNextAt, ssProvisional),
    },
    irmaa: { scope: NOT_MODELED.irmaa },
    niit: { scope: NOT_MODELED.niit },
    rmd: { required: null, satisfied: null, remaining: null, age: null },
    ladders: {
      ordinary: (Array.isArray(brackets) ? brackets : []).map(b => ({
        rate: b.rate, upTo: Number.isFinite(b.upTo) ? b.upTo : null,
      })),
      ltcg: { zeroRateMax: num(cgT.zeroRateMax), fifteenRateMax: num(cgT.fifteenRateMax) },
      socialSecurity: { tier1: ssTier1, tier2: ssTier2 },
      irmaa: null,
    },
    coverage: {
      unsupportedIntentional: res.unsupportedIntentional || [],
      warnings: res.warnings || [],
    },
  };
}

export async function attributeSleeves({ plan, taxYear, facts, levers }) {
  const { annual1040, attribution } = await load();
  if (!facts || !facts.filingStatus) return null;

  const basisPct = num(plan?.portfolio?.accounts?.taxable?.basisPct);
  const gainFraction = basisPct === null ? null : 1 - basisPct;
  const context = annual1040.buildDefaultTaxContext({
    taxYear, runId: 'tax_aware_withdrawal', scenarioId: 'sleeve_attribution',
  });

  const held = { rothConversion: levers.rothConversion || 0, qcd: levers.qcd || 0 };
  const amounts = {
    taxable: Math.max(0, levers.taxableWithdrawal || 0),
    traditional: Math.max(0, levers.deferredWithdrawal || 0),
    roth: Math.max(0, levers.rothWithdrawal || 0),
  };

  const taxFor = buckets => {
    const lv = {
      ...held,
      taxableWithdrawal: buckets.includes('taxable') ? amounts.taxable : 0,
      deferredWithdrawal: buckets.includes('traditional') ? amounts.traditional : 0,
      rothWithdrawal: buckets.includes('roth') ? amounts.roth : 0,
    };
    const out = annual1040.runEngineYearTax(toYearFacts({ facts, levers: lv, gainFraction, taxYear }), context);
    return num(out?.annual1040Result?.federalSummary?.federalTaxLiability) ?? 0;
  };

  try {
    const coalitionTaxes = {};
    for (const c of attribution.WITHDRAWAL_TAX_COALITIONS) coalitionTaxes[c.id] = taxFor(c.buckets);
    const att = attribution.attributeWithdrawalTaxByBucket(coalitionTaxes);
    return {
      method: att.method,
      baselineTax: att.baselineTax,
      incrementalTax: att.incrementalTax,
      byBucket: att.displayByBucket,
      exactByBucket: att.byBucket,
      residual: att.displayReconciliation.difference,
      withdrawals: amounts,
      heldFixed: held,
    };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}
