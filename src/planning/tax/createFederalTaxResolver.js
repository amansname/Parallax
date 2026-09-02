/* Planning-owned bridge: completed engine row -> federal Form 1040 line 24. */

import { buildPlanMetaFromEngineParams, buildRowPlanMetaFromOptions } from './buildPlanMetaFromEngineParams.js';
import { buildRowTaxableGainPlanMeta } from './taxableBasisTracker.js';
import { TaxInputError } from '../../tax/core/errors.js';
import {
  buildProjectedAnnualFederalTaxInput,
  calculateAnnualFederalTaxLiability,
  buildDefaultTaxContext,
} from '../../tax/annual1040.js';

/**
 * Create the synchronous tax-policy callback accepted by engine.runSinglePath.
 *
 * The engine remains unaware of federal modules. This planning-layer resolver
 * consumes only the completed annual row facts and returns Form 1040 line 24.
 * It is intentionally opt-in and used only for selected single paths.
 */
export function createFederalTaxResolver(params, options = {}){
  const planMeta = buildPlanMetaFromEngineParams(params, options);
  const baseRowPlanMeta = buildRowPlanMetaFromOptions(options, params);
  const rowPlanMeta = options.taxableGainFraction !== undefined
    ? baseRowPlanMeta
    : buildRowTaxableGainPlanMeta(baseRowPlanMeta);
  const contextOverrides = {
    ...(options.contextOverrides ?? {}),
    scenarioId: options.scenarioId ?? 'engine_single_path',
  };
  const contextByTaxYear = new Map();
  const line24ByFacts = new Map();

  const resolveFederalTax = (row) => {
    const unresolvedMeta = {
      ...planMeta,
      ...(rowPlanMeta ? rowPlanMeta(row, 0) : {}),
    };
    const taxYear = unresolvedMeta.taxYear
      ?? contextOverrides.taxYear
      ?? 2026;
    const meta = { ...unresolvedMeta, taxYear };
    const input = buildProjectedAnnualFederalTaxInput(row, meta);
    const factsKey = JSON.stringify(input);
    if(line24ByFacts.has(factsKey)) return line24ByFacts.get(factsKey);

    let context = contextByTaxYear.get(taxYear);
    if(!context){
      context = buildDefaultTaxContext({ ...contextOverrides, taxYear });
      contextByTaxYear.set(taxYear, context);
    }
    const line24 = calculateAnnualFederalTaxLiability(input, context);
    if(!Number.isFinite(line24)){
      throw new TaxInputError('federal tax resolver did not produce Form 1040 line 24', {
        rowYear: row?.year ?? null,
      });
    }
    line24ByFacts.set(factsKey, line24);
    return line24;
  };
  return resolveFederalTax;
}
