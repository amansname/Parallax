import { resolvePortfolioAccounts } from '../household/resolvePortfolioAccounts.js';
import {
  registerTransientCalculatedTaxableBasis,
} from '../household/transientCalculatedTaxableBasis.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);
const TRADITIONAL_OWNER_KEYS = Object.freeze(['client', 'spouse', 'unattributed']);

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} must be a finite non-negative number`);
  }
}

function assertTraditionalOwnerBuckets(byOwner, balance, path){
  if(!byOwner || typeof byOwner !== 'object' || Array.isArray(byOwner)){
    throw new Error(`${path} is required`);
  }
  let total = 0;
  for(const owner of TRADITIONAL_OWNER_KEYS){
    assertFiniteNonNegative(byOwner[owner], `${path}.${owner}`);
    total += byOwner[owner];
  }
  if(Math.abs(total - balance) > 0.01){
    throw new Error(`${path} must reconcile to the Traditional balance`);
  }
}

function assertEntryAccounts(
  accounts,
  path = 'entryAccounts',
  { requireTraditionalByOwner = false } = {}
){
  if(!accounts || typeof accounts !== 'object' || Array.isArray(accounts)){
    throw new Error(`${path} is required`);
  }
  for(const bucket of BUCKET_KEYS){
    assertFiniteNonNegative(accounts[bucket]?.balance, `${path}.${bucket}.balance`);
  }
  assertFiniteNonNegative(accounts.taxable.basis, `${path}.taxable.basis`);
  if(requireTraditionalByOwner || accounts.traditional.byOwner != null){
    assertTraditionalOwnerBuckets(
      accounts.traditional.byOwner,
      accounts.traditional.balance,
      `${path}.traditional.byOwner`
    );
  }
}

function totalBalance(accounts){
  return BUCKET_KEYS.reduce((sum, bucket) => sum + accounts[bucket].balance, 0);
}

function freezeEntryAccounts(source, includeTraditionalByOwner = false){
  const traditional = { balance: source.traditional.balance };
  if(includeTraditionalByOwner){
    traditional.byOwner = Object.freeze(Object.fromEntries(
      TRADITIONAL_OWNER_KEYS.map(owner => [owner, source.traditional.byOwner[owner]])
    ));
  }
  return Object.freeze({
    taxable: Object.freeze({
      balance: source.taxable.balance,
      basis: source.taxable.basis,
    }),
    traditional: Object.freeze(traditional),
    roth: Object.freeze({ balance: source.roth.balance }),
  });
}

/**
 * Read the unscaled account sleeves and taxable basis at the exact end of the
 * displayed p50 accumulation path. Historical Cash Flow uses this handoff so
 * its first retirement row begins from the ledger's preceding ending state.
 */
export function deriveExactRetirementEntryAccounts(
  analysis,
  accumulationYears,
  fallbackAccounts
){
  if(!Number.isInteger(accumulationYears) || accumulationYears < 0){
    throw new Error('accumulationYears must be a non-negative integer');
  }
  assertEntryAccounts(fallbackAccounts, 'fallbackAccounts', {
    requireTraditionalByOwner: true,
  });

  let source = fallbackAccounts;
  if(accumulationYears > 0){
    const row = analysis?.paths?.p50?.rows?.[accumulationYears - 1];
    if(!row?.accountBalances){
      throw new Error('analysis p50 retirement-entry row is required');
    }
    source = {
      taxable: {
        balance: row.accountBalances.taxable,
        basis: Number.isFinite(row.taxableEndingBasis)
          ? row.taxableEndingBasis
          : (row.accountBalances.taxable === 0 ? 0 : undefined),
      },
      traditional: {
        balance: row.accountBalances.traditional,
        byOwner: row.traditionalEndingBalancesByOwner,
      },
      roth: { balance: row.accountBalances.roth },
    };
    assertEntryAccounts(source, 'analysis retirement-entry accounts', {
      requireTraditionalByOwner: true,
    });
  }

  return freezeEntryAccounts(source, true);
}

function preserveTraditionalAccounts(clone, fold, targetBalance){
  const modeledIds = new Set(fold.engineBuckets.traditional.accountIds);
  const sources = fold.accounts.filter(account => modeledIds.has(account.id));
  const fundedSources = sources.filter(account => account.balance > 0);
  const sourceTotal = fundedSources.reduce((sum, account) => sum + account.balance, 0);

  clone.portfolio.accounts.traditional.balance = 0;
  for(const source of sources){
    if(source.sourceKind === 'typed-account'){
      clone.portfolio.extraAccounts[source.sourceIndex].balance = 0;
    }
  }

  if(targetBalance === 0) return;
  if(sourceTotal <= 0){
    clone.portfolio.accounts.traditional.balance = targetBalance;
    return;
  }

  let assigned = 0;
  fundedSources.forEach((source, index) => {
    const balance = index === fundedSources.length - 1
      ? targetBalance - assigned
      : targetBalance * source.balance / sourceTotal;
    assigned += balance;
    if(source.sourceKind === 'legacy-base'){
      clone.portfolio.accounts.traditional.balance = balance;
    }else{
      clone.portfolio.extraAccounts[source.sourceIndex].balance = balance;
    }
  });
}

function traditionalOwnerForSource(account, hasSpouse, ownerOverrides = null){
  const override = ownerOverrides?.get(account.id);
  if(override) return override;
  if(account.owner === 'client') return 'client';
  if(account.owner === 'spouse' && hasSpouse) return 'spouse';
  if(!hasSpouse && account.owner !== 'spouse') return 'client';
  return 'unattributed';
}

function setTraditionalSourceBalance(clone, source, balance){
  if(source.sourceKind === 'legacy-base'){
    clone.portfolio.accounts.traditional.balance = balance;
  }else{
    clone.portfolio.extraAccounts[source.sourceIndex].balance = balance;
  }
}

function prepareSpouseRolloverAtRetirement(
  clone,
  sources,
  target,
  currentAge,
  retirementAge
){
  const ownerOverrides = new Map();
  const spouse = clone.household.spouse;
  const primary = clone.household.primary;
  const retirementAdvance = retirementAge - currentAge;
  if(!spouse || !Number.isInteger(retirementAdvance) || retirementAdvance <= 0){
    return ownerOverrides;
  }

  const spouseStartAge = spouse.currentAge;
  const spouseRetirementBoundaryAge = spouseStartAge + retirementAdvance;
  const clientRetirementBoundaryAge = currentAge + retirementAdvance;
  const spouseDiedDuringAccumulation = Number.isFinite(spouseStartAge)
    && Number.isFinite(spouse.planEndAge)
    && spouseStartAge <= spouse.planEndAge
    && spouseRetirementBoundaryAge > spouse.planEndAge;
  const clientSurvivesRetirementBoundary = Number.isFinite(primary?.planEndAge)
    && clientRetirementBoundaryAge <= primary.planEndAge;
  if(!spouseDiedDuringAccumulation
      || !clientSurvivesRetirementBoundary
      || target.byOwner.client <= 0
      || target.byOwner.spouse !== 0
      || target.byOwner.unattributed !== 0){
    return ownerOverrides;
  }

  const clientSources = sources.filter(source => source.owner === 'client');
  if(clientSources.length === 0){
    const rolloverSource = sources.find(source => (
      source.owner === 'spouse'
      && source.sourceKind === 'typed-account'
      && source.taxCharacter === 'traditional_ira'
      && source.balance > 0
    ));
    if(!rolloverSource) return ownerOverrides;
    ownerOverrides.set(rolloverSource.id, 'client');
    clone.portfolio.extraAccounts[rolloverSource.sourceIndex].owner = 'client';
  }

  // This is an ephemeral retirement-boundary plan. The displayed accumulation
  // path has already modeled the spouse's death and rollover, so carrying the
  // deceased spouse into the rebased plan would duplicate that lifecycle year.
  clone.household.spouse = null;
  if(clone.income?.socialSecurity) clone.income.socialSecurity.spouse = null;
  clone.meta.filingStatus = 'single';
  return ownerOverrides;
}

function preserveTraditionalAccountsByOwner(
  clone,
  fold,
  target,
  currentAge,
  retirementAge
){
  const modeledIds = new Set(fold.engineBuckets.traditional.accountIds);
  const sources = fold.accounts.filter(account => modeledIds.has(account.id));
  const hasSpouse = Boolean(clone.household.spouse);
  const ownerOverrides = prepareSpouseRolloverAtRetirement(
    clone,
    sources,
    target,
    currentAge,
    retirementAge
  );
  const sourcesByOwner = Object.fromEntries(
    TRADITIONAL_OWNER_KEYS.map(owner => [owner, []])
  );

  for(const source of sources){
    sourcesByOwner[
      traditionalOwnerForSource(source, hasSpouse, ownerOverrides)
    ].push(source);
  }
  for(const owner of TRADITIONAL_OWNER_KEYS){
    if(target.byOwner[owner] > 0 && sourcesByOwner[owner].length === 0){
      throw new Error(`entryAccounts.traditional.byOwner.${owner} has no modeled account source`);
    }
  }

  for(const source of sources) setTraditionalSourceBalance(clone, source, 0);
  for(const owner of TRADITIONAL_OWNER_KEYS){
    const ownerSources = sourcesByOwner[owner];
    const fundedSources = ownerSources.filter(source => source.balance > 0);
    const sourceTotal = fundedSources.reduce((sum, source) => sum + source.balance, 0);
    if(sourceTotal <= 0){
      if(ownerSources.length > 0){
        setTraditionalSourceBalance(clone, ownerSources[0], target.byOwner[owner]);
      }
      continue;
    }
    let assigned = 0;
    fundedSources.forEach((source, index) => {
      const balance = index === fundedSources.length - 1
        ? target.byOwner[owner] - assigned
        : target.byOwner[owner] * source.balance / sourceTotal;
      assigned += balance;
      setTraditionalSourceBalance(clone, source, balance);
    });
  }
}

/**
 * Derive the exact aggregate engine sleeves at the retirement boundary. The
 * representative funded p50 path supplies the accumulation-created account
 * mix and taxable basis; the envelope preserves the existing median entry
 * balance used by Sequencing.
 */
export function deriveRetirementEntryAccounts(
  analysis,
  accumulationYears,
  fallbackAccounts
){
  const source = deriveExactRetirementEntryAccounts(
    analysis,
    accumulationYears,
    fallbackAccounts
  );

  const sourceTotal = totalBalance(source);
  const envelopeTotal = analysis?.envelope?.[accumulationYears]?.p50;
  const targetTotal = Number.isFinite(envelopeTotal) && envelopeTotal >= 0
    ? envelopeTotal
    : sourceTotal;
  if(sourceTotal <= 0){
    if(targetTotal > 0){
      throw new Error('retirement entry balance has no account source');
    }
    return freezeEntryAccounts({
      taxable: { balance: 0, basis: 0 },
      traditional: { balance: 0 },
      roth: { balance: 0 },
    });
  }

  const factor = targetTotal / sourceTotal;
  return Object.freeze({
    taxable: Object.freeze({
      balance: source.taxable.balance * factor,
      basis: source.taxable.basis * factor,
    }),
    traditional: Object.freeze({ balance: source.traditional.balance * factor }),
    roth: Object.freeze({ balance: source.roth.balance * factor }),
  });
}

/**
 * Stand a scenario at retirement with the projected aggregate engine sleeves.
 * Taxable and Roth modeled accounts are collapsed into their legacy engine
 * sleeves only in this ephemeral clone. Traditional balances remain in their
 * modeled source accounts so owner and account-type RMD rules stay available;
 * rules-pending accounts remain untouched and excluded.
 */
export function buildRetirementEntryPlan(plan, {
  entryAccounts,
  currentAge,
  retirementAge,
}){
  assertEntryAccounts(entryAccounts);
  assertFiniteNonNegative(currentAge, 'currentAge');
  assertFiniteNonNegative(retirementAge, 'retirementAge');
  const fold = resolvePortfolioAccounts(plan);
  const clone = structuredClone(plan);
  const modeledIds = new Set(BUCKET_KEYS.flatMap(
    bucket => fold.engineBuckets[bucket].accountIds
  ));

  clone.portfolio.accounts.taxable.balance = entryAccounts.taxable.balance;
  clone.portfolio.accounts.taxable.basisPct = entryAccounts.taxable.balance > 0
    ? entryAccounts.taxable.basis / entryAccounts.taxable.balance
    : 1;
  registerTransientCalculatedTaxableBasis(
    clone,
    entryAccounts.taxable.basis,
  );
  clone.portfolio.accounts.roth.balance = entryAccounts.roth.balance;

  (clone.portfolio.extraAccounts ?? []).forEach((account, index) => {
    const id = account.id || `extra-${index}`;
    if(!modeledIds.has(id)) return;
    account.balance = 0;
    if(typeof account.basis?.amount === 'number') account.basis.amount = 0;
  });

  if(entryAccounts.traditional.byOwner){
    preserveTraditionalAccountsByOwner(
      clone,
      fold,
      entryAccounts.traditional,
      currentAge,
      retirementAge
    );
  }else{
    preserveTraditionalAccounts(clone, fold, entryAccounts.traditional.balance);
  }

  const retirementAdvance = retirementAge - currentAge;
  if(Number.isInteger(clone.meta?.planningAsOfYear)
      && Number.isInteger(retirementAdvance)){
    clone.meta.planningAsOfYear += retirementAdvance;
  }
  clone.household.primary.currentAge = retirementAge;
  clone.household.primary.retirementAge = retirementAge;
  if(clone.household.spouse?.currentAge != null){
    clone.household.spouse.currentAge += retirementAge - currentAge;
  }
  return clone;
}
