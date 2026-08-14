import {
  FILING_STATUSES,
  IRMAA_MFS_LIVING_ARRANGEMENTS,
} from '../tax/core/constants.js';

export const WIZARD_IRMAA_SCHEMA_VERSION = 1;

function parseIrmaaNumber(value){
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[$,\s]/g, ''));
  if(!Number.isFinite(parsed)) throw new Error('Enter a valid number');
  if(parsed < 0) throw new Error('Enter zero or a positive amount');
  return parsed;
}

function planStartYear(plan){
  return Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
}

export function irmaaLookbackTaxYears(plan){
  const start = planStartYear(plan);
  return Object.freeze([start - 2, start - 1]);
}

function savedLookback(plan, year){
  const saved = plan?.incomeTax?.irmaa?.lookbackByTaxYear?.[year];
  return saved && typeof saved === 'object' && !Array.isArray(saved)
    ? saved
    : {};
}

export function readWizardIrmaaLookback(plan){
  const defaultFilingStatus = FILING_STATUSES.includes(plan?.meta?.filingStatus)
    ? plan.meta.filingStatus
    : '';
  return Object.freeze(irmaaLookbackTaxYears(plan).map(taxYear => {
    const saved = savedLookback(plan, taxYear);
    return Object.freeze({
      taxYear,
      magi: saved.magi,
      filingStatus: FILING_STATUSES.includes(saved.filingStatus)
        ? saved.filingStatus
        : defaultFilingStatus,
      mfsLivingArrangement:
        IRMAA_MFS_LIVING_ARRANGEMENTS.includes(saved.mfsLivingArrangement)
          ? saved.mfsLivingArrangement
          : '',
    });
  }));
}

function ensureIrmaaEnvelope(plan){
  if(!plan.incomeTax || typeof plan.incomeTax !== 'object'
      || Array.isArray(plan.incomeTax)) plan.incomeTax = {};
  if(!plan.incomeTax.irmaa || typeof plan.incomeTax.irmaa !== 'object'
      || Array.isArray(plan.incomeTax.irmaa)){
    plan.incomeTax.irmaa = {
      schemaVersion: WIZARD_IRMAA_SCHEMA_VERSION,
      lookbackByTaxYear: {},
    };
  }
  const envelope = plan.incomeTax.irmaa;
  envelope.schemaVersion = WIZARD_IRMAA_SCHEMA_VERSION;
  if(!envelope.lookbackByTaxYear
      || typeof envelope.lookbackByTaxYear !== 'object'
      || Array.isArray(envelope.lookbackByTaxYear)){
    envelope.lookbackByTaxYear = {};
  }
  return envelope;
}

function removeEmptyEnvelope(plan, year){
  const envelope = plan.incomeTax?.irmaa;
  const row = envelope?.lookbackByTaxYear?.[year];
  if(row && Object.keys(row).length === 0) delete envelope.lookbackByTaxYear[year];
  if(envelope && Object.keys(envelope.lookbackByTaxYear || {}).length === 0){
    delete plan.incomeTax.irmaa;
  }
}

export function setWizardIrmaaLookbackField(plan, field, value){
  const match = /^irmaa\.lookback\.(\d{4})\.(magi|filingStatus|mfsLivingArrangement)$/.exec(field);
  if(!match) throw new Error(`Unsupported IRMAA field: ${field}`);
  const taxYear = Number(match[1]);
  const key = match[2];
  if(!irmaaLookbackTaxYears(plan).includes(taxYear)){
    throw new Error('IRMAA lookback year is outside the plan window');
  }
  if(key === 'magi' && (value === '' || value === null || value === undefined)){
    const row = plan.incomeTax?.irmaa?.lookbackByTaxYear?.[taxYear];
    if(row) delete row.magi;
    removeEmptyEnvelope(plan, taxYear);
    return null;
  }
  if(key === 'mfsLivingArrangement'
      && (value === '' || value === null || value === undefined)){
    const row = plan.incomeTax?.irmaa?.lookbackByTaxYear?.[taxYear];
    if(row) delete row.mfsLivingArrangement;
    removeEmptyEnvelope(plan, taxYear);
    return null;
  }

  const envelope = ensureIrmaaEnvelope(plan);
  const row = envelope.lookbackByTaxYear[taxYear]
    && typeof envelope.lookbackByTaxYear[taxYear] === 'object'
    && !Array.isArray(envelope.lookbackByTaxYear[taxYear])
    ? envelope.lookbackByTaxYear[taxYear]
    : {};
  envelope.lookbackByTaxYear[taxYear] = row;

  if(key === 'magi'){
    row.magi = parseIrmaaNumber(value);
    if(!FILING_STATUSES.includes(row.filingStatus)
        && FILING_STATUSES.includes(plan.meta?.filingStatus)){
      row.filingStatus = plan.meta.filingStatus;
    }
  }else if(key === 'filingStatus'){
    if(!FILING_STATUSES.includes(value)){
      throw new Error('Unsupported IRMAA filing status');
    }
    row.filingStatus = value;
    if(value !== 'marriedFilingSeparately') delete row.mfsLivingArrangement;
  }else{
    if(row.filingStatus !== 'marriedFilingSeparately'){
      throw new Error('IRMAA living arrangement applies only to MFS');
    }
    if(!IRMAA_MFS_LIVING_ARRANGEMENTS.includes(value)){
      throw new Error('Unsupported IRMAA living arrangement');
    }
    row.mfsLivingArrangement = value;
  }
  return row;
}
