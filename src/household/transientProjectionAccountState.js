import { cloneInvestmentAllocation } from './investmentAllocation.js';

const stateByPlan = new WeakMap();

/** Calculation-only values belong to one ephemeral plan, never saved facts. */
export function registerTransientProjectionAccountState(plan, states){
  if(!plan || typeof plan !== 'object' || Array.isArray(plan)){
    throw new TypeError('projection plan is required');
  }
  const byId = new Map();
  for(const state of states){
    if(typeof state.id !== 'string' || !state.id || byId.has(state.id)){
      throw new TypeError('projection account IDs must be nonempty and unique');
    }
    const record = {};
    if(state.basis !== undefined){
      if(!Number.isFinite(state.basis) || state.basis < 0){
        throw new TypeError('projection account basis must be finite and nonnegative');
      }
      record.basis = state.basis;
    }
    if(state.investmentAllocation !== undefined){
      record.investmentAllocation = cloneInvestmentAllocation(state.investmentAllocation);
    }
    byId.set(state.id, Object.freeze(record));
  }
  stateByPlan.set(plan, byId);
}

export function readTransientProjectionAccountState(plan, id){
  return stateByPlan.get(plan)?.get(id) ?? null;
}
