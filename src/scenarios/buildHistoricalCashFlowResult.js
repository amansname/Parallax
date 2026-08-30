import { pathDigest, resolveInputs } from '../../engine.js';
import { runHistoricalPathWithFederalTax } from '../planning/tax/runHistoricalPathWithFederalTax.js';
import {
  buildRetirementEntryPlan,
  deriveExactRetirementEntryAccounts,
} from './buildRetirementEntryPlan.js';
import { historicalPeriodById } from './historicalPeriods.js';

const SUPPORTED_WITHDRAWAL_STRATEGIES = new Set([
  'taxable-first',
  'proportional',
  'traditional-first',
]);

function continuityError(message){
  const error = new Error(message);
  error.code = 'HISTORICAL_CASH_FLOW_CONTINUITY_UNAVAILABLE';
  return error;
}

function assertNear(actual, expected, label){
  if(!Number.isFinite(actual) || !Number.isFinite(expected)
      || Math.abs(actual - expected) > 0.01){
    throw continuityError(`${label} does not match the displayed accumulation path`);
  }
}

function retirementOverrides(overrides, accumulationYears){
  const result = { ...(overrides || {}), retireDelay: 0 };
  if(Number.isInteger(result.lumpSumYear)){
    const rebasedYear = result.lumpSumYear - accumulationYears;
    if(rebasedYear < 0){
      delete result.lumpSum;
      delete result.lumpSumYear;
    }else{
      result.lumpSumYear = rebasedYear;
    }
  }
  return result;
}

function assertRetirementHandoff(accumulationRows, retirementRows, entryAccounts, retirementAge){
  const firstRetirement = retirementRows[0];
  if(!firstRetirement){
    throw continuityError('historical retirement rows are required');
  }
  const previous = accumulationRows[accumulationRows.length - 1] ?? null;
  const expectedAge = previous ? previous.age + 1 : retirementAge;
  if(firstRetirement.age !== expectedAge){
    throw continuityError('historical retirement age is not contiguous');
  }

  const saleProceeds = Number.isFinite(firstRetirement.assetSale)
    ? firstRetirement.assetSale
    : 0;
  assertNear(
    firstRetirement.accountStartingBalances?.taxable,
    entryAccounts.taxable.balance + saleProceeds,
    'retirement taxable opening balance'
  );
  assertNear(
    firstRetirement.accountStartingBalances?.traditional,
    entryAccounts.traditional.balance,
    'retirement Traditional opening balance'
  );
  assertNear(
    firstRetirement.accountStartingBalances?.roth,
    entryAccounts.roth.balance,
    'retirement Roth opening balance'
  );
  assertNear(
    firstRetirement.taxableStartingBasis,
    entryAccounts.taxable.basis + saleProceeds,
    'retirement taxable opening basis'
  );
}

function assertTraditionalOwnerHandoff(entryAccounts, retirementParams){
  for(const owner of ['client', 'spouse', 'unattributed']){
    assertNear(
      retirementParams.accounts.traditional.byOwner?.[owner],
      entryAccounts.traditional.byOwner?.[owner],
      `retirement Traditional ${owner} opening balance`
    );
  }
}

function calendarYearForRetirementRow(row, retirementBaseYear){
  return Number.isInteger(retirementBaseYear) && Number.isInteger(row?.year)
    ? retirementBaseYear + row.year - 1
    : null;
}

export function buildHistoricalCashFlowResult({
  analysis,
  plan,
  overrides = {},
  periodId,
  scenarioId = 'historical_cash_flow',
  taxOptions = {},
}){
  const period = historicalPeriodById(periodId);
  if(!period) throw new TypeError('a valid historical Cash Flow period is required');
  if(!analysis || typeof analysis !== 'object' || analysis.projectionStatus === 'unavailable'){
    throw new TypeError('a completed scenario analysis is required');
  }

  const params = resolveInputs(plan, overrides);
  const accumulationYears = Math.max(0, params.retirementAge - params.currentAge);
  const p50Rows = analysis?.paths?.p50?.rows;
  if(!Array.isArray(p50Rows)){
    throw continuityError('the scenario p50 path is required');
  }
  const accumulationRows = p50Rows.slice(0, accumulationYears);
  if(accumulationRows.length !== accumulationYears
      || accumulationRows.some(row => row?.phase !== 'accum')){
    throw continuityError('the displayed p50 path did not reach retirement continuously');
  }

  const entryAccounts = deriveExactRetirementEntryAccounts(
    analysis,
    accumulationYears,
    params.accounts,
    params.projectionAccounts,
  );
  const retirementPlan = buildRetirementEntryPlan(plan, {
    entryAccounts,
    currentAge: params.currentAge,
    retirementAge: params.retirementAge,
  });
  const rebasedOverrides = retirementOverrides(overrides, accumulationYears);
  const retirementParams = resolveInputs(retirementPlan, rebasedOverrides);
  const retirementBaseYear = Number.isInteger(retirementPlan.meta?.planningAsOfYear)
    ? retirementPlan.meta.planningAsOfYear
    : (Number.isInteger(plan.meta?.planningAsOfYear)
      ? plan.meta.planningAsOfYear + accumulationYears
      : null);
  if(!Number.isInteger(retirementBaseYear)){
    throw continuityError('a planning year is required for the historical retirement handoff');
  }
  assertTraditionalOwnerHandoff(entryAccounts, retirementParams);
  const strategy = SUPPORTED_WITHDRAWAL_STRATEGIES.has(params.withdrawalStrategy)
    ? params.withdrawalStrategy
    : 'taxable-first';
  const historical = runHistoricalPathWithFederalTax(
    retirementPlan,
    period.startYear,
    strategy,
    undefined,
    rebasedOverrides,
    {
      ...taxOptions,
      baseTaxYear: retirementBaseYear ?? taxOptions.baseTaxYear,
      filingStatus: retirementPlan.meta?.filingStatus,
      scenarioId: `${scenarioId}_${period.startYear}`,
    }
  );
  if(!historical || !Array.isArray(historical.rows)){
    throw continuityError('the selected historical path could not be modeled');
  }
  if(historical.rows.length !== retirementParams.horizonYears){
    throw continuityError('the selected historical path did not cover the full retirement horizon');
  }
  const firstFillerIndex = historical.rows.findIndex(row => row?.source == null);
  const realHistoricalRows = firstFillerIndex < 0
    ? historical.rows
    : historical.rows.slice(0, firstFillerIndex);
  const fillerRows = firstFillerIndex < 0
    ? []
    : historical.rows.slice(firstFillerIndex);
  if(realHistoricalRows.length === 0
      || fillerRows.some(row => row?.source != null)
      || (!historical.failed && fillerRows.length > 0)){
    throw continuityError('the selected historical path has an invalid failure boundary');
  }
  const underfundedRows = realHistoricalRows.filter(
    row => Number.isFinite(row.fundingShortfall) && row.fundingShortfall > 0.01
  );
  const firstUnderfundedRow = underfundedRows[0] ?? null;
  if(historical.failed){
    if(underfundedRows.length !== 1
        || firstUnderfundedRow !== realHistoricalRows.at(-1)){
      throw continuityError('the first underfunded retirement year is unavailable');
    }
  }else if(underfundedRows.length > 0){
    throw continuityError('a surviving historical path cannot contain an underfunded year');
  }
  assertRetirementHandoff(
    accumulationRows,
    realHistoricalRows,
    entryAccounts,
    params.retirementAge
  );

  const retirementRows = realHistoricalRows.map((row, index) => Object.freeze({
    ...row,
    year: accumulationYears + index + 1,
  }));
  const rows = Object.freeze([
    ...accumulationRows,
    ...retirementRows,
  ]);
  const retirementDigest = pathDigest(historical, retirementParams);
  const previousFundedRow = historical.failed
    ? realHistoricalRows.at(-2) ?? null
    : realHistoricalRows.at(-1);
  const endingRow = historical.failed ? null : realHistoricalRows.at(-1);
  const peakRow = retirementDigest.peakWdAge == null
    ? null
    : realHistoricalRows.find(row => row.age === retirementDigest.peakWdAge) ?? null;
  const summary = Object.freeze({
    outcome: historical.failed ? 'underfunded' : 'survives',
    failed: Boolean(historical.failed),
    firstUnderfundedAge: firstUnderfundedRow?.age ?? null,
    firstUnderfundedYear: calendarYearForRetirementRow(
      firstUnderfundedRow,
      retirementBaseYear
    ),
    fundedThroughAge: previousFundedRow?.age ?? null,
    fundedThroughYear: calendarYearForRetirementRow(
      previousFundedRow,
      retirementBaseYear
    ),
    endingBalance: endingRow?.balance ?? null,
    endingAge: endingRow?.age ?? null,
    endingYear: calendarYearForRetirementRow(endingRow, retirementBaseYear),
    peakWdRate: retirementDigest.peakWdRate,
    peakWdAge: retirementDigest.peakWdAge,
    peakWdYear: calendarYearForRetirementRow(peakRow, retirementBaseYear),
  });
  const simulation = Object.freeze({
    ...historical,
    rows,
  });
  const digest = Object.freeze(pathDigest(simulation, params));

  return Object.freeze({
    kind: 'historical',
    pathId: period.id,
    period,
    simulation,
    rows,
    summary,
    digest,
    accumulationYears,
    retirementBaseYear,
    taxScope: 'MODELED_FEDERAL_LINE_24',
  });
}

export function createHistoricalCashFlowCache(){
  const byAnalysis = new WeakMap();
  function peek(args){
    const analysis = args?.analysis;
    if(!analysis || typeof analysis !== 'object') return null;
    const period = historicalPeriodById(args.periodId);
    if(!period) return null;
    const cached = byAnalysis.get(analysis)?.get(period.id) ?? null;
    return cached
      && cached.plan === args.plan
      && cached.overrides === args.overrides
      && cached.scenarioId === args.scenarioId
      && cached.taxOptions === args.taxOptions
      ? cached.result
      : null;
  }
  return Object.freeze({
    get(args){
      const analysis = args?.analysis;
      if(!analysis || typeof analysis !== 'object'){
        throw new TypeError('analysis must be an object');
      }
      const period = historicalPeriodById(args.periodId);
      if(!period) throw new TypeError('a valid historical Cash Flow period is required');
      let byPeriod = byAnalysis.get(analysis);
      if(!byPeriod){
        byPeriod = new Map();
        byAnalysis.set(analysis, byPeriod);
      }
      const cached = byPeriod.get(period.id);
      if(cached
          && cached.plan === args.plan
          && cached.overrides === args.overrides
          && cached.scenarioId === args.scenarioId
          && cached.taxOptions === args.taxOptions){
        return cached.result;
      }
      const result = buildHistoricalCashFlowResult({
        ...args,
        periodId: period.id,
      });
      byPeriod.set(period.id, Object.freeze({
        plan: args.plan,
        overrides: args.overrides,
        scenarioId: args.scenarioId,
        taxOptions: args.taxOptions,
        result,
      }));
      return result;
    },
    peek,
    invalidate(analysis){
      if(analysis && typeof analysis === 'object') byAnalysis.delete(analysis);
    },
  });
}
