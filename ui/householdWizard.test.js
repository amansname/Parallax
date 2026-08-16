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
      planningAsOfYear: 2026,
      state: 'VA',
    },
    household: {
      primary: { currentAge: 55, retirementAge: 62, planEndAge: 94, employmentStatus: 'employed' },
      spouse: { currentAge: 55, retirementAge: 64, planEndAge: 101, employmentStatus: 'employed' },
      children: [],
      dependentsCount: 0,
    },
    income: {
      socialSecurity: {
        primary: { pia: 31200, claimAge: 67 },
        spouse: { pia: 24600, claimAge: 68 },
      },
      other: [{
        id: 'income-wage-1',
        typeId: 'wages',
        label: 'Client salary',
        owner: 'client',
        amount: 125000,
        startAge: 55,
        endAge: 61,
        realGrowth: 0,
        taxablePct: 1,
      }],
      pension: {
        benefitByAge: { 65: 30000 },
        base: 0,
        startAge: 65,
        colaPct: 2,
      },
    },
    savings: {
      annual: 24000,
      split: { traditional: 0.5, roth: 0.25, taxable: 0.25 },
    },
    goals: [{
      id: 'goal-travel',
      name: 'Travel',
      amount: 12000,
      startAge: 65,
      endAge: 74,
      cat: 'travel',
      area: 'travel',
      per: 'yr',
    }],
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
  netWorthPanelCategory = null,
  netWorthDraft = null,
  withoutSpouse = false,
  withoutSpouseFilingStatus = 'single',
  children = [],
  goals = null,
  familyChildrenExpanded = false,
  taxView = 'simplified',
  optionalMenuOpen = false,
  showScheduleSE = false,
  grossOnlyDistributions = false,
  planningWages = false,
  planningWagesOverridden = false,
  taxReady = true,
  partialIncome = false,
  partialTax = false,
  sources = null,
  savingsSplit = null,
} = {}){
  const value = plan();
  if(withoutSpouse){
    value.household.spouse = null;
    value.meta.spouseName = '';
    value.meta.filingStatus = withoutSpouseFilingStatus;
  }
  value.household.children = children;
  if(sources) value.income.other = sources;
  if(savingsSplit) value.savings.split = savingsSplit;
  if(goals) value.goals = goals;
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
    familyChildrenExpanded,
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
    goalsContent: '<div class="gh-page"><div data-goal-lane="goal-travel">Travel</div></div>',
  });
}

test('production wizard exposes the six approved semantic steps in order', () => {
  assert.deepEqual(
    HOUSEHOLD_WIZARD_STEPS.map(step => step.id),
    ['family', 'net-worth', 'income', 'goals', 'tax', 'summary'],
  );
});

test('Family matches the approved compact people, filing, and children contract', () => {
  const html = wizard({
    familyChildrenExpanded: true,
    children: [{ name: 'Avery Calloway', birthYear: 2012 }],
  }).render('family');
  assert.match(html, /data-hh-wizard-screen="family"/);
  assert.match(html, /Johnny Calloway/);
  assert.match(html, /Joanie Calloway/);
  assert.doesNotMatch(html, /<h1>|hh-card-head/);
  assert.match(html, /data-hh-action="remove-spouse"/);
  assert.match(html, /aria-label="Remove co-client"/);
  assert.doesNotMatch(html, /socialSecurity|Social Security|data-wizard-field="dependents"|data-wizard-field="filingStatus"|data-wizard-field="state"/);
  assert.match(html, /data-wizard-field="client\.planEndAge"/);
  assert.match(html, /data-wizard-field="spouse\.planEndAge"/);
  assert.match(html, /data-family-children-toggle/);
  assert.match(html, /data-child-row="0"/);
  assert.match(html, /data-wizard-field="children\.0\.name"/);
  assert.match(html, /data-wizard-field="children\.0\.birthYear"/);
  assert.match(html, /data-hh-action="remove-child"/);
  assert.match(html, /data-hh-action="add-child"/);
  assert.match(html, /Avery Calloway/);
  assert.match(html, /2012/);
  assert.doesNotMatch(html, /Married filing separately/);
  assert.doesNotMatch(html, /Survivor assumption/i);
});

test('Income exposes every canonical planning-income family without current-year tax fields', () => {
  const html = wizard().render('income');
  assert.match(html, /data-hh-wizard-screen="income"/);
  assert.match(html, /data-wizard-field="socialSecurity\.primary\.pia"/);
  assert.match(html, /data-wizard-field="socialSecurity\.primary\.claimAge"/);
  assert.match(html, /Annual benefit at full retirement age/);
  assert.match(html, /data-income-source-row="income-wage-1"/);
  assert.match(html, /data-wizard-field="pension\.benefitByAge\.65"/);
  assert.match(html, /data-wizard-field="savings\.annual"/);
  assert.match(html, /<option value="rental"[^>]*>Rental net income<\/option>/);
  for(const forbidden of [
    'social_security',
    'pension',
    'tax_exempt_interest',
    'ira_distribution',
    'roth_conversion',
    'short_term_capital_gain',
    'long_term_capital_gain',
  ]){
    assert.doesNotMatch(html, new RegExp(`<option value="${forbidden}"`));
  }
  assert.match(html, /data-income-tax-treatment="fully-taxable"/);
  assert.doesNotMatch(html, /data-wizard-field="source\.taxablePct"/);
  assert.doesNotMatch(html, /data-wizard-field="source\.qualifiedPct"/);
  assert.doesNotMatch(html, /<option value="undefined"/);
  assert.match(html, /125,000|125000/);
  assert.match(html, /31,200|31200/);
  assert.doesNotMatch(html, /data-tax-field=/);
});

test('Income renders only type-applicable tax attributes and preserves legacy rows visibly', () => {
  const html = wizard({
    sources: [
      {
        id: 'income-dividend', typeId: 'dividends', label: 'Dividends', owner: 'client',
        amount: 10000, startAge: 55, endAge: 99, realGrowth: 0, taxablePct: 1,
        qualifiedPct: 0.7,
      },
      {
        id: 'income-annuity', typeId: 'annuity', label: 'Annuity', owner: 'client',
        amount: 18000, startAge: 65, endAge: 99, realGrowth: 0, taxablePct: 0.6,
      },
      {
        id: 'legacy-pension', typeId: 'pension', label: 'Saved pension row', owner: 'client',
        amount: 9000, startAge: 65, endAge: 99, realGrowth: 0, taxablePct: 0.8,
      },
    ],
    savingsSplit: {
      traditional: 0.6,
      roth: 0.3,
      taxable: 0.2,
      byOwner: { client: 0.55, spouse: 0.35 },
    },
  }).render('income');
  assert.match(
    html,
    /data-income-row-id="income-dividend"[^>]*data-wizard-field="source\.qualifiedPct"|data-wizard-field="source\.qualifiedPct"[^>]*data-income-row-id="income-dividend"/,
  );
  assert.match(
    html,
    /data-income-row-id="income-annuity"[^>]*data-wizard-field="source\.taxablePct"|data-wizard-field="source\.taxablePct"[^>]*data-income-row-id="income-annuity"/,
  );
  assert.match(html, /data-income-source-row="legacy-pension"/);
  assert.match(html, /Saved type/);
  assert.match(html, /data-income-tax-treatment="saved"/);
  assert.match(html, /data-savings-allocation="sleeves" data-allocation-status="invalid"/);
  assert.match(html, /data-savings-allocation="owners" data-allocation-status="invalid"/);
});

test('Goals intake step mounts the existing canonical Goals Horizon content', () => {
  const html = wizard().render('goals');
  assert.match(html, /data-hh-wizard-screen="goals"/);
  assert.match(html, /data-goals-horizon-mount/);
  assert.match(html, /data-goal-lane="goal-travel"/);
});

test('Tax is the visible owner of filing status and residence', () => {
  const html = wizard().render('tax');
  assert.match(html, /data-wizard-scope="tax-profile" data-wizard-field="filingStatus"/);
  assert.match(html, /data-wizard-scope="tax-profile" data-wizard-field="state"/);
  assert.match(html, /data-tax-field="income\.wages\.client"/);
});

test('Family uses the dashed co-client slot and keeps children collapsed by default', () => {
  const html = wizard({
    withoutSpouse: true,
    children: [{ name: 'Stored child', birthYear: 2014 }],
  }).render('family');
  assert.equal((html.match(/data-person-owner=/g) || []).length, 1);
  assert.match(html, /data-hh-action="add-spouse"/);
  assert.match(html, /data-family-children-toggle/);
  assert.doesNotMatch(html, /data-child-row=|Stored child|data-hh-action="add-child"/);
});

test('Family derives co-client presence from the household relationship, not filing status', () => {
  const html = wizard({
    withoutSpouse: true,
    withoutSpouseFilingStatus: 'marriedFilingJointly',
  }).render('family');
  assert.equal((html.match(/data-person-owner=/g) || []).length, 1);
  assert.match(html, /data-hh-action="add-spouse"/);
  assert.doesNotMatch(html, /data-person-owner="spouse"/);
});

test('Net Worth presents the approved category workflow and canonical portfolio total', () => {
  const html = wizard().render('net-worth');
  assert.match(html, /data-hh-wizard-screen="net-worth"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="bank"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="investment"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="property"/);
  assert.match(html, /data-hh-action="net-worth-open-category" data-category-id="mortgage"/);
  assert.match(html, /\$1,450,000/);
  assert.match(html, /data-hh-action="net-worth-show-summary"/);
  assert.doesNotMatch(html, /data-account-field|data-hh-action="add-account"/);
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

  assert.doesNotMatch(rendered.render('family'), /filing status/i);
  assert.doesNotMatch(rendered.render('family'), /value="marriedFilingJointly" selected/);
  assert.match(rendered.render('tax'), /Unsupported saved filing status/);
});

test('Simplified Tax reveals taxable companions when gross distributions are entered', () => {
  const html = wizard({ grossOnlyDistributions: true }).render('tax');
  assert.match(html, /data-tax-field="income\.taxableIra"/);
  assert.match(html, /data-tax-field="income\.taxablePensions"/);
});

test('Tax shows current-return wages without presenting planning wages as return facts', () => {
  const rowSourced = wizard({ planningWages: true }).render('tax');
  assert.match(rowSourced, /value=""[\s\S]*data-tax-field="income\.wages\.client"/);
  assert.match(rowSourced, /value="450000"[\s\S]*data-tax-field="income\.wages"/);
  assert.doesNotMatch(rowSourced, /value="125000"/);
  assert.doesNotMatch(rowSourced, /From planning income|Use current-year amount/);
  assert.doesNotMatch(rowSourced, /data-income-group="wages"/);
  assert.doesNotMatch(rowSourced, /income\.wages\.client"[\s\S]*disabled/);
});

test('Tax page omits confirmation checkbox markup', () => {
  const html = wizard().render('tax');
  assert.doesNotMatch(html, /data-tax-confirmation/);
});

test('Tax page provides only the two manual IRMAA lookback input rows', () => {
  const html = wizard().render('tax');
  assert.match(html, /data-tax-input-section="irmaa-lookback"/);
  assert.match(html, /data-irmaa-tax-year="2024"/);
  assert.match(html, /data-irmaa-tax-year="2025"/);
  assert.match(html, /data-tax-field="irmaa\.lookback\.2024\.magi"/);
  assert.match(html, /data-tax-field="irmaa\.lookback\.2025\.filingStatus"/);
  assert.equal((html.match(/data-irmaa-tax-year=/g) || []).length, 2);
  assert.doesNotMatch(html, /current tier|next tier|premium year|timeline|estimate/i);
});

test('Summary remains minimal and omits the rejected status and unlock sections', () => {
  const html = wizard().render('summary');
  assert.match(html, /data-summary-metric="portfolio"/);
  assert.match(html, /data-summary-metric="income"/);
  assert.match(html, /data-summary-metric="federal-tax"/);
  assert.match(html, /data-summary-income-status="ready"/);
  assert.match(html, /data-summary-tax-status="ready"/);
  assert.match(html, /data-summary-tax-scope="FULL_1040"/);
  assert.equal((html.match(/data-summary-income-source="income-wage-1"/g) || []).length, 1);
  assert.match(html, /Client salary[\s\S]*\$125,000/);
  assert.match(html, /Client Social Security[\s\S]*\$31,200 at 67/);
  assert.equal((html.match(/data-summary-pension/g) || []).length, 1);
  assert.match(html, /Pension[\s\S]*\$30,000 at 65 · 2% COLA/);
  assert.equal((html.match(/data-summary-savings="annual"/g) || []).length, 1);
  assert.equal((html.match(/data-summary-savings="mix"/g) || []).length, 1);
  assert.match(html, /Annual savings[\s\S]*\$24,000/);
  assert.match(html, /50% traditional · 25% Roth · 25% taxable/);
  const unavailable = wizard({ taxReady: false }).render('summary');
  assert.match(unavailable, /data-summary-income-status="not-calculable"/);
  assert.match(unavailable, /data-summary-tax-status="not-calculable"/);
  assert.match(unavailable, /data-summary-tax-scope="NOT_CALCULABLE"/);
  assert.match(html, /Portfolio by tax treatment/);
  assert.match(html, /<table class="hh-summary-irmaa"/);
  assert.match(html, /<th scope="col">Item<\/th><th scope="col">Value<\/th>/);
  assert.match(html, /<tr><td>Program<\/td><td>IRMAA<\/td><\/tr>/);
  assert.match(html, /<tr><td>MAGI<\/td><td>\$218,000<\/td><\/tr>/);
  assert.match(html, /<tr><td>Current tier<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /<tr><td>Next tier<\/td><td>2<\/td><\/tr>/);
  assert.match(html, /<tr><td>To next tier<\/td><td>\$56,000<\/td><\/tr>/);
  assert.match(html, /<tr><td>Premium year<\/td><td>2028<\/td><\/tr>/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) || []).length, 6);
  assert.doesNotMatch(html, /Intake status/i);
  assert.doesNotMatch(html, /What this intake unlocks/i);
  assert.doesNotMatch(html, /planning estimate|disclosure|timeline/i);
  assert.doesNotMatch(unavailable, /data-summary-irmaa/);
});

test('Summary preserves one-time and monthly goal display semantics', () => {
  const html = wizard({
    goals: [
      { id: 'goal-once', name: 'Roof', amount: 25000, startAge: 70, endAge: 70, per: 'yr' },
      { id: 'goal-monthly', name: 'Travel', amount: 12000, startAge: 65, endAge: 75, per: 'mo' },
    ],
  }).render('summary');
  assert.match(html, /Roof[\s\S]*\$25,000 once/);
  assert.match(html, /Travel[\s\S]*\$1,000 per month/);
});

test('Summary shows available-input income and tax without incompleteness flags', () => {
  const html = wizard({
    taxReady: false,
    partialIncome: true,
    partialTax: true,
  }).render('summary');
  assert.match(html, /data-summary-income-status="partial"/);
  assert.match(html, /\$125,000/);
  assert.match(html, /data-summary-tax-status="partial"/);
  assert.match(html, /data-summary-tax-scope="available-inputs"/);
  assert.match(html, /Modeled federal tax[\s\S]*\$18,734/);
  assert.doesNotMatch(html, /more facts needed/i);
  assert.doesNotMatch(html, /additional tax facts/i);
  assert.doesNotMatch(html, /needs additional facts/i);
});

test('Summary Enter planning is available even when tax summary is not calculable', () => {
  const incomplete = wizard({ taxReady: false });
  assert.match(
    incomplete.render('summary'),
    /data-summary-tax-status="not-calculable"/,
  );
  assert.doesNotMatch(
    incomplete.footer('summary'),
    /data-tax-completion-required="true"/,
  );
  assert.doesNotMatch(incomplete.footer('summary'), /aria-disabled="true"/);
});
