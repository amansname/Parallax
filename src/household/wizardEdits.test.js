import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SCHEMA_VERSION } from './accountTypes.js';
import { createAccount } from './createAccount.js';
import { createBlankTaxProfiles } from './factEnvelope.js';
import { HOUSEHOLD_RECORD_SCHEMA_VERSION } from './householdRecordSchema.js';
import {
  applyHouseholdWizardEdit,
  createHouseholdWizardCommitBoundary,
} from './wizardEdits.js';

function plan(){
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
      accounts: {
        taxable: { balance: 0, basisPct: 1 },
        traditional: { balance: 0 },
        roth: { balance: 0 },
      },
      extraAccounts: [],
    },
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

test('Income owns each person\'s Social Security amount while Family owns live-to age', () => {
  let current = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    action: 'add-spouse',
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'income',
    field: 'socialSecurity.primary.pia',
    value: '31,200',
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'income',
    field: 'socialSecurity.spouse.pia',
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

test('Income rejects a negative Social Security amount without changing the plan', () => {
  const subject = plan();
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'income',
      field: 'socialSecurity.primary.pia',
      value: -1,
    }),
    /value from 0 through/,
  );
  assert.deepEqual(subject, before);
});

test('clearing Social Security keeps the amount unknown instead of inventing zero', () => {
  const current = applyHouseholdWizardEdit(plan(), {
    scope: 'income',
    field: 'socialSecurity.primary.pia',
    value: '',
  });
  assert.equal(current.income.socialSecurity.primary.pia, null);
});

test('Family rejects fields owned by Income and Tax without changing the plan', () => {
  const subject = plan();
  for(const field of [
    'client.socialSecurityBenefit',
    'client.socialSecurityAge',
    'filingStatus',
    'state',
    'dependents',
  ]){
    const before = structuredClone(subject);
    assert.throws(
      () => applyHouseholdWizardEdit(subject, {
        scope: 'family',
        field,
        value: field === 'state' ? 'MD' : 1,
      }),
      /Unsupported family field/,
    );
    assert.deepEqual(subject, before);
  }
});

test('Family child rows add, edit, remove, and preserve displaced inputs', () => {
  const subject = plan();
  subject.household.dependentsCount = 3;
  subject.income.socialSecurity.primary = { pia: 31200, claimAge: 70 };

  let edited = applyHouseholdWizardEdit(subject, {
    scope: 'family',
    action: 'add-child',
  });
  assert.deepEqual(edited.household.children, [{ name: '', birthYear: null }]);

  edited = applyHouseholdWizardEdit(edited, {
    scope: 'family',
    field: 'children.0.name',
    value: ' Avery ',
  });
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'family',
    field: 'children.0.birthYear',
    value: '2012',
  });
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'family',
    action: 'add-child',
  });
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'family',
    field: 'children.1.name',
    value: 'Jordan',
  });
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'family',
    action: 'remove-child',
    childIndex: 0,
  });

  assert.deepEqual(edited.household.children, [{ name: 'Jordan', birthYear: null }]);
  assert.equal(edited.household.dependentsCount, 3);
  assert.deepEqual(edited.income.socialSecurity.primary, { pia: 31200, claimAge: 70 });
});

test('Family child edits fail atomically when the row does not resolve', () => {
  const subject = plan();
  subject.household.children = [{ name: 'Avery', birthYear: 2012 }];
  const before = structuredClone(subject);

  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family',
      field: 'children.4.name',
      value: 'Wrong row',
    }),
    /Child row must resolve exactly once/,
  );
  assert.deepEqual(subject, before);
});

test('Income edits the canonical planning record without changing current-year tax facts', () => {
  let subject = plan();
  subject.household.spouse = {
    currentAge: 58,
    retirementAge: 65,
    planEndAge: 96,
  };
  subject.meta.spouseName = 'Co-client';
  subject.meta.filingStatus = 'marriedFilingJointly';
  subject.income.socialSecurity.spouse = { pia: 18000, claimAge: 68 };
  subject.income.other = [{
    id: 'income_salary',
    typeId: 'wages',
    label: 'Client salary',
    owner: 'client',
    amount: 75000,
    startAge: 60,
    endAge: 64,
    realGrowth: 0.01,
    taxablePct: 1,
    provenance: 'fixture-kept-byte-for-byte',
  }];
  subject.income.pension = {
    benefitByAge: { 65: 24000, 67: 30000 },
    base: 12000,
    startAge: 65,
    colaPct: 2,
  };
  subject.savings = {
    annual: 18000,
    split: {
      traditional: 0.6,
      roth: 0.25,
      taxable: 0.15,
      byOwner: { client: 0.7, spouse: 0.3 },
    },
  };
  subject.incomeTax.current1040 = {
    schemaVersion: 1,
    taxYear: 2026,
    incomeSourcesComplete: true,
    income: { wages: 91000, taxableInterest: 1200 },
  };
  const current1040Before = structuredClone(subject.incomeTax.current1040);

  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'socialSecurity.primary.pia',
    value: '32,000',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'socialSecurity.primary.claimAge',
    value: '70',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'source.amount',
    rowId: 'income_salary',
    value: '81,000',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'pension.benefitByAge.67',
    value: '31,500',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'savings.annual',
    value: '24,000',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'savings.split.roth',
    value: '30',
  });

  assert.deepEqual(subject.income.socialSecurity.primary, {
    pia: 32000,
    claimAge: 70,
  });
  assert.equal(subject.income.other[0].amount, 81000);
  assert.equal(subject.income.other[0].provenance, 'fixture-kept-byte-for-byte');
  assert.equal(subject.income.pension.benefitByAge[67], 31500);
  assert.equal(subject.income.pension.benefitByAge[65], 24000);
  assert.equal(subject.income.pension.base, 12000);
  assert.equal(subject.savings.annual, 24000);
  assert.equal(subject.savings.split.roth, 0.3);
  assert.equal(subject.savings.split.traditional, 0.6);
  assert.deepEqual(subject.incomeTax.current1040, current1040Before);
});

test('Income accepts sequential allocation edits but rejects a final total other than 100%', () => {
  let subject = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    action: 'add-spouse',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income',
    field: 'savings.split.traditional',
    value: 60,
  });
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'income',
      action: 'validate-step',
    }),
    error => error?.code === 'SAVINGS_SPLIT_MUST_TOTAL_100',
  );
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.roth', value: 20,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.taxable', value: 20,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.byOwner.client', value: 55,
  });
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'income', action: 'validate-step',
    }),
    error => error?.code === 'SAVINGS_OWNER_SPLIT_MUST_TOTAL_100',
  );
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.byOwner.spouse', value: 45,
  });
  const validated = applyHouseholdWizardEdit(subject, {
    scope: 'income', action: 'validate-step',
  });
  assert.deepEqual(validated.savings.split, {
    traditional: 0.6,
    roth: 0.2,
    taxable: 0.2,
    byOwner: { client: 0.55, spouse: 0.45 },
  });
});

test('Income recurring rows use the planning-only type and tax-attribute contract', () => {
  const forbidden = [
    'social_security',
    'pension',
    'tax_exempt_interest',
    'ira_distribution',
    'roth_conversion',
    'short_term_capital_gain',
    'long_term_capital_gain',
  ];
  for(const typeId of forbidden){
    const subject = plan();
    const before = structuredClone(subject);
    assert.throws(
      () => applyHouseholdWizardEdit(subject, {
        scope: 'income', action: 'add-income-source', typeId,
      }),
      /Unsupported planning income source type/,
    );
    assert.deepEqual(subject, before);
  }

  let subject = applyHouseholdWizardEdit(plan(), {
    scope: 'income', action: 'add-income-source', typeId: 'wages',
  });
  const rowId = subject.income.other[0].id;
  assert.equal(subject.income.other[0].taxablePct, 1);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'income', field: 'source.taxablePct', rowId, value: 25,
    }),
    /does not use a taxable percentage/,
  );
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.typeId', rowId, value: 'self_employment',
  });
  assert.equal(subject.income.other[0].taxablePct, 1);
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.typeId', rowId, value: 'dividends',
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'source.qualifiedPct', rowId, value: 65,
  });
  assert.equal(subject.income.other[0].taxablePct, 1);
  assert.equal(subject.income.other[0].qualifiedPct, 0.65);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'income', field: 'source.typeId', rowId, value: 'pension',
    }),
    /Unsupported planning income source type/,
  );

  const legacy = plan();
  legacy.income.other = [{
    id: 'legacy-ira',
    typeId: 'ira_distribution',
    label: 'Saved IRA row',
    owner: 'client',
    amount: 12000,
    startAge: 70,
    endAge: 72,
    taxablePct: 0.8,
  }];
  const editedLegacy = applyHouseholdWizardEdit(legacy, {
    scope: 'income', field: 'source.amount', rowId: 'legacy-ira', value: 13000,
  });
  assert.equal(editedLegacy.income.other[0].typeId, 'ira_distribution');
  assert.equal(editedLegacy.income.other[0].amount, 13000);
  assert.equal(editedLegacy.income.other[0].taxablePct, 0.8);
});

test('Tax current-year wages stay separate from canonical planning wages', () => {
  const subject = plan();
  subject.income.other = [{
    id: 'planning_wages',
    typeId: 'wages',
    owner: 'client',
    label: 'Long-term salary',
    amount: 75000,
    startAge: 60,
    endAge: 64,
    realGrowth: 0,
    taxablePct: 1,
  }];
  const planningIncomeBefore = structuredClone(subject.income);

  const edited = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.wages.client',
    value: '91,000',
  });

  assert.deepEqual(edited.income, planningIncomeBefore);
  assert.equal(edited.incomeTax.current1040.income.wages, 91000);
  assert.deepEqual(edited.incomeTax.current1040.wagesByOwner, {
    client: 91000,
  });
});

test('Tax-profile edits own filing status and residence without creating people', () => {
  const subject = plan();
  const incomeBefore = structuredClone(subject.income);

  let edited = applyHouseholdWizardEdit(subject, {
    scope: 'tax-profile',
    field: 'state',
    value: 'md',
  });
  edited = applyHouseholdWizardEdit(edited, {
    scope: 'tax-profile',
    field: 'filingStatus',
    value: 'headOfHousehold',
  });

  assert.equal(edited.meta.state, 'MD');
  assert.equal(edited.meta.filingStatus, 'headOfHousehold');
  assert.equal(edited.household.spouse, null);
  assert.deepEqual(edited.income, incomeBefore);
  assert.throws(
    () => applyHouseholdWizardEdit(edited, {
      scope: 'tax-profile',
      field: 'filingStatus',
      value: 'marriedFilingJointly',
    }),
    /Add a co-client in Family first/,
  );
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
      scope: 'tax-profile',
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
    action: 'add-spouse',
  });
  const before = structuredClone(subject);

  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'tax-profile',
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
    action: 'add-spouse',
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
    action: 'add-spouse',
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
      action: 'add-spouse',
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
    action: 'add-spouse',
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

test('co-client removal blocks a contribution share until it is visibly reassigned', () => {
  let subject = applyHouseholdWizardEdit(plan(), {
    scope: 'family', action: 'add-spouse',
  });
  subject.savings = {
    annual: 18000,
    split: {
      traditional: 0.6,
      roth: 0.2,
      taxable: 0.2,
      byOwner: { client: 0.55, spouse: 0.45 },
    },
  };
  const before = structuredClone(subject);
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'family', action: 'remove-spouse', confirmed: true,
    }),
    error => error?.code === 'CO_CLIENT_CONTRIBUTIONS_REQUIRE_REASSIGNMENT'
      && /co-client contribution share to 0%/.test(error.message),
  );
  assert.deepEqual(subject, before);

  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.byOwner.client', value: 100,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'income', field: 'savings.split.byOwner.spouse', value: 0,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'family', action: 'remove-spouse', confirmed: true,
  });
  assert.deepEqual(subject.savings.split.byOwner, { client: 1 });
});

test('confirmed co-client removal is one atomic transition and clears spouse facts', () => {
  let current = applyHouseholdWizardEdit(plan(), {
    scope: 'family',
    action: 'add-spouse',
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
  current = applyHouseholdWizardEdit(current, {
    scope: 'tax', action: 'set', field: 'income.wages.client', value: 81000,
  });
  current = applyHouseholdWizardEdit(current, {
    scope: 'tax', action: 'set', field: 'income.wages.spouse', value: 39000,
  });
  current.incomeTax.current1040.income.taxableInterest = 1200;
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
  assert.deepEqual(current.incomeTax.current1040.wagesByOwner, { client: 81000 });
  assert.equal(current.incomeTax.current1040.income.wages, 81000);
  assert.equal(current.incomeTax.current1040.income.taxableInterest, 1200);
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

test('income completion rejects hidden taxable-portion gaps and accepts explicit zero', () => {
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
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'tax',
      action: 'confirm-tax-inputs',
    }),
    /taxable IRA amount/,
  );

  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.taxableIra',
    value: 0,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.pensionAmount',
    value: 15000,
  });
  assert.throws(
    () => applyHouseholdWizardEdit(subject, {
      scope: 'tax',
      action: 'confirm-tax-inputs',
    }),
    /taxable pension amount/,
  );

  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'income.taxablePensions',
    value: 0,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'set',
    field: 'scheduleD.netLongTermGainOrLoss',
    value: 0,
  });
  subject = applyHouseholdWizardEdit(subject, {
    scope: 'tax',
    action: 'confirm-tax-inputs',
  });
  assert.equal(subject.incomeTax.current1040.incomeSourcesComplete, true);
});

test('failed Tax confirmation is atomic and performs no commit transition', () => {
  let current = plan();
  current = applyHouseholdWizardEdit(current, {
    scope: 'family',
    field: 'client.birthDate',
    value: '1971-03-14',
  }, { timestamp: '2026-07-29T12:00:00.000Z' });
  current = applyHouseholdWizardEdit(current, {
    scope: 'tax',
    action: 'set',
    field: 'income.iraDistributions',
    value: 20000,
  });
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
    /taxable IRA amount/,
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
