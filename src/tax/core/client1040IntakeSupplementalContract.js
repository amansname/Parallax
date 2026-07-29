import {
  hasOwn,
  isPlainObject,
  issue,
  rejectUnexpectedKeys,
  requireFinite,
  requireNonNegative,
  requirePlainObject,
} from './client1040IntakeContractShared.js';

export function validateCanonicalSuppliedFields(errors, intake){
  if(intake.passThrough !== undefined){
    if(requirePlainObject(errors, intake.passThrough, 'passThrough')){
      rejectUnexpectedKeys(errors, intake.passThrough, [
        'line11a',
        'line15',
        'line17',
        'line19',
        'line20',
        'line23',
        'payments',
      ], 'passThrough', 'UNKNOWN_CANONICAL_FIELD');
      if(hasOwn(intake.passThrough, 'line11a')){
        requireFinite(errors, intake.passThrough.line11a, 'passThrough.line11a');
      }
      for(const field of ['line15', 'line17', 'line19', 'line20', 'line23', 'payments']){
        if(hasOwn(intake.passThrough, field)){
          requireNonNegative(errors, intake.passThrough[field], `passThrough.${field}`);
        }
      }
    }
  }

  if(intake.schedule2 !== undefined
      && requirePlainObject(errors, intake.schedule2, 'schedule2')){
    rejectUnexpectedKeys(errors, intake.schedule2, [
      'netInvestmentIncomeTax',
      'additionalMedicareTax',
      'otherPartIITaxes',
    ], 'schedule2', 'UNKNOWN_CANONICAL_FIELD');
    for(const field of [
      'netInvestmentIncomeTax',
      'additionalMedicareTax',
      'otherPartIITaxes',
    ]){
      requireNonNegative(errors, intake.schedule2[field], `schedule2.${field}`);
    }
    if(intake.passThrough?.line23 !== undefined){
      issue(errors, 'SCHEDULE_2_SOURCE_CONFLICT',
        'Canonical Schedule 2 components cannot be mixed with supplied line 23',
        'schedule2');
    }
    if(intake.scheduleSE === undefined){
      issue(errors, 'SCHEDULE_2_COMPONENTS_REQUIRE_COMPOSER',
        'Schedule 2 components without Schedule SE must be supplied as Form 1040 line 23 for now',
        'schedule2');
    }
  }

  if(intake.deductions?.qbi !== undefined){
    requireNonNegative(errors, intake.deductions.qbi, 'deductions.qbi');
  }
  if(intake.reconciliation !== undefined
      && requirePlainObject(errors, intake.reconciliation, 'reconciliation')){
    rejectUnexpectedKeys(errors, intake.reconciliation,
      ['theirLine24', 'tolerance'],
      'reconciliation',
      'UNKNOWN_CANONICAL_FIELD');
    if(hasOwn(intake.reconciliation, 'theirLine24')){
      requireNonNegative(errors, intake.reconciliation.theirLine24,
        'reconciliation.theirLine24');
    }
    if(hasOwn(intake.reconciliation, 'tolerance')){
      requireNonNegative(errors, intake.reconciliation.tolerance,
        'reconciliation.tolerance');
    }
  }
}

export function validateScheduleSE(errors, intake){
  if(intake.scheduleSE === undefined) return;
  if(!Array.isArray(intake.scheduleSE)){
    issue(errors, 'INVALID_SCHEDULE_SE',
      'scheduleSE must be an array', 'scheduleSE');
    return;
  }
  if(intake.scheduleSE.length === 0){
    issue(errors, 'INVALID_SCHEDULE_SE',
      'scheduleSE must contain at least one taxpayer entry', 'scheduleSE');
    return;
  }

  const seen = new Set();
  const modeled = intake.returnScope?.modeledTaxpayer;
  for(const [index, entry] of intake.scheduleSE.entries()){
    const path = `scheduleSE[${index}]`;
    if(!isPlainObject(entry)){
      issue(errors, 'INVALID_SCHEDULE_SE',
        `${path} must be a plain object`, path);
      continue;
    }
    rejectUnexpectedKeys(errors, entry, [
      'taxpayerOwner',
      'netEarningsFromSelfEmployment',
      'socialSecurityWagesAndTips',
      'socialSecurityWagesAndTipsIsScheduleSELine8d',
    ], path, 'UNKNOWN_CANONICAL_FIELD');
    const owner = entry.taxpayerOwner;
    if(owner !== 'client' && owner !== 'spouse'){
      issue(errors, 'MISSING_SCHEDULE_SE_TAXPAYER',
        `${path}.taxpayerOwner must be client or spouse`,
        `${path}.taxpayerOwner`);
    } else if(seen.has(owner)){
      issue(errors, 'DUPLICATE_SCHEDULE_SE_TAXPAYER',
        `Only one aggregated Schedule SE entry is allowed for ${owner}`,
        `${path}.taxpayerOwner`);
    } else {
      seen.add(owner);
    }

    if((intake.filingStatus === 'single' || intake.filingStatus === 'headOfHousehold')
        && owner === 'spouse'){
      issue(errors, 'SCHEDULE_SE_OUTSIDE_MODELED_RETURN',
        'A non-married modeled return cannot include a spouse Schedule SE',
        `${path}.taxpayerOwner`);
    }
    if(intake.filingStatus === 'marriedFilingSeparately'
        && (owner === 'client' || owner === 'spouse')
        && owner !== modeled){
      issue(errors, 'SCHEDULE_SE_OUTSIDE_MODELED_RETURN',
        'MFS Schedule SE must belong to the modeled taxpayer',
        `${path}.taxpayerOwner`);
    }
    requireNonNegative(errors, entry.netEarningsFromSelfEmployment,
      `${path}.netEarningsFromSelfEmployment`);
    requireNonNegative(errors, entry.socialSecurityWagesAndTips,
      `${path}.socialSecurityWagesAndTips`);
    if(entry.socialSecurityWagesAndTipsIsScheduleSELine8d !== true){
      issue(errors, 'UNRESOLVED_SCHEDULE_SE_LINE_8D',
        `${path}.socialSecurityWagesAndTips must be the resolved Schedule SE line 8d aggregate, including W-2 Social Security wages and tips plus applicable unreported tips, Form 8919 wages, and Tier 1 railroad compensation`,
        `${path}.socialSecurityWagesAndTipsIsScheduleSELine8d`);
    }
  }

  if(intake.passThrough?.line23 !== undefined || intake.supplied?.line23 !== undefined){
    issue(errors, 'SCHEDULE_2_SOURCE_CONFLICT',
      'Supplied line 23 cannot be combined with calculated Schedule SE',
      'scheduleSE');
  }

  const schedule2 = intake.schedule2;
  if(!requirePlainObject(errors, schedule2, 'schedule2')) return;
  for(const field of [
    'netInvestmentIncomeTax',
    'additionalMedicareTax',
    'otherPartIITaxes',
  ]){
    requireNonNegative(errors, schedule2[field], `schedule2.${field}`);
  }
}
