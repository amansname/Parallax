/* Planning-layer wrapper: simulation path → annual federal tax by year.
   Reshapes rows and delegates all tax math to the annual1040 module. */

import {
  buildDefaultTaxContext,
  calculateAnnualFederalTax,
  engineYearTo1040Input,
  mapSimulationRowToYearFacts,
} from '../../tax/annual1040.js';
import { TaxInputError } from '../../tax/core/errors.js';

function assertPlainObject(value, label){
  if(value === null || typeof value !== 'object' || Array.isArray(value)){
    throw new TaxInputError(`${label} must be a plain object`, { received: typeof value });
  }
}

function resolveYearKey(row, index){
  if(row?.year != null) return row.year;
  return index + 1;
}

function resolveRowPlanMeta(row, index, planMeta, rowPlanMeta){
  const base = { ...planMeta, ...(rowPlanMeta ? rowPlanMeta(row, index) : {}) };
  if(base.filingStatus === undefined || base.filingStatus === null){
    throw new TaxInputError('planMeta is missing filingStatus', { field: 'filingStatus', rowIndex: index });
  }
  return base;
}

function isFailedFillerRow(row){
  return row.failed === true && row.source === null;
}

/**
 * Run annual federal tax for each simulation row in a path.
 *
 * @param {object[]} rows - engine-shaped year rows (plain data)
 * @param {object} planMeta - shared filing status, tax year, deductions, gain split, etc.
 * @param {object} [options]
 * @param {object} [options.contextOverrides] - passed to buildDefaultTaxContext
 * @param {(row: object, index: number) => object} [options.rowPlanMeta] - per-row planMeta merge
 * Post-depletion filler rows (failed with a null source) are not tax years and
 * are skipped. The real failure year retains its non-null source and is run.
 *
 * @returns {{ results: object[], byYear: Record<string|number, object> }}
 */
export function runTaxForScenarioPath(rows, planMeta, options = {}){
  if(!Array.isArray(rows)){
    throw new TaxInputError('rows must be an array', { received: typeof rows });
  }
  assertPlainObject(planMeta, 'planMeta');

  const { contextOverrides = {}, rowPlanMeta = null } = options;
  const results = [];
  const byYear = {};

  for(let index = 0; index < rows.length; index++){
    const row = rows[index];
    assertPlainObject(row, `rows[${index}]`);
    if(isFailedFillerRow(row)) continue;
    const meta = resolveRowPlanMeta(row, index, planMeta, rowPlanMeta);
    const yearKey = resolveYearKey(row, index);
    const taxYear = meta.taxYear ?? contextOverrides.taxYear ?? 2026;
    const yearMeta = { ...meta, taxYear };
    const context = buildDefaultTaxContext({
      ...contextOverrides,
      taxYear,
      scenarioId: `${contextOverrides.scenarioId ?? 'scenario_path'}_${yearKey}`,
    });

    const facts = mapSimulationRowToYearFacts(row, yearMeta);
    const input = engineYearTo1040Input(facts);
    const pipeline = calculateAnnualFederalTax(input, context);
    const entry = {
      year: yearKey,
      rowIndex: index,
      facts,
      input,
      context,
      ...pipeline,
    };

    results.push(entry);
    byYear[yearKey] = pipeline.annual1040Result;
  }

  return { results, byYear };
}
