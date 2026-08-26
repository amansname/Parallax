export const INVALID_ASSET_WEIGHTS = 'INVALID_ASSET_WEIGHTS';
export const ASSET_ALLOCATION_PRESET_CATALOG_ID = 'asset-allocation-presets-v1';
export const ASSET_WEIGHT_TOLERANCE = 1e-9;

export const ASSET_META = Object.freeze({
  usLarge: Object.freeze({ label: 'US Large Cap', ticker: 'VFIAX', bucket: 'growth', era: 'full' }),
  usSmall: Object.freeze({ label: 'US Small Cap', ticker: 'VSMAX', bucket: 'growth', era: 'full' }),
  intlDev: Object.freeze({ label: "Int'l Developed", ticker: 'VTMGX', bucket: 'growth', era: 'post1985' }),
  emerging: Object.freeze({ label: 'Emerging Markets', ticker: 'VEMAX', bucket: 'growth', era: 'post1985' }),
  usBonds: Object.freeze({ label: 'US Bonds', ticker: 'VBTLX', bucket: 'defensive', era: 'full' }),
  cash: Object.freeze({ label: 'Cash · T-Bill', ticker: 'VUSXX', bucket: 'cash', era: 'full' }),
  reit: Object.freeze({ label: 'REIT', ticker: 'VGSLX', bucket: 'growth', era: 'post1985' }),
  gold: Object.freeze({ label: 'Gold', ticker: 'IAU', bucket: 'diversifier', era: 'full' }),
});

export const ASSET_KEYS = Object.freeze(Object.keys(ASSET_META));

const ALLOCATION_KEYS = Object.freeze([
  'weights',
  'source',
  'presetId',
  'presetVersion',
  'legacyRiskProfile',
  'reviewRequired',
]);

const PRESET_ROWS = Object.freeze([
  Object.freeze({ id: 'defensive', label: 'Defensive', percentages: Object.freeze([10, 2, 5, 2, 64, 10, 1, 6]) }),
  Object.freeze({ id: 'conservative', label: 'Conservative', percentages: Object.freeze([19, 5, 11, 3, 48, 7, 2, 5]) }),
  Object.freeze({ id: 'balanced', label: 'Balanced', percentages: Object.freeze([29, 7, 17, 4, 32, 4, 3, 4]) }),
  Object.freeze({ id: 'growth', label: 'Growth', percentages: Object.freeze([36, 9, 21, 5, 20, 2, 4, 3]) }),
  Object.freeze({ id: 'aggressive', label: 'Aggressive', percentages: Object.freeze([43, 11, 25, 7, 7, 0, 4, 3]) }),
  Object.freeze({ id: 'all-equity', label: 'All Equity', percentages: Object.freeze([48, 12, 28, 7, 0, 0, 5, 0]) }),
]);

function allocationError(message){
  return Object.assign(new Error(message), { code: INVALID_ASSET_WEIGHTS });
}

function isPlainObject(value){
  if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateAssetWeights(weights){
  if(!isPlainObject(weights)){
    throw allocationError('Asset weights must be a plain object');
  }
  const keys = Object.keys(weights);
  if(keys.length !== ASSET_KEYS.length
      || keys.some(key => !ASSET_KEYS.includes(key))
      || ASSET_KEYS.some(key => !Object.prototype.hasOwnProperty.call(weights, key))){
    throw allocationError('Asset weights must contain exactly the canonical asset keys');
  }
  let total = 0;
  for(const key of ASSET_KEYS){
    const value = weights[key];
    if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
      throw allocationError(`Asset weight ${key} must be finite and nonnegative`);
    }
    total += value;
  }
  if(Math.abs(total - 1) > ASSET_WEIGHT_TOLERANCE){
    throw allocationError('Asset weights must total 1');
  }
  return true;
}

function weightsMatch(left, right){
  return ASSET_KEYS.every(key => (
    Math.abs(left[key] - right[key]) <= ASSET_WEIGHT_TOLERANCE
  ));
}

export function snapshotAssetWeights(weights){
  validateAssetWeights(weights);
  return Object.freeze(Object.fromEntries(ASSET_KEYS.map(key => [key, weights[key]])));
}

function weightsFromPercentages(percentages){
  return snapshotAssetWeights(Object.fromEntries(
    ASSET_KEYS.map((key, index) => [key, percentages[index] / 100]),
  ));
}

export const ASSET_ALLOCATION_PRESETS = Object.freeze(PRESET_ROWS.map(row => Object.freeze({
  id: row.id,
  label: row.label,
  version: ASSET_ALLOCATION_PRESET_CATALOG_ID,
  weights: weightsFromPercentages(row.percentages),
})));

const presetById = new Map(ASSET_ALLOCATION_PRESETS.map(preset => [preset.id, preset]));

export function getAssetAllocationPreset(presetId){
  const preset = presetById.get(presetId);
  if(!preset) throw allocationError(`Unknown asset-allocation preset: ${presetId}`);
  return preset;
}

function freezeAllocation(value){
  return Object.freeze({
    weights: snapshotAssetWeights(value.weights),
    source: value.source,
    presetId: value.presetId,
    presetVersion: value.presetVersion,
    legacyRiskProfile: value.legacyRiskProfile,
    reviewRequired: value.reviewRequired,
  });
}

export function validateInvestmentAllocation(allocation){
  if(!isPlainObject(allocation)){
    throw allocationError('Investment allocation must be a plain object');
  }
  const keys = Object.keys(allocation);
  if(keys.length !== ALLOCATION_KEYS.length
      || ALLOCATION_KEYS.some(key => !Object.prototype.hasOwnProperty.call(allocation, key))){
    throw allocationError('Investment allocation has an invalid contract shape');
  }
  validateAssetWeights(allocation.weights);
  if(!['preset', 'custom', 'legacy-risk-profile', 'cash-only'].includes(allocation.source)){
    throw allocationError('Investment allocation has an invalid source');
  }
  if(typeof allocation.reviewRequired !== 'boolean'){
    throw allocationError('Investment allocation reviewRequired must be boolean');
  }
  if(allocation.presetId !== null || allocation.presetVersion !== null){
    if(typeof allocation.presetId !== 'string'
        || allocation.presetVersion !== ASSET_ALLOCATION_PRESET_CATALOG_ID
        || !presetById.has(allocation.presetId)){
      throw allocationError('Investment allocation has invalid preset provenance');
    }
  }
  if(allocation.source === 'preset'){
    if(allocation.presetId === null || allocation.legacyRiskProfile !== null || allocation.reviewRequired){
      throw allocationError('Preset allocation provenance is invalid');
    }
    const preset = getAssetAllocationPreset(allocation.presetId);
    if(!weightsMatch(allocation.weights, preset.weights)){
      throw allocationError('Preset allocation weights do not match their provenance');
    }
  }
  if(allocation.source === 'custom'){
    const hasPresetAncestry = allocation.presetId !== null;
    const hasLegacyAncestry = allocation.legacyRiskProfile !== null;
    if(hasPresetAncestry && hasLegacyAncestry){
      throw allocationError('Custom allocation cannot combine preset and legacy provenance');
    }
    if(hasLegacyAncestry){
      if(!Number.isInteger(allocation.legacyRiskProfile)
          || allocation.legacyRiskProfile < 1
          || allocation.legacyRiskProfile > 6
          || !allocation.reviewRequired){
        throw allocationError('Custom allocation legacy provenance is invalid');
      }
      snapshotLegacyRiskProfileAllocation(allocation.legacyRiskProfile);
    }else if(allocation.reviewRequired){
      throw allocationError('Custom allocation review state requires legacy provenance');
    }
  }
  if(allocation.source === 'legacy-risk-profile'){
    if(!Number.isInteger(allocation.legacyRiskProfile)
        || allocation.legacyRiskProfile < 1
        || allocation.legacyRiskProfile > 6
        || allocation.presetId !== null
        || allocation.presetVersion !== null
        || !allocation.reviewRequired){
      throw allocationError('Legacy allocation provenance is invalid');
    }
    const legacySnapshot = snapshotLegacyRiskProfileAllocation(allocation.legacyRiskProfile);
    if(!weightsMatch(allocation.weights, legacySnapshot.weights)){
      throw allocationError('Legacy allocation weights do not match their migration provenance');
    }
  }
  if(allocation.source === 'cash-only'){
    if(allocation.presetId !== null
        || allocation.presetVersion !== null
        || allocation.legacyRiskProfile !== null
        || allocation.reviewRequired
        || ASSET_KEYS.some(key => allocation.weights[key] !== (key === 'cash' ? 1 : 0))){
      throw allocationError('Cash-only allocation is invalid');
    }
  }
  return true;
}

export function cloneInvestmentAllocation(allocation){
  validateInvestmentAllocation(allocation);
  return freezeAllocation(allocation);
}

export function snapshotPresetAllocation(presetId = 'balanced'){
  const preset = getAssetAllocationPreset(presetId);
  return freezeAllocation({
    weights: preset.weights,
    source: 'preset',
    presetId: preset.id,
    presetVersion: preset.version,
    legacyRiskProfile: null,
    reviewRequired: false,
  });
}

export function resolveCashOnlyAllocation(){
  return freezeAllocation({
    weights: Object.fromEntries(ASSET_KEYS.map(key => [key, key === 'cash' ? 1 : 0])),
    source: 'cash-only',
    presetId: null,
    presetVersion: null,
    legacyRiskProfile: null,
    reviewRequired: false,
  });
}

const LEGACY_EQUITY_MIX = Object.freeze({
  usLarge: 0.50,
  usSmall: 0.10,
  intlDev: 0.22,
  emerging: 0.08,
  reit: 0.10,
});
const LEGACY_DEFENSIVE_MIX = Object.freeze({ usBonds: 0.75, cash: 0.17, gold: 0.08 });
const LEGACY_EQUITY_SHARES = Object.freeze({ 1: 0.30, 2: 0.45, 3: 0.60, 4: 0.75, 5: 0.90, 6: 1 });

export function snapshotLegacyRiskProfileAllocation(riskProfile){
  const equityShare = LEGACY_EQUITY_SHARES[riskProfile];
  if(typeof equityShare !== 'number'){
    throw allocationError('Legacy risk profile is invalid');
  }
  const fixedIncomeShare = 1 - equityShare;
  const weights = Object.fromEntries(ASSET_KEYS.map(key => [key, 0]));
  for(const [key, share] of Object.entries(LEGACY_EQUITY_MIX)){
    weights[key] += equityShare * share;
  }
  for(const [key, share] of Object.entries(LEGACY_DEFENSIVE_MIX)){
    weights[key] += fixedIncomeShare * share;
  }
  return freezeAllocation({
    weights,
    source: 'legacy-risk-profile',
    presetId: null,
    presetVersion: null,
    legacyRiskProfile: riskProfile,
    reviewRequired: true,
  });
}

export function withCustomAssetWeights(allocation, weights){
  validateInvestmentAllocation(allocation);
  return freezeAllocation({
    weights,
    source: 'custom',
    presetId: allocation.presetId,
    presetVersion: allocation.presetVersion,
    legacyRiskProfile: allocation.legacyRiskProfile,
    reviewRequired: allocation.reviewRequired,
  });
}

export function identifyInvestmentAllocation(allocation){
  validateInvestmentAllocation(allocation);
  if(allocation.source === 'custom'){
    const basedOn = allocation.presetId === null ? null : getAssetAllocationPreset(allocation.presetId).label;
    return Object.freeze({ id: 'custom', label: 'Custom', basedOn });
  }
  if(allocation.source === 'preset'){
    const preset = getAssetAllocationPreset(allocation.presetId);
    return Object.freeze({ id: preset.id, label: preset.label, basedOn: null });
  }
  if(allocation.source === 'cash-only'){
    return Object.freeze({ id: 'cash-only', label: 'Cash', basedOn: null });
  }
  return Object.freeze({ id: 'legacy-risk-profile', label: 'Custom', basedOn: null });
}

export function calculateBalanceWeightedAllocation(accounts){
  if(!Array.isArray(accounts)){
    throw allocationError('Allocation accounts must be an array');
  }
  const totals = Object.fromEntries(ASSET_KEYS.map(key => [key, 0]));
  let totalBalance = 0;
  const accountIds = [];
  for(const [index, account] of accounts.entries()){
    if(!isPlainObject(account)){
      throw allocationError(`Allocation account ${index} must be an object`);
    }
    const balance = account.balance;
    if(typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0){
      throw allocationError(`Allocation account ${index} has an invalid balance`);
    }
    if(balance === 0) continue;
    validateInvestmentAllocation(account.investmentAllocation);
    totalBalance += balance;
    accountIds.push(account.id ?? null);
    for(const key of ASSET_KEYS){
      totals[key] += balance * account.investmentAllocation.weights[key];
    }
  }
  if(totalBalance === 0) return null;
  return Object.freeze({
    totalBalance,
    weights: snapshotAssetWeights(Object.fromEntries(
      ASSET_KEYS.map(key => [key, totals[key] / totalBalance]),
    )),
    accountIds: Object.freeze(accountIds),
  });
}
