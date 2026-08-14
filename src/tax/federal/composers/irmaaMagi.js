import { TaxInputError } from '../../core/errors.js';

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

function requiredFinite(value, field){
  if(typeof value !== 'number' || !Number.isFinite(value)){
    throw new TaxInputError(`${field} must be a finite number`, { field });
  }
  return value;
}

function optionalNonnegative(value, field){
  if(value === undefined || value === null || value === '') return 0;
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new TaxInputError(`${field} must be zero or a positive finite number`, { field });
  }
  return value;
}

export function composeIrmaaMagi({
  adjustedGrossIncome,
  taxExemptInterest = 0,
  uncommonAddbacks = 0,
}){
  const components = {
    adjustedGrossIncome: requiredFinite(
      adjustedGrossIncome,
      'adjustedGrossIncome',
    ),
    taxExemptInterest: optionalNonnegative(
      taxExemptInterest,
      'taxExemptInterest',
    ),
    uncommonAddbacks: optionalNonnegative(
      uncommonAddbacks,
      'uncommonAddbacks',
    ),
  };
  return Object.freeze({
    magi: round2(
      components.adjustedGrossIncome
      + components.taxExemptInterest
      + components.uncommonAddbacks
    ),
    components: Object.freeze(components),
  });
}
