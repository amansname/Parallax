import { pathDigest } from '../../engine.js';
import { buildCashFlowHeaderMetrics } from './buildCashFlowHeaderMetrics.js';
import { createHistoricalCashFlowCache } from './buildHistoricalCashFlowResult.js';
import {
  CASH_FLOW_PATH_OPTIONS,
  RANDOM_CASH_FLOW_PATH_ID,
  TYPICAL_CASH_FLOW_PATH_ID,
} from './historicalPeriods.js';

function simulationByIndex(result, simIndex){
  if(!result || !Array.isArray(result.sims)) return null;
  return result.sims.find(simulation => simulation?.simIndex === simIndex) ?? null;
}

function freezeSelectedResult(result){
  return Object.freeze({
    ...result,
    rows: Object.freeze([...(result.rows ?? [])]),
    summary: result.summary && typeof result.summary === 'object'
      ? Object.freeze({ ...result.summary })
      : result.summary,
  });
}

export function baselineP50SimulationIndex(scenarios){
  const list = Array.isArray(scenarios) ? scenarios : [];
  const baseline = list.find(scenario => scenario?.base) ?? list[0] ?? null;
  const simIndex = baseline?.res?.paths?.p50?.simIndex;
  return Number.isInteger(simIndex) && simIndex >= 0 ? simIndex : null;
}

function baselineSimulationIndices(scenarios){
  const list = Array.isArray(scenarios) ? scenarios : [];
  const baseline = list.find(scenario => scenario?.base) ?? list[0] ?? null;
  if(!Array.isArray(baseline?.res?.sims)) return [];
  const seen = new Set();
  return baseline.res.sims.reduce((indices, simulation) => {
    const simIndex = simulation?.simIndex;
    if(Number.isInteger(simIndex) && simIndex >= 0 && !seen.has(simIndex)){
      seen.add(simIndex);
      indices.push(simIndex);
    }
    return indices;
  }, []);
}

export function createCashFlowController({
  getScenarios,
  scenarioInputsByResult,
  selection,
  saveSelection,
  historicalCache = createHistoricalCashFlowCache(),
  digest = pathDigest,
  buildRows,
  random = Math.random,
  currentYear = () => new Date().getFullYear(),
  onError = (...args) => console.error(...args),
  onHeaderDiagnostic = (...args) => console.warn(...args),
}){
  if(typeof getScenarios !== 'function') throw new TypeError('getScenarios is required');
  if(!scenarioInputsByResult || typeof scenarioInputsByResult.get !== 'function'){
    throw new TypeError('scenarioInputsByResult is required');
  }
  if(!selection || typeof selection !== 'object') throw new TypeError('selection is required');
  if(typeof buildRows !== 'function') throw new TypeError('buildRows is required');

  let sessionPathId = null;
  let randomSimIndex = null;

  function activePathId(){
    return sessionPathId ?? selection.id;
  }

  function isTypical(){
    return activePathId() === TYPICAL_CASH_FLOW_PATH_ID;
  }

  function isRandom(){
    return activePathId() === RANDOM_CASH_FLOW_PATH_ID;
  }

  function pickRandomSimulationIndex({ avoid = null, avoidTypical = false } = {}){
    const allIndices = baselineSimulationIndices(getScenarios());
    if(allIndices.length === 0) return null;

    let candidates = allIndices.filter(simIndex => simIndex !== avoid);
    if(candidates.length === 0) candidates = allIndices;

    if(avoidTypical && candidates.length > 1){
      const typicalIndex = baselineP50SimulationIndex(getScenarios());
      const nonTypical = candidates.filter(simIndex => simIndex !== typicalIndex);
      if(nonTypical.length > 0) candidates = nonTypical;
    }

    const sample = Number(random());
    const bounded = Number.isFinite(sample)
      ? Math.min(0.9999999999999999, Math.max(0, sample))
      : 0;
    return candidates[Math.floor(bounded * candidates.length)] ?? candidates[0];
  }

  function ensureRandomSimulationIndex(){
    const indices = baselineSimulationIndices(getScenarios());
    if(indices.includes(randomSimIndex)) return randomSimIndex;
    randomSimIndex = pickRandomSimulationIndex({ avoidTypical: true });
    return randomSimIndex;
  }

  function randomSimulationIndex(){
    return randomSimIndex;
  }

  function setPathId(pathId, { persist = false } = {}){
    const requested = typeof pathId === 'string'
      ? pathId.trim().toLowerCase()
      : pathId;
    if(requested === RANDOM_CASH_FLOW_PATH_ID){
      sessionPathId = RANDOM_CASH_FLOW_PATH_ID;
      ensureRandomSimulationIndex();
      return activePathId();
    }

    sessionPathId = null;
    selection.id = pathId;
    if(persist && typeof saveSelection === 'function') saveSelection();
    return activePathId();
  }

  function regenerateRandomPath(){
    if(!isRandom()) return null;
    const current = ensureRandomSimulationIndex();
    randomSimIndex = pickRandomSimulationIndex({ avoid: current });
    return randomSimIndex;
  }

  function resetSessionPath(){
    sessionPathId = null;
    randomSimIndex = null;
  }

  function historicalArgsForScenario(scenario, periodId){
    if(!scenario?.res) return null;
    const runInputs = scenarioInputsByResult.get(scenario.res);
    if(!runInputs) return null;
    return {
      analysis: scenario.res,
      plan: runInputs.plan,
      overrides: runInputs.overrides,
      periodId,
      scenarioId: `cash_flow_${scenario.name}`,
    };
  }

  function knownHistoricalOutcome(scenario, periodId){
    if(typeof historicalCache.peek !== 'function') return null;
    const args = historicalArgsForScenario(scenario, periodId);
    if(!args) return null;
    const outcome = historicalCache.peek(args)?.summary?.outcome;
    return outcome === 'survives' || outcome === 'underfunded' ? outcome : null;
  }

  function headerMetricsOrNull(argsOrFactory, scenario, pathId){
    try{
      const args = typeof argsOrFactory === 'function' ? argsOrFactory() : argsOrFactory;
      return buildCashFlowHeaderMetrics(args);
    }catch(error){
      onHeaderDiagnostic('Cash Flow header unavailable:', scenario?.name, pathId, error);
      return null;
    }
  }

  function syncSelect(select, scenario = null){
    if(!select) return;
    const currentIds = [...select.options].map(option => option.value);
    const expectedIds = CASH_FLOW_PATH_OPTIONS.map(option => option.id);
    if(JSON.stringify(currentIds) !== JSON.stringify(expectedIds)){
      select.replaceChildren(...CASH_FLOW_PATH_OPTIONS.map(option => {
        const element = select.ownerDocument.createElement('option');
        element.value = option.id;
        return element;
      }));
    }
    const pathId = activePathId();
    select.value = pathId;
    [...select.options].forEach((element, index) => {
      const option = CASH_FLOW_PATH_OPTIONS[index];
      const outcome = option?.kind === 'historical'
        ? knownHistoricalOutcome(scenario, option.id)
        : null;
      const glyph = outcome === 'survives' ? '✓' : outcome === 'underfunded' ? '!' : '';
      element.textContent = glyph && option.id !== pathId
        ? `${glyph} ${option.label}`
        : option.label;
      if(outcome) element.dataset.outcome = outcome;
      else delete element.dataset.outcome;
    });

    const selectedOption = CASH_FLOW_PATH_OPTIONS.find(option => option.id === pathId);
    const selectedOutcome = selectedOption?.kind === 'historical'
      ? knownHistoricalOutcome(scenario, pathId)
      : null;
    const status = select.ownerDocument?.getElementById('cashflow-path-status') ?? null;
    if(status){
      status.textContent = selectedOutcome === 'survives'
        ? '✓'
        : selectedOutcome === 'underfunded'
          ? '!'
          : '';
      status.hidden = !selectedOutcome;
      status.classList.toggle('is-success', selectedOutcome === 'survives');
      status.classList.toggle('is-underfunded', selectedOutcome === 'underfunded');
      if(selectedOutcome){
        status.setAttribute(
          'aria-label',
          selectedOutcome === 'survives'
            ? 'Historical path funded through plan end'
            : 'Historical path becomes underfunded'
        );
      }else{
        status.removeAttribute('aria-label');
      }
    }
  }

  function resultForScenario(scenario){
    const pathId = activePathId();
    const kind = isTypical() ? 'typical' : isRandom() ? 'random' : 'historical';
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

      if(kind === 'typical' || kind === 'random'){
        const simIndex = kind === 'random'
          ? ensureRandomSimulationIndex()
          : baselineP50SimulationIndex(getScenarios());
        if(simIndex === null){
          throw new Error(`${kind === 'random' ? 'Random' : 'baseline Typical'} simulation identity is unavailable`);
        }
        const simulation = simulationByIndex(scenario.res, simIndex);
        if(!simulation?.rows) throw new Error(`shared ${kind === 'random' ? 'Random' : 'Typical'} simulation is unavailable`);
        const summary = digest(simulation);
        const headerMetrics = headerMetricsOrNull({
          typicalSimulation: simulation,
          typicalDigest: summary,
        }, scenario, pathId);
        return freezeSelectedResult({
          kind,
          pathId,
          simIndex,
          simulation,
          rows: buildRows(simulation, { plan: scenarioPlan, currentYear: displayYear }),
          summary,
          ...(headerMetrics ? { headerMetrics } : {}),
          taxScope: scenario.res?.federalFunding?.semantics?.convergence === 'per-year-to-one-cent'
            ? 'MODELED_FEDERAL_LINE_24'
            : null,
        });
      }

      const historical = historicalCache.get(
        historicalArgsForScenario(scenario, pathId)
      );
      const historicalRows = buildRows(historical.simulation, {
        plan: scenarioPlan,
        currentYear: displayYear,
      });
      const headerMetrics = headerMetricsOrNull(() => {
        const simIndex = baselineP50SimulationIndex(getScenarios());
        if(simIndex === null) throw new Error('baseline Typical simulation identity is unavailable');
        const typicalSimulation = simulationByIndex(scenario.res, simIndex);
        if(!typicalSimulation?.rows) throw new Error('shared Typical simulation is unavailable');
        return {
          historicalResult: historical,
          typicalSimulation,
          typicalDigest: digest(typicalSimulation),
        };
      }, scenario, pathId);
      return freezeSelectedResult({
        ...historical,
        rows: historicalRows,
        ...(headerMetrics ? { headerMetrics } : {}),
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
    activePathId,
    isTypical,
    isRandom,
    randomSimulationIndex,
    regenerateRandomPath,
    resetSessionPath,
    resultForScenario,
    setPathId,
    syncSelect,
  });
}
