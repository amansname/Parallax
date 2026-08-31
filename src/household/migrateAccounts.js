import {
  ACCOUNT_SCHEMA_VERSION,
  UNSUPPORTED_TYPE_ID,
  getAccountTypeById,
  isValidEngineBucket,
  isValidOwner,
  isValidValuationDate,
  parseSchemaVersion,
  resolveTypeFromLabel,
} from './accountTypes.js';
import { createBlankTaxProfiles, validateBasisEnvelope, validateFactEnvelope } from './factEnvelope.js';
import { resolvePortfolioAccounts } from './resolvePortfolioAccounts.js';
import {
  cloneInvestmentAllocation,
  resolveCashOnlyAllocation,
  snapshotLegacyRiskProfileAllocation,
  validateInvestmentAllocation,
} from './investmentAllocation.js';

export const ACCOUNT_MIGRATION_BLOCKED = 'ACCOUNT_MIGRATION_BLOCKED';
export const ACCOUNT_MIGRATION_READ_ONLY = 'ACCOUNT_MIGRATION_READ_ONLY';
export const ACCOUNT_SCHEMA_VERSION_UNSUPPORTED = 'ACCOUNT_SCHEMA_VERSION_UNSUPPORTED';

export const BLOCKED_MESSAGE = 'Household data could not be safely upgraded. No saved data was changed.';
export const READ_ONLY_MESSAGE = 'Household storage could not be upgraded. Viewing a read-only copy; reload after storage is available.';

const VALID_INCLUSION = new Set(['household-return', 'separate-return', 'unknown']);
const ACCOUNT_KEYS = ['id', 'typeId', 'type', 'owner', 'bucket', 'balance', 'valuationDate', 'basis', 'taxReporting', 'employerPlanFacts', 'designatedRothFacts', 'investmentAllocation'];
const ACCOUNT_KEYS_V1 = ACCOUNT_KEYS.filter(key => key !== 'investmentAllocation');
const REPORTING_KEYS = ['inclusion', 'reportingTaxpayer', 'householdReturnShare'];
const EMPLOYER_FACT_KEYS = ['afterTaxContributionBasis', 'planSubtypeConfirmed'];
const DESIGNATED_FACT_KEYS = ['firstContributionYear', 'contributionBasis', 'inPlanRolloverCohorts'];
const PROFILE_FACT_KEYS = ['birthDate', 'blind', 'disabled'];
const TRADITIONAL_IRA_FACT_KEYS = [
  'priorYearCarryforwardBasis',
  'currentYearNondeductibleContributions',
  'yearEndAggregateValueOverride',
  'outstandingRolloversAtYearEnd',
  'otherForm8606Adjustments',
];
const ROTH_IRA_FACT_KEYS = ['firstContributionYear', 'contributionBasis', 'conversionCohorts'];

export const LEGACY_BASE_ACCOUNT_IDS = Object.freeze({
  taxable: 'base-taxable',
  traditional: 'base-traditional',
  roth: 'base-roth',
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function assertRequiredKeys(record, keys, path){
  for(const key of keys){
    if(!hasOwn(record, key)){
      throw new Error(`${path}.${key} is required`);
    }
  }
}

function stableHash(input){
  const s = JSON.stringify(input);
  let h = 2166136261;
  for(let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function deterministicLegacyAccountId(householdId, ledger, index, legacy){
  return `acct_legacy_${stableHash({
    householdId,
    ledger,
    index,
    type: legacy.type ?? null,
    bucket: legacy.bucket ?? null,
    owner: legacy.owner ?? null,
    balance: legacy.balance ?? null,
  })}`;
}

function assertFiniteNonNegativeBalance(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} has invalid balance`);
  }
}

function cloneRecord(record){
  return structuredClone(record);
}

function parseLegacyBalance(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new Error(`${path} has invalid balance`);
  }
  return value;
}

function parseLegacyOwner(owner, path, { omitted = false } = {}){
  if(omitted) return 'joint';
  if(typeof owner !== 'string'){
    throw new Error(`${path} has invalid owner`);
  }
  const o = owner.trim();
  if(!isValidOwner(o)){
    throw new Error(`${path} has invalid owner`);
  }
  return o;
}

function validateTaxReporting(record, path){
  if(!record || typeof record !== 'object' || Array.isArray(record)){
    throw new Error(`${path}.taxReporting must be an object`);
  }
  assertRequiredKeys(record, REPORTING_KEYS, `${path}.taxReporting`);
  if(!VALID_INCLUSION.has(record.inclusion)){
    throw new Error(`${path}.taxReporting.inclusion is invalid`);
  }
  if(record.reportingTaxpayer != null && record.reportingTaxpayer !== 'client' && record.reportingTaxpayer !== 'spouse' && record.reportingTaxpayer !== 'return-level'){
    throw new Error(`${path}.taxReporting.reportingTaxpayer is invalid`);
  }
  if(record.householdReturnShare != null){
    if(typeof record.householdReturnShare !== 'number'
      || !Number.isFinite(record.householdReturnShare)
      || record.householdReturnShare < 0
      || record.householdReturnShare > 1){
      throw new Error(`${path}.taxReporting.householdReturnShare is invalid`);
    }
  }
}

function validateEmployerFacts(facts, path, required){
  if(facts === null){
    if(required) throw new Error(`${path}.employerPlanFacts is required`);
    return;
  }
  if(!required){
    throw new Error(`${path}.employerPlanFacts is not valid for this account type`);
  }
  if(!facts || typeof facts !== 'object' || Array.isArray(facts)){
    throw new Error(`${path}.employerPlanFacts is invalid`);
  }
  assertRequiredKeys(facts, EMPLOYER_FACT_KEYS, `${path}.employerPlanFacts`);
  validateFactEnvelope(facts.afterTaxContributionBasis, `${path}.employerPlanFacts.afterTaxContributionBasis`);
  validateFactEnvelope(facts.planSubtypeConfirmed, `${path}.employerPlanFacts.planSubtypeConfirmed`);
}

function validateDesignatedFacts(facts, path, required){
  if(facts === null){
    if(required) throw new Error(`${path}.designatedRothFacts is required`);
    return;
  }
  if(!required){
    throw new Error(`${path}.designatedRothFacts is not valid for this account type`);
  }
  if(!facts || typeof facts !== 'object' || Array.isArray(facts)){
    throw new Error(`${path}.designatedRothFacts is invalid`);
  }
  assertRequiredKeys(facts, DESIGNATED_FACT_KEYS, `${path}.designatedRothFacts`);
  validateFactEnvelope(facts.firstContributionYear, `${path}.designatedRothFacts.firstContributionYear`);
  validateFactEnvelope(facts.contributionBasis, `${path}.designatedRothFacts.contributionBasis`);
  validateFactEnvelope(facts.inPlanRolloverCohorts, `${path}.designatedRothFacts.inPlanRolloverCohorts`);
}

function validateTaxProfileOwner(profile, path){
  if(!profile || typeof profile !== 'object' || Array.isArray(profile)){
    throw new Error(`${path} tax profile is required`);
  }
  if(!profile.traditionalIra || typeof profile.traditionalIra !== 'object' || Array.isArray(profile.traditionalIra)){
    throw new Error(`${path}.traditionalIra is required`);
  }
  if(!profile.rothIra || typeof profile.rothIra !== 'object' || Array.isArray(profile.rothIra)){
    throw new Error(`${path}.rothIra is required`);
  }
  assertRequiredKeys(profile, [...PROFILE_FACT_KEYS, 'traditionalIra', 'rothIra'], path);
  assertRequiredKeys(profile.traditionalIra, TRADITIONAL_IRA_FACT_KEYS, `${path}.traditionalIra`);
  assertRequiredKeys(profile.rothIra, ROTH_IRA_FACT_KEYS, `${path}.rothIra`);
  for(const key of PROFILE_FACT_KEYS){
    validateFactEnvelope(profile[key], `${path}.${key}`);
  }
  for(const key of Object.keys(profile.traditionalIra)){
    validateFactEnvelope(profile.traditionalIra[key], `${path}.traditionalIra.${key}`);
  }
  for(const key of Object.keys(profile.rothIra)){
    validateFactEnvelope(profile.rothIra[key], `${path}.rothIra.${key}`);
  }
}

function validateBaseSleeves(accounts, path, { allocationRequired = true } = {}){
  if(!accounts || typeof accounts !== 'object' || Array.isArray(accounts)){
    throw new Error(`${path}.portfolio.accounts is required`);
  }
  for(const sleeve of ['taxable', 'traditional', 'roth']){
    const acct = accounts[sleeve];
    if(!acct || typeof acct !== 'object' || Array.isArray(acct)){
      throw new Error(`${path}.portfolio.accounts.${sleeve} is required`);
    }
    if(!hasOwn(acct, 'balance')){
      throw new Error(`${path}.portfolio.accounts.${sleeve}.balance is required`);
    }
    assertFiniteNonNegativeBalance(acct.balance, `${path}.portfolio.accounts.${sleeve}`);
    if(allocationRequired){
      if(acct.id !== LEGACY_BASE_ACCOUNT_IDS[sleeve]){
        throw new Error(`${path}.portfolio.accounts.${sleeve}.id is invalid`);
      }
      validateInvestmentAllocation(acct.investmentAllocation);
      if(acct.investmentAllocation.source !== 'legacy-risk-profile'){
        throw new Error(`${path}.portfolio.accounts.${sleeve}.investmentAllocation must be legacy-derived`);
      }
    }
  }
  if(!hasOwn(accounts.taxable, 'basisPct')){
    throw new Error(`${path}.portfolio.accounts.taxable.basisPct is required`);
  }
  const pct = accounts.taxable.basisPct;
  if(typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0){
    throw new Error(`${path}.portfolio.accounts.taxable.basisPct is invalid`);
  }
}

function validateCurrentAccount(acct, index, { allocationRequired = true } = {}){
  const path = `account[${index}]`;
  if(!acct || typeof acct !== 'object' || Array.isArray(acct)){
    throw new Error(`${path} must be an object`);
  }
  assertRequiredKeys(acct, allocationRequired ? ACCOUNT_KEYS : ACCOUNT_KEYS_V1, path);
  if(typeof acct.id !== 'string' || !acct.id.trim()){
    throw new Error(`${path}.id is required`);
  }
  if(typeof acct.typeId !== 'string' || !acct.typeId.trim()){
    throw new Error(`${path}.typeId is required`);
  }
  if(typeof acct.type !== 'string' || !acct.type.trim()){
    throw new Error(`${path}.type is required`);
  }
  if(acct.typeId !== UNSUPPORTED_TYPE_ID && !getAccountTypeById(acct.typeId)){
    throw new Error(`${path}.typeId is unknown`);
  }
  if(!isValidOwner(acct.owner)){
    throw new Error(`${path}.owner is invalid`);
  }
  const unresolvedUnsupported = acct.typeId === UNSUPPORTED_TYPE_ID && acct.bucket === null;
  if(!unresolvedUnsupported && !isValidEngineBucket(acct.bucket)){
    throw new Error(`${path}.bucket is invalid`);
  }
  assertFiniteNonNegativeBalance(acct.balance, path);
  if(!isValidValuationDate(acct.valuationDate)){
    throw new Error(`${path}.valuationDate is invalid`);
  }
  validateBasisEnvelope(acct.basis, `${path}.basis`);
  validateTaxReporting(acct.taxReporting, path);
  const canonical = acct.typeId === UNSUPPORTED_TYPE_ID ? null : getAccountTypeById(acct.typeId);
  validateEmployerFacts(acct.employerPlanFacts, path, canonical?.taxCharacter === 'employer_pretax');
  validateDesignatedFacts(acct.designatedRothFacts, path, canonical?.taxCharacter === 'designated_roth');
  if(allocationRequired){
    if(canonical){
      validateInvestmentAllocation(acct.investmentAllocation);
      if(canonical.investmentAllocationEligible && acct.investmentAllocation.source === 'cash-only'){
        throw new Error(`${path}.investmentAllocation cash-only provenance is reserved for bank accounts`);
      }
      if(!canonical.investmentAllocationEligible && acct.investmentAllocation.source !== 'cash-only'){
        throw new Error(`${path}.investmentAllocation must be cash-only`);
      }
    }else if(acct.balance > 0 && isValidEngineBucket(acct.bucket)){
      validateInvestmentAllocation(acct.investmentAllocation);
      if(acct.investmentAllocation.source !== 'legacy-risk-profile'
          || acct.investmentAllocation.reviewRequired !== true){
        throw new Error(`${path}.investmentAllocation must preserve reviewed legacy provenance`);
      }
    }else if(acct.investmentAllocation !== null){
      throw new Error(`${path}.investmentAllocation must be null`);
    }
  }
}

function validateSchemaHousehold(plan, householdId, expectedVersion){
  if(!plan || typeof plan !== 'object' || Array.isArray(plan)){
    throw new Error(`${householdId}: household must be an object`);
  }
  if(!plan.meta || typeof plan.meta !== 'object' || Array.isArray(plan.meta)){
    throw new Error(`${householdId}: meta is required`);
  }
  const version = parseSchemaVersion(plan.meta.accountSchemaVersion);
  if(version !== expectedVersion){
    throw new Error(`${householdId}: unsupported accountSchemaVersion`);
  }
  if(!plan.portfolio || typeof plan.portfolio !== 'object' || Array.isArray(plan.portfolio)){
    throw new Error(`${householdId}: portfolio is required`);
  }
  const allocationRequired = expectedVersion === ACCOUNT_SCHEMA_VERSION;
  validateBaseSleeves(plan.portfolio.accounts, householdId, { allocationRequired });
  if(!Array.isArray(plan.portfolio.extraAccounts)){
    throw new Error(`${householdId}: portfolio.extraAccounts must be an array`);
  }
  const seen = new Set(Object.values(LEGACY_BASE_ACCOUNT_IDS));
  plan.portfolio.extraAccounts.forEach((acct, index) => {
    validateCurrentAccount(acct, index, { allocationRequired });
    if(seen.has(acct.id)){
      throw new Error(`${householdId}: duplicate account id ${acct.id}`);
    }
    seen.add(acct.id);
  });
  if(!plan.taxProfiles || typeof plan.taxProfiles !== 'object' || Array.isArray(plan.taxProfiles)){
    throw new Error(`${householdId}: taxProfiles is required`);
  }
  validateTaxProfileOwner(plan.taxProfiles.client, `${householdId}.taxProfiles.client`);
  validateTaxProfileOwner(plan.taxProfiles.spouse, `${householdId}.taxProfiles.spouse`);
}

export function validateCurrentSchemaHousehold(plan, householdId = 'household'){
  validateSchemaHousehold(plan, householdId, ACCOUNT_SCHEMA_VERSION);
}

function basisFromLegacy(entry, balance, plan){
  if(entry.taxCharacter === 'taxable_cash'){
    return { amount: null, method: 'principal', status: 'unknown', source: null, confirmedAt: null, version: 1 };
  }
  if(entry.taxCharacter === 'capital_asset'){
    const pct = plan?.portfolio?.accounts?.taxable?.basisPct;
    if(typeof pct === 'number' && Number.isFinite(pct) && pct >= 0){
      return {
        amount: Math.round(balance * pct),
        method: 'legacy-proportional',
        status: 'assumed',
        source: 'planner-assumption',
        confirmedAt: null,
        version: 1,
      };
    }
    return { amount: null, method: 'unknown', status: 'unknown', source: null, confirmedAt: null, version: 1 };
  }
  return { amount: null, method: 'unknown', status: 'unknown', source: null, confirmedAt: null, version: 1 };
}

function legacyAllocationForPlan(plan, path){
  const riskProfile = plan?.portfolio?.riskProfile;
  if(!Number.isInteger(riskProfile) || riskProfile < 1 || riskProfile > 6){
    throw new Error(`${path}.portfolio.riskProfile is invalid`);
  }
  return snapshotLegacyRiskProfileAllocation(riskProfile);
}

function allocationForMigratedAccount(entry, balance, bucket, plan, path){
  if(entry){
    return entry.investmentAllocationEligible
      ? legacyAllocationForPlan(plan, path)
      : resolveCashOnlyAllocation();
  }
  return balance > 0 && isValidEngineBucket(bucket)
    ? legacyAllocationForPlan(plan, path)
    : null;
}

function applyLegacyBaseAllocations(plan, path){
  const allocation = legacyAllocationForPlan(plan, path);
  for(const sleeve of ['taxable', 'traditional', 'roth']){
    plan.portfolio.accounts[sleeve].id = LEGACY_BASE_ACCOUNT_IDS[sleeve];
    plan.portfolio.accounts[sleeve].investmentAllocation = cloneInvestmentAllocation(allocation);
  }
}

function migrateLegacyExtraAccount(legacy, index, householdId, plan){
  if(!legacy || typeof legacy !== 'object' || Array.isArray(legacy)){
    throw new Error(`${householdId}: invalid account at index ${index}`);
  }
  const path = `${householdId}: account[${index}]`;
  const balance = parseLegacyBalance(legacy.balance, path);
  const owner = parseLegacyOwner(legacy.owner, path, { omitted: !hasOwn(legacy, 'owner') });
  const resolved = resolveTypeFromLabel(legacy.type);
  const storedBucket = legacy.bucket;
  const hasStoredBucket = hasOwn(legacy, 'bucket');

  if(!resolved.known){
    const bucket = isValidEngineBucket(storedBucket) ? storedBucket : null;
    return {
      id: deterministicLegacyAccountId(householdId, 'extraAccounts', index, legacy),
      typeId: UNSUPPORTED_TYPE_ID,
      type: String(legacy.type || 'Unknown account').trim() || 'Unknown account',
      owner,
      bucket,
      balance,
      valuationDate: null,
      basis: { amount: null, method: 'unknown', status: 'unknown', source: null, confirmedAt: null, version: 1 },
      taxReporting: { inclusion: 'unknown', reportingTaxpayer: null, householdReturnShare: null },
      employerPlanFacts: null,
      designatedRothFacts: null,
      investmentAllocation: allocationForMigratedAccount(null, balance, bucket, plan, path),
    };
  }

  const entry = getAccountTypeById(resolved.typeId);
  let bucket = resolved.engineBucket;
  if(hasStoredBucket){
    if(!isValidEngineBucket(storedBucket)){
      throw new Error(`${path}: invalid bucket`);
    }
    bucket = storedBucket;
  }

  return {
    id: deterministicLegacyAccountId(householdId, 'extraAccounts', index, legacy),
    typeId: entry.id,
    type: entry.label,
    owner,
    bucket,
    balance,
    valuationDate: null,
    basis: basisFromLegacy(entry, balance, plan),
    taxReporting: defaultTaxReportingFor(entry, owner),
    employerPlanFacts: defaultEmployerFactsFor(entry),
    designatedRothFacts: defaultDesignatedFactsFor(entry),
    investmentAllocation: allocationForMigratedAccount(entry, balance, bucket, plan, path),
  };
}

function defaultTaxReportingFor(entry, owner){
  const reportingTaxpayer = (owner === 'client' || owner === 'spouse') ? owner : null;
  const inclusion = (entry.id === 'joint_brokerage' || entry.id === 'trust_brokerage' || owner === 'joint' || owner === 'trust')
    ? 'unknown'
    : 'household-return';
  return {
    inclusion,
    reportingTaxpayer,
    householdReturnShare: inclusion === 'household-return' ? 1 : null,
  };
}

function defaultEmployerFactsFor(entry){
  if(entry.taxCharacter !== 'employer_pretax') return null;
  return {
    afterTaxContributionBasis: { value: null, status: 'unknown', source: null, confirmedAt: null, version: 1 },
    planSubtypeConfirmed: { value: null, status: 'unknown', source: null, confirmedAt: null, version: 1 },
  };
}

function defaultDesignatedFactsFor(entry){
  if(entry.taxCharacter !== 'designated_roth') return null;
  return {
    firstContributionYear: { value: null, status: 'unknown', source: null, confirmedAt: null, version: 1 },
    contributionBasis: { value: null, status: 'unknown', source: null, confirmedAt: null, version: 1 },
    inPlanRolloverCohorts: { value: null, status: 'unknown', source: null, confirmedAt: null, version: 1 },
  };
}

export function migrateHouseholdRecord(record, householdId){
  if(!record || typeof record !== 'object' || Array.isArray(record)){
    throw new Error('Invalid household record');
  }
  const hasVersion = record.meta
    && typeof record.meta === 'object'
    && !Array.isArray(record.meta)
    && hasOwn(record.meta, 'accountSchemaVersion');
  if(hasVersion){
    const rawVersion = record.meta.accountSchemaVersion;
    const parsed = parseSchemaVersion(rawVersion);
    if(parsed > ACCOUNT_SCHEMA_VERSION){
      throw Object.assign(new Error('Unsupported account schema version'), { code: ACCOUNT_SCHEMA_VERSION_UNSUPPORTED });
    }
    if(parsed === ACCOUNT_SCHEMA_VERSION){
      validateCurrentSchemaHousehold(record, householdId);
      return { changed: false, plan: cloneRecord(record) };
    }
    if(parsed === 1){
      return { changed: true, plan: migrateV1HouseholdAllocation(record, householdId) };
    }
  }
  return { changed: true, plan: migrateLegacyHousehold(record, householdId) };
}

export function migrateV1HouseholdAllocation(record, householdId){
  validateSchemaHousehold(record, householdId, 1);
  const plan = cloneRecord(record);
  applyLegacyBaseAllocations(plan, householdId);
  plan.portfolio.extraAccounts = plan.portfolio.extraAccounts.map((account, index) => {
    const canonical = account.typeId === UNSUPPORTED_TYPE_ID
      ? null
      : getAccountTypeById(account.typeId);
    return {
      ...account,
      investmentAllocation: allocationForMigratedAccount(
        canonical,
        account.balance,
        account.bucket,
        plan,
        `${householdId}: account[${index}]`,
      ),
    };
  });
  plan.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  validateCurrentSchemaHousehold(plan, householdId);
  return plan;
}

export function migrateLegacyHousehold(record, householdId){
  const plan = cloneRecord(record);
  if(!plan.meta || typeof plan.meta !== 'object') plan.meta = {};
  const version = hasOwn(plan.meta, 'accountSchemaVersion')
    ? parseSchemaVersion(plan.meta.accountSchemaVersion)
    : null;
  if(version != null && version > ACCOUNT_SCHEMA_VERSION){
    throw Object.assign(new Error('Unsupported account schema version'), { code: ACCOUNT_SCHEMA_VERSION_UNSUPPORTED });
  }
  if(!plan.portfolio || typeof plan.portfolio !== 'object'){
    throw new Error(`${householdId}: portfolio is required`);
  }
  if(!Array.isArray(plan.portfolio.extraAccounts)){
    throw new Error(`${householdId}: portfolio.extraAccounts must be an array`);
  }
  validateBaseSleeves(plan.portfolio.accounts || {}, householdId, { allocationRequired: false });
  legacyAllocationForPlan(plan, householdId);
  if(!plan.taxProfiles) plan.taxProfiles = createBlankTaxProfiles();
  const migrated = plan.portfolio.extraAccounts.map((acct, index) =>
    migrateLegacyExtraAccount(acct, index, householdId, plan)
  );
  plan.portfolio.extraAccounts = migrated;
  applyLegacyBaseAllocations(plan, householdId);
  plan.meta.accountSchemaVersion = ACCOUNT_SCHEMA_VERSION;
  validateCurrentSchemaHousehold(plan, householdId);
  return plan;
}

export function deriveHouseholdIssues(plan){
  return [...resolvePortfolioAccounts(plan).issues];
}

export function mergeNonAccountDefaults(record, defaults){
  const merged = cloneRecord(record);
  const shouldSkip = (path, key, target) => {
    if(path.length === 0 && key === 'taxProfiles') return true;
    if(path.length === 0 && key === 'portfolio' && !hasOwn(target, key)) return true;
    if(path.length === 1 && path[0] === 'portfolio' && (key === 'accounts' || key === 'extraAccounts')) return true;
    return path.length === 1 && path[0] === 'meta' && key === 'accountSchemaVersion';
  };
  const fill = (target, source, path = []) => {
    Object.entries(source || {}).forEach(([key, value]) => {
      if(shouldSkip(path, key, target)) return;
      if(!(key in target)){
        if(value && typeof value === 'object' && !Array.isArray(value)){
          target[key] = {};
          fill(target[key], value, [...path, key]);
        }else{
          target[key] = cloneRecord(value);
        }
      } else if(
        target[key] && value
        && typeof target[key] === 'object' && !Array.isArray(target[key])
        && typeof value === 'object' && !Array.isArray(value)
      ){
        fill(target[key], value, [...path, key]);
      }
    });
  };
  fill(merged, defaults);
  return merged;
}

export function migrateHouseholdsDb(rawDb){
  if(!rawDb || typeof rawDb !== 'object' || Array.isArray(rawDb)){
    return { ok: false, code: ACCOUNT_MIGRATION_BLOCKED, error: 'Invalid household database' };
  }
  const entries = Object.entries(rawDb);
  if(!entries.length){
    return { ok: false, code: ACCOUNT_MIGRATION_BLOCKED, error: 'Empty household database' };
  }
  for(const [recordId, record] of entries){
    if(!record || typeof record !== 'object' || Array.isArray(record)){
      return { ok: false, code: ACCOUNT_MIGRATION_BLOCKED, error: `Invalid household record ${recordId}` };
    }
  }

  const migratedDb = {};
  const issuesByHousehold = {};
  let anyChanged = false;

  try{
    for(const [recordId, record] of entries){
      const { changed, plan } = migrateHouseholdRecord(record, recordId);
      migratedDb[recordId] = plan;
      issuesByHousehold[recordId] = deriveHouseholdIssues(plan);
      if(changed) anyChanged = true;
    }
  }catch(error){
    if(error?.code === ACCOUNT_SCHEMA_VERSION_UNSUPPORTED){
      return { ok: false, code: ACCOUNT_SCHEMA_VERSION_UNSUPPORTED, error: error.message };
    }
    return {
      ok: false,
      code: ACCOUNT_MIGRATION_BLOCKED,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, db: migratedDb, changed: anyChanged, issuesByHousehold };
}

export function getAccountMigrationReadOnlyMessage(){
  return READ_ONLY_MESSAGE;
}

export function getAccountMigrationBlockedMessage(){
  return BLOCKED_MESSAGE;
}

export function detectLegacyTypedOverlap(plan){
  return deriveHouseholdIssues(plan).includes('LEGACY_TYPED_OVERLAP');
}
