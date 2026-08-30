const projectionAccountStateByPlan = new WeakMap();

function assertPlan(value){
  if(value === null || typeof value !== 'object' || Array.isArray(value)){
    throw new TypeError('plan must be a plain object');
  }
}

function normalizedMap(value, path){
  if(value == null) return new Map();
  if(value instanceof Map) return new Map(value);
  if(typeof value !== 'object' || Array.isArray(value)){
    throw new TypeError(`${path} must be a Map or plain object`);
  }
  return new Map(Object.entries(value));
}

function assertBasisById(entries){
  for(const [accountId, basisAmount] of entries){
    if(typeof accountId !== 'string' || accountId.length === 0){
      throw new TypeError('taxable basis account IDs must be non-empty strings');
    }
    if(typeof basisAmount !== 'number' || !Number.isFinite(basisAmount) || basisAmount < 0){
      throw new TypeError(`taxable basis for ${accountId} must be finite and nonnegative`);
    }
  }
}

function assertAllocationById(entries){
  for(const [accountId, allocation] of entries){
    if(typeof accountId !== 'string' || accountId.length === 0){
      throw new TypeError('allocation account IDs must be non-empty strings');
    }
    if(!allocation || typeof allocation !== 'object' || Array.isArray(allocation)){
      throw new TypeError(`investment allocation for ${accountId} must be an object`);
    }
  }
}

/**
 * Attach calculation-only account state to an ephemeral plan without adding
 * serializable Household fields or rewriting saved provenance.
 */
export function registerTransientProjectionAccountState(plan, {
  taxableBasisById = null,
  investmentAllocationById = null,
} = {}){
  assertPlan(plan);
  const basis = normalizedMap(taxableBasisById, 'taxableBasisById');
  const allocations = normalizedMap(investmentAllocationById, 'investmentAllocationById');
  assertBasisById(basis);
  assertAllocationById(allocations);
  projectionAccountStateByPlan.set(plan, Object.freeze({
    taxableBasisById: basis,
    investmentAllocationById: allocations,
  }));
  return plan;
}

export function readTransientProjectionAccountState(plan){
  if(plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null;
  return projectionAccountStateByPlan.get(plan) ?? null;
}
