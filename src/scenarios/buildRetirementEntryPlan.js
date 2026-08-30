import { resolvePortfolioAccounts } from '../household/resolvePortfolioAccounts.js';
import { cloneInvestmentAllocation } from '../household/investmentAllocation.js';
import { registerTransientProjectionAccountState } from '../household/transientProjectionAccountState.js';
import { aggregateProjectionAccounts } from '../projection/accountLedger.js';

const BUCKETS = ['taxable', 'traditional', 'roth'];
const OWNERS = ['client', 'spouse', 'unattributed'];

function nonnegative(value, label){
  if(!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative`);
}

function near(actual, expected, label){
  if(!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > 0.01){
    throw new Error(`${label} does not reconcile to retirement account states`);
  }
}

function entryFromStates(states){
  if(!Array.isArray(states)) throw new Error('retirement account states are required');
  const ids = new Set();
  const accountStates = Object.freeze(states.map(state => {
    if(!state || typeof state.id !== 'string' || !state.id || ids.has(state.id)){
      throw new Error('retirement account IDs must be nonempty and unique');
    }
    ids.add(state.id);
    if(!BUCKETS.includes(state.bucket) || !OWNERS.includes(state.owner)){
      throw new Error(`retirement account ${state.id} has invalid bucket or owner`);
    }
    nonnegative(state.balance, `${state.id}.balance`);
    nonnegative(state.basis, `${state.id}.basis`);
    return Object.freeze({
      ...state, investmentAllocation: cloneInvestmentAllocation(state.investmentAllocation),
    });
  }));
  const aggregate = aggregateProjectionAccounts(accountStates);
  return Object.freeze({
    taxable: Object.freeze({ balance: aggregate.balances.taxable, basis: aggregate.taxableBasis }),
    traditional: Object.freeze({ balance: aggregate.balances.traditional,
      byOwner: Object.freeze(aggregate.traditionalByOwner) }),
    roth: Object.freeze({ balance: aggregate.balances.roth }),
    accountStates,
  });
}

/** Carry the engine's exact per-account endpoint, not reconstructed bucket shares. */
export function deriveExactRetirementEntryAccounts(analysis, accumulationYears, fallbackAccounts, fallbackStates){
  if(!Number.isInteger(accumulationYears) || accumulationYears < 0){
    throw new Error('accumulationYears must be a non-negative integer');
  }
  const row = accumulationYears > 0 ? analysis?.paths?.p50?.rows?.[accumulationYears - 1] : null;
  if(accumulationYears > 0 && !row) throw new Error('analysis p50 retirement-entry row is required');
  const entry = entryFromStates(row ? row.accountStates : fallbackStates);
  for(const bucket of BUCKETS){
    near(row ? row.accountBalances?.[bucket] : fallbackAccounts?.[bucket]?.balance,
      entry[bucket].balance, `${bucket} balance`);
  }
  near(row ? row.taxableEndingBasis : fallbackAccounts?.taxable?.basis, entry.taxable.basis, 'taxable basis');
  for(const owner of OWNERS){
    near(row ? row.traditionalEndingBalancesByOwner?.[owner] : fallbackAccounts?.traditional?.byOwner?.[owner],
      entry.traditional.byOwner[owner], `traditional.byOwner.${owner}`);
  }
  return entry;
}

/** Keep Sequencing's existing median envelope, scaling the same exact ledger. */
export function deriveRetirementEntryAccounts(analysis, accumulationYears, fallbackAccounts, fallbackStates){
  const entry = deriveExactRetirementEntryAccounts(analysis, accumulationYears, fallbackAccounts, fallbackStates);
  const total = BUCKETS.reduce((sum, bucket) => sum + entry[bucket].balance, 0);
  const envelope = analysis?.envelope?.[accumulationYears]?.p50;
  const target = Number.isFinite(envelope) && envelope >= 0 ? envelope : total;
  if(total === 0 && target > 0) throw new Error('retirement entry balance has no account source');
  const factor = total > 0 ? target / total : 0;
  return entryFromStates(entry.accountStates.map(account => ({
    ...account, balance: account.balance * factor, basis: account.basis * factor,
  })));
}

function sourcesById(plan, fold){
  const sources = new Map();
  const modeledIds = new Set(BUCKETS.flatMap(bucket => fold.engineBuckets[bucket].accountIds));
  for(const account of fold.accounts){
    if(!modeledIds.has(account.id) || account.sourceKind !== 'typed-account') continue;
    if(sources.has(account.id)) throw new Error(`ambiguous retirement account ${account.id}`);
    sources.set(account.id, { ...account, record: plan.portfolio.extraAccounts[account.sourceIndex] });
  }
  for(const bucket of BUCKETS){
    const record = plan.portfolio.accounts[bucket];
    const id = record.id || `base-${bucket}`;
    if(sources.has(id)) continue; // Migrated typed account already owns this ID.
    sources.set(id, { sourceKind: 'legacy-base', typeId: null, taxCharacter: `legacy_${bucket}`,
      engineBucket: bucket, record });
  }
  return sources;
}

/** Rehydrate account state on an ephemeral plan; saved facts remain unchanged. */
export function buildRetirementEntryPlan(plan, { entryAccounts, currentAge, retirementAge }){
  nonnegative(currentAge, 'currentAge');
  nonnegative(retirementAge, 'retirementAge');
  const entry = entryFromStates(entryAccounts?.accountStates);
  for(const bucket of BUCKETS) near(entryAccounts[bucket]?.balance, entry[bucket].balance, `${bucket} balance`);
  near(entryAccounts.taxable.basis, entry.taxable.basis, 'taxable basis');
  for(const owner of OWNERS){
    near(entryAccounts.traditional.byOwner?.[owner], entry.traditional.byOwner[owner], `traditional.byOwner.${owner}`);
  }
  const fold = resolvePortfolioAccounts(plan);
  const clone = structuredClone(plan);
  const sources = sourcesById(clone, fold);
  // A household already past retirement begins today, never in a previous year.
  const boundaryAge = Math.max(currentAge, retirementAge);
  const advance = boundaryAge - currentAge;
  const spouse = clone.household.spouse;
  const spouseDiedBeforeEntry = Boolean(spouse && advance > 0
    && spouse.currentAge <= spouse.planEndAge
    && spouse.currentAge + advance > spouse.planEndAge
    && boundaryAge <= clone.household.primary.planEndAge);
  if(sources.size !== entry.accountStates.length){
    throw new Error('retirement account states do not match the modeled account ledger');
  }
  for(const state of entry.accountStates){
    const source = sources.get(state.id);
    if(!source || source.engineBucket !== state.bucket || source.sourceKind !== state.sourceKind
        || source.typeId !== state.typeId || source.taxCharacter !== state.taxCharacter){
      throw new Error(`retirement account identity changed for ${state.id}`);
    }
    if(['client', 'spouse'].includes(source.owner) && state.owner !== source.owner
        && !(source.owner === 'spouse' && state.owner === 'client'
          && state.bucket === 'traditional' && spouseDiedBeforeEntry)){
      throw new Error(`retirement account owner changed for ${state.id}`);
    }
    source.record.balance = state.balance;
    if(state.sourceKind === 'typed-account' && ['client', 'spouse'].includes(state.owner)){
      source.record.owner = state.owner;
    }
  }
  registerTransientProjectionAccountState(clone, entry.accountStates);

  if(spouseDiedBeforeEntry && entry.traditional.byOwner.spouse <= 0.01){
    clone.household.spouse = null;
    if(clone.income?.socialSecurity) clone.income.socialSecurity.spouse = null;
    clone.meta.filingStatus = 'single';
  }
  if(Number.isInteger(clone.meta?.planningAsOfYear) && Number.isInteger(advance)){
    clone.meta.planningAsOfYear += advance;
  }
  clone.household.primary.currentAge = boundaryAge;
  clone.household.primary.retirementAge = boundaryAge;
  if(clone.household.spouse?.currentAge != null) clone.household.spouse.currentAge += advance;
  return clone;
}
