import test from 'node:test';
import assert from 'node:assert/strict';

import { getWizardAccountTypes } from '../src/household/accountTypes.js';
import { snapshotPresetAllocation } from '../src/household/investmentAllocation.js';
import { createHouseholdWizardController } from '../src/household/wizard.js';
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
      planningAsOfYear: 2026,
      state: 'VA',
    },
    household: {
      primary: { currentAge: 55, retirementAge: 62, planEndAge: 94, employmentStatus: 'employed' },
      spouse: { currentAge: 55, retirementAge: 64, planEndAge: 101, employmentStatus: 'employed' },
      dependentsCount: 0,
    },
    income: {
      socialSecurity: {
        primary: { pia: 31200, claimAge: 67 },
        spouse: { pia: 24600, claimAge: 68 },
      },
    },
    incomeTax: {
      irmaa: {
        schemaVersion: 1,
        lookbackByTaxYear: {
          2024: { magi: 340000, filingStatus: 'marriedFilingJointly' },
          2025: { magi: 200000, filingStatus: 'marriedFilingJointly' },
        },
      },
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
        investmentAllocation: snapshotPresetAllocation('balanced'),
      }],
    },
    taxProfiles: {
      client: { birthDate: { value: '1971-03-14' } },
      spouse: { birthDate: { value: '1971-05-22' } },
    },
  };
}

function wizard({
  financeRailOpen = false,
  financeOwner = null,
  financeMode = 'savings',
  financeTypeId = null,
  savingsEntries = null,
  savingsAnnual = 68_300,
  netWorthPanelCategory = null,
  netWorthDraft = null,
  withoutSpouse = false,
  taxView = 'simplified',
  optionalMenuOpen = false,
  showScheduleSE = false,
  grossOnlyDistributions = false,
  planningWages = false,
  planningWagesOverridden = false,
  taxReady = true,
  partialIncome = false,
  partialTax = false,
  durableNetWorth = false,
  portfolioTotal = 1450000,
} = {}){
  const value = plan();
  value.savings = { annual: savingsAnnual, entries: savingsEntries || [] };
  if(durableNetWorth){
    value.portfolio.extraAccounts = [];
    value.properties = [{
      name: 'Audit Lake House',
      value: 500000,
      purchasePrice: 0,
      netWorthMeta: { type: 'Second Home', owner: 'joint' },
      mortgage: {
        balance: 120000,
        rate: 0,
        termYears: 0,
        netWorthMeta: {
          present: true,
          name: 'Audit Lake Lender',
          type: 'Second Home',
          owner: 'joint',
        },
      },
    }];
    value.netWorth = {
      schemaVersion: 1,
      shellEntries: [
        { id: 'nw-trust', categoryId: 'investment', name: 'Audit Trust', type: 'Trust', owner: 'joint', tax: 'Taxable', value: 100000, projectionTreatment: 'net-worth-only' },
        { id: 'nw-insurance', categoryId: 'insurance', name: 'Audit Insurance', type: 'Whole Life', owner: 'client', tax: '', value: 50000, projectionTreatment: 'net-worth-only' },
        { id: 'nw-card', categoryId: 'card', name: 'Audit Card', type: 'Revolving', owner: 'client', tax: '', value: 5000, projectionTreatment: 'net-worth-only' },
        { id: 'nw-loan', categoryId: 'loan', name: 'Audit Loan', type: 'Auto', owner: 'client', tax: '', value: 20000, projectionTreatment: 'net-worth-only' },
        { id: 'nw-custom', categoryId: 'bank', name: 'Audit Custom', type: 'Collector cash', owner: 'client', tax: '', value: 3000, projectionTreatment: 'net-worth-only' },
      ],
    };
  }
  if(withoutSpouse){
    value.household.spouse = null;
    value.meta.spouseName = '';
  }
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
    financeRailOpen,
    financeOwner,
    financeMode,
    financeTypeId,
    netWorthView: 'entry',
    netWorthPanelCategory,
    netWorthMoreOpen: false,
    netWorthDraft,
    netWorthShellEntries: [],
    netWorthAccountMeta: {},
    netWorthPropertyMeta: [],
    netWorthMortgageMeta: [],
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
      planningIncome: {
        hasActivePlanningSocialSecurity: false,
        hasNonzeroShortTermCapitalGain: false,
        wagesByOwner: {
          client: {
            rowIds: planningWages ? ['income-wages-1'] : [],
            value: 125000,
            present: planningWages,
          },
          spouse: { rowIds: [], value: 0, present: false },
        },
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
      totalBalance: portfolioTotal,
      buckets: {
        taxable: { label: 'Taxable', balance: portfolioTotal, accountCount: portfolioTotal > 0 ? 1 : 0 },
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
          irmaa: {
            magi: 218000,
            tier: 1,
            nextTier: 2,
            roomToNext: 56000,
            premiumYear: 2028,
          },
          reasonCodes: [],
        })
      : partialTax
        ? ({
            status: 'partial',
            calculationScope: 'available-inputs',
            totalIncome: partialIncome ? 125000 : null,
            federalTaxLiability: 18734,
            effectiveRate: 0.172,
            taxTotalScope: 'FULL_1040',
            reasonCodes: [],
          })
        : ({
          status: 'needs_facts',
          totalIncome: partialIncome ? 125000 : null,
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

test('Family preserves its demographic fields and routes Social Security amounts through the rail', () => {
  const html = wizard().render('family');
  assert.match(html, /data-hh-wizard-screen="family"/);
  assert.match(html, /Johnny Calloway/);
  assert.match(html, /Joanie Calloway/);
  assert.match(html, /Married filing jointly/);
  assert.match(html, /data-hh-action="remove-spouse"/);
  assert.match(html, /Remove co-client/);
  assert.match(html, /data-wizard-field="client\.socialSecurityAge"/);
  assert.match(html, /data-wizard-field="spouse\.socialSecurityAge"/);
  assert.match(html, /data-wizard-field="client\.planEndAge"/);
  assert.match(html, /data-wizard-field="spouse\.planEndAge"/);
  assert.equal((html.match(/<span>Social Security<\/span>/g) || []).length, 2);
  assert.match(html, /<span>Children\?<\/span>/);
  assert.match(html, /data-wizard-field="dependents"/);
  assert.doesNotMatch(html, /Social Security at/);
  assert.doesNotMatch(html, /Annual Social Security at full retirement age/);
  assert.doesNotMatch(html, /data-wizard-field="(?:client|spouse)\.socialSecurityBenefit"/);
  assert.doesNotMatch(html, /Married filing separately/);
  assert.doesNotMatch(html, /Survivor assumption/i);
});

test('Family preserves the locked two-card composition and labeled compact rail', () => {
  const closed = wizard().render('family');
  assert.equal((closed.match(/data-person-owner=/g) || []).length, 2);
  assert.match(closed, /data-finances-rail/);
  assert.match(closed, />Savings and Income</);
  assert.match(closed, /data-hh-action="toggle-finances-rail"/);
  assert.match(closed, /id="hh-finances-rail-body" hidden/);
  assert.doesNotMatch(closed, /data-finances-person-owner/);
  assert.doesNotMatch(closed, /data-finance-entry-panel/);
  assert.doesNotMatch(closed, />\s*Finances\s*</i);

  const open = wizard({ financeRailOpen: true }).render('family');
  assert.equal((open.match(/data-finances-person-owner=/g) || []).length, 2);
  assert.match(open, /Johnny Calloway/);
  assert.match(open, /Joanie Calloway/);
  assert.match(open, /class="hh-finances-person-name"/);
  assert.match(open, /data-finances-summary/);
  assert.match(open, />\s*Savings\s*</i);
  assert.match(open, />\s*\$68,300\/yr\s*</);
  assert.doesNotMatch(open, /Savings while working/i);
  assert.doesNotMatch(open, /data-finance-entry-panel/);
});

test('Family finance entry renders only after a person is chosen and keeps the amount conditional', () => {
  const closed = wizard().render('family');
  assert.equal((closed.match(/data-hh-action="toggle-finance-entry"/g) || []).length, 0);
  assert.doesNotMatch(closed, /data-finance-entry-panel/);
  assert.doesNotMatch(closed, /Income &amp; Savings|Income & Savings|>FINANCES</i);

  const picker = wizard({ financeRailOpen: true, financeOwner: 'spouse' }).render('family');
  assert.equal((picker.match(/data-hh-action="toggle-finance-entry"/g) || []).length, 2);
  assert.equal((picker.match(/data-finance-entry-panel/g) || []).length, 1);
  assert.match(picker, /data-finance-owner="spouse"/);
  assert.match(picker, /data-hh-action="set-finance-mode" data-finance-mode="savings"/);
  assert.match(picker, /data-hh-action="set-finance-mode" data-finance-mode="income"/);
  assert.match(picker, />\s*401\(k\) deferral\s*</);
  assert.match(picker, />\s*Roth IRA\s*</);
  assert.match(picker, />\s*Cash savings\s*</);
  assert.doesNotMatch(picker, /data-finance-amount/);
  assert.doesNotMatch(picker, />Save</);
  assert.doesNotMatch(picker, />\s*529 contribution\s*</);

  const amount = wizard({
    financeRailOpen: true,
    financeOwner: 'spouse',
    financeTypeId: '401k',
  }).render('family');
  assert.equal((amount.match(/data-finance-amount/g) || []).length, 1);
  assert.match(amount, /aria-label="401\(k\) deferral annual amount"/);
  assert.match(amount, /data-finance-amount[^>]*value=""/);
  assert.match(amount, /data-hh-action="commit-finance-entry"/);
  assert.doesNotMatch(amount, />Save</);

  const existing = wizard({
    financeRailOpen: true,
    financeOwner: 'client',
    financeTypeId: '401k',
    savingsEntries: [{
      id: 'savings_client_401k',
      typeId: '401k',
      label: '401(k) deferral',
      owner: 'client',
      amount: 28_300,
      bucket: 'traditional',
    }],
  }).render('family');
  assert.match(existing, /data-finance-amount[^>]*value="28,300"/);
});

test('Family finance income mode exposes the ordered common-source inventory only', () => {
  const html = wizard({
    financeRailOpen: true,
    financeOwner: 'client',
    financeMode: 'income',
  }).render('family');
  const labels = [...html.matchAll(/data-finance-type-id="[^"]+"[\s\S]*?>([^<]+)<\/button>/g)]
    .map(match => match[1].trim());
  assert.deepEqual(labels, [
    'Social Security',
    'Pension',
    'Wages or salary',
    'Self-employment',
    'Rental net income',
    'Annuity',
    'Interest',
    'Dividends',
    'Deferred compensation',
    'Other income',
  ]);
});

test('Family rail edits each person Social Security reference benefit independently', () => {
  const primary = wizard({
    financeRailOpen: true,
    financeOwner: 'client',
    financeMode: 'income',
    financeTypeId: 'social_security',
  }).render('family');
  assert.match(primary, /data-finance-owner="client"/);
  assert.match(primary, /aria-label="Social Security annual amount"/);
  assert.match(primary, /data-finance-amount[^>]*value="31,200"/);

  const spouse = wizard({
    financeRailOpen: true,
    financeOwner: 'spouse',
    financeMode: 'income',
    financeTypeId: 'social_security',
  }).render('family');
  assert.match(spouse, /data-finance-owner="spouse"/);
  assert.match(spouse, /data-finance-amount[^>]*value="24,600"/);
  assert.doesNotMatch(spouse, /data-wizard-field="(?:client|spouse)\.socialSecurityBenefit"/);
});

test('Net Worth presents the approved category workflow and canonical portfolio total', () => {
  const html = wizard().render('net-worth');
  assert.match(html, /data-hh-wizard-screen="net-worth"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="bank"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="investment"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="property"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="mortgage"/);
  assert.match(html, /\$1,450,000/);
  assert.match(html, /class="nw-rail"/);
  assert.match(html, /data-hh-action="step-next">Continue/);
  assert.match(html, /data-hh-action="step-back">Back/);
  assert.doesNotMatch(html, /data-hh-action="net-worth-show-summary"/);
  assert.doesNotMatch(html, /class="nw-entry-footer"/);
  assert.doesNotMatch(html, /data-account-field|data-hh-action="add-account"/);
});

test('Net Worth exposes saved canonical accounts for in-place editing', () => {
  const row = wizard({ netWorthPanelCategory: 'investment' }).render('net-worth');
  assert.match(row, /data-hh-action="net-worth-edit-entry"/);
  assert.match(row, /data-account-id="acct-1"/);
  assert.match(row, /data-account-type-id="brokerage_taxable"/);

  const form = wizard({
    netWorthPanelCategory: 'investment',
    netWorthDraft: {
      categoryId: 'investment',
      name: 'Joint brokerage',
      type: 'Brokerage (taxable)',
      custom: false,
      owner: 'joint',
      link: '',
      linkLabel: '',
      linkAvailable: false,
      value: '$1,450,000',
      accountTypeId: 'brokerage_taxable',
      canonicalTax: 'Taxable',
      shellOnly: false,
      owners: ['client', 'spouse', 'joint'],
      allocationPresetId: 'balanced',
      editSource: 'account',
      editId: 'acct-1',
    },
  }).render('net-worth');
  assert.match(form, /value="Joint brokerage"[\s\S]*data-net-worth-draft="name"/);
  assert.match(form, /value="\$1,450,000"[\s\S]*data-net-worth-draft="value"/);
  assert.equal(form.includes('data-asset-allocation-selector'), true);
  assert.match(form, />Save changes<\/button>/);
});

test('Net Worth shows allocation presets only for canonical investment accounts', () => {
  const investment = wizard({
    netWorthPanelCategory: 'investment',
    netWorthDraft: {
      categoryId: 'investment',
      name: '',
      type: 'Roth IRA',
      custom: false,
      owner: 'client',
      link: '',
      linkLabel: '',
      linkAvailable: false,
      value: '$',
      accountTypeId: 'roth_ira',
      canonicalTax: 'Tax-Free',
      shellOnly: false,
      owners: ['client', 'spouse'],
      allocationPresetId: 'growth',
    },
  }).render('net-worth');
  assert.equal(investment.includes('data-asset-allocation-selector'), true);

  const bank = wizard({
    netWorthPanelCategory: 'bank',
    netWorthDraft: {
      categoryId: 'bank',
      name: '',
      type: 'Checking',
      custom: false,
      owner: 'client',
      link: '',
      linkLabel: '',
      linkAvailable: false,
      value: '$',
      accountTypeId: 'checking',
      canonicalTax: 'Taxable',
      shellOnly: false,
      owners: ['client', 'spouse', 'joint'],
      allocationPresetId: '',
    },
  }).render('net-worth');
  assert.equal(bank.includes('data-asset-allocation-selector'), false);
});

test('Net Worth requires a valid owner and hides spouse ownership when no spouse exists', () => {
  const html = wizard({
    netWorthPanelCategory: 'bank',
    withoutSpouse: true,
    netWorthDraft: {
      categoryId: 'bank',
      name: '',
      type: 'Checking',
      custom: false,
      owner: '',
      link: '',
      linkLabel: '',
      linkAvailable: false,
      value: '$250,000',
      accountTypeId: 'checking',
      canonicalTax: 'Taxable',
      shellOnly: false,
      owners: ['client', 'joint'],
    },
  }).render('net-worth');
  assert.match(html, /value="\$250,000"\s+data-net-worth-draft="value"/);
  assert.match(html, /data-hh-action="net-worth-save-entry"[\s\S]*data-net-worth-owner-required="true"[\s\S]*disabled>Save/);
  assert.doesNotMatch(html, /<option value="spouse"/);
});

test('Net Worth uses durable shell records and property metadata in rows and totals', () => {
  const insurance = wizard({
    durableNetWorth: true,
    portfolioTotal: 0,
    netWorthPanelCategory: 'insurance',
  }).render('net-worth');
  assert.match(insurance, /Audit Insurance/);
  assert.match(insurance, /Whole Life · Client/);
  assert.match(insurance, /\$508,000/);
  assert.match(insurance, /\$50,000/);
  assert.match(insurance, /\$100,000/);
  assert.match(insurance, /\$5,000/);
  assert.match(insurance, /\$20,000/);
  assert.match(insurance, /\$3,000/);

  const property = wizard({
    durableNetWorth: true,
    portfolioTotal: 0,
    netWorthPanelCategory: 'property',
  }).render('net-worth');
  assert.match(property, /Audit Lake House/);
  assert.match(property, /Second Home · Joint/);

  const mortgage = wizard({
    durableNetWorth: true,
    portfolioTotal: 0,
    netWorthPanelCategory: 'mortgage',
  }).render('net-worth');
  assert.match(mortgage, /Audit Lake Lender/);
  assert.match(mortgage, /Second Home · Joint · Audit Lake House/);
});

test('Tax preserves the approved 1040 order and removes ledger-only columns', () => {
  const html = wizard().render('tax');
  assert.match(html, /Long-term capital gain or loss/);
  assert.match(html, /data-tax-field="scheduleD\.netLongTermGainOrLoss"/);
  assert.match(html, /data-tax-field="income\.wages\.client"/);
  assert.match(html, /data-tax-field="income\.wages\.spouse"/);
  assert.doesNotMatch(html, />Line</);
  assert.doesNotMatch(html, />Treatment</);
  assert.doesNotMatch(html, /IRA deduction from MAGI/i);
  assert.doesNotMatch(html, /workplace plan coverage/i);
  assert.doesNotMatch(html, /Account name|Tax treatment selector/i);
  assert.doesNotMatch(html, /Client 1040/i);
});

test('Tax exposes one complete input view without the Simplified/Detailed toggle', () => {
  const html = wizard({
    optionalMenuOpen: true,
    showScheduleSE: true,
  }).render('tax');
  assert.doesNotMatch(html, /data-hh-action="set-tax-view"/);
  assert.doesNotMatch(html, />Simplified<|>Detailed</);
  assert.match(html, /data-tax-view="detailed"/);
  assert.doesNotMatch(html, /Taxable IRA amount/);
  assert.doesNotMatch(html, /Taxable pension amount/);
  assert.match(html, /Social Security source/);
  assert.match(html, /Schedule SE/);
  assert.match(html, /Resolved Schedule SE line 6/);
  assert.doesNotMatch(html, /business profit/i);
  assert.match(html, /all three Schedule 2 components/i);
});

test('Tax preserves an incomplete reason code without rendering readiness copy', () => {
  const html = wizard({ taxReady: false }).render('tax');
  assert.match(html, /data-tax-readiness="needs-facts"/);
  assert.match(html, /data-tax-reason="CURRENT_1040_LINE9_DEFERRED"/);
  assert.match(html, /class="hh-tax-readiness"[\s\S]*?hidden>/);
  assert.doesNotMatch(html, /Additional tax facts are needed/);
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

test('Tax reveals taxable companions when gross distributions are entered', () => {
  const html = wizard({ grossOnlyDistributions: true }).render('tax');
  assert.match(html, /data-tax-field="income\.taxableIra"/);
  assert.match(html, /data-tax-field="income\.taxablePensions"/);
});

test('Tax edits member wages directly without source or override controls', () => {
  const rowSourced = wizard({ planningWages: true }).render('tax');
  assert.match(
    rowSourced,
    /value="125,000"[\s\S]*data-tax-field="income\.wages\.client"/,
  );
  assert.doesNotMatch(rowSourced, /class="hh-tax-amount"[^>]*value="\$/);
  assert.doesNotMatch(rowSourced, /From planning income|Use current-year amount/);
  assert.doesNotMatch(rowSourced, /data-income-group="wages"/);
  assert.doesNotMatch(rowSourced, /income\.wages\.client"[\s\S]*disabled/);
});

test('Tax page omits confirmation checkbox markup', () => {
  const html = wizard().render('tax');
  assert.doesNotMatch(html, /data-tax-confirmation/);
});

test('Tax page exposes two IRMAA MAGI rows and one authoritative filing-status reminder', () => {
  const html = wizard().render('tax');
  assert.match(html, /data-tax-input-section="irmaa-lookback"/);
  assert.match(html, /data-irmaa-tax-year="2024"/);
  assert.match(html, /data-irmaa-tax-year="2025"/);
  assert.match(html, /data-tax-field="irmaa\.lookback\.2024\.magi"/);
  assert.match(html, /data-tax-field="irmaa\.lookback\.2025\.magi"/);
  assert.match(html, /value="340,000"[^>]*data-tax-field="irmaa\.lookback\.2024\.magi"/);
  assert.match(html, /value="200,000"[^>]*data-tax-field="irmaa\.lookback\.2025\.magi"/);
  assert.doesNotMatch(html, /value="\$340,000"|value="\$200,000"/);
  assert.doesNotMatch(html, /data-tax-field="irmaa\.lookback\.\d{4}\.filingStatus"/);
  assert.equal((html.match(/>Filing status<\/span>/g) || []).length, 1);
  assert.equal((html.match(/data-tax-summary-box=/g) || []).length, 5);
  assert.equal((html.match(/data-irmaa-tax-year=/g) || []).length, 2);
  assert.doesNotMatch(html, /data-hh-action="set-tax-view"/);
  assert.doesNotMatch(html, /current tier|next tier|premium year|timeline|estimate/i);
});

test('Summary remains minimal and omits the rejected status and unlock sections', () => {
  const html = wizard().render('summary');
  assert.match(html, /data-summary-metric="portfolio"/);
  assert.doesNotMatch(html, /data-summary-metric="income"|Base-year income/);
  assert.doesNotMatch(html, /data-summary-metric="federal-tax"|Modeled federal tax/);
  const unavailable = wizard({ taxReady: false }).render('summary');
  assert.doesNotMatch(unavailable, /data-summary-income-status|data-summary-tax-status/);
  assert.match(html, /Portfolio by tax treatment/);
  assert.match(html, /<table class="hh-summary-irmaa"/);
  assert.match(html, /<th scope="col">Item<\/th><th scope="col">Value<\/th>/);
  assert.match(html, /<tr><td>MAGI<\/td><td>\$218,000<\/td><\/tr>/);
  assert.match(html, /<tr><td>Current tier<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /<tr><td>To next tier<\/td><td>\$56,000<\/td><\/tr>/);
  assert.match(html, /<tr><td>Premium year<\/td><td>2028<\/td><\/tr>/);
  assert.doesNotMatch(html, /<tr><td>Program<\/td>/);
  assert.doesNotMatch(html, /<tr><td>Next tier<\/td>/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) || []).length, 4);
  assert.doesNotMatch(html, /Intake status/i);
  assert.doesNotMatch(html, /What this intake unlocks/i);
  assert.doesNotMatch(html, /planning estimate|disclosure|timeline/i);
  assert.doesNotMatch(unavailable, /data-summary-irmaa/);
});

test('Summary omits unreliable income and tax headlines for partial facts', () => {
  const html = wizard({
    taxReady: false,
    partialIncome: true,
    partialTax: true,
  }).render('summary');
  assert.doesNotMatch(html, /data-summary-income-status|Base-year income|\$125,000/);
  assert.doesNotMatch(html, /data-summary-tax-status|Modeled federal tax|\$18,734/);
  assert.doesNotMatch(html, /more facts needed/i);
  assert.doesNotMatch(html, /additional tax facts/i);
  assert.doesNotMatch(html, /needs additional facts/i);
});

test('Summary Continue to Goals is available even when tax summary is not calculable', () => {
  const incomplete = wizard({ taxReady: false });
  assert.doesNotMatch(incomplete.render('summary'), /data-summary-tax-status/);
  assert.doesNotMatch(
    incomplete.footer('summary'),
    /data-tax-completion-required="true"/,
  );
  assert.doesNotMatch(incomplete.footer('summary'), /aria-disabled="true"/);
  assert.match(incomplete.footer('summary'), /Continue to Goals/);
});

test('no active household exposes selection actions without rendering live wizard controls', () => {
  const elements = new Map();
  const makeElement = () => ({
    hidden: false,
    innerHTML: 'stale',
    textContent: 'stale',
    value: 'stale',
    dataset: {},
    style: {},
    attributes: {},
    classList: {
      values: new Set(),
      toggle(name, force){
        if(force) this.values.add(name);
        else this.values.delete(name);
      },
      contains(name){ return this.values.has(name); },
    },
    setAttribute(name, value){ this.attributes[name] = String(value); },
  });
  for(const selector of [
    '#hh-view',
    '[data-hh-wizard-root]',
    '.hh-progress',
    '.hh-stepper',
    '#hh-wiz-footer',
    '#hh-menu-btn',
    '#hh-menu-pop',
    '#hh-switch',
    '#hh-rail-name',
    '#hh-progress-copy',
    '#hh-progress-percent',
    '#hh-progress-bar',
    '#hh-nav-summary-net-worth',
  ]) elements.set(selector, makeElement());
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: selector => elements.get(selector) || null,
    querySelectorAll: () => [],
  };
  try{
    const controller = createHouseholdWizardController({
      getPlan: () => ({ meta: {}, portfolio: { extraAccounts: [] } }),
      getHouseholdsDb: () => ({
        'now-household': { meta: { name: 'Now Household' } },
        'future-household': { meta: { name: 'Future Household' } },
      }),
      getActiveHouseholdId: () => null,
      isStorageBlocked: () => false,
      renderBlockedRecoverySurfaces: () => {},
      syncRecoveryControls: () => {},
      onSwitchHousehold: () => {},
      onNewHousehold: () => {},
    });
    controller.sync();

    assert.equal(elements.get('#hh-view').innerHTML, '');
    assert.equal(elements.get('#hh-wiz-footer').innerHTML, '');
    assert.equal(elements.get('#hh-wiz-footer').hidden, true);
    assert.equal(elements.get('.hh-progress').hidden, true);
    assert.equal(elements.get('.hh-stepper').hidden, true);
    assert.equal(elements.get('#hh-menu-btn').hidden, true);
    assert.equal(elements.get('#hh-menu-pop').hidden, false);
    assert.equal(elements.get('#hh-switch').value, '');
    assert.match(elements.get('#hh-switch').innerHTML, /Select household/);
    assert.match(elements.get('#hh-switch').innerHTML, /Now Household/);
    assert.match(elements.get('#hh-switch').innerHTML, /Future Household/);
    assert.equal(elements.get('#hh-rail-name').textContent, '');
    assert.equal(elements.get('[data-hh-wizard-root]').dataset.householdId, '');
    assert.equal(elements.get('[data-hh-wizard-root]').dataset.wizardStep, '');
    assert.equal(elements.get('[data-hh-wizard-root]').dataset.wizardReady, 'true');
    assert.equal(
      elements.get('[data-hh-wizard-root]').classList.contains('is-unselected'),
      true,
    );
  } finally {
    globalThis.document = originalDocument;
  }
});
