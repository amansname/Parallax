export const BANK_TYPE_IDS = new Set(['checking', 'savings', 'money_market', 'certificate_of_deposit']);
const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

// Shared aggregation of entered balances, previously owned by the Net Worth
// renderer. Portfolio remains the production tax-bucket snapshot's total.
export function householdNetWorthTotals(plan, taxBucketSnapshot){
  const accounts = plan.portfolio?.extraAccounts || [];
  const properties = plan.properties || [];
  const shellTotals = { bank: 0, investment: 0, property: 0, insurance: 0, card: 0, mortgage: 0, loan: 0 };
  for(const entry of plan.netWorth?.shellEntries || []){
    if(entry?.categoryId in shellTotals) shellTotals[entry.categoryId] += number(entry.value);
  }
  const canonicalBankTotal = accounts.filter(account => BANK_TYPE_IDS.has(account.typeId))
    .reduce((sum, account) => sum + number(account.balance), 0);
  const categoryAmounts = {
    bank: canonicalBankTotal + shellTotals.bank,
    investment: Math.max(0, number(taxBucketSnapshot.totalBalance) - canonicalBankTotal) + shellTotals.investment,
    property: properties.reduce((sum, property) => sum + number(property?.value), 0) + shellTotals.property,
    insurance: shellTotals.insurance,
    card: shellTotals.card,
    mortgage: properties.reduce((sum, property) => sum + number(property?.mortgage?.balance), 0) + shellTotals.mortgage,
    loan: shellTotals.loan,
  };
  const basePortfolioTotal = Object.values(plan.portfolio?.accounts || {})
    .reduce((sum, sleeve) => sum + number(sleeve?.balance), 0);
  const assetTotal = ['bank', 'investment', 'property', 'insurance'].reduce((sum, key) => sum + categoryAmounts[key], 0);
  const liabilityTotal = ['card', 'mortgage', 'loan'].reduce((sum, key) => sum + categoryAmounts[key], 0);
  return { categoryAmounts, basePortfolioTotal, assetTotal, liabilityTotal, netWorthTotal: assetTotal - liabilityTotal };
}
