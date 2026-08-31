// Shared engine fixtures; each factory returns fresh state.
import { ASSET_KEYS, defaultPlan } from '../../engine.js';
import { createAccount } from '../../src/household/createAccount.js';
import { ACCOUNT_SCHEMA_VERSION } from '../../src/household/accountTypes.js';
import { snapshotLegacyRiskProfileAllocation } from '../../src/household/investmentAllocation.js';

export function flatAssetReturnRow(year, returnRate = 0){
  return {
    y: year,
    ...Object.fromEntries(ASSET_KEYS.map(key => [key, returnRate])),
  };
}

export function currentAllocationPlan(){
  const p = structuredClone(defaultPlan);
  p.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  const legacyAllocation = snapshotLegacyRiskProfileAllocation(p.portfolio.riskProfile);
  for(const bucket of ['taxable', 'traditional', 'roth']){
    p.portfolio.accounts[bucket].id = `base-${bucket}`;
    p.portfolio.accounts[bucket].investmentAllocation = legacyAllocation;
  }
  return p;
}

export function typedInvestmentAccount(typeId, id, balance, allocation){
  const account = createAccount(typeId, {
    owner: 'client',
    balance,
    investmentAllocation: allocation,
  });
  account.id = id;
  return account;
}
