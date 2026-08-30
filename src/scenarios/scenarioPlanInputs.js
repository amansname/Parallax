import { ACCOUNT_SCHEMA_VERSION, getAccountTypeById } from '../household/accountTypes.js';
import {
  ASSET_ALLOCATION_PRESETS,
  identifyInvestmentAllocation,
  snapshotPresetAllocation,
} from '../household/investmentAllocation.js';
import {
  registerTransientProjectionAccountState,
} from '../household/transientProjectionAccountState.js';

const CURRENT_ALLOCATION_ID = 'current';
const presetIds = new Set(ASSET_ALLOCATION_PRESETS.map(preset => preset.id));
const legacyRiskProfileByPresetId = new Map(
  ASSET_ALLOCATION_PRESETS.map((preset, index) => [preset.id, index + 1]),
);

export const SCENARIO_ALLOCATION_OPTIONS = Object.freeze([
  Object.freeze({ value: CURRENT_ALLOCATION_ID, label: 'Current mix' }),
  ...ASSET_ALLOCATION_PRESETS.map(preset => Object.freeze({
    value: preset.id,
    label: preset.label,
  })),
]);

function currentAllocationRecords(plan){
  const baseAccounts = Object.values(plan?.portfolio?.accounts || {})
    .filter(account => account && account.balance > 0);
  const typedAccounts = (Array.isArray(plan?.portfolio?.extraAccounts)
    ? plan.portfolio.extraAccounts
    : [])
    .filter(account => (
      getAccountTypeById(account?.typeId)?.investmentAllocationEligible === true
    ));
  return [...baseAccounts, ...typedAccounts];
}

export function resolveCurrentScenarioAllocation(plan){
  const records = currentAllocationRecords(plan);
  if(records.length === 0) return CURRENT_ALLOCATION_ID;
  const identities = records.map(account => (
    account.investmentAllocation
      ? identifyInvestmentAllocation(account.investmentAllocation)
      : { id: 'custom' }
  ));
  const first = identities[0].id;
  return first !== 'custom'
    && first !== 'legacy-risk-profile'
    && first !== 'cash-only'
    && identities.every(identity => identity.id === first)
    ? first
    : CURRENT_ALLOCATION_ID;
}

function integerAge(value, { min, max, path }){
  if(!Number.isInteger(value) || value < min || value > max){
    throw new RangeError(`${path} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function applyPersonAges(plan, levers){
  plan.household.primary.retirementAge = integerAge(levers.retireAge, {
    min: 45,
    max: 90,
    path: 'scenario.client.retirementAge',
  });
  plan.income.socialSecurity.primary.claimAge = integerAge(levers.ssAge, {
    min: 62,
    max: 70,
    path: 'scenario.client.socialSecurityAge',
  });
  if(!plan.household.spouse) return;
  if(!plan.income?.socialSecurity?.spouse){
    throw new TypeError('income.socialSecurity.spouse is required for a spouse scenario');
  }
  plan.household.spouse.retirementAge = integerAge(levers.spouseRetireAge, {
    min: 45,
    max: 90,
    path: 'scenario.spouse.retirementAge',
  });
  plan.income.socialSecurity.spouse.claimAge = integerAge(levers.spouseSsAge, {
    min: 62,
    max: 70,
    path: 'scenario.spouse.socialSecurityAge',
  });
}

function applyAllocationPreset(plan, presetId){
  if(presetId === CURRENT_ALLOCATION_ID) return;
  if(!presetIds.has(presetId)){
    throw new RangeError(`Unknown scenario allocation model: ${presetId}`);
  }
  const allocation = snapshotPresetAllocation(presetId);
  const investmentAllocationById = new Map();
  Object.entries(plan.portfolio.accounts || {}).forEach(([bucket, account]) => {
    if(account && account.investmentAllocation?.source !== 'cash-only'){
      investmentAllocationById.set(account.id || `base-${bucket}`, allocation);
    }
  });
  (Array.isArray(plan.portfolio.extraAccounts) ? plan.portfolio.extraAccounts : [])
    .forEach((account, index) => {
      if(getAccountTypeById(account?.typeId)?.investmentAllocationEligible === true){
        investmentAllocationById.set(account.id || `extra-${index}`, allocation);
      }
    });
  registerTransientProjectionAccountState(plan, { investmentAllocationById });
  if(plan?.meta?.accountSchemaVersion !== ACCOUNT_SCHEMA_VERSION){
    plan.portfolio.riskProfile = legacyRiskProfileByPresetId.get(presetId);
  }
}

export function applyScenarioPlanInputs(plan, levers){
  const scenarioPlan = JSON.parse(JSON.stringify(plan));
  applyPersonAges(scenarioPlan, levers);
  if(scenarioPlan?.meta?.accountSchemaVersion !== ACCOUNT_SCHEMA_VERSION
      && Number.isInteger(levers.risk)
      && levers.risk >= 1
      && levers.risk <= 6){
    scenarioPlan.portfolio.riskProfile = levers.risk;
  }
  applyAllocationPreset(
    scenarioPlan,
    levers.allocationPresetId ?? CURRENT_ALLOCATION_ID,
  );
  return scenarioPlan;
}
