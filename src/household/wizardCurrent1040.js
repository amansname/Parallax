import {
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
} from '../tax/annual1040.js';
import {
  cloneWizardValue,
  hasOwn,
} from './wizardIntakeSupport.js';

function supportedDefaultTaxYear(){
  return 2026;
}

function birthDateValue(plan, owner){
  const value = plan.taxProfiles?.[owner]?.birthDate?.value;
  return typeof value === 'string' && value.trim() ? value : null;
}

function returnScopeForFilingStatus(filingStatus){
  return {
    modeledTaxpayer: filingStatus === 'marriedFilingJointly'
      ? 'jointReturn'
      : 'client',
  };
}

function activeTaxpayerOwners(filingStatus){
  return filingStatus === 'marriedFilingJointly'
    ? ['client', 'spouse']
    : ['client'];
}

function syncTaxpayerFacts(plan, current){
  const filingStatus = plan.meta?.filingStatus;
  const previous = current.taxpayers && typeof current.taxpayers === 'object'
    ? current.taxpayers
    : {};
  const taxpayers = {};
  for(const owner of activeTaxpayerOwners(filingStatus)){
    const prior = previous[owner] && typeof previous[owner] === 'object'
      ? cloneWizardValue(previous[owner])
      : {};
    const birthDate = birthDateValue(plan, owner);
    if(birthDate) prior.birthDate = birthDate;
    else delete prior.birthDate;
    if(filingStatus === 'marriedFilingJointly'){
      taxpayers[owner] = prior;
    }else if(Object.keys(prior).length > 0){
      taxpayers[owner] = prior;
    }
  }
  if(filingStatus !== 'marriedFilingSeparately'){
    current.returnScope = returnScopeForFilingStatus(filingStatus);
  }else if(!current.returnScope || typeof current.returnScope !== 'object'){
    current.returnScope = { modeledTaxpayer: 'client' };
  }
  current.taxpayers = taxpayers;
}

export function restrictTaxpayersToBaseAndAge(plan, current){
  const taxpayers = {};
  for(const owner of activeTaxpayerOwners(plan.meta?.filingStatus)){
    const birthDate = birthDateValue(plan, owner);
    if(birthDate) taxpayers[owner] = { birthDate };
  }
  current.returnScope = returnScopeForFilingStatus(plan.meta?.filingStatus);
  current.taxpayers = taxpayers;
}

function createBaseCurrent1040(plan){
  const current = {
    schemaVersion: CLIENT_1040_INTAKE_SCHEMA_VERSION,
    taxYear: supportedDefaultTaxYear(),
    incomeSourcesComplete: false,
    returnScope: returnScopeForFilingStatus(plan.meta?.filingStatus),
    taxpayers: {},
    income: {},
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
    },
  };
  syncTaxpayerFacts(plan, current);
  return current;
}

export function ensureWizardCurrent1040(plan){
  if(!plan.incomeTax || typeof plan.incomeTax !== 'object'){
    plan.incomeTax = {};
  }
  if(!plan.incomeTax.current1040
      || typeof plan.incomeTax.current1040 !== 'object'
      || Array.isArray(plan.incomeTax.current1040)){
    plan.incomeTax.current1040 = createBaseCurrent1040(plan);
  }
  const current = plan.incomeTax.current1040;
  if(!hasOwn(current, 'schemaVersion')){
    current.schemaVersion = CLIENT_1040_INTAKE_SCHEMA_VERSION;
  }
  if(!hasOwn(current, 'taxYear')) current.taxYear = supportedDefaultTaxYear();
  if(!hasOwn(current, 'incomeSourcesComplete')) current.incomeSourcesComplete = false;
  if(!current.income || typeof current.income !== 'object') current.income = {};
  if(!current.deductions || typeof current.deductions !== 'object'){
    current.deductions = {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
    };
  }
  syncTaxpayerFacts(plan, current);
  return current;
}

export function syncWizardTaxpayerFacts(plan){
  if(!plan.incomeTax?.current1040) return;
  syncTaxpayerFacts(plan, plan.incomeTax.current1040);
}

export function buildWizardTaxPlan(plan){
  const next = cloneWizardValue(plan);
  ensureWizardCurrent1040(next);
  return next;
}
