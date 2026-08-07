import { resolvePortfolioAccounts } from '../household/resolvePortfolioAccounts.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} must be a finite non-negative number`);
  }
}

function assertEntryAccounts(accounts, path = 'entryAccounts'){
  if(!accounts || typeof accounts !== 'object' || Array.isArray(accounts)){
    throw new Error(`${path} is required`);
  }
  for(const bucket of BUCKET_KEYS){
    assertFiniteNonNegative(accounts[bucket]?.balance, `${path}.${bucket}.balance`);
  }
  assertFiniteNonNegative(accounts.taxable.basis, `${path}.taxable.basis`);
}

function totalBalance(accounts){
  return BUCKET_KEYS.reduce((sum, bucket) => sum + accounts[bucket].balance, 0);
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
  if(!Number.isInteger(accumulationYears) || accumulationYears < 0){
    throw new Error('accumulationYears must be a non-negative integer');
  }
  assertEntryAccounts(fallbackAccounts, 'fallbackAccounts');

  let source = fallbackAccounts;
  if(accumulationYears > 0){
    const row = analysis?.paths?.p50?.rows?.[accumulationYears - 1];
    if(!row?.accountBalances){
      throw new Error('analysis p50 retirement-entry row is required');
    }
    source = {
      taxable: {
        balance: row.accountBalances.taxable,
        basis: row.taxableEndingBasis,
      },
      traditional: { balance: row.accountBalances.traditional },
      roth: { balance: row.accountBalances.roth },
    };
    assertEntryAccounts(source, 'analysis retirement-entry accounts');
  }

  const sourceTotal = totalBalance(source);
  const envelopeTotal = analysis?.envelope?.[accumulationYears]?.p50;
  const targetTotal = Number.isFinite(envelopeTotal) && envelopeTotal >= 0
    ? envelopeTotal
    : sourceTotal;
  if(sourceTotal <= 0){
    if(targetTotal > 0){
      throw new Error('retirement entry balance has no account source');
    }
    return Object.freeze({
      taxable: Object.freeze({ balance: 0, basis: 0 }),
      traditional: Object.freeze({ balance: 0 }),
      roth: Object.freeze({ balance: 0 }),
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
  clone.portfolio.accounts.roth.balance = entryAccounts.roth.balance;

  (clone.portfolio.extraAccounts ?? []).forEach((account, index) => {
    const id = account.id || `extra-${index}`;
    if(!modeledIds.has(id)) return;
    account.balance = 0;
    if(typeof account.basis?.amount === 'number') account.basis.amount = 0;
  });

  preserveTraditionalAccounts(clone, fold, entryAccounts.traditional.balance);

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
