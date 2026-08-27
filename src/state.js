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
const PATH_REPLAY_MODES = Object.freeze([
  'typical',
  'stressed',
  'favorable',
  'sequence-stress',
]);

function normalizePathSeed(value){
  const numeric = Number(value);
  if(!Number.isFinite(numeric)) return 1;
  return (Math.trunc(numeric) >>> 0) || 1;
}

export function generateFreshPathSeed({
  cryptoApi = globalThis.crypto,
  random = Math.random,
} = {}){
  try{
    if(typeof cryptoApi?.getRandomValues === 'function'){
      const values = new Uint32Array(1);
      cryptoApi.getRandomValues(values);
      return normalizePathSeed(values[0]);
    }
  }catch{}

  const sample = Number(random());
  const bounded = Number.isFinite(sample)
    ? Math.min(0.9999999999999999, Math.max(0, sample))
    : 0;
  return normalizePathSeed(Math.floor(bounded * 0xFFFFFFFF) + 1);
}

export function createPathReplaySession({
  storage = globalThis.localStorage,
  generateSeed = generateFreshPathSeed,
} = {}){
  let mode = 'typical';
  try{
    const saved = JSON.parse(storage?.getItem(PATH_KEY) || '{}');
    mode = PATH_REPLAY_MODES.includes(saved.mode) ? saved.mode : 'typical';
    if(Object.prototype.hasOwnProperty.call(saved, 'seed')){
      storage?.setItem(PATH_KEY, JSON.stringify({ mode }));
    }
  }catch{}

  let sessionSeed = null;
  const pathReplay = {
    get mode(){ return mode; },
    set mode(value){ mode = value; },
    get seed(){
      if(sessionSeed === null) sessionSeed = normalizePathSeed(generateSeed());
      return sessionSeed;
    },
  };

  function refreshPathSeed(){
    const generatedSeed = normalizePathSeed(generateSeed());
    sessionSeed = sessionSeed !== null && generatedSeed === sessionSeed
      ? normalizePathSeed(generatedSeed + 1)
      : generatedSeed;
    return sessionSeed;
  }

  function savePathReplay(){
    try{
      storage?.setItem(PATH_KEY, JSON.stringify({ mode: pathReplay.mode }));
    }catch{}
  }

  return Object.freeze({
    pathReplay,
    refreshPathSeed,
    savePathReplay,
  });
}

const pathReplaySession = createPathReplaySession();

export const pathReplay = pathReplaySession.pathReplay;
export const refreshPathSeed = pathReplaySession.refreshPathSeed;
export const savePathReplay = pathReplaySession.savePathReplay;

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
