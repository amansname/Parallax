import { getAccountTypeById } from '../../household/accountTypes.js';
import {
  FORBIDDEN_ACCOUNT_TREATMENT_FIELDS,
} from './client1040IntakeContractConstants.js';
import {
  hasOwn,
  isPlainObject,
  issue,
  rejectUnexpectedKeys,
  requirePlainObject,
} from './client1040IntakeContractShared.js';

export function deriveAccountTaxTreatment(typeId){
  const entry = getAccountTypeById(typeId);
  if(!entry) return null;
  if(entry.taxCharacter === 'capital_asset' || entry.taxCharacter === 'taxable_cash'){
    return 'taxable';
  }
  if(['traditional_ira', 'inherited_traditional_ira', 'employer_pretax']
    .includes(entry.taxCharacter)){
    return 'taxDeferred';
  }
  if(['roth_ira', 'inherited_roth_ira', 'designated_roth']
    .includes(entry.taxCharacter)){
    return 'roth';
  }
  if(entry.taxCharacter === 'hsa') return 'hsa';
  return 'unsupported';
}

export function validateAccounts(errors, intake){
  if(intake.accounts === undefined) return;
  if(!Array.isArray(intake.accounts)){
    issue(errors, 'INVALID_ACCOUNTS', 'accounts must be an array', 'accounts');
    return;
  }
  for(const [index, account] of intake.accounts.entries()){
    const path = `accounts[${index}]`;
    if(!requirePlainObject(errors, account, path)) continue;
    rejectUnexpectedKeys(errors, account, [
      'id',
      'typeId',
      'owner',
      'bucket',
      'taxReporting',
    ], path, 'UNKNOWN_CANONICAL_FIELD');
    const entry = getAccountTypeById(account.typeId);
    if(!entry){
      issue(errors, 'UNKNOWN_ACCOUNT_TYPE',
        `${path}.typeId must be a canonical account type`, `${path}.typeId`);
      continue;
    }
    if(account.owner !== 'client' && account.owner !== 'spouse' && account.owner !== 'joint'){
      issue(errors, 'INVALID_ACCOUNT_OWNER',
        `${path}.owner must be client, spouse, or joint`, `${path}.owner`);
    }
    if(Array.isArray(entry.wizardOwners)
        && !entry.wizardOwners.includes(account.owner)){
      issue(errors, 'ACCOUNT_OWNER_TYPE_CONFLICT',
        `${path}.owner is not valid for account type ${account.typeId}`,
        `${path}.owner`);
    }
    for(const field of FORBIDDEN_ACCOUNT_TREATMENT_FIELDS){
      if(hasOwn(account, field)){
        issue(errors, 'ACCOUNT_TREATMENT_NOT_INPUT',
          `${path}.${field} is derived from typeId and cannot be supplied`,
          `${path}.${field}`);
      }
    }
    if(account.bucket !== undefined && account.bucket !== entry.engineBucket){
      issue(errors, 'ACCOUNT_BUCKET_CONFLICT',
        `${path}.bucket conflicts with the canonical account type`,
        `${path}.bucket`);
    }
    if(account.taxReporting === undefined){
      issue(errors, 'ACCOUNT_RETURN_ATTRIBUTION_REQUIRED',
        `${path}.taxReporting is required`, `${path}.taxReporting`);
    } else if(requirePlainObject(errors, account.taxReporting, `${path}.taxReporting`)){
      rejectUnexpectedKeys(errors, account.taxReporting, [
        'inclusion',
        'reportingTaxpayer',
        'householdReturnShare',
      ], `${path}.taxReporting`, 'UNKNOWN_CANONICAL_FIELD');
      if(!['household-return', 'separate-return'].includes(account.taxReporting.inclusion)){
        issue(errors, 'ACCOUNT_RETURN_ATTRIBUTION_INCOMPLETE',
          `${path}.taxReporting.inclusion must identify the modeled return`,
          `${path}.taxReporting.inclusion`);
      }
      if(!['client', 'spouse', 'return-level'].includes(
        account.taxReporting.reportingTaxpayer
      )){
        issue(errors, 'INVALID_REPORTING_TAXPAYER',
          `${path}.taxReporting.reportingTaxpayer is invalid`,
          `${path}.taxReporting.reportingTaxpayer`);
      }
      if(account.taxReporting.householdReturnShare !== 1){
        issue(errors, 'ACCOUNT_RETURN_SHARE_INCOMPLETE',
          `${path}.taxReporting.householdReturnShare must be 1`,
          `${path}.taxReporting.householdReturnShare`);
      }
    }
    if(!entry.supportedForTax){
      issue(errors, 'ACCOUNT_TAX_TREATMENT_UNSUPPORTED',
        `${path}.typeId is not supported for tax calculation`,
        `${path}.typeId`,
        { derivedTaxTreatment: deriveAccountTaxTreatment(account.typeId) });
    }
    if(intake.filingStatus === 'marriedFilingSeparately'){
      const modeled = intake.returnScope?.modeledTaxpayer;
      const reporting = account.taxReporting;
      if(account.owner !== modeled
          || !isPlainObject(reporting)
          || reporting.inclusion !== 'separate-return'
          || reporting.reportingTaxpayer !== modeled
          || reporting.householdReturnShare !== 1){
        issue(errors, 'MFS_RETURN_TAXPAYER_UNATTRIBUTED',
          `${path} must be wholly attributed to the modeled MFS taxpayer`,
          path);
      }
    } else if((intake.filingStatus === 'single'
        || intake.filingStatus === 'headOfHousehold')
        && account.owner !== 'client'){
      issue(errors, 'ACCOUNT_OUTSIDE_MODELED_RETURN',
        `${path}.owner is outside this modeled return`, `${path}.owner`);
    } else {
      const expectedReportingTaxpayer = account.owner === 'joint'
        ? 'return-level'
        : account.owner;
      if(account.taxReporting?.inclusion !== 'household-return'
          || account.taxReporting?.reportingTaxpayer !== expectedReportingTaxpayer
          || account.taxReporting?.householdReturnShare !== 1){
        issue(errors, 'ACCOUNT_OUTSIDE_MODELED_RETURN',
          `${path}.taxReporting must attribute the whole account to this return`,
          `${path}.taxReporting`);
      }
    }
  }
}
