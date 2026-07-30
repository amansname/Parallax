import test from 'node:test';
import assert from 'node:assert/strict';

import { getWizardAccountTypes } from '../src/household/accountTypes.js';
import {
  createHouseholdWizard,
  HOUSEHOLD_WIZARD_STEPS,
} from './householdWizard.js';

function plan(){
  return {
    meta: {
      householdId: 'hh-wizard-test',
      name: 'Calloway household',
      primaryName: 'Johnny Calloway',
      spouseName: 'Joanie Calloway',
      filingStatus: 'marriedFilingJointly',
      state: 'VA',
    },
    household: {
      primary: { currentAge: 55, retirementAge: 62, employmentStatus: 'employed' },
      spouse: { currentAge: 55, retirementAge: 62, employmentStatus: 'employed' },
      dependentsCount: 0,
    },
    income: {
      socialSecurity: {
        primary: { claimAge: 67 },
        spouse: { claimAge: 67 },
      },
    },
    incomeTax: {
      current1040: {
        schemaVersion: 1,
        taxYear: 2026,
        incomeSourcesComplete: true,
        returnScope: { modeledTaxpayer: 'jointReturn' },
        taxpayers: {
          client: { birthDate: '1971-03-14' },
          spouse: { birthDate: '1971-05-22' },
        },
        income: {
          wages: 450000,
          taxExemptInterest: 4200,
          taxableInterest: 9500,
          qualifiedDividends: 24000,
          ordinaryDividends: 28500,
          iraDistributions: 0,
          taxableIra: 0,
          rothConversion: 0,
          pensionAmount: 0,
          taxablePensions: 0,
          socialSecurityBenefits: 0,
          otherIncome: 0,
        },
        scheduleD: {
          mode: 'manual-net-long-term',
          netLongTermGainOrLoss: 32000,
        },
        deductions: {
          method: 'standard',
          source: 'calculated',
          standardScope: 'base-and-age',
        },
      },
    },
    portfolio: {
      extraAccounts: [{
        id: 'acct-1',
        displayName: 'Joint brokerage',
        typeId: 'brokerage_taxable',
        type: 'Brokerage',
        owner: 'joint',
        balance: 1450000,
        basis: { amount: 980000 },
      }],
    },
    taxProfiles: {
      client: { birthDate: { value: '1971-03-14' } },
      spouse: { birthDate: { value: '1971-05-22' } },
    },
  };
}

function wizard({
  taxView = 'simplified',
  optionalMenuOpen = false,
  showScheduleSE = false,
  grossOnlyDistributions = false,
  planningWages = false,
  planningWagesOverridden = false,
  completionConfirmed = false,
  taxReady = true,
} = {}){
  const value = plan();
  if(grossOnlyDistributions){
    value.incomeTax.current1040.income.iraDistributions = 20000;
    value.incomeTax.current1040.income.pensionAmount = 15000;
    delete value.incomeTax.current1040.income.taxableIra;
    delete value.incomeTax.current1040.income.taxablePensions;
  }
  if(showScheduleSE){
    value.incomeTax.current1040.scheduleSE = [{
      taxpayerOwner: 'client',
      netEarningsFromSelfEmployment: 18000,
      socialSecurityWagesAndTips: 0,
      socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    }];
  }
  const uiState = {
    accountFormOpen: false,
    accountDraft: {},
    taxView,
    optionalTaxItems: new Set(),
    optionalMenuOpen,
  };
  return createHouseholdWizard({
    plan: value,
    uiState,
    states: [['VA', 'Virginia']],
    accountTypes: getWizardAccountTypes(),
    taxState: () => ({
      current: value.incomeTax.current1040,
      deductionMode: 'standard',
      completionConfirmed,
      planningIncome: {
        hasActivePlanningSocialSecurity: false,
        hasNonzeroShortTermCapitalGain: false,
        groups: {
          wages: {
            id: 'wages',
            rowIds: planningWages ? ['income-wages-1'] : [],
            values: { wages: 125000 },
            invalid: false,
            overridden: planningWagesOverridden,
            rowSourced: planningWages && !planningWagesOverridden,
          },
        },
      },
    }),
    taxBucketSnapshot: () => ({
      status: 'ready',
      totalBalance: 1450000,
      buckets: {
        taxable: { label: 'Taxable', balance: 1450000, accountCount: 1 },
        traditional: { label: 'Tax-Deferred', balance: 0, accountCount: 0 },
        roth: { label: 'Roth', balance: 0, accountCount: 0 },
      },
    }),
    incomeTaxSummary: () => taxReady
      ? ({
          status: 'ready',
          totalIncome: 524200,
          federalTaxLiability: 93406,
          effectiveRate: 0.178,
          taxTotalScope: 'FULL_1040',
          reasonCodes: [],
        })
      : ({
          status: 'needs_facts',
          totalIncome: null,
          federalTaxLiability: null,
          taxTotalScope: 'NOT_CALCULABLE',
          reasonCodes: ['CURRENT_1040_LINE9_DEFERRED'],
          message: 'Additional tax facts are needed',
        }),
  });
}

test('production wizard exposes exactly the four approved semantic steps', () => {
  assert.deepEqual(
    HOUSEHOLD_WIZARD_STEPS.map(step => step.id),
    ['family', 'net-worth', 'tax', 'summary'],
  );
});

test('Family is compact and omits MFS and survivor controls', () => {
  const html = wizard().render('family');
  assert.match(html, /data-hh-wizard-screen="family"/);
  assert.match(html, /Johnny Calloway/);
  assert.match(html, /Joanie Calloway/);
  assert.match(html, /Married filing jointly/);
  assert.match(html, /data-hh-action="remove-spouse"/);
  assert.match(html, /Remove co-client/);
  assert.doesNotMatch(html, /Married filing separately/);
  assert.doesNotMatch(html, /Survivor assumption/i);
});

test('Net Worth uses stable account identity and derived tax treatment', () => {
  const html = wizard().render('net-worth');
  assert.match(html, /data-account-id="acct-1"/);
  assert.match(html, /data-derived-treatment="acct-1"/);
  assert.match(html, /data-account-field="displayName"/);
  assert.doesNotMatch(html, /data-account-field="taxTreatment"/);
});

test('Tax preserves the approved 1040 order and removes ledger-only columns', () => {
  const html = wizard().render('tax');
  assert.match(html, /Long-term capital gain or loss/);
  assert.match(html, /data-tax-field="scheduleD\.netLongTermGainOrLoss"/);
  assert.match(html, /data-tax-field="income\.wages"/);
  assert.doesNotMatch(html, />Line</);
  assert.doesNotMatch(html, />Treatment</);
  assert.doesNotMatch(html, /IRA deduction from MAGI/i);
  assert.doesNotMatch(html, /workplace plan coverage/i);
  assert.doesNotMatch(html, /Account name|Tax treatment selector/i);
  assert.doesNotMatch(html, /Client 1040/i);
  assert.match(
    html,
    /I’ve entered every current-year tax item that applies\./,
  );
});

test('Detailed Tax adds return-only facts without changing the stored core inputs', () => {
  const html = wizard({
    taxView: 'detailed',
    optionalMenuOpen: true,
    showScheduleSE: true,
  }).render('tax');
  assert.match(html, /Taxable IRA amount/);
  assert.match(html, /Taxable pension amount/);
  assert.match(html, /Social Security source/);
  assert.match(html, /Schedule SE/);
  assert.match(html, /Resolved Schedule SE line 6/);
  assert.doesNotMatch(html, /business profit/i);
  assert.match(html, /all three Schedule 2 components/i);
});

test('legacy MFS is visible as unsupported instead of displaying MFJ', () => {
  const value = plan();
  value.meta.filingStatus = 'marriedFilingSeparately';
  const uiState = {
    accountFormOpen: false,
    accountDraft: {},
    taxView: 'simplified',
    optionalTaxItems: new Set(),
    optionalMenuOpen: false,
  };
  const rendered = createHouseholdWizard({
    plan: value,
    uiState,
    states: [['VA', 'Virginia']],
    accountTypes: getWizardAccountTypes(),
    taxState: () => ({
      current: value.incomeTax.current1040,
      deductionMode: 'standard',
    }),
    taxBucketSnapshot: () => ({
      totalBalance: 0,
      buckets: {
        taxable: { label: 'Taxable', balance: 0, accountCount: 0 },
        traditional: { label: 'Tax-Deferred', balance: 0, accountCount: 0 },
        roth: { label: 'Roth', balance: 0, accountCount: 0 },
      },
    }),
    incomeTaxSummary: () => ({ status: 'needs_facts', reasonCodes: [] }),
  });

  assert.match(rendered.render('family'), /Unsupported saved filing status/);
  assert.doesNotMatch(rendered.render('family'), /value="marriedFilingJointly" selected/);
  assert.match(rendered.render('tax'), /Unsupported saved filing status/);
});

test('Simplified Tax reveals taxable companions when gross distributions are entered', () => {
  const html = wizard({ grossOnlyDistributions: true }).render('tax');
  assert.match(html, /data-tax-field="income\.taxableIra"/);
  assert.match(html, /data-tax-field="income\.taxablePensions"/);
});

test('Tax shows planning-row provenance and requires an explicit current-year override', () => {
  const rowSourced = wizard({ planningWages: true }).render('tax');
  assert.match(rowSourced, /From planning income/);
  assert.match(rowSourced, /data-hh-action="override-income-group"/);
  assert.match(rowSourced, /data-income-group="wages"/);
  assert.match(
    rowSourced,
    /data-tax-field="income\.wages"[\s\S]*disabled aria-disabled="true"/,
  );
  assert.match(rowSourced, /value="125000"/);

  const overridden = wizard({
    planningWages: true,
    planningWagesOverridden: true,
  }).render('tax');
  assert.match(overridden, /Current-year amount/);
  assert.match(overridden, /data-hh-action="revert-income-group"/);
  assert.doesNotMatch(
    overridden,
    /data-tax-field="income\.wages"[\s\S]*disabled aria-disabled="true"/,
  );
});

test('Tax completion checkbox reflects persisted canonical completeness', () => {
  const unchecked = wizard().render('tax');
  assert.match(unchecked, /data-tax-confirmation/);
  assert.doesNotMatch(unchecked, /data-tax-confirmation\s+checked/);

  const checked = wizard({ completionConfirmed: true }).render('tax');
  assert.match(checked, /data-tax-confirmation\s+checked/);
});

test('Summary remains minimal and omits the rejected status and unlock sections', () => {
  const html = wizard().render('summary');
  assert.match(html, /data-summary-metric="portfolio"/);
  assert.match(html, /data-summary-metric="income"/);
  assert.match(html, /data-summary-metric="federal-tax"/);
  assert.match(html, /data-summary-income-status="ready"/);
  assert.match(html, /data-summary-tax-status="ready"/);
  assert.match(html, /data-summary-tax-scope="FULL_1040"/);
  const unavailable = wizard({ taxReady: false }).render('summary');
  assert.match(unavailable, /data-summary-income-status="not-calculable"/);
  assert.match(unavailable, /data-summary-tax-status="not-calculable"/);
  assert.match(unavailable, /data-summary-tax-scope="NOT_CALCULABLE"/);
  assert.match(html, /Portfolio by tax treatment/);
  assert.doesNotMatch(html, /Intake status/i);
  assert.doesNotMatch(html, /What this intake unlocks/i);
});

test('incomplete Summary remains viewable but cannot enter planning', () => {
  const incomplete = wizard({ completionConfirmed: false, taxReady: false });
  assert.match(
    incomplete.render('summary'),
    /data-summary-tax-scope="NOT_CALCULABLE"/,
  );
  assert.match(
    incomplete.footer('summary'),
    /data-tax-completion-required="true"/,
  );
  assert.match(incomplete.footer('summary'), /aria-disabled="true"/);

  const complete = wizard({ completionConfirmed: true });
  assert.doesNotMatch(
    complete.footer('summary'),
    /data-tax-completion-required="true"/,
  );
});
