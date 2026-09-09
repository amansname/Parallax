// Confirmation is bound to the household, original savings, and proposed entry.
// It is transient UI state; only the accepted prior values enter the archive.
export function requireSavingsReplacementConfirmation(plan, entry, confirmation){
  const savings = plan.savings;
  if(savings?.entries !== undefined && !Array.isArray(savings.entries)){
    throw new Error('savings.entries must be an array');
  }
  const required = entry.amount > 0 && Number(savings?.annual) > 0
    && (!Array.isArray(savings?.entries) || savings.entries.length === 0);
  const snapshot = JSON.stringify({
    householdId: plan.meta?.householdId,
    savings,
    entry,
  });
  if(confirmation != null){
    if(!required || confirmation.snapshot !== snapshot){
      const error = new Error('Savings changed since this review. Review the current amount before saving.');
      error.code = 'SAVINGS_REPLACEMENT_STALE';
      throw error;
    }
    return true;
  }
  if(!required) return false;
  const error = new Error('Review the existing savings total before replacing it.');
  error.code = 'SAVINGS_REPLACEMENT_REQUIRED';
  error.confirmation = {
    snapshot,
    priorAnnual: Number(savings.annual),
    itemizedAnnual: entry.amount,
  };
  throw error;
}

export function archiveSavingsReplacement(plan, priorSavings){
  const archive = Array.isArray(plan.meta?.legacyRepairArchive)
    ? plan.meta.legacyRepairArchive : [];
  plan.meta.legacyRepairArchive = [...archive, {
    version: 1,
    code: 'LEGACY_SAVINGS_REPLACED',
    householdId: plan.meta.householdId,
    priorSavings,
    priorAnnual: Number(priorSavings.annual),
    priorSplit: structuredClone(priorSavings.split),
    itemizedAnnual: plan.savings.annual,
    itemizedSplit: structuredClone(plan.savings.split),
  }];
}
