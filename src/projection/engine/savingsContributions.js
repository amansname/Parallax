import { householdStateAtYear } from './householdTimeline.js';

/** Resolve person-directed savings before account allocation for this year. */
export function savingsContributionsAtYear(params, yearIndex){
  const annualByBucket = {
    taxable: params.savingsAnnual * params.savingsSplit.taxable,
    traditional: params.savingsAnnual * params.savingsSplit.traditional,
    roth: params.savingsAnnual * params.savingsSplit.roth,
  };
  const state = householdStateAtYear(params, yearIndex);
  const entries = [];
  for(const entry of params.savingsEntries){
    const person = state.people[entry.owner];
    if(person?.alive === true && person.retired === false){
      entries.push(entry);
    }else{
      // Remove stopped savings from the total as well as the explicit entries.
      // Otherwise account allocation would add them back as unallocated savings.
      annualByBucket[entry.bucket] = Math.max(0, annualByBucket[entry.bucket] - entry.amount);
    }
  }
  return { annualByBucket, entries };
}
