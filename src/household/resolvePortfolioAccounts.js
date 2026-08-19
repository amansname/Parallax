import {
  UNSUPPORTED_TYPE_ID,
  getAccountTypeById,
  isValidEngineBucket,
} from './accountTypes.js';
import {
  readTransientCalculatedTaxableBasis,
} from './transientCalculatedTaxableBasis.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} must be a finite nonnegative number`);
  }
  return value;
}

function cloneBasis(value){
  if(!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({ ...value });
}

function freezeBucket(bucket){
  return Object.freeze({
    balance: bucket.balance,
    accountIds: Object.freeze([...bucket.accountIds]),
  });
}

function emptyBuckets(){
  return {
    taxable: { balance: 0, accountIds: [] },
    traditional: { balance: 0, accountIds: [] },
    roth: { balance: 0, accountIds: [] },
  };
}

function addToBucket(target, bucket, account){
  if(!isValidEngineBucket(bucket)) return;
  target[bucket].balance += account.balance;
  target[bucket].accountIds.push(account.id);
}

function freezeAccount(account){
  return Object.freeze({
    ...account,
    basis: account.basis,
  });
}

/**
 * One pure, deterministic fold of Household portfolio sources.
 *
 * `engineBuckets` preserves existing engine compatibility for strategy-ready
 * accounts while enforcing explicit rules-pending gates.
 * `taxBuckets` contains only the account types approved for Tax Buckets.
 * Excluded or unresolved balances remain traceable and are never reassigned.
 */
export function resolvePortfolioAccounts(plan){
  const portfolio = plan?.portfolio;
  const base = portfolio?.accounts;
  if(!portfolio || typeof portfolio !== 'object' || Array.isArray(portfolio)){
    throw new Error('portfolio is required');
  }
  if(!base || typeof base !== 'object' || Array.isArray(base)){
    throw new Error('portfolio.accounts is required');
  }
  const extras = portfolio.extraAccounts ?? [];
  if(!Array.isArray(extras)){
    throw new Error('portfolio.extraAccounts must be an array');
  }

  const accounts = [];
  const issues = [];
  const engineBuckets = emptyBuckets();
  const taxBuckets = emptyBuckets();
  const transientCalculatedTaxableBasis =
    readTransientCalculatedTaxableBasis(plan);

  let baseTotal = 0;
  for(const bucket of BUCKET_KEYS){
    const sleeve = base[bucket];
    if(!sleeve || typeof sleeve !== 'object' || Array.isArray(sleeve)){
      throw new Error(`portfolio.accounts.${bucket} is required`);
    }
    const balance = assertFiniteNonNegative(sleeve.balance, `portfolio.accounts.${bucket}.balance`);
    baseTotal += balance;
    if(balance === 0) continue;
    const account = freezeAccount({
      id: `base-${bucket}`,
      sourceKind: 'legacy-base',
      sourceIndex: null,
      typeId: null,
      label: `Legacy ${bucket} balance`,
      owner: 'household',
      engineBucket: bucket,
      taxBucketGroup: bucket,
      taxCharacter: `legacy_${bucket}`,
      balance,
      valuationDate: null,
      basis: bucket === 'taxable'
        ? Object.freeze(transientCalculatedTaxableBasis === null
          ? {
              amount: balance * 0.5,
              method: 'assumed-50-50',
              status: 'assumed',
            }
          : {
              amount: transientCalculatedTaxableBasis,
              method: 'calculated-carried-forward',
              status: 'calculated',
            })
        : null,
      classificationStatus: 'included',
      exclusionReason: null,
      strategyRulesPending: false,
    });
    accounts.push(account);
    addToBucket(engineBuckets, bucket, account);
    addToBucket(taxBuckets, bucket, account);
  }

  let typedTotal = 0;
  extras.forEach((raw, index) => {
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)){
      throw new Error(`portfolio.extraAccounts.${index} must be an object`);
    }
    const balance = assertFiniteNonNegative(raw.balance, `portfolio.extraAccounts.${index}.balance`);
    typedTotal += balance;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `extra-${index}`;
    const canonical = raw.typeId && raw.typeId !== UNSUPPORTED_TYPE_ID
      ? getAccountTypeById(raw.typeId)
      : null;
    const engineBucket = isValidEngineBucket(raw.bucket) ? raw.bucket : null;

    let classificationStatus = 'included';
    let exclusionReason = null;
    let taxBucketGroup = null;

    if(!canonical){
      classificationStatus = engineBucket ? 'unsupported' : 'invalid';
      exclusionReason = engineBucket ? 'unsupported-account-type' : 'invalid-classification';
      issues.push(engineBucket
        ? `ACCOUNT_UNSUPPORTED:${id}`
        : `ACCOUNT_INVALID_CLASSIFICATION:${id}`);
    } else if(engineBucket !== canonical.engineBucket){
      classificationStatus = 'conflict';
      exclusionReason = 'bucket-conflict';
      issues.push(`ACCOUNT_BUCKET_CONFLICT:${id}`);
    } else if(!canonical.taxBucketGroup){
      classificationStatus = 'out-of-scope';
      exclusionReason = 'outside-current-tax-buckets-scope';
    } else {
      taxBucketGroup = canonical.taxBucketGroup;
    }

    const account = freezeAccount({
      id,
      sourceKind: 'typed-account',
      sourceIndex: index,
      typeId: raw.typeId || null,
      label: canonical?.label || raw.type || 'Unknown account',
      owner: raw.owner || null,
      engineBucket,
      taxBucketGroup,
      taxCharacter: canonical?.taxCharacter || 'unsupported',
      balance,
      valuationDate: raw.valuationDate ?? null,
      basis: cloneBasis(raw.basis),
      classificationStatus,
      exclusionReason,
      strategyRulesPending: Boolean(canonical?.strategyRulesPending),
    });
    accounts.push(account);
    if(!account.strategyRulesPending){
      addToBucket(engineBuckets, engineBucket, account);
    }
    addToBucket(taxBuckets, taxBucketGroup, account);
  });

  if(baseTotal > 0 && typedTotal > 0){
    issues.unshift('LEGACY_TYPED_OVERLAP');
  }

  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  const engineBalance = BUCKET_KEYS.reduce((sum, key) => sum + engineBuckets[key].balance, 0);
  const includedBalance = BUCKET_KEYS.reduce((sum, key) => sum + taxBuckets[key].balance, 0);
  const unclassifiedBalance = accounts
    .filter(account => !isValidEngineBucket(account.engineBucket))
    .reduce((sum, account) => sum + account.balance, 0);
  const excludedAccounts = accounts.filter(account => account.sourceKind === 'typed-account' && !account.taxBucketGroup);
  const pendingStrategyAccounts = accounts.filter(account => account.strategyRulesPending);
  const pendingStrategyBalance = pendingStrategyAccounts.reduce((sum, account) => sum + account.balance, 0);

  return Object.freeze({
    totalBalance,
    engineBalance,
    unclassifiedBalance,
    includedBalance,
    excludedBalance: totalBalance - includedBalance,
    pendingStrategyBalance,
    engineBuckets: Object.freeze({
      taxable: freezeBucket(engineBuckets.taxable),
      traditional: freezeBucket(engineBuckets.traditional),
      roth: freezeBucket(engineBuckets.roth),
    }),
    taxBuckets: Object.freeze({
      taxable: freezeBucket(taxBuckets.taxable),
      traditional: freezeBucket(taxBuckets.traditional),
      roth: freezeBucket(taxBuckets.roth),
    }),
    accounts: Object.freeze(accounts),
    excludedAccounts: Object.freeze(excludedAccounts),
    pendingStrategyAccounts: Object.freeze(pendingStrategyAccounts),
    issues: Object.freeze([...new Set(issues)]),
  });
}

export { BUCKET_KEYS };
