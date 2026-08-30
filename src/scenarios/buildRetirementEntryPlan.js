import { resolvePortfolioAccounts } from '../household/resolvePortfolioAccounts.js';
import {
  registerTransientProjectionAccountState,
} from '../household/transientProjectionAccountState.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);
const TRADITIONAL_OWNER_KEYS = Object.freeze(['client', 'spouse', 'unattributed']);

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} must be a finite non-negative number`);
  }
}

function assertAccountState(state, path){
  if(!state || typeof state !== 'object' || Array.isArray(state)){
    throw new Error(`${path} is required`);
  }
  if(typeof state.id !== 'string' || state.id.length === 0){
    throw new Error(`${path}.id is required`);
  }
  if(!BUCKET_KEYS.includes(state.bucket)){
    throw new Error(`${path}.bucket is invalid`);
  }
  assertFiniteNonNegative(state.balance, `${path}.balance`);
  assertFiniteNonNegative(state.basis, `${path}.basis`);
  if(!state.investmentAllocation
      || typeof state.investmentAllocation !== 'object'
      || Array.isArray(state.investmentAllocation)){
    throw new Error(`${path}.investmentAllocation is required`);
  }
}

function freezeAccountStates(states){
  const seen = new Set();
  return Object.freeze(states.map((state, index) => {
    assertAccountState(state, `accountStates.${index}`);
    if(seen.has(state.id)) throw new Error(`accountStates contains duplicate ID ${state.id}`);
    seen.add(state.id);
    return Object.freeze({
      id: state.id,
      bucket: state.bucket,
      owner: state.owner,
      sourceKind: state.sourceKind,
      typeId: state.typeId,
      taxCharacter: state.taxCharacter,
      balance: state.balance,
      basis: state.basis,
      investmentAllocation: state.investmentAllocation,
    });
  }));
}

function summarizeAccountStates(accountStates){
  const balances = { taxable: 0, traditional: 0, roth: 0 };
  const traditionalByOwner = { client: 0, spouse: 0, unattributed: 0 };
  let taxableBasis = 0;
  for(const account of accountStates){
    balances[account.bucket] += account.balance;
    if(account.bucket === 'taxable') taxableBasis += account.basis;
    if(account.bucket === 'traditional'){
      const owner = TRADITIONAL_OWNER_KEYS.includes(account.owner)
        ? account.owner
        : 'unattributed';
      traditionalByOwner[owner] += account.balance;
    }
  }
  return Object.freeze({
    taxable: Object.freeze({ balance: balances.taxable, basis: taxableBasis }),
    traditional: Object.freeze({
      balance: balances.traditional,
      byOwner: Object.freeze(traditionalByOwner),
    }),
    roth: Object.freeze({ balance: balances.roth }),
    accountStates,
  });
}

function exactEntryFromStates(states){
  if(!Array.isArray(states)){
    throw new Error('projection account states are required at retirement');
  }
  return summarizeAccountStates(freezeAccountStates(states));
}

function totalBalance(accounts){
  return BUCKET_KEYS.reduce((sum, bucket) => sum + accounts[bucket].balance, 0);
}

function assertNear(actual, expected, path){
  if(!Number.isFinite(actual) || Math.abs(actual - expected) > 0.01){
    throw new Error(`${path} does not reconcile to accountStates`);
  }
}

function assertEntryReconciliation(entry, aggregate, path){
  if(!aggregate) return;
  for(const bucket of BUCKET_KEYS){
    assertNear(aggregate[bucket], entry[bucket].balance, `${path}.${bucket}`);
  }
}

/**
 * Read the exact per-account Projection Engine state at the retirement
 * boundary. Bucket totals remain derived compatibility views only.
 */
export function deriveExactRetirementEntryAccounts(
  analysis,
  accumulationYears,
  fallbackAccounts,
  fallbackAccountStates = null
){
  if(!Number.isInteger(accumulationYears) || accumulationYears < 0){
    throw new Error('accumulationYears must be a non-negative integer');
  }

  if(accumulationYears === 0){
    const entry = exactEntryFromStates(fallbackAccountStates);
    assertEntryReconciliation(entry, {
      taxable: fallbackAccounts?.taxable?.balance,
      traditional: fallbackAccounts?.traditional?.balance,
      roth: fallbackAccounts?.roth?.balance,
    }, 'fallbackAccounts');
    return entry;
  }

  const row = analysis?.paths?.p50?.rows?.[accumulationYears - 1];
  if(!row){
    throw new Error('analysis p50 retirement-entry row is required');
  }
  const entry = exactEntryFromStates(row.accountStates);
  assertEntryReconciliation(entry, row.accountBalances, 'analysis retirement-entry accounts');
  assertNear(row.taxableEndingBasis, entry.taxable.basis, 'analysis taxable ending basis');
  for(const owner of TRADITIONAL_OWNER_KEYS){
    assertNear(
      row.traditionalEndingBalancesByOwner?.[owner],
      entry.traditional.byOwner[owner],
      `analysis Traditional ${owner} ending balance`,
    );
  }
  return entry;
}

/**
 * Sequencing retains its median-envelope entry balance while scaling every
 * account and taxable basis proportionally, preserving identity and mix.
 */
export function deriveRetirementEntryAccounts(
  analysis,
  accumulationYears,
  fallbackAccounts,
  fallbackAccountStates = null
){
  const source = deriveExactRetirementEntryAccounts(
    analysis,
    accumulationYears,
    fallbackAccounts,
    fallbackAccountStates,
  );
  const sourceTotal = totalBalance(source);
  const envelopeTotal = analysis?.envelope?.[accumulationYears]?.p50;
  const targetTotal = Number.isFinite(envelopeTotal) && envelopeTotal >= 0
    ? envelopeTotal
    : sourceTotal;
  if(sourceTotal <= 0 && targetTotal > 0){
    throw new Error('retirement entry balance has no account source');
  }
  const factor = sourceTotal > 0 ? targetTotal / sourceTotal : 0;
  return exactEntryFromStates(source.accountStates.map(account => ({
    ...account,
    balance: account.balance * factor,
    basis: account.basis * factor,
  })));
}

function modeledSources(plan, fold){
  const sources = new Map();
  const modeledIds = new Set(BUCKET_KEYS.flatMap(
    bucket => fold.engineBuckets[bucket].accountIds
  ));
  const modeledTypedIds = new Set(fold.accounts
    .filter(account => account.sourceKind === 'typed-account' && modeledIds.has(account.id))
    .map(account => account.id));
  for(const [bucket, sleeve] of Object.entries(plan.portfolio.accounts)){
    const id = sleeve.id || `base-${bucket}`;
    if(modeledTypedIds.has(id)) continue;
    sources.set(id, {
      id,
      bucket,
      sourceKind: 'legacy-base',
      typeId: null,
      taxCharacter: `legacy_${bucket}`,
      record: sleeve,
    });
  }
  for(const account of fold.accounts){
    if(account.sourceKind !== 'typed-account' || !modeledIds.has(account.id)) continue;
    if(sources.has(account.id)) throw new Error(`modeled account ID ${account.id} is ambiguous`);
    sources.set(account.id, {
      id: account.id,
      bucket: account.engineBucket,
      sourceKind: account.sourceKind,
      typeId: account.typeId,
      taxCharacter: account.taxCharacter,
      record: plan.portfolio.extraAccounts[account.sourceIndex],
    });
  }
  return sources;
}

function removeDeceasedSpouseAtBoundary(clone, accountStates, currentAge, retirementAge){
  const spouse = clone.household.spouse;
  const primary = clone.household.primary;
  const retirementAdvance = retirementAge - currentAge;
  if(!spouse || !Number.isInteger(retirementAdvance) || retirementAdvance <= 0) return;
  const spouseBoundaryAge = spouse.currentAge + retirementAdvance;
  const clientBoundaryAge = currentAge + retirementAdvance;
  const spouseDied = Number.isFinite(spouse.currentAge)
    && Number.isFinite(spouse.planEndAge)
    && spouse.currentAge <= spouse.planEndAge
    && spouseBoundaryAge > spouse.planEndAge;
  const clientSurvives = Number.isFinite(primary?.planEndAge)
    && clientBoundaryAge <= primary.planEndAge;
  const spouseTraditionalBalance = accountStates
    .filter(account => account.bucket === 'traditional' && account.owner === 'spouse')
    .reduce((sum, account) => sum + account.balance, 0);
  if(!spouseDied || !clientSurvives || spouseTraditionalBalance > 0.01) return;
  clone.household.spouse = null;
  if(clone.income?.socialSecurity) clone.income.socialSecurity.spouse = null;
  clone.meta.filingStatus = 'single';
}

/**
 * Stand a scenario at retirement by rehydrating the exact engine-owned account
 * ledger. Saved account provenance remains untouched; calculated basis and
 * scenario allocation stay transient on this ephemeral clone.
 */
export function buildRetirementEntryPlan(plan, {
  entryAccounts,
  currentAge,
  retirementAge,
}){
  assertFiniteNonNegative(currentAge, 'currentAge');
  assertFiniteNonNegative(retirementAge, 'retirementAge');
  if(!entryAccounts?.accountStates){
    throw new Error('entryAccounts.accountStates is required');
  }
  const fold = resolvePortfolioAccounts(plan);
  const clone = structuredClone(plan);
  const sources = modeledSources(clone, fold);
  const states = freezeAccountStates(entryAccounts.accountStates);
  const stateById = new Map(states.map(state => [state.id, state]));
  if(stateById.size !== sources.size){
    throw new Error('retirement account state does not match the modeled account ledger');
  }

  const taxableBasisById = new Map();
  const investmentAllocationById = new Map();
  for(const [id, source] of sources){
    const state = stateById.get(id);
    if(!state) throw new Error(`retirement account state is missing ${id}`);
    if(state.bucket !== source.bucket
        || state.sourceKind !== source.sourceKind
        || state.typeId !== source.typeId
        || state.taxCharacter !== source.taxCharacter){
      throw new Error(`retirement account identity changed for ${id}`);
    }
    source.record.balance = state.balance;
    if(source.sourceKind === 'typed-account'
        && (state.owner === 'client' || state.owner === 'spouse')){
      source.record.owner = state.owner;
    }
    if(state.bucket === 'taxable') taxableBasisById.set(id, state.basis);
    investmentAllocationById.set(id, state.investmentAllocation);
  }

  removeDeceasedSpouseAtBoundary(clone, states, currentAge, retirementAge);
  registerTransientProjectionAccountState(clone, {
    taxableBasisById,
    investmentAllocationById,
  });

  const retirementAdvance = retirementAge - currentAge;
  if(Number.isInteger(clone.meta?.planningAsOfYear)
      && Number.isInteger(retirementAdvance)){
    clone.meta.planningAsOfYear += retirementAdvance;
  }
  clone.household.primary.currentAge = retirementAge;
  clone.household.primary.retirementAge = retirementAge;
  if(clone.household.spouse?.currentAge != null){
    clone.household.spouse.currentAge += retirementAdvance;
  }
  return clone;
}
