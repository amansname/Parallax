const calculatedTaxableBasisByPlan = new WeakMap();

function assertPlan(value){
  if(value === null || typeof value !== 'object' || Array.isArray(value)){
    throw new TypeError('plan must be a plain object');
  }
}

function assertBasisAmount(value){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new TypeError('calculated taxable basis must be finite and nonnegative');
  }
}

/**
 * Attach calculation-only provenance to an ephemeral plan object without
 * adding a serializable Household field.
 */
export function registerTransientCalculatedTaxableBasis(plan, basisAmount){
  assertPlan(plan);
  assertBasisAmount(basisAmount);
  calculatedTaxableBasisByPlan.set(plan, basisAmount);
  return plan;
}

/** Read the exact carried-forward basis only from the same ephemeral object. */
export function readTransientCalculatedTaxableBasis(plan){
  if(plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null;
  return calculatedTaxableBasisByPlan.get(plan) ?? null;
}
