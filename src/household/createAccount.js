import { getAccountTypeById, isValidOwner, isValidValuationDate } from './accountTypes.js';
import { createFact } from './factEnvelope.js';
import {
  cloneInvestmentAllocation,
  resolveCashOnlyAllocation,
  snapshotPresetAllocation,
} from './investmentAllocation.js';

function newAccountId(){
  if(typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'){
    return `acct_${crypto.randomUUID()}`;
  }
  return `acct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseBalanceInput(value, { allowOmitted = false } = {}){
  if(allowOmitted && value === undefined) return 0;
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error('Invalid balance');
  }
  return Math.round(value);
}

function defaultBasisForType(entry){
  if(entry.taxCharacter === 'taxable_cash'){
    return {
      amount: null,
      method: 'principal',
      status: 'unknown',
      source: null,
      confirmedAt: null,
      version: 1,
    };
  }
  if(entry.taxCharacter === 'capital_asset'){
    return {
      amount: null,
      method: 'unknown',
      status: 'unknown',
      source: null,
      confirmedAt: null,
      version: 1,
    };
  }
  return {
    amount: null,
    method: 'unknown',
    status: 'unknown',
    source: null,
    confirmedAt: null,
    version: 1,
  };
}

function defaultTaxReporting(entry, owner){
  const reportingTaxpayer = (owner === 'client' || owner === 'spouse') ? owner : null;
  const inclusion = (entry.id === 'joint_brokerage' || entry.id === 'trust_brokerage' || owner === 'joint' || owner === 'trust')
    ? 'unknown'
    : 'household-return';
  return {
    inclusion,
    reportingTaxpayer,
    householdReturnShare: inclusion === 'household-return' ? 1 : null,
  };
}

function defaultEmployerPlanFacts(entry){
  if(entry.taxCharacter !== 'employer_pretax') return null;
  return {
    afterTaxContributionBasis: createFact(null),
    planSubtypeConfirmed: createFact(null),
  };
}

function defaultDesignatedRothFacts(entry){
  if(entry.taxCharacter !== 'designated_roth') return null;
  return {
    firstContributionYear: createFact(null),
    contributionBasis: createFact(null),
    inPlanRolloverCohorts: createFact(null),
  };
}

function resolveCreatedInvestmentAllocation(entry, options){
  const hasExplicitAllocation = Object.prototype.hasOwnProperty.call(options, 'investmentAllocation');
  if(entry.investmentAllocationEligible){
    const allocation = hasExplicitAllocation
      ? cloneInvestmentAllocation(options.investmentAllocation)
      : snapshotPresetAllocation('balanced');
    if(allocation.source === 'cash-only'){
      throw new Error('Investment accounts require preset, custom, or legacy allocation provenance');
    }
    return allocation;
  }
  if(!hasExplicitAllocation) return resolveCashOnlyAllocation();
  const allocation = cloneInvestmentAllocation(options.investmentAllocation);
  if(allocation.source !== 'cash-only'){
    throw new Error('Non-investment accounts require cash-only allocation');
  }
  return allocation;
}

/**
 * Create a new account at the current schema version.
 */
export function createAccount(typeId, options = {}){
  if(!options || typeof options !== 'object' || Array.isArray(options)){
    throw new Error('Account options must be an object');
  }
  const entry = getAccountTypeById(typeId);
  if(!entry){
    throw new Error(`Unknown account typeId: ${typeId}`);
  }
  const hasOwner = Object.prototype.hasOwnProperty.call(options, 'owner');
  const owner = hasOwner ? options.owner : (entry.defaultOwner || 'client');
  if(!isValidOwner(owner)){
    throw new Error(`Invalid account owner: ${owner}`);
  }
  const hasBalance = Object.prototype.hasOwnProperty.call(options, 'balance');
  const balance = parseBalanceInput(options.balance, { allowOmitted: !hasBalance });
  const hasValuationDate = Object.prototype.hasOwnProperty.call(options, 'valuationDate');
  const valuationDate = hasValuationDate ? options.valuationDate : null;
  if(!isValidValuationDate(valuationDate)){
    throw new Error('Invalid valuationDate');
  }
  const displayName = options.displayName == null ? '' : String(options.displayName).trim();
  return {
    id: newAccountId(),
    displayName,
    typeId: entry.id,
    type: entry.label,
    owner,
    bucket: entry.engineBucket,
    balance,
    valuationDate,
    basis: defaultBasisForType(entry),
    taxReporting: defaultTaxReporting(entry, owner),
    employerPlanFacts: defaultEmployerPlanFacts(entry),
    designatedRothFacts: defaultDesignatedRothFacts(entry),
    investmentAllocation: resolveCreatedInvestmentAllocation(entry, options),
  };
}

export function hasSpouseOwnedAccounts(plan){
  return (plan.portfolio?.extraAccounts || []).some(a => a && a.owner === 'spouse');
}

export { newAccountId, parseBalanceInput };
