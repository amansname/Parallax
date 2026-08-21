import { pathDigest } from '../../engine.js';
import { createHistoricalCashFlowCache } from './buildHistoricalCashFlowResult.js';
import {
  CASH_FLOW_PATH_OPTIONS,
  TYPICAL_CASH_FLOW_PATH_ID,
} from './historicalPeriods.js';

function simulationByIndex(result, simIndex){
  if(!result || !Array.isArray(result.sims)) return null;
  return result.sims.find(simulation => simulation?.simIndex === simIndex) ?? null;
}

function federalTaxTotal(simulation){
  const rows = simulation?.rows;
  if(!Array.isArray(rows) || rows.length === 0) return null;
  if(rows.some(row => !Number.isFinite(row?.taxes))) return null;
  return rows.reduce((total, row) => total + row.taxes, 0);
}

function freezeSelectedResult(result){
  return Object.freeze({
    ...result,
    rows: Object.freeze([...(result.rows ?? [])]),
  });
}

export function baselineP50SimulationIndex(scenarios){
  const list = Array.isArray(scenarios) ? scenarios : [];
  const baseline = list.find(scenario => scenario?.base) ?? list[0] ?? null;
  const simIndex = baseline?.res?.paths?.p50?.simIndex;
  return Number.isInteger(simIndex) && simIndex >= 0 ? simIndex : null;
}

export function createCashFlowController({
  getScenarios,
  scenarioInputsByResult,
  selection,
  saveSelection,
  historicalCache = createHistoricalCashFlowCache(),
  digest = pathDigest,
  buildRows,
  currentYear = () => new Date().getFullYear(),
  onError = (...args) => console.error(...args),
}){
  if(typeof getScenarios !== 'function') throw new TypeError('getScenarios is required');
  if(!scenarioInputsByResult || typeof scenarioInputsByResult.get !== 'function'){
    throw new TypeError('scenarioInputsByResult is required');
  }
  if(!selection || typeof selection !== 'object') throw new TypeError('selection is required');
  if(typeof buildRows !== 'function') throw new TypeError('buildRows is required');

  function isTypical(){
    return selection.id === TYPICAL_CASH_FLOW_PATH_ID;
  }

  function setPathId(pathId, { persist = false } = {}){
    selection.id = pathId;
    if(persist && typeof saveSelection === 'function') saveSelection();
  }

  function syncSelect(select){
    if(!select) return;
    const currentIds = [...select.options].map(option => option.value);
    const expectedIds = CASH_FLOW_PATH_OPTIONS.map(option => option.id);
    if(JSON.stringify(currentIds) !== JSON.stringify(expectedIds)){
      select.replaceChildren(...CASH_FLOW_PATH_OPTIONS.map(option => {
        const element = select.ownerDocument.createElement('option');
        element.value = option.id;
        element.textContent = option.label;
        return element;
      }));
    }
    select.value = selection.id;
  }

  function resultForScenario(scenario){
    const pathId = selection.id;
    const kind = isTypical() ? 'typical' : 'historical';
    if(!scenario?.res){
      return freezeSelectedResult({
        kind,
        pathId,
        rows: [],
        summary: {},
        error: 'Run this plan to build Cash Flow.',
      });
    }

    try{
      const runInputs = scenarioInputsByResult.get(scenario.res);
      if(!runInputs) throw new Error('scenario run inputs are unavailable');
      const scenarioPlan = runInputs.plan;
      const displayYear = Number.isInteger(scenarioPlan.meta?.planningAsOfYear)
        ? scenarioPlan.meta.planningAsOfYear
        : currentYear();

      if(kind === 'typical'){
        const simIndex = baselineP50SimulationIndex(getScenarios());
        if(simIndex === null) throw new Error('baseline Typical simulation identity is unavailable');
        const simulation = simulationByIndex(scenario.res, simIndex);
        if(!simulation?.rows) throw new Error('shared Typical simulation is unavailable');
        const summary = digest(simulation);
        return freezeSelectedResult({
          kind,
          pathId,
          simulation,
          rows: buildRows(simulation, { plan: scenarioPlan, currentYear: displayYear }),
          summary: {
            ...summary,
            federalTotal: federalTaxTotal(simulation),
          },
          taxScope: scenario.res?.federalFunding?.semantics?.convergence === 'per-year-to-one-cent'
            ? 'MODELED_FEDERAL_LINE_24'
            : null,
        });
      }

      const historical = historicalCache.get({
        analysis: scenario.res,
        plan: scenarioPlan,
        overrides: runInputs.overrides,
        periodId: pathId,
        scenarioId: `cash_flow_${scenario.name}`,
      });
      return freezeSelectedResult({
        ...historical,
        rows: buildRows(historical.simulation, {
          plan: scenarioPlan,
          currentYear: displayYear,
        }),
      });
    }catch(error){
      onError('Cash Flow unavailable:', scenario.name, pathId, error);
      return freezeSelectedResult({
        kind,
        pathId,
        rows: [],
        summary: {},
        error: 'This path is unavailable because its retirement handoff could not be verified.',
      });
    }
  }

  return Object.freeze({
    isTypical,
    resultForScenario,
    setPathId,
    syncSelect,
  });
}
