import { ACCOUNT_SCHEMA_VERSION } from '../household/accountTypes.js';
import {
  ASSET_KEYS,
  ASSET_META,
  resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation,
} from '../household/investmentAllocation.js';
import {
  createProjectionReturnCache,
  prepareProjectionAssetAllocation,
} from './portfolioReturns.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);
const OWNER_KEYS = Object.freeze(['client', 'spouse', 'unattributed']);
const PREPARED_ALLOCATION_BY_RECORD = new WeakMap();

function allocationError(code, message){
  const error = new RangeError(message ?? code);
  error.code = code;
  return error;
}

function growthShare(allocation){
  return ASSET_KEYS.reduce((sum, key) => (
    sum + (ASSET_META[key].bucket === 'growth' ? allocation.weights[key] : 0)
  ), 0);
}

function prepareAllocationAtLedgerBoundary(allocation){
  if(!allocation || typeof allocation !== 'object' || Array.isArray(allocation)){
    throw allocationError('INVALID_ASSET_WEIGHTS', 'Investment allocation is required');
  }
  const prepared = prepareProjectionAssetAllocation(allocation.weights);
  PREPARED_ALLOCATION_BY_RECORD.set(allocation, prepared);
  return prepared;
}

function preparedAllocationForRead(allocation){
  return PREPARED_ALLOCATION_BY_RECORD.get(allocation)
    ?? prepareAllocationAtLedgerBoundary(allocation);
}

function cloneAccount(account){
  const clone = {
    ...account,
    investmentAllocation: account.investmentAllocation,
  };
  return clone;
}

function evidenceBasisById(taxableBasis){
  if(taxableBasis?.basisOverride === null
      && taxableBasis?.appliedMode === 'unavailable'){
    return new Map();
  }
  return new Map((taxableBasis?.evidence ?? []).map(item => [item.accountId, item.amount]));
}

export function buildProjectionAccountLedger({ plan, accountFold, taxableBasis, initialShock = 0 }){
  const legacySchema = plan?.meta?.accountSchemaVersion !== ACCOUNT_SCHEMA_VERSION;
  const legacyAllocation = legacySchema
    ? snapshotLegacyRiskProfileAllocation(plan?.portfolio?.riskProfile)
    : null;
  const modeledIds = new Set(BUCKET_KEYS.flatMap(bucket => accountFold.engineBuckets[bucket].accountIds));
  const accounts = accountFold.accounts
    .filter(account => modeledIds.has(account.id))
    .map(account => ({ ...account }));

  for(const bucket of BUCKET_KEYS){
    const sleeve = plan?.portfolio?.accounts?.[bucket];
    const id = sleeve?.id ?? `base-${bucket}`;
    if(accounts.some(account => account.id === id) || !sleeve) continue;
    accounts.push({
      id,
      sourceKind: 'legacy-base',
      sourceIndex: null,
      typeId: null,
      label: `Legacy ${bucket} balance`,
      owner: 'household',
      engineBucket: bucket,
      taxCharacter: `legacy_${bucket}`,
      balance: Number(sleeve.balance) || 0,
      basis: null,
      strategyRulesPending: false,
      investmentAllocation: sleeve.investmentAllocation ?? legacyAllocation,
    });
  }

  const basisById = evidenceBasisById(taxableBasis);
  const taxableAccounts = accounts.filter(account => account.engineBucket === 'taxable');
  const knownBasis = taxableAccounts.reduce((sum, account) => sum + (basisById.get(account.id) ?? 0), 0);
  const missingTaxable = taxableAccounts.filter(account => !basisById.has(account.id));
  const missingBalance = missingTaxable.reduce((sum, account) => sum + account.balance, 0);
  const remainingBasis = Math.max(0, (taxableBasis?.appliedBasis ?? 0) - knownBasis);

  return accounts.map(account => {
    const allocation = account.investmentAllocation
      ?? (legacySchema
        ? (account.investmentAllocationEligible === false
          ? resolveCashOnlyAllocation()
          : legacyAllocation)
        : null);
    if(!allocation){
      throw allocationError('INVALID_ASSET_WEIGHTS', `Account ${account.id} has no investment allocation`);
    }
    prepareAllocationAtLedgerBoundary(allocation);
    const shockMultiplier = 1 - initialShock * growthShare(allocation);
    const rawBalance = account.balance;
    const basis = account.engineBucket === 'taxable'
      ? (basisById.get(account.id)
        ?? (missingBalance > 0 ? remainingBasis * (rawBalance / missingBalance) : 0))
      : 0;
    const projectionAccount = {
      id: account.id,
      bucket: account.engineBucket,
      owner: account.owner === 'client' || account.owner === 'spouse'
        ? account.owner
        : (account.engineBucket === 'traditional' && !plan?.household?.spouse
          ? 'client'
          : 'unattributed'),
      sourceKind: account.sourceKind,
      typeId: account.typeId,
      taxCharacter: account.taxCharacter,
      balance: rawBalance * shockMultiplier,
      basis,
      appliedReturn: 0,
      investmentAllocation: allocation,
    };
    return projectionAccount;
  });
}

export function cloneProjectionAccountLedger(ledger){
  return ledger.map(cloneAccount);
}

export function accountBalancesById(ledger){
  return Object.fromEntries(ledger.map(account => [account.id, account.balance]));
}

export function aggregateProjectionAccounts(ledger){
  const balances = { taxable: 0, traditional: 0, roth: 0 };
  const traditionalByOwner = { client: 0, spouse: 0, unattributed: 0 };
  let taxableBasis = 0;
  for(const account of ledger){
    balances[account.bucket] += account.balance;
    if(account.bucket === 'taxable') taxableBasis += account.basis;
    if(account.bucket === 'traditional') traditionalByOwner[account.owner] += account.balance;
  }
  return { balances, traditionalByOwner, taxableBasis };
}

export function syncProjectionAggregates(ledger, accounts){
  const aggregate = aggregateProjectionAccounts(ledger);
  accounts.taxable.balance = aggregate.balances.taxable;
  accounts.taxable.basis = aggregate.taxableBasis;
  accounts.traditional.balance = aggregate.balances.traditional;
  accounts.traditional.byOwner = { ...aggregate.traditionalByOwner };
  accounts.roth.balance = aggregate.balances.roth;
  return aggregate;
}

export function resolveProjectionReturnFrame(ledger, returnRow, returnAdj, options = {}){
  const includeAccountDiagnostics = options.includeAccountDiagnostics !== false;
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  const accountReturns = includeAccountDiagnostics ? {} : null;
  const appliedReturns = [];
  let openingBalance = 0;
  let returnDollars = 0;
  const requestedTotals = includeAccountDiagnostics
    ? Object.fromEntries(ASSET_KEYS.map(key => [key, 0]))
    : null;
  const effectiveTotals = includeAccountDiagnostics
    ? Object.fromEntries(ASSET_KEYS.map(key => [key, 0]))
    : null;

  for(const account of ledger){
    const allocation = projectionReturnCache.resolve(
      returnRow,
      preparedAllocationForRead(account.investmentAllocation),
    );
    const appliedReturn = allocation.baseRealReturn + returnAdj;
    account.appliedReturn = appliedReturn;
    appliedReturns.push(appliedReturn);
    const contribution = account.balance * appliedReturn;
    openingBalance += account.balance;
    returnDollars += contribution;
    if(includeAccountDiagnostics){
      for(const key of ASSET_KEYS){
        requestedTotals[key] += account.balance * allocation.requestedWeights[key];
        effectiveTotals[key] += account.balance * allocation.effectiveWeights[key];
      }
      accountReturns[account.id] = Object.freeze({
        mode: 'asset-blend',
        sourceYear: allocation.sourceYear,
        baseRealReturn: allocation.baseRealReturn,
        returnAdj,
        appliedReturn,
        requestedWeights: allocation.requestedWeights,
        effectiveWeights: allocation.effectiveWeights,
        unavailableAssetKeys: allocation.unavailableAssetKeys,
        redistributionKind: allocation.redistributionKind,
        returnDollars: contribution,
      });
    }
  }

  const householdWeights = totals => Object.freeze(Object.fromEntries(
    ASSET_KEYS.map(key => [key, openingBalance > 0 ? totals[key] / openingBalance : 0]),
  ));
  const commonAppliedReturn = appliedReturns.length > 0
    && appliedReturns.every(value => value === appliedReturns[0])
    ? appliedReturns[0]
    : null;
  const frame = {
    sourceYear: Number.isInteger(returnRow?.y) ? returnRow.y : null,
    openingBalance,
    returnDollars,
    returnRate: openingBalance > 0
      ? (commonAppliedReturn ?? returnDollars / openingBalance)
      : 0,
  };
  if(includeAccountDiagnostics){
    frame.accountReturns = Object.freeze(accountReturns);
    frame.householdAllocation = Object.freeze({
      requestedWeights: householdWeights(requestedTotals),
      effectiveWeights: householdWeights(effectiveTotals),
    });
  }
  return Object.freeze(frame);
}

function midyearFactor(returnRate){
  return Math.abs(returnRate) < 1e-7
    ? 12
    : returnRate / (Math.pow(1 + returnRate, 1 / 12) - 1);
}

function capacityFor(account){
  const factor = midyearFactor(account.appliedReturn);
  const rawScale = factor > 0
    ? ((1 + account.appliedReturn) * 12) / factor
    : 0;
  return account.balance * Math.max(0, Math.min(1, rawScale));
}

function candidateRate(account, taxRates){
  if(account.bucket === 'traditional') return taxRates.ordinary;
  if(account.bucket !== 'taxable' || account.balance <= 0) return 0;
  const gainFraction = Math.max(0, Math.min(1, (account.balance - account.basis) / account.balance));
  return gainFraction * taxRates.capitalGains;
}

export function fundProjectionGap(
  ledger,
  frame,
  gap,
  taxRates,
  strategy = 'taxable-first',
  traditionalRequiredByOwner = null,
){
  let remainingNeed = gap;
  const grossById = Object.fromEntries(ledger.map(account => [account.id, 0]));
  const breakdown = { taxable: 0, traditional: 0, roth: 0 };
  const taxBySource = { taxable: 0, traditional: 0 };
  const traditionalGrossByOwner = { client: 0, spouse: 0, unattributed: 0 };
  const available = new Map(ledger.map(account => [
    account.id,
    capacityFor(account),
  ]));

  function drawBucket(bucket, netNeeded){
    if(netNeeded <= 0.01) return;
    const candidates = ledger.filter(account => account.bucket === bucket && available.get(account.id) > 0.01);
    const capacity = candidates.reduce((sum, account) => sum + available.get(account.id), 0);
    if(capacity <= 0.01) return;
    const effectiveRate = candidates.reduce((sum, account) => (
      sum + available.get(account.id) * candidateRate(account, taxRates)
    ), 0) / capacity;
    const grossNeeded = effectiveRate < 0.999 ? netNeeded / (1 - effectiveRate) : netNeeded;
    const gross = Math.min(grossNeeded, capacity);
    const amounts = new Map(candidates.map(account => [account.id, 0]));
    let undistributed = gross;
    if(bucket === 'traditional' && traditionalRequiredByOwner){
      for(const owner of ['client', 'spouse']){
        const ownerAccounts = candidates.filter(account => account.owner === owner);
        const ownerCapacity = ownerAccounts.reduce((sum, account) => sum + available.get(account.id), 0);
        const ownerTake = Math.min(
          Math.max(0, traditionalRequiredByOwner[owner] ?? 0),
          ownerCapacity,
          undistributed,
        );
        if(ownerTake > 0 && ownerCapacity > 0){
          for(const account of ownerAccounts){
            amounts.set(account.id, ownerTake * (available.get(account.id) / ownerCapacity));
          }
          traditionalGrossByOwner[owner] += ownerTake;
          undistributed -= ownerTake;
        }
      }
    }
    if(undistributed > 0){
      const remainingCapacity = candidates.reduce(
        (sum, account) => sum + available.get(account.id) - amounts.get(account.id),
        0,
      );
      if(remainingCapacity > 0){
        for(const account of candidates){
          const residualCapacity = available.get(account.id) - amounts.get(account.id);
          const extra = undistributed * (residualCapacity / remainingCapacity);
          amounts.set(account.id, amounts.get(account.id) + extra);
          if(bucket === 'traditional') traditionalGrossByOwner[account.owner] += extra;
        }
      }
    }
    let delivered = 0;
    for(const account of candidates){
      const amount = amounts.get(account.id);
      const tax = amount * candidateRate(account, taxRates);
      grossById[account.id] += amount;
      available.set(account.id, available.get(account.id) - amount);
      breakdown[bucket] += amount;
      if(bucket === 'taxable' || bucket === 'traditional') taxBySource[bucket] += tax;
      delivered += amount - tax;
    }
    remainingNeed -= delivered;
  }

  if(strategy === 'proportional'){
    const total = [...available.values()].reduce((sum, value) => sum + value, 0);
    if(total > 0.01){
      for(const bucket of BUCKET_KEYS){
        const bucketCapacity = ledger
          .filter(account => account.bucket === bucket)
          .reduce((sum, account) => sum + available.get(account.id), 0);
        drawBucket(bucket, gap * (bucketCapacity / total));
      }
    }
    if(remainingNeed > 0.01){
      for(const bucket of BUCKET_KEYS){
        if(remainingNeed <= 0.01) break;
        drawBucket(bucket, remainingNeed);
      }
    }
  }else{
    const order = strategy === 'traditional-first'
      ? ['traditional', 'taxable', 'roth']
      : BUCKET_KEYS;
    for(const bucket of order){
      if(remainingNeed <= 0.01) break;
      drawBucket(bucket, remainingNeed);
    }
  }

  return {
    totalWithdrawn: Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    totalTax: taxBySource.taxable + taxBySource.traditional,
    breakdown,
    taxBySource,
    shortfall: Math.max(0, remainingNeed),
    grossById,
    traditionalGrossByOwner,
  };
}

export function applyProjectionYearReturnsAndWithdrawals(ledger, frame, grossById){
  let taxableCapitalGain = 0;
  for(const account of ledger){
    const start = account.balance;
    const gross = grossById?.[account.id] ?? 0;
    const appliedReturn = account.appliedReturn;
    const factor = midyearFactor(appliedReturn);
    if(account.bucket === 'taxable' && gross > 0 && start > 0){
      const basisFraction = Math.max(0, account.basis / start);
      taxableCapitalGain += gross * Math.max(0, 1 - basisFraction);
      account.basis = Math.max(0, account.basis - gross * basisFraction);
    }
    account.balance = start * (1 + appliedReturn) - (gross / 12) * factor;
    if(account.balance < 0 && account.balance > -0.01) account.balance = 0;
  }
  return { taxableCapitalGain };
}

function accountsInBucket(ledger, bucket, owner = null){
  return ledger.filter(account => account.bucket === bucket && (owner === null || account.owner === owner));
}

function contributionCandidates(ledger, bucket){
  const bucketAccounts = accountsInBucket(ledger, bucket);
  if(bucket !== 'traditional') return bucketAccounts;
  const existing401kAccounts = bucketAccounts.filter(account => account.typeId === '401k');
  return existing401kAccounts.length > 0 ? existing401kAccounts : bucketAccounts;
}

function contributionShares(accounts){
  const positive = accounts.filter(account => account.balance > 0);
  if(positive.length){
    const total = positive.reduce((sum, account) => sum + account.balance, 0);
    return positive.map(account => [account, account.balance / total]);
  }
  if(accounts.length) return [[accounts[0], 1]];
  return [];
}

export function applyProjectionContributions(ledger, frame, annualByBucket){
  const contributionsById = Object.fromEntries(ledger.map(account => [account.id, 0]));
  for(const bucket of BUCKET_KEYS){
    const annual = annualByBucket[bucket] ?? 0;
    const candidates = contributionCandidates(ledger, bucket);
    if(annual > 0 && candidates.length === 0){
      throw allocationError(
        'ALLOCATION_REQUIRED_FOR_CONTRIBUTIONS',
        `No allocation-bearing ${bucket} account is available for contributions`,
      );
    }
    for(const [account, share] of contributionShares(candidates)){
      contributionsById[account.id] = annual * share;
    }
  }
  for(const account of ledger){
    const annual = contributionsById[account.id];
    const appliedReturn = account.appliedReturn;
    const factor = midyearFactor(appliedReturn);
    account.balance = account.balance * (1 + appliedReturn) + (annual / 12) * factor;
    if(account.bucket === 'taxable') account.basis += annual;
  }
  return contributionsById;
}

export function applyDirectBucketWithdrawal(ledger, bucket, amount, owner = null){
  const candidates = accountsInBucket(ledger, bucket, owner).filter(account => account.balance > 0);
  const total = candidates.reduce((sum, account) => sum + account.balance, 0);
  const withdrawalsById = {};
  if(!(amount > 0) || total <= 0) return { withdrawn: 0, withdrawalsById, taxableCapitalGain: 0 };
  const withdrawn = Math.min(amount, total);
  let taxableCapitalGain = 0;
  for(const account of candidates){
    const take = withdrawn * (account.balance / total);
    withdrawalsById[account.id] = take;
    if(bucket === 'taxable'){
      const basisFraction = account.balance > 0 ? Math.max(0, account.basis / account.balance) : 0;
      taxableCapitalGain += take * Math.max(0, 1 - basisFraction);
      account.basis = Math.max(0, account.basis - take * basisFraction);
    }
    account.balance -= take;
  }
  return { withdrawn, withdrawalsById, taxableCapitalGain };
}

export function addProjectionCash(ledger, bucket, amount, basisAmount = 0){
  if(!(amount > 0)) return null;
  const shares = contributionShares(accountsInBucket(ledger, bucket));
  if(shares.length === 0){
    throw allocationError('ALLOCATION_REQUIRED_FOR_CONTRIBUTIONS', `No allocation-bearing ${bucket} account is available`);
  }
  for(const [account, share] of shares){
    account.balance += amount * share;
    if(bucket === 'taxable') account.basis += basisAmount * share;
  }
  return Object.fromEntries(shares.map(([account, share]) => [account.id, amount * share]));
}

export function applyProjectionOwnerRmd(ledger, requiredByOwner){
  const byOwner = { client: 0, spouse: 0, unattributed: 0 };
  const byId = {};
  for(const owner of ['client', 'spouse']){
    const result = applyDirectBucketWithdrawal(
      ledger,
      'traditional',
      requiredByOwner?.[owner] ?? 0,
      owner,
    );
    byOwner[owner] = result.withdrawn;
    Object.assign(byId, result.withdrawalsById);
  }
  return { byOwner, byId, total: byOwner.client + byOwner.spouse };
}

export function rolloverProjectionAccounts(ledger, from, to){
  for(const account of ledger){
    if(account.bucket === 'traditional' && account.owner === from) account.owner = to;
  }
}

export function zeroProjectionAccounts(ledger){
  for(const account of ledger){
    account.balance = 0;
    if(account.bucket === 'taxable') account.basis = 0;
  }
}
