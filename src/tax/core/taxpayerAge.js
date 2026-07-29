import { TaxInputError } from './errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTaxDate(value){
  if(typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * Federal age convention: a person attains an age on the day before their
 * birthday. A January 1 birthday therefore qualifies for the preceding tax
 * year (for example, born before January 2, 1961 for tax year 2025).
 */
export function isAge65ByTaxYearEnd(birthDate, taxYear){
  if(!isValidTaxDate(birthDate) || !Number.isInteger(taxYear)) return false;
  const [year, month, day] = birthDate.split('-').map(Number);
  const attainment = new Date(Date.UTC(year + 65, month - 1, day));
  attainment.setUTCDate(attainment.getUTCDate() - 1);
  return attainment <= new Date(Date.UTC(taxYear, 11, 31));
}

export function activeTaxpayerOwnersForReturn(filingStatus, modeledTaxpayer){
  if(filingStatus === 'marriedFilingJointly') return ['client', 'spouse'];
  if(filingStatus === 'marriedFilingSeparately'){
    if(modeledTaxpayer !== 'client' && modeledTaxpayer !== 'spouse'){
      throw new TaxInputError(
        'MFS calculation requires modeledTaxpayer to be client or spouse',
        { modeledTaxpayer }
      );
    }
    return [modeledTaxpayer];
  }
  return ['client'];
}
