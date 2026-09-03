import { getAccountTypeById } from './accountTypes.js';
import { createAccount, hasSpouseOwnedAccounts } from './createAccount.js';
import { createBlankTaxProfiles, createFact } from './factEnvelope.js';
import { addFamilyFinanceEntry } from './familyFinanceEntries.js';
import { syncHealthcareGoalToHousehold } from './migrateSpendingToGoals.js';
import { validateCurrentSchemaHousehold } from './migrateAccounts.js';
import { validateHouseholdRecordSchema } from './householdRecordSchema.js';
import { snapshotPresetAllocation } from './investmentAllocation.js';
import {
  NET_WORTH_ONLY_TREATMENT,
  NET_WORTH_SHELL_CATEGORIES,
} from './netWorthRecords.js';
import {
  clearWizardTaxConfirmation,
  confirmWizardTaxInputs,
  ensureWizardCurrent1040,
  overrideWizardIncomeGroup,
  removeWizardTaxItem,
  revertWizardIncomeGroup,
  setWizardTaxField,
  syncWizardTaxpayerFacts,
} from './wizardIntake.js';

const hasOwn = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

function asRecord(value, label){
  if(!value || typeof value !== 'object' || Array.isArray(value)){
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizedText(value, { required = false } = {}){
  const text = String(value ?? '').trim();
  if(required && !text) throw new Error('A value is required');
  return text;
}

function integer(value, { min, max }){
  const parsed = Number(value);
  if(!Number.isFinite(parsed)) throw new Error('Enter a valid number');
  const rounded = Math.round(parsed);
  if(rounded < min || rounded > max){
    throw new Error(`Enter a value from ${min} through ${max}`);
  }
  return rounded;
}

function money(value){
  if(value === '' || value === null || value === undefined) return 0;
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/[$,\s]/g, ''));
  if(!Number.isFinite(parsed) || parsed < 0) throw new Error('Enter zero or a positive amount');
  return Math.round(parsed);
}

function validBirthDate(value){
  const text = normalizedText(value, { required: true });
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)
      || !Number.isFinite(Date.parse(`${text}T00:00:00Z`))){
    throw new Error('Enter a valid date of birth');
  }
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if(date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
      || year < 1900){
    throw new Error('Enter a valid date of birth');
  }
  return text;
}

function ageOnDate(birthDate, isoTimestamp){
  const today = new Date(isoTimestamp);
  const birth = new Date(`${birthDate}T00:00:00Z`);
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth()
      && today.getUTCDate() < birth.getUTCDate());
  if(beforeBirthday) age -= 1;
  return age;
}

function ensureSpouse(plan){
  if(!plan.household.spouse){
    const client = plan.household.primary || {};
    plan.household.spouse = {
      currentAge: client.currentAge ?? 60,
      retirementAge: client.retirementAge ?? 65,
      planEndAge: client.planEndAge ?? 90,
      birthYear: client.birthYear ?? null,
      employmentStatus: 'employed',
    };
  }
  if(!plan.income.socialSecurity.spouse){
    plan.income.socialSecurity.spouse = { pia: null, claimAge: 67 };
  }
  // Healthcare is priced per person, so adding a co-client raises the preload —
  // unless the advisor has already entered their own figure, which stands.
  syncHealthcareGoalToHousehold(plan);
  return plan.household.spouse;
}

function personForOwner(plan, owner){
  if(owner === 'spouse') return ensureSpouse(plan);
  return plan.household.primary;
}

function setBirthDate(plan, owner, value, timestamp){
  const birthDate = validBirthDate(value);
  const person = personForOwner(plan, owner);
  const age = ageOnDate(birthDate, timestamp);
  if(age < 0 || age > 125) throw new Error('Enter a valid date of birth');
  person.birthYear = Number(birthDate.slice(0, 4));
  person.currentAge = age;
  plan.taxProfiles[owner].birthDate = createFact(
    birthDate,
    'confirmed',
    'household-entry',
    timestamp,
  );
  ensureWizardCurrent1040(plan);
  syncWizardTaxpayerFacts(plan);
}

function maybeNameHousehold(plan){
  const current = plan.meta.name || '';
  if(current && current !== 'New Household' && current !== 'Demo Household') return;
  const primaryName = normalizedText(plan.meta.primaryName);
  const lastName = primaryName.split(/\s+/).filter(Boolean).at(-1);
  if(lastName) plan.meta.name = `${lastName} household`;
}

function wizardEditError(message, field, code){
  const error = new Error(message);
  error.field = field;
  error.code = code;
  return error;
}

function removeSpouseCurrent1040Facts(plan){
  const current = plan.incomeTax?.current1040;
  if(!current) return;
  if(current.taxpayers && typeof current.taxpayers === 'object'){
    delete current.taxpayers.spouse;
  }
  if(Array.isArray(current.scheduleSE)){
    const retained = current.scheduleSE
      .filter(entry => entry?.taxpayerOwner !== 'spouse');
    if(retained.length > 0) current.scheduleSE = retained;
    else delete current.scheduleSE;
  }
  current.incomeSourcesComplete = false;
}

function removeSpouse(plan, command){
  if(!plan.household?.spouse){
    throw wizardEditError(
      'This household does not have a co-client',
      'filingStatus',
      'CO_CLIENT_NOT_PRESENT',
    );
  }
  if(hasSpouseOwnedAccounts(plan)){
    throw wizardEditError(
      'Reassign or remove Co-client accounts before removing the Co-client.',
      'filingStatus',
      'CO_CLIENT_ACCOUNTS_REQUIRE_REASSIGNMENT',
    );
  }
  if((plan.income?.other || []).some(row => row?.owner === 'spouse')){
    throw wizardEditError(
      'Reassign or remove co-client income first.',
      'filingStatus',
      'CO_CLIENT_INCOME_REQUIRES_REASSIGNMENT',
    );
  }
  if((plan.savings?.entries || []).some(row => row?.owner === 'spouse')){
    throw wizardEditError(
      'Reassign or remove co-client savings first.',
      'filingStatus',
      'CO_CLIENT_SAVINGS_REQUIRES_REASSIGNMENT',
    );
  }
  if(command.confirmed !== true){
    throw wizardEditError(
      'Confirm removal before discarding Co-client information',
      'filingStatus',
      'CO_CLIENT_REMOVAL_CONFIRMATION_REQUIRED',
    );
  }
  plan.household.spouse = null;
  plan.meta.spouseName = '';
  plan.meta.filingStatus = 'single';
  plan.income.socialSecurity.spouse = null;
  plan.taxProfiles.spouse = createBlankTaxProfiles().spouse;
  syncHealthcareGoalToHousehold(plan);
  removeSpouseCurrent1040Facts(plan);
  ensureWizardCurrent1040(plan);
  syncWizardTaxpayerFacts(plan);
}

function applyFamilyEdit(plan, command, timestamp){
  if(command.action === 'remove-spouse'){
    removeSpouse(plan, command);
    return;
  }
  const field = command.field;
  if(field === 'primaryName'){
    plan.meta.primaryName = normalizedText(command.value);
    maybeNameHousehold(plan);
    return;
  }
  if(field === 'spouseName'){
    ensureSpouse(plan);
    plan.meta.spouseName = normalizedText(command.value);
    return;
  }
  if(field === 'filingStatus'){
    if(!['single', 'headOfHousehold', 'marriedFilingJointly'].includes(command.value)){
      throw new Error('Unsupported filing status');
    }
    if(command.value !== 'marriedFilingJointly' && plan.household?.spouse){
      throw wizardEditError(
        'Remove co-client first',
        'filingStatus',
        'CO_CLIENT_REMOVAL_REQUIRED',
      );
    }
    plan.meta.filingStatus = command.value;
    if(command.value === 'marriedFilingJointly') ensureSpouse(plan);
    ensureWizardCurrent1040(plan);
    syncWizardTaxpayerFacts(plan);
    return;
  }
  if(field === 'state'){
    const state = normalizedText(command.value, { required: true }).toUpperCase();
    if(!/^[A-Z]{2}$/.test(state)) throw new Error('Enter a valid state');
    plan.meta.state = state;
    return;
  }
  if(field === 'dependents'){
    plan.household.dependentsCount = integer(command.value, { min: 0, max: 20 });
    return;
  }
  const match = /^(client|spouse)\.(birthDate|status|retirementAge|socialSecurityAge|socialSecurityBenefit|planEndAge)$/.exec(field);
  if(!match) throw new Error(`Unsupported family field: ${field}`);
  const [, owner, personField] = match;
  const person = personForOwner(plan, owner);
  if(personField === 'birthDate'){
    setBirthDate(plan, owner, command.value, timestamp);
  }else if(personField === 'status'){
    if(!['employed', 'self-employed', 'retired'].includes(command.value)){
      throw new Error('Unsupported employment status');
    }
    person.employmentStatus = command.value;
  }else if(personField === 'retirementAge'){
    person.retirementAge = integer(command.value, { min: 45, max: 90 });
  }else if(personField === 'planEndAge'){
    const planEndAge = integer(command.value, { min: 45, max: 125 });
    if(Number.isFinite(person.currentAge) && planEndAge < person.currentAge){
      throw new Error('Live-to age cannot precede current age');
    }
    person.planEndAge = planEndAge;
  }else{
    const key = owner === 'spouse' ? 'spouse' : 'primary';
    if(!plan.income.socialSecurity[key]){
      plan.income.socialSecurity[key] = { pia: null, claimAge: 67 };
    }
    if(personField === 'socialSecurityBenefit'){
      plan.income.socialSecurity[key].pia = command.value === ''
        || command.value === null
        || command.value === undefined
        ? null
        : money(command.value);
    }else{
      plan.income.socialSecurity[key].claimAge = integer(command.value, { min: 62, max: 70 });
    }
  }
}

function applyFinanceEdit(plan, command){
  if(command.action !== 'add') throw new Error('Unsupported finance action');
  addFamilyFinanceEntry(plan, {
    mode: command.mode,
    typeId: command.typeId,
    owner: command.owner,
    amount: money(command.amount),
  });
  if(command.mode === 'income' && plan.incomeTax?.current1040){
    plan.incomeTax.current1040.incomeSourcesComplete = false;
  }
}

function accountIndex(plan, accountId){
  const accounts = plan.portfolio?.extraAccounts || [];
  const matches = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => account.id === accountId);
  if(matches.length !== 1) throw new Error(`Account id must resolve exactly once: ${accountId}`);
  return matches[0].index;
}

function defaultOwnerForType(entry, requestedOwner){
  const owners = entry.wizardOwners || ['client', 'spouse'];
  if(owners.includes(requestedOwner)) return requestedOwner;
  if(entry.defaultOwner && owners.includes(entry.defaultOwner)) return entry.defaultOwner;
  return owners[0];
}

function replaceAccountType(account, typeId){
  const entry = getAccountTypeById(typeId);
  if(!entry || entry.wizardEnabled !== true) throw new Error('Unsupported account type');
  const currentEntry = getAccountTypeById(account.typeId);
  const preserveAllocation = currentEntry?.investmentAllocationEligible === true
    && entry.investmentAllocationEligible === true;
  const replacement = createAccount(typeId, {
    displayName: account.displayName,
    owner: defaultOwnerForType(entry, account.owner),
    balance: account.balance,
    valuationDate: account.valuationDate,
    ...(preserveAllocation
      ? { investmentAllocation: account.investmentAllocation }
      : {}),
  });
  replacement.id = account.id;
  return replacement;
}

function confirmedFact(value, timestamp){
  if(value === '' || value === null || value === undefined) return createFact(null);
  return createFact(money(value), 'confirmed', 'household-entry', timestamp);
}

function setAccountBasis(plan, account, value, timestamp){
  const entry = getAccountTypeById(account.typeId);
  if(!entry) throw new Error('Unsupported account type');
  if(entry.taxCharacter === 'capital_asset'){
    if(value === '' || value === null || value === undefined){
      account.basis = {
        amount: null,
        method: 'unknown',
        status: 'unknown',
        source: null,
        confirmedAt: null,
        version: 1,
      };
    }else{
      account.basis = {
        amount: money(value),
        method: 'reported-cost-basis',
        status: 'confirmed',
        source: 'household-entry',
        confirmedAt: timestamp,
        version: 1,
      };
    }
    return;
  }
  if(entry.taxCharacter === 'traditional_ira'){
    if(account.owner !== 'client' && account.owner !== 'spouse'){
      throw new Error('Traditional IRA basis needs an individual owner');
    }
    plan.taxProfiles[account.owner].traditionalIra.priorYearCarryforwardBasis =
      confirmedFact(value, timestamp);
    return;
  }
  if(entry.taxCharacter === 'roth_ira'){
    if(account.owner !== 'client' && account.owner !== 'spouse'){
      throw new Error('Roth IRA basis needs an individual owner');
    }
    plan.taxProfiles[account.owner].rothIra.contributionBasis =
      confirmedFact(value, timestamp);
    return;
  }
  if(entry.taxCharacter === 'employer_pretax'){
    account.employerPlanFacts.afterTaxContributionBasis = confirmedFact(value, timestamp);
    return;
  }
  if(entry.taxCharacter === 'designated_roth'){
    account.designatedRothFacts.contributionBasis = confirmedFact(value, timestamp);
    return;
  }
  throw new Error('This account type does not accept a basis amount');
}

function applyAccountEdit(plan, command, timestamp){
  if(command.action === 'add'){
    const entry = getAccountTypeById(command.typeId);
    if(!entry || entry.wizardEnabled !== true) throw new Error('Unsupported account type');
    const owner = defaultOwnerForType(entry, command.owner);
    if(owner === 'spouse' && !plan.household?.spouse){
      throw new Error('Spouse ownership requires an active spouse');
    }
    plan.portfolio.extraAccounts.push(createAccount(entry.id, {
      displayName: normalizedText(command.displayName),
      owner,
      balance: money(command.balance),
      ...(command.allocationPresetId
        ? { investmentAllocation: snapshotPresetAllocation(command.allocationPresetId) }
        : {}),
    }));
    return;
  }
  const index = accountIndex(plan, command.accountId);
  if(command.action === 'remove'){
    plan.portfolio.extraAccounts.splice(index, 1);
    return;
  }
  if(command.action !== 'update') throw new Error('Unsupported account action');
  let account = plan.portfolio.extraAccounts[index];
  const fields = command.fields && typeof command.fields === 'object'
    ? command.fields
    : { [command.field]: command.value };
  const order = ['typeId', 'displayName', 'owner', 'balance', 'basis', 'allocationPresetId'];
  const unsupported = Object.keys(fields).find(field => !order.includes(field));
  if(unsupported) throw new Error(`Unsupported account field: ${unsupported}`);

  for(const field of order){
    if(!Object.hasOwn(fields, field)) continue;
    const value = fields[field];
    if(field === 'typeId'){
      if(value !== account.typeId){
        account = replaceAccountType(account, value);
        plan.portfolio.extraAccounts[index] = account;
      }
    }else if(field === 'displayName'){
      account.displayName = normalizedText(value);
    }else if(field === 'owner'){
      if(value !== account.owner){
        if(account.typeId === 'joint_brokerage' && value !== 'joint'){
          account = replaceAccountType(account, 'brokerage_taxable');
          plan.portfolio.extraAccounts[index] = account;
        }
        const entry = getAccountTypeById(account.typeId);
        if(!entry?.wizardOwners?.includes(value)) throw new Error('Owner is not valid for this account type');
        if(value === 'spouse' && !plan.household?.spouse){
          throw new Error('Spouse ownership requires an active spouse');
        }
        account.owner = value;
        account.taxReporting.reportingTaxpayer =
          value === 'client' || value === 'spouse' ? value : null;
        account.taxReporting.inclusion = value === 'joint'
          ? 'unknown'
          : 'household-return';
        account.taxReporting.householdReturnShare =
          account.taxReporting.inclusion === 'household-return' ? 1 : null;
      }
    }else if(field === 'balance'){
      account.balance = money(value);
    }else if(field === 'basis'){
      setAccountBasis(plan, account, value, timestamp);
    }else if(field === 'allocationPresetId'){
      const entry = getAccountTypeById(account.typeId);
      if(entry?.investmentAllocationEligible !== true){
        throw new Error('Asset allocation is unavailable for this account type');
      }
      account.investmentAllocation = snapshotPresetAllocation(value);
    }
  }
}

function propertyIndex(plan, value){
  if(!Array.isArray(plan.properties)) throw new Error('properties must be an array');
  const index = Number(value);
  if(!Number.isInteger(index)
      || index < 0
      || index >= plan.properties.length){
    throw new Error('Property must resolve exactly once');
  }
  return index;
}

function applyPropertyEdit(plan, command){
  if(!Array.isArray(plan.properties)) throw new Error('properties must be an array');
  if(command.action === 'add'){
    plan.properties.push({
      name: normalizedText(command.name),
      value: money(command.value),
      purchasePrice: 0,
      netWorthMeta: {
        type: normalizedText(command.type),
        owner: normalizedText(command.owner),
      },
      mortgage: {
        balance: 0,
        rate: 0,
        termYears: 0,
      },
    });
    return;
  }
  if(command.action !== 'remove') throw new Error('Unsupported property action');
  plan.properties.splice(propertyIndex(plan, command.propertyIndex), 1);
}

function applyMortgageEdit(plan, command){
  const index = propertyIndex(plan, command.propertyIndex);
  const property = plan.properties[index];
  const mortgage = property.mortgage;
  if(!mortgage || typeof mortgage !== 'object' || Array.isArray(mortgage)){
    throw new Error('mortgage must be an object');
  }
  if(command.action === 'set-balance'){
    mortgage.balance = money(command.value);
    mortgage.netWorthMeta = {
      present: true,
      name: normalizedText(command.name),
      type: normalizedText(command.type),
      owner: normalizedText(command.owner),
    };
  }else if(command.action === 'remove'){
    mortgage.balance = 0;
    delete mortgage.netWorthMeta;
  }else{
    throw new Error('Unsupported mortgage action');
  }
}

function applyNetWorthEdit(plan, command){
  if(!plan.netWorth || !Array.isArray(plan.netWorth.shellEntries)){
    throw new Error('netWorth.shellEntries must be an array');
  }
  if(command.action === 'add-shell-entry'){
    const entry = asRecord(command.entry, 'entry');
    const id = normalizedText(entry.id, { required: true });
    if(plan.netWorth.shellEntries.some(candidate => candidate?.id === id)){
      throw new Error(`Duplicate Net Worth record id: ${id}`);
    }
    const categoryId = normalizedText(entry.categoryId, { required: true });
    if(!NET_WORTH_SHELL_CATEGORIES.includes(categoryId)){
      throw new Error('Unsupported Net Worth record category');
    }
    plan.netWorth.shellEntries.push({
      id,
      categoryId,
      name: normalizedText(entry.name),
      type: normalizedText(entry.type, { required: true }),
      owner: normalizedText(entry.owner),
      tax: normalizedText(entry.tax),
      value: money(entry.value),
      projectionTreatment: NET_WORTH_ONLY_TREATMENT,
    });
    return;
  }
  if(command.action === 'remove-shell-entry'){
    const entryId = normalizedText(command.entryId, { required: true });
    const matches = plan.netWorth.shellEntries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry?.id === entryId);
    if(matches.length !== 1){
      throw new Error(`Net Worth record id must resolve exactly once: ${entryId}`);
    }
    plan.netWorth.shellEntries.splice(matches[0].index, 1);
    return;
  }
  throw new Error('Unsupported Net Worth record action');
}

function applyTaxEdit(plan, command){
  if(command.action === 'set'){
    setWizardTaxField(plan, command.field, command.value);
  }else if(command.action === 'remove'){
    removeWizardTaxItem(plan, command.item);
  }else if(command.action === 'confirm-tax-inputs'){
    confirmWizardTaxInputs(plan);
  }else if(command.action === 'clear-tax-confirmation'){
    clearWizardTaxConfirmation(plan);
  }else if(command.action === 'override-income-group'){
    overrideWizardIncomeGroup(plan, command.groupId);
  }else if(command.action === 'revert-income-group'){
    revertWizardIncomeGroup(plan, command.groupId);
  }else{
    throw new Error('Unsupported tax action');
  }
}

export function applyHouseholdWizardEdit(plan, command, options = {}){
  asRecord(plan, 'plan');
  asRecord(command, 'command');
  const timestamp = options.timestamp || new Date().toISOString();
  const next = structuredClone(plan);
  if(command.scope === 'family'){
    applyFamilyEdit(next, command, timestamp);
    if((command.action === 'remove-spouse'
        || command.field === 'filingStatus'
        || command.field === 'client.birthDate'
        || command.field === 'spouse.birthDate')
        && next.incomeTax?.current1040){
      next.incomeTax.current1040.incomeSourcesComplete = false;
    }
  }else if(command.scope === 'account'){
    applyAccountEdit(next, command, timestamp);
  }else if(command.scope === 'finance'){
    applyFinanceEdit(next, command);
  }else if(command.scope === 'property'){
    applyPropertyEdit(next, command);
  }else if(command.scope === 'mortgage'){
    applyMortgageEdit(next, command);
  }else if(command.scope === 'net-worth'){
    applyNetWorthEdit(next, command);
  }else if(command.scope === 'tax'){
    applyTaxEdit(next, command);
  }else{
    throw new Error(`Unsupported wizard edit scope: ${command.scope}`);
  }
  validateCurrentSchemaHousehold(next, next.meta?.householdId || 'household');
  validateHouseholdRecordSchema(next, next.meta?.householdId || 'household');
  return next;
}

export function createHouseholdWizardCommitBoundary({
  getPlan,
  replacePlan,
  afterCommit = () => {},
  timestamp = () => new Date().toISOString(),
}){
  if(typeof getPlan !== 'function'
      || typeof replacePlan !== 'function'
      || typeof afterCommit !== 'function'){
    throw new Error('Wizard commit boundary requires getPlan, replacePlan, and afterCommit functions');
  }
  let revision = 0;
  return {
    get revision(){ return revision; },
    preflight(command){
      applyHouseholdWizardEdit(getPlan(), command, {
        timestamp: timestamp(),
      });
      return true;
    },
    commit(command){
      const next = applyHouseholdWizardEdit(getPlan(), command, {
        timestamp: timestamp(),
      });
      replacePlan(next);
      revision += 1;
      let refreshError = null;
      try{
        afterCommit({ command, revision });
      }catch(error){
        refreshError = error instanceof Error ? error : new Error(String(error));
      }
      return { plan: next, revision, refreshError };
    },
  };
}

export function wizardCommandHasExplicitValue(command){
  return hasOwn(command, 'value');
}
