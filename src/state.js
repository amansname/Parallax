import {
  TYPICAL_CASH_FLOW_PATH_ID,
  normalizeCashFlowPathId,
} from './scenarios/historicalPeriods.js';

export let scenarios;
export let sharedPaths = null;
export let plansDirty = false;
export let baseSnapshot;

export const uiState = {
  get scenarios(){ return scenarios; },
  set scenarios(value){ scenarios = value; },
  addScenario(value){ scenarios.push(value); },
  removeScenarioAt(index){ scenarios.splice(index, 1); },

  get sharedPaths(){ return sharedPaths; },
  set sharedPaths(value){ sharedPaths = value; },
  appendSharedPath(value){ sharedPaths.push(value); },

  get plansDirty(){ return plansDirty; },
  set plansDirty(value){ plansDirty = value; },
  get baseSnapshot(){ return baseSnapshot; },
  set baseSnapshot(value){ baseSnapshot = value; },
};

const PATH_KEY = 'parallax.pathReplay.v1';
const DEFAULT_PATH_SEED = 20260609;
const replayValues = (() => {
  try{
    const saved = JSON.parse(localStorage.getItem(PATH_KEY) || '{}');
    return {
      mode: ['typical','stressed','favorable','sequence-stress'].includes(saved.mode) ? saved.mode : 'typical',
      seed: Math.max(1, parseInt(saved.seed, 10) || DEFAULT_PATH_SEED),
    };
  }catch{
    return { mode:'typical', seed:DEFAULT_PATH_SEED };
  }
})();

export const pathReplay = {
  get mode(){ return replayValues.mode; },
  set mode(value){ replayValues.mode = value; },
  get seed(){ return replayValues.seed; },
  set seed(value){ replayValues.seed = value; },
};

export function savePathReplay(){
  try{ localStorage.setItem(PATH_KEY, JSON.stringify(pathReplay)); }catch{}
}

const CASH_FLOW_PATH_KEY = 'parallax.cashFlowPath.v1';
const cashFlowPathValues = (() => {
  try{
    const saved = localStorage.getItem(CASH_FLOW_PATH_KEY);
    if(saved !== null) return { id: normalizeCashFlowPathId(JSON.parse(saved)) };
    // The old Cash Flow selector shared pathReplay. Its generic settings do not
    // map to a historical period, so normalization deterministically returns
    // Typical while preserving an old Typical selection.
    return { id: normalizeCashFlowPathId(JSON.parse(localStorage.getItem(PATH_KEY) || '{}')) };
  }catch{
    return { id: TYPICAL_CASH_FLOW_PATH_ID };
  }
})();

export const cashFlowPathSelection = {
  get id(){ return cashFlowPathValues.id; },
  set id(value){ cashFlowPathValues.id = normalizeCashFlowPathId(value); },
};

export function saveCashFlowPathSelection(){
  try{
    localStorage.setItem(CASH_FLOW_PATH_KEY, JSON.stringify({
      id: cashFlowPathSelection.id,
    }));
  }catch{}
}

const scenariosUiValues = {
  view: 'compare',
  cashActive: false,
  focusedId: null,
  showRange: true,
  goalsExpanded: true,
  cashFromRetirement: false,
};

export const scenariosUiState = {
  get view(){ return scenariosUiValues.view; },
  set view(value){ scenariosUiValues.view = value; },
  get cashActive(){ return scenariosUiValues.cashActive; },
  set cashActive(value){ scenariosUiValues.cashActive = value; },
  get focusedId(){ return scenariosUiValues.focusedId; },
  set focusedId(value){ scenariosUiValues.focusedId = value; },
  get showRange(){ return scenariosUiValues.showRange; },
  set showRange(value){ scenariosUiValues.showRange = value; },
  get goalsExpanded(){ return scenariosUiValues.goalsExpanded; },
  set goalsExpanded(value){ scenariosUiValues.goalsExpanded = value; },
  get cashFromRetirement(){ return scenariosUiValues.cashFromRetirement; },
  set cashFromRetirement(value){ scenariosUiValues.cashFromRetirement = value; },
};
