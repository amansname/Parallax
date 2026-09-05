const SAVINGS_BUCKETS = Object.freeze(['taxable', 'traditional', 'roth']);

function emptyTotals(){
  return { taxable: 0, traditional: 0, roth: 0 };
}

function itemizedAmount(entry, index){
  const amount = Number(entry?.amount);
  if(!Number.isFinite(amount) || amount <= 0){
    throw new Error(`savings.entries[${index}].amount must be positive`);
  }
  if(!SAVINGS_BUCKETS.includes(entry?.bucket)){
    throw new Error(`savings.entries[${index}].bucket is invalid`);
  }
  return amount;
}

export function itemizedSavingsAggregate(entries){
  const rows = Array.isArray(entries) ? entries : [];
  const totals = emptyTotals();
  rows.forEach((entry, index) => {
    totals[entry.bucket] += itemizedAmount(entry, index);
  });
  const annual = SAVINGS_BUCKETS.reduce((sum, bucket) => sum + totals[bucket], 0);
  const split = annual > 0
    ? Object.fromEntries(SAVINGS_BUCKETS.map(bucket => [bucket, totals[bucket] / annual]))
    : { taxable: 0, traditional: 1, roth: 0 };
  return { annual, totals, split };
}

export function writeItemizedSavingsAggregate(plan){
  if(!plan.savings || typeof plan.savings !== 'object' || Array.isArray(plan.savings)){
    plan.savings = {};
  }
  if(!Array.isArray(plan.savings.entries)) plan.savings.entries = [];
  const aggregate = itemizedSavingsAggregate(plan.savings.entries);
  plan.savings.annual = aggregate.annual;
  plan.savings.split = aggregate.split;
  delete plan.savings.unallocatedAnnual;
  delete plan.savings.unallocatedSplit;
  return aggregate;
}

export function reconcilePersistedItemizedSavings(plan, householdId = 'household'){
  const entries = plan?.savings?.entries;
  if(!Array.isArray(entries) || entries.length === 0){
    return { changed: false, repair: null };
  }

  const aggregate = itemizedSavingsAggregate(entries);
  const currentSplit = plan.savings.split || {};
  const hasHiddenAggregate = Object.hasOwn(plan.savings, 'unallocatedAnnual')
    || Object.hasOwn(plan.savings, 'unallocatedSplit');
  const aggregateChanged = Number(plan.savings.annual) !== aggregate.annual
    || SAVINGS_BUCKETS.some(bucket => Number(currentSplit[bucket]) !== aggregate.split[bucket]);
  if(!hasHiddenAggregate && !aggregateChanged){
    return { changed: false, repair: null };
  }

  const archive = Array.isArray(plan.meta?.legacyRepairArchive)
    ? plan.meta.legacyRepairArchive
    : [];
  const archived = {
    version: 1,
    code: 'HIDDEN_SAVINGS_AGGREGATE_RECONCILED',
    householdId,
    priorAnnual: Number(plan.savings.annual) || 0,
    priorSplit: structuredClone(currentSplit),
    itemizedAnnual: aggregate.annual,
    itemizedSplit: structuredClone(aggregate.split),
    ...(Object.hasOwn(plan.savings, 'unallocatedAnnual')
      ? { unallocatedAnnual: Number(plan.savings.unallocatedAnnual) || 0 }
      : {}),
    ...(Object.hasOwn(plan.savings, 'unallocatedSplit')
      ? { unallocatedSplit: structuredClone(plan.savings.unallocatedSplit) }
      : {}),
  };
  archive.push(archived);
  plan.meta.legacyRepairArchive = archive;
  writeItemizedSavingsAggregate(plan);
  return {
    changed: true,
    repair: {
      code: archived.code,
      priorAnnual: archived.priorAnnual,
      itemizedAnnual: archived.itemizedAnnual,
    },
  };
}
