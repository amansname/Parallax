/* Attach a federal 1040 tax summary for a selected scenario story path. */

import { ANNUAL_1040_MODULE_VERSION } from '../../tax/annual1040.js';
import { TaxInputError } from '../../tax/core/errors.js';
import { buildPlanMetaFromEngineParams, buildRowPlanMetaFromOptions } from './buildPlanMetaFromEngineParams.js';
import { buildRowTaxableGainPlanMeta } from './taxableBasisTracker.js';
import { runTaxForScenarioPath } from './runTaxForScenarioPath.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function assertAnalysis(analysis){
  if(analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)){
    throw new TaxInputError('analysis must be a plain object', { received: typeof analysis });
  }
}

function isAccumulationRow(row, retirementAge){
  if(row.phase === 'accum') return true;
  if(retirementAge != null && row.age != null && row.age < retirementAge) return true;
  return false;
}

function selectRetirementRows(rows, retirementAge){
  if(!Array.isArray(rows)) return [];
  return rows.filter((row) => !isAccumulationRow(row, retirementAge));
}

function dedupeWarnings(warnings){
  const seen = new Set();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if(seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptySummary(selected, pathKey){
  const engineLifetimeTax = selected.lifetimeTax ?? null;
  return {
    path: pathKey,
    simIndex: selected.simIndex ?? null,
    moduleVersion: ANNUAL_1040_MODULE_VERSION,
    years: [],
    totals: {
      federalTaxLiability: 0,
      enginePathTax: 0,
      engineLifetimeTax,
      deltaVsEnginePath: 0,
      deltaVsEngineLifetime: engineLifetimeTax != null ? round2(-engineLifetimeTax) : null,
    },
    warnings: [],
    scope: 'INCOME_TAX_ONLY',
  };
}

/**
 * Run federal tax on one selected analysis path's retirement rows.
 * Returns a slim summary — does not mutate analysis or engine tax fields.
 */
export function attachPathFederalTax(analysis, pathKey, options = {}){
  assertAnalysis(analysis);
  if(!['p10', 'p50', 'p90'].includes(pathKey)){
    throw new TaxInputError('pathKey must be p10, p50, or p90');
  }

  const selected = analysis.paths?.[pathKey];
  if(!selected || !Array.isArray(selected.rows)){
    throw new TaxInputError(`analysis.paths.${pathKey}.rows is required`);
  }

  const params = analysis.params ?? {};
  const retirementAge = params.retirementAge ?? params.currentAge ?? null;
  const rows = selectRetirementRows(selected.rows, retirementAge);
  if(rows.length === 0) return emptySummary(selected, pathKey);

  const planMeta = buildPlanMetaFromEngineParams(params, options);
  const baseRowPlanMeta = buildRowPlanMetaFromOptions(options, params);
  const rowPlanMeta = options.taxableGainFraction !== undefined
    ? baseRowPlanMeta
    : buildRowTaxableGainPlanMeta(baseRowPlanMeta);
  const scenarioId = options.scenarioId ?? `${pathKey}_path`;

  const { results } = runTaxForScenarioPath(rows, planMeta, {
    contextOverrides: { ...(options.contextOverrides ?? {}), scenarioId },
    rowPlanMeta,
  });

  const years = [];
  const warnings = [];
  let federalTotal = 0;
  let enginePathTotal = 0;
  let scope = 'INCOME_TAX_ONLY';

  for(const entry of results){
    const sourceRow = rows[entry.rowIndex];
    const annual = entry.annual1040Result;
    const engineTax = sourceRow?.taxes ?? 0;
    const federalTaxLiability = annual.lines.line24.value ?? 0;

    federalTotal += federalTaxLiability;
    enginePathTotal += engineTax;
    scope = annual.federalSummary.taxTotalScope ?? scope;
    warnings.push(...(annual.warnings ?? []));

    years.push({
      year: entry.year,
      age: sourceRow?.age ?? null,
      filingStatus: entry.facts.filingStatus,
      agi: annual.lines.line11.value,
      taxableIncome: annual.lines.line15.value,
      federalTaxLiability,
      marginalRate: annual.federalSummary.marginalRate,
      engineTax: round2(engineTax),
      delta: round2(federalTaxLiability - engineTax),
    });
  }

  const engineLifetimeTax = selected.lifetimeTax ?? null;
  const federalTaxLiability = round2(federalTotal);
  const enginePathTax = round2(enginePathTotal);

  return {
    path: pathKey,
    simIndex: selected.simIndex ?? null,
    moduleVersion: ANNUAL_1040_MODULE_VERSION,
    years,
    totals: {
      federalTaxLiability,
      enginePathTax,
      engineLifetimeTax,
      deltaVsEnginePath: round2(federalTaxLiability - enginePathTax),
      deltaVsEngineLifetime: engineLifetimeTax != null
        ? round2(federalTaxLiability - engineLifetimeTax)
        : null,
    },
    warnings: dedupeWarnings(warnings),
    scope,
  };
}

/** Backward-compatible p50 summary entry point. */
export function attachTypicalPathFederalTax(analysis, options = {}){
  return attachPathFederalTax(analysis, 'p50', options);
}
