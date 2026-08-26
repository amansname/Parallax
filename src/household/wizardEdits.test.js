import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SCHEMA_VERSION } from './accountTypes.js';
import { bindHouseholdEditor } from './commit.js';
import { createAccount } from './createAccount.js';
import {
  snapshotLegacyRiskProfileAllocation,
  snapshotPresetAllocation,
} from './investmentAllocation.js';
import { LEGACY_BASE_ACCOUNT_IDS } from './migrateAccounts.js';
import { createBlankTaxProfiles, createFact } from './factEnvelope.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from './householdRecordSchema.js';
import { createEmptyNetWorthRecords } from './netWorthRecords.js';
import {
  applyHouseholdWizardEdit,
  createHouseholdWizardCommitBoundary,
} from './wizardEdits.js';

function plan(){
  const legacyAllocation = snapshotLegacyRiskProfileAllocation(3);
  return {
    meta: {
      householdId: 'hh_edits',
      name: 'New Household',
      primaryName: '',
      spouseName: '',
      filingStatus: 'single',
      state: 'VA',
      accountSchemaVersion: ACCOUNT_SCHEMA_VERSION,
      householdRecordSchemaVersion: HOUSEHOLD_RECORD_SCHEMA_VERSION,
    },
    household: {
      primary: {
        currentAge: 60,
        retirementAge: 65,
        planEndAge: 90,
        birthYear: 1966,
      },
      spouse: null,
      children: [],
    },
    portfolio: {
      riskProfile: 3,
      accounts: {
        taxable: { id: LEGACY_BASE_ACCOUNT_IDS.taxable, balance: 0, basisPct: 1, investmentAllocation: structuredClone(legacyAllocation) },
        traditional: { id: LEGACY_BASE_ACCOUNT_IDS.traditional, balance: 0, investmentAllocation: structuredClone(legacyAllocation) },
        roth: { id: LEGACY_BASE_ACCOUNT_IDS.roth, balance: 0, investmentAllocation: structuredClone(legacyAllocation) },
      },
      extraAccounts: [],
    },
    netWorth: createEmptyNetWorthRecords(),
    taxProfiles: createBlankTaxProfiles(),
    income: {
      other: [],
      socialSecurity: {
        primary: { pia: 0, claimAge: 67 },
        spouse: null,
      },
    },
    incomeTax: {
      adjustments: [],
      deductions: [],
      credits: [],
      deductionMode: 'auto',
    },
  };
}

test('visible Tax Next confirms canonical Tax facts before navigating', () => {
  const listeners = {};
  const commands = [];
  const navigations = [];
  const headerStatuses = [];
  const attributes = {};
  let customValidity = '';
  let rejectConfirmation = false;
  const root = {
    dataset: { wizardStep: 'tax' },
    addEventListener(type, listener){ listeners[type] = listener; },
  };
  const action = {
    dataset: { hhAction: 'step-next' },
    disabled: false,
    closest(selector){ return selector === '[data-hh-action]' ? this : null; },
    getAttribute(){ return null; },
    matches(){ return false; },
    removeAttribute(){},
    setAttribute(name, value){ attributes[name] = value; },
    setCustomValidity(message){ customValidity = message; },
    focus(){},
    reportValidity(){},
  };

  bindHouseholdEditor({
    root,
    wizardRoot: root,
    transientState: {},
    guardPlanMutation: () => true,
    commitWizardEdit(command){
      commands.push(command);
      if(rejectConfirmation){
        throw Object.assign(
          new Error('Current Tax facts are incomplete'),
          { code: 'CURRENT_1040_INCOME_SOURCES_INCOMPLETE' },
        );
      }
      return {};
    },
    syncHousehold(){},
    navigateWizard(direction){ navigations.push(direction); },
    syncHeaderStatus(message){ headerStatuses.push(message); },
    liveCommas(){},
  });

  listeners.click({ target: action });
  assert.deepEqual(commands, [{
    scope: 'tax',
    action: 'confirm-tax-inputs',
  }]);
  assert.deepEqual(navigations, ['next']);

  root.dataset.wizardStep = 'family';
  commands.length = 0;
  navigations.length = 0;
  listeners.click({ target: action });
  assert.deepEqual(commands, []);
  assert.deepEqual(navigations, ['next']);

  root.dataset.wizardStep = 'tax';
  commands.length = 0;
  navigations.length = 0;
  rejectConfirmation = true;
  listeners.click({ target: action });
  assert.deepEqual(commands, [{
    scope: 'tax',
    action: 'confirm-tax-inputs',
  }]);
  assert.deepEqual(navigations, []);
  assert.equal(
    root.dataset.validationCode,
    'CURRENT_1040_INCOME_SOURCES_INCOMPLETE',
  );
  assert.equal(attributes['aria-invalid'], 'true');
  assert.equal(customValidity, 'Current Tax facts are incomplete');
  assert.deepEqual(headerStatuses, ['Current Tax facts are incomplete']);
});

test('wizard teardown blur does not dispatch a nested Tax edit', () => {
  const listeners = {};
  const root = {
    dataset: { wizardReady: 'false' },
    addEventListener(type, listener){ listeners[type] = listener; },
  };
  let dispatched = 0;
  const control = {
    value: '125,000',
    dataset: { householdCommittedValue: '120,000' },
    closest(selector){ return selector === '.hh-tax-amount' ? this : null; },
    dispatchEvent(){ dispatched += 1; },
  };

  bindHouseholdEditor({
    root,
    wizardRoot: root,
    transientState: {},
    guardPlanMutation: () => true,
    commitWizardEdit: () => ({}),
    syncHousehold(){},
    navigateWizard(){},
    syncHeaderStatus(){},
    liveCommas(){},
  });

  listeners.focusout({ target: control });
  assert.equal(dispatched, 0);

  root.dataset.wizardReady = 'true';
  listeners.focusout({ target: control });
  assert.equal(dispatched, 1);
});

test('Net Worth account save submits a preset only after an explicit selector change', () => {
  const listeners = {};
  const commands = [];
  const root = {
    dataset: { wizardReady: 'true', wizardStep: 'net-worth' },
    addEventListener(type, listener){ listeners[type] = listener; },
  };
  const transientState = {};
  const saveAction = {
    dataset: {
      hhAction: 'net-worth-save-entry',
      netWorthResolvedLinkAvailable: 'false',
      netWorthOwnerRequired: 'true',
      netWorthLinkRequired: 'false',
    },
    disabled: false,
    closest(selector){ return selector === '[data-hh-action]' ? this : null; },
    getAttribute(){ return null; },
    matches(){ return false; },
    removeAttribute(){},
  };
  const panel = { querySelector(){ return saveAction; } };
  const draft = () => ({
    categoryId: 'investment',
    name: 'Client rollover',
    type: 'Rollover IRA',
    custom: false,
    owner: 'client',
    link: '',
    linkLabel: '',
    linkAvailable: false,
    value: '$400,000',
    accountTypeId: 'rollover_ira',
    allocationPresetId: 'balanced',
    initialAllocationPresetId: 'balanced',
    allocationSelectionChanged: false,
    canonicalTax: 'Tax-Deferred',
    shellOnly: false,
    owners: ['client', 'spouse'],
    editSource: 'account',
    editId: 'acct-rollover',
  });

  bindHouseholdEditor({
    root,
    wizardRoot: root,
    transientState,
    guardPlanMutation: () => true,
    commitWizardEdit(command){
      commands.push(command);
      return {};
    },
    syncHousehold(){},
    navigateWizard(){},
    syncHeaderStatus(){},
    liveCommas(){},
  });

  transientState.netWorthDraft = draft();
  listeners.click({ target: saveAction });
  assert.equal(Object.hasOwn(commands[0].fields, 'allocationPresetId'), false);

  transientState.netWorthDraft = draft();
  const growthRadio = {
    dataset: { netWorthDraft: 'allocationPresetId' },
    value: 'growth',
    closest(selector){
      if(selector === '[data-net-worth-draft]') return this;
      if(selector === '.nw-panel') return panel;
      return null;
    },
  };
  listeners.change({ target: growthRadio });
  assert.equal(transientState.netWorthDraft.allocationSelectionChanged, true);
  listeners.click({ target: saveAction });
  assert.equal(commands[1].fields.allocationPresetId, 'growth');
});

test('family DOB is one atomic edit across profile, plan age, and canonical taxpayers', () => {
  let current = plan();
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => { current = next; },
    timestamp: () => '2026-07-29T12:00:00.000Z',
  });

  boundary.commit({
    scope: 'family',
    field: 'client.birthDate',
    value: '1971-03-14',
  });

  assert.equal(current.taxProfiles.client.birthDate.value, '1971-03-14');
  assert.equal(current.taxProfiles.client.birthDate.status, 'confirmed');
  assert.equal(current.household.primary.birthYear, 1971);
  assert.equal(current.household.primary.currentAge, 55);
  assert.deepEqual(current.incomeTax.current1040.taxpayers, {
    client: { birthDate: '1971-03-14' },
  });
  assert.equal(boundary.revision, 1);
});

test('family preserves each person\'s Social Security amount and live-to age', () => {
  let current = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'family',
    field: 'client.socialSecurityBenefit',
    value: '31,200',
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'family',
    field: 'spouse.socialSecurityBenefit',
    value: '24,600',
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'family',
    field: 'client.planEndAge',
    value: 94,
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'family',
    field: 'spouse.planEndAge',
    value: 101,
  });

  assert.equal(current.income.socialSecurity.primary.pia, 31200);
  assert.equal(current.income.socialSecurity.spouse.pia, 24600);
  assert.equal(current.household.primary.planEndAge, 94);
  assert.equal(current.household.spouse.planEndAge, 101);
});

test('family rejects a live-to age before that person\'s current age', () => {
  const subject = plan();
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      field: 'client.planEndAge',
      value: 59,
    }),
    /cannot precede current age/,
  );
});

test('family rejects a negative Social Security amount without changing the plan', () => {
  const subject = plan();
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      field: 'client.socialSecurityBenefit',
      value: -1,
    }),
    /zero or a positive amount/,
  );
  assert.deepEqual(subject, before);
});

test('clearing Social Security keeps the amount unknown instead of inventing zero', () => {
  const current = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'client.socialSecurityBenefit',
    value: '',
  });
  assert.equal(current.income.socialSecurity.primary.pia, null);
});

test('invalid edits leave the live plan untouched and emit no commit transition', () => {
  const current = plan();
  const before = structuredClone(current);
  let replacements = 0;
  let transitions = 0;
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: () => { replacements += 1; },
    afterCommit: () => { transitions += 1; },
    timestamp: () => '2026-07-29T12:00:00.000Z',
  });

  assert.throws(
    () => boundary.commit({
      scope: 'family',
      field: 'filingStatus',
      value: 'marriedFilingSeparately',
    }),
    /Unsupported filing status/,
  );
  assert.equal(replacements, 0);
  assert.equal(transitions, 0);
  assert.deepEqual(current, before);
});

test('filing status cannot leave MFJ while a co-client record exists', () => {
  const subject = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  const before = structuredClone(subject);

  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      field: 'filingStatus',
      value: 'headOfHousehold',
    }),
    error => error?.code === 'CO_CLIENT_REMOVAL_REQUIRED'
      && error?.field === 'filingStatus'
      && /Remove co-client first/.test(error.message),
  );
  assert.deepEqual(subject, before);
});

test('cancelled co-client removal leaves every spouse fact untouched', () => {
  const subject = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      action: 'remove-spouse',
      confirmed: false,
    }),
    error => error?.code === 'CO_CLIENT_REMOVAL_CONFIRMATION_REQUIRED',
  );
  assert.deepEqual(subject, before);
});

test('co-client removal blocks on spouse-owned accounts without partial mutation', () => {
  const subject = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  subject.portfolio.extraAccounts.push(createAccount('roth_ira', {
    displayName: 'Co-client Roth IRA',
    owner: 'spouse',
    balance: 40000,
  }));
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      action: 'remove-spouse',
      confirmed: true,
    }),
    error => error?.code === 'CO_CLIENT_ACCOUNTS_REQUIRE_REASSIGNMENT',
  );
  assert.deepEqual(subject, before);
});

test('co-client removal blocks one or many spouse-owned income rows only', () => {
  const spouseRow = (id, amount) => ({
    id,
    typeId: 'wages',
    label: 'Wages or salary',
    owner: 'spouse',
    amount,
    startAge: 60,
    endAge: 65,
    realGrowth: 0,
    taxablePct: 1,
  });
  for(const rows of [
    [spouseRow('income-spouse-1', 50000)],
    [
      spouseRow('income-spouse-1', 50000),
      spouseRow('income-spouse-2', 25000),
    ],
  ]){
    const subject = applyHouseholdWizardEdit(plan(), {
      scope: 'family',
      field: 'filingStatus',
      value: 'marriedFilingJointly',
    });
    subject.income.other = rows;
    const before = structuredClone(subject);
    assert.throws(
      () => applyHouseholdWizardEdit(subject, {
        scope: 'family',
        action: 'remove-spouse',
        confirmed: true,
      }),
      error => error?.code === 'CO_CLIENT_INCOME_REQUIRES_REASSIGNMENT'
        && /Reassign or remove co-client income first/.test(error.message),
    );
    assert.deepEqual(subject, before);
  }

  let allowed = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  allowed.income.other = [
    { ...spouseRow('income-client', 50000), owner: 'client' },
    { ...spouseRow('income-joint', 25000), owner: 'joint' },
    { ...spouseRow('income-unowned', 10000), owner: undefined },
  ];
  allowed = applyHouseholdWizardEdit(allowed, {
    scope: 'family',
    action: 'remove-spouse',
    confirmed: true,
  });
  assert.deepEqual(
    allowed.income.other.map(row => row.id),
    ['income-client', 'income-joint', 'income-unowned'],
  );
});

test('confirmed co-client removal is one atomic transition and clears spouse facts', () => {
  let current = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    field: 'filingStatus',
    value: 'marriedFilingJointly',
  });
  current.meta.spouseName = 'Joanie Calloway';
  current.taxProfiles.spouse.birthDate = {
    value: '1972-04-10',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-07-29T12:00:00.000Z',
    version: 1,
  };
  current.incomeTax.current1040.scheduleSE = [{
    taxpayerOwner: 'spouse',
    netEarningsFromSelfEmployment: 20000,
    socialSecurityWagesAndTips: 0,
    socialSecurityWagesAndTipsIsScheduleSELine8d: true,
  }];
  current.incomeTax.current1040.incomeSourcesComplete = true;
  let replacements = 0;
  let transitions = 0;
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => {
      replacements += 1;
      current = next;
    },
    afterCommit: () => { transitions += 1; },
  });

  boundary.commit({
    scope: 'family',
    action: 'remove-spouse',
    confirmed: true,
  });

  assert.equal(replacements, 1);
  assert.equal(transitions, 1);
  assert.equal(current.meta.filingStatus, 'single');
  assert.equal(current.meta.spouseName, '');
  assert.equal(current.household.spouse, null);
  assert.equal(current.income.socialSecurity.spouse, null);
  assert.deepEqual(current.taxProfiles.spouse, createBlankTaxProfiles().spouse);
  assert.deepEqual(current.incomeTax.current1040.taxpayers, {});
  assert.equal(Object.hasOwn(current.incomeTax.current1040, 'scheduleSE'), false);
  assert.equal(current.incomeTax.current1040.incomeSourcesComplete, false);
});

test('account updates and removals resolve the stable ID after reorder', () => {
  const subject = plan();
  const first = createAccount('brokerage_taxable', {
    displayName: 'First',
    owner: 'client',
    balance: 100,
  });
  const second = createAccount('traditional_ira', {
    displayName: 'Second',
    owner: 'client',
    balance: 200,
  });
  subject.portfolio.extraAccounts = [second, first];

  const edited = applyHouseholdWizardEdit(subject, {
    scope: 'account',
    action: 'update',
    accountId: first.id,
    field: 'balance',
    value: 999,
  }, { timestamp: '2026-07-29T12:00:00.000Z' });

  assert.equal(edited.portfolio.extraAccounts[0].balance, 200);
  assert.equal(edited.portfolio.extraAccounts[1].balance, 999);
  const removed = applyHouseholdWizardEdit(edited, {
    scope: 'account',
    action: 'remove',
    accountId: second.id,
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  assert.deepEqual(removed.portfolio.extraAccounts.map(account => account.id), [first.id]);
});

test('account edit applies type, name, owner, and value atomically while preserving identity', () => {
  const subject = plan();
  const account = createAccount('brokerage_taxable', {
    displayName: 'Original brokerage',
    owner: 'joint',
    balance: 100000,
  });
  subject.portfolio.extraAccounts = [account];

  const edited = applyHouseholdWizardEdit(subject, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    fields: {
      typeId: 'roth_ira',
      displayName: 'Client Roth IRA',
      owner: 'client',
      balance: '$125,000',
    },
  }, { timestamp: '2026-08-21T12:00:00.000Z' });

  assert.equal(edited.portfolio.extraAccounts.length, 1);
  assert.equal(edited.portfolio.extraAccounts[0].id, account.id);
  assert.equal(edited.portfolio.extraAccounts[0].typeId, 'roth_ira');
  assert.equal(edited.portfolio.extraAccounts[0].displayName, 'Client Roth IRA');
  assert.equal(edited.portfolio.extraAccounts[0].owner, 'client');
  assert.equal(edited.portfolio.extraAccounts[0].balance, 125000);
  assert.equal(subject.portfolio.extraAccounts[0].displayName, 'Original brokerage');
});

test('account edits preserve saved allocations unless a preset is explicitly selected', () => {
  const subject = plan();
  const account = createAccount('rollover_ira', {
    displayName: 'Client rollover',
    owner: 'client',
    balance: 400000,
    investmentAllocation: snapshotPresetAllocation('growth'),
  });
  subject.portfolio.extraAccounts = [account];

  const preserved = applyHouseholdWizardEdit(subject, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    fields: {
      typeId: 'rollover_ira',
      displayName: 'Updated rollover',
      owner: 'client',
      balance: '$425,000',
    },
  }, { timestamp: '2026-08-26T12:00:00.000Z' });
  assert.deepEqual(
    preserved.portfolio.extraAccounts[0].investmentAllocation,
    snapshotPresetAllocation('growth'),
  );

  const selected = applyHouseholdWizardEdit(preserved, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    fields: { allocationPresetId: 'aggressive' },
  }, { timestamp: '2026-08-26T12:00:00.000Z' });
  assert.deepEqual(
    selected.portfolio.extraAccounts[0].investmentAllocation,
    snapshotPresetAllocation('aggressive'),
  );
});

test('same-type account saves preserve authoritative account envelopes byte-exactly', () => {
  const subject = plan();
  const nearBalanced = structuredClone(snapshotPresetAllocation('balanced'));
  nearBalanced.weights.usLarge += 5e-10;
  nearBalanced.weights.cash -= 5e-10;

  const brokerage = createAccount('brokerage_taxable', {
    displayName: 'Client brokerage',
    owner: 'client',
    balance: 100000,
    investmentAllocation: nearBalanced,
  });
  brokerage.basis = {
    amount: 64000,
    method: 'reported-cost-basis',
    status: 'confirmed',
    source: 'household-entry',
    confirmedAt: '2026-08-25T12:00:00.000Z',
    version: 1,
  };
  brokerage.taxReporting = {
    inclusion: 'unknown',
    reportingTaxpayer: 'return-level',
    householdReturnShare: 0.6,
  };
  const employer = createAccount('401k', {
    displayName: 'Client 401(k)',
    owner: 'client',
    balance: 200000,
    investmentAllocation: snapshotPresetAllocation('growth'),
  });
  employer.employerPlanFacts = {
    afterTaxContributionBasis: createFact(
      12000,
      'confirmed',
      'household-entry',
      '2026-08-25T12:00:00.000Z',
    ),
    planSubtypeConfirmed: createFact(
      true,
      'confirmed',
      'household-entry',
      '2026-08-25T12:00:00.000Z',
    ),
  };
  const designated = createAccount('roth_401k', {
    displayName: 'Client Roth 401(k)',
    owner: 'client',
    balance: 150000,
    investmentAllocation: snapshotPresetAllocation('aggressive'),
  });
  designated.designatedRothFacts = {
    firstContributionYear: createFact(
      2014,
      'confirmed',
      'household-entry',
      '2026-08-25T12:00:00.000Z',
    ),
    contributionBasis: createFact(
      75000,
      'confirmed',
      'household-entry',
      '2026-08-25T12:00:00.000Z',
    ),
    inPlanRolloverCohorts: createFact(
      [],
      'confirmed',
      'household-entry',
      '2026-08-25T12:00:00.000Z',
    ),
  };
  subject.portfolio.extraAccounts = [brokerage, employer, designated];
  const preservedBytes = Object.fromEntries(subject.portfolio.extraAccounts.map(account => [
    account.id,
    JSON.stringify({
      basis: account.basis,
      taxReporting: account.taxReporting,
      employerPlanFacts: account.employerPlanFacts,
      designatedRothFacts: account.designatedRothFacts,
      investmentAllocation: account.investmentAllocation,
    }),
  ]));

  let edited = subject;
  for(const account of subject.portfolio.extraAccounts){
    edited = applyHouseholdWizardEdit(edited, {
      scope: 'account',
      action: 'update',
      accountId: account.id,
      fields: {
        typeId: account.typeId,
        displayName: `${account.displayName} updated`,
        owner: account.owner,
        balance: account.balance + 1000,
      },
    }, { timestamp: '2026-08-26T12:00:00.000Z' });
  }

  for(const account of edited.portfolio.extraAccounts){
    assert.equal(account.id in preservedBytes, true);
    assert.equal(account.displayName.endsWith(' updated'), true);
    assert.equal(JSON.stringify({
      basis: account.basis,
      taxReporting: account.taxReporting,
      employerPlanFacts: account.employerPlanFacts,
      designatedRothFacts: account.designatedRothFacts,
      investmentAllocation: account.investmentAllocation,
    }), preservedBytes[account.id]);
  }
});

test('legacy allocations remain byte-stable until an advisor selects a preset', () => {
  const subject = plan();
  const legacyAllocation = snapshotLegacyRiskProfileAllocation(4);
  const account = createAccount('traditional_ira', {
    displayName: 'Legacy IRA',
    owner: 'client',
    balance: 300000,
    investmentAllocation: legacyAllocation,
  });
  subject.portfolio.extraAccounts = [account];
  const beforeBytes = JSON.stringify(account.investmentAllocation);

  const edited = applyHouseholdWizardEdit(subject, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    fields: {
      typeId: 'rollover_ira',
      displayName: 'Legacy rollover',
      owner: 'client',
      balance: 325000,
    },
  }, { timestamp: '2026-08-26T12:00:00.000Z' });
  assert.equal(
    JSON.stringify(edited.portfolio.extraAccounts[0].investmentAllocation),
    beforeBytes,
  );
});

test('new investment accounts accept one canonical allocation preset id', () => {
  const edited = applyHouseholdWizardEdit(plan(), {
    scope: 'account',
    action: 'add',
    typeId: 'roth_ira',
    displayName: 'Client Roth IRA',
    owner: 'client',
    balance: 125000,
    allocationPresetId: 'conservative',
  }, { timestamp: '2026-08-26T12:00:00.000Z' });
  assert.deepEqual(
    edited.portfolio.extraAccounts[0].investmentAllocation,
    snapshotPresetAllocation('conservative'),
  );
});

test('asset allocation presets are rejected for registry-ineligible accounts', () => {
  const subject = plan();
  const checking = createAccount('checking', {
    displayName: 'Client checking',
    owner: 'client',
    balance: 5000,
  });
  subject.portfolio.extraAccounts = [checking];
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'account',
      action: 'update',
      accountId: checking.id,
      fields: { allocationPresetId: 'growth' },
    }, { timestamp: '2026-08-26T12:00:00.000Z' }),
    /Asset allocation is unavailable/,
  );
});

test('taxable brokerage accepts joint ownership while legacy joint brokerage remains editable', () => {
  const subject = plan();
  let edited = applyHouseholdWizardEdit(subject, {
    scope: 'account',
    action: 'add',
    typeId: 'brokerage_taxable',
    displayName: 'Joint brokerage',
    owner: 'joint',
    balance: 1450000,
  }, { timestamp: '2026-07-29T12:00:00.000Z' });

  const account = edited.portfolio.extraAccounts[0];
  assert.equal(account.displayName, 'Joint brokerage');
  assert.equal(account.typeId, 'brokerage_taxable');
  assert.equal(account.owner, 'joint');
  assert.equal(account.bucket, 'taxable');

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    field: 'typeId',
    value: 'roth_ira',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  assert.equal(edited.portfolio.extraAccounts[0].displayName, 'Joint brokerage');
  assert.equal(edited.portfolio.extraAccounts[0].bucket, 'roth');
  assert.equal(edited.portfolio.extraAccounts[0].owner, 'client');

  const legacy = createAccount('joint_brokerage', {
    displayName: 'Existing joint brokerage',
    owner: 'joint',
    balance: 250000,
  });
  edited.portfolio.extraAccounts = [legacy];
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'account',
    action: 'update',
    accountId: legacy.id,
    field: 'owner',
    value: 'client',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  assert.equal(edited.portfolio.extraAccounts[0].typeId, 'brokerage_taxable');
  assert.equal(edited.portfolio.extraAccounts[0].owner, 'client');
  assert.equal(edited.portfolio.extraAccounts[0].balance, 250000);
});

test('account money edits accept comma-formatted display values without storing strings', () => {
  let edited = applyHouseholdWizardEdit(plan(), {
    scope: 'account',
    action: 'add',
    typeId: 'brokerage_taxable',
    owner: 'joint',
    balance: '1,234,567',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  const account = edited.portfolio.extraAccounts[0];
  assert.equal(account.balance, 1234567);

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    field: 'basis',
    value: '765,432',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  assert.equal(edited.portfolio.extraAccounts[0].basis.amount, 765432);

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'account',
    action: 'update',
    accountId: account.id,
    field: 'balance',
    value: '2,000,000',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  assert.equal(edited.portfolio.extraAccounts[0].balance, 2000000);
});

test('account ownership rejects a spouse owner when no spouse exists', () => {
  const subject = plan();
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'account',
      action: 'add',
      typeId: 'roth_ira',
      owner: 'spouse',
      balance: 40000,
    }),
    /Spouse ownership requires an active spouse/,
  );
  assert.deepEqual(subject, before);
});

test('Net Worth canonical mutations round decimal display values once', () => {
  let edited = applyHouseholdWizardEdit(plan(), {
    scope: 'account',
    action: 'add',
    typeId: 'checking',
    owner: 'client',
    balance: '$1,000.75',
  });
  assert.equal(edited.portfolio.extraAccounts[0].balance, 1001);

  edited.properties = [];
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'property',
    action: 'add',
    name: '',
    value: '$500,000.25',
  });
  assert.equal(edited.properties[0].value, 500000);

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'mortgage',
    action: 'set-balance',
    propertyIndex: 0,
    value: '$120,000.75',
  });
  assert.equal(edited.properties[0].mortgage.balance, 120001);
});

test('Net Worth shell records and canonical metadata mutate the household record atomically', () => {
  const subject = plan();
  subject.netWorth = { schemaVersion: 1, shellEntries: [] };
  subject.properties = [];

  let edited = applyHouseholdWizardEdit(subject, {
    scope: 'net-worth',
    action: 'add-shell-entry',
    entry: {
      id: 'nw-insurance',
      categoryId: 'insurance',
      name: 'Audit Insurance',
      type: 'Whole Life',
      owner: 'client',
      tax: '',
      value: '$50,000.40',
    },
  });
  assert.deepEqual(edited.netWorth.shellEntries, [{
    id: 'nw-insurance',
    categoryId: 'insurance',
    name: 'Audit Insurance',
    type: 'Whole Life',
    owner: 'client',
    tax: '',
    value: 50000,
    projectionTreatment: 'net-worth-only',
  }]);

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'property',
    action: 'add',
    name: 'Audit Lake House',
    type: 'Second Home',
    owner: 'joint',
    value: '$500,000',
  });
  assert.deepEqual(edited.properties[0].netWorthMeta, {
    type: 'Second Home',
    owner: 'joint',
  });

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'mortgage',
    action: 'set-balance',
    propertyIndex: 0,
    name: 'Audit Lake Lender',
    type: 'Second Home',
    owner: 'joint',
    value: '$120,000',
  });
  assert.deepEqual(edited.properties[0].mortgage.netWorthMeta, {
    present: true,
    name: 'Audit Lake Lender',
    type: 'Second Home',
    owner: 'joint',
  });

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'net-worth',
    action: 'remove-shell-entry',
    entryId: 'nw-insurance',
  });
  assert.deepEqual(edited.netWorth.shellEntries, []);
});

test('tax edits route only through canonical current1040 and preserve explicit zero', () => {
  let subject = plan();
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.wages',
    value: 450000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'scheduleD.netLongTermGainOrLoss',
    value: 0,
  });

  assert.equal(subject.incomeTax.current1040.income.wages, 450000);
  assert.deepEqual(subject.incomeTax.current1040.scheduleD, {
    mode: 'manual-net-long-term',
    netLongTermGainOrLoss: 0,
  });
  assert.deepEqual(subject.income.other, []);
});

test('income completion defaults hidden taxable-portion gaps to zero', () => {
  let subject = plan();
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'family',
    field: 'client.birthDate',
    value: '1971-03-14',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.iraDistributions',
    value: 20000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.pensionAmount',
    value: 15000,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'confirm-tax-inputs',
  });
  assert.equal(subject.incomeTax.current1040.income.taxableIra, 0);
  assert.equal(subject.incomeTax.current1040.income.taxablePensions, 0);
  assert.equal(subject.incomeTax.current1040.incomeSourcesComplete, true);
});

test('failed Tax confirmation for missing taxpayer facts is atomic', () => {
  let current = plan();
  let replacements = 0;
  let transitions = 0;
  const before = structuredClone(current);
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => {
      replacements += 1;
      current = next;
    },
    afterCommit: () => { transitions += 1; },
  });

  assert.throws(
    () => boundary.commit({
      scope: 'tax',
      action: 'confirm-tax-inputs',
    }),
    /taxpayers\.client is required/,
  );
  assert.equal(replacements, 0);
  assert.equal(transitions, 0);
  assert.deepEqual(current, before);
});

test('planning-income override and revert each use one cloned-plan transition', () => {
  let current = plan();
  current.household.primary.currentAge = 60;
  current.income.other = [{
    id: 'income-wages-1',
    typeId: 'wages',
    owner: 'client',
    amount: 90000,
    startAge: 60,
    endAge: 60,
  }];
  let transitions = 0;
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => { current = next; },
    afterCommit: () => { transitions += 1; },
  });

  boundary.commit({
    scope: 'tax',
    action: 'override-income-group',
    groupId: 'wages',
  });
  assert.equal(current.incomeTax.current1040.income.wages, 90000);
  assert.deepEqual(
    current.incomeTax.current1040.planningIncomeOverrides,
    ['wages'],
  );
  assert.equal(transitions, 1);

  boundary.commit({
    scope: 'tax',
    action: 'revert-income-group',
    groupId: 'wages',
  });
  assert.equal(
    Object.hasOwn(current.incomeTax.current1040.income, 'wages'),
    false,
  );
  assert.equal(
    Object.hasOwn(current.incomeTax.current1040, 'planningIncomeOverrides'),
    false,
  );
  assert.equal(transitions, 2);
});

test('every successful wizard command performs one replace and one transition', () => {
  let current = plan();
  let replacements = 0;
  let transitions = 0;
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => {
      replacements += 1;
      current = next;
    },
    afterCommit: () => { transitions += 1; },
  });

  boundary.commit({ scope: 'family', field: 'primaryName', value: 'Johnny Calloway' });
  assert.equal(replacements, 1);
  assert.equal(transitions, 1);
  assert.equal(current.meta.primaryName, 'Johnny Calloway');
});

test('a post-commit refresh failure never reports the applied edit as rejected', () => {
  let current = plan();
  let replacements = 0;
  const boundary = createHouseholdWizardCommitBoundary({
    getPlan: () => current,
    replacePlan: next => {
      replacements += 1;
      current = next;
    },
    afterCommit: () => {
      throw new Error('render failed');
    },
  });

  const result = boundary.commit({
    scope: 'family',
    field: 'primaryName',
    value: 'Johnny Calloway',
  });

  assert.equal(current.meta.primaryName, 'Johnny Calloway');
  assert.equal(replacements, 1);
  assert.equal(boundary.revision, 1);
  assert.match(result.refreshError?.message || '', /render failed/);
});
