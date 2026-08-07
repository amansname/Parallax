/* Integration tests: rule + composer + adapter working together.
   Run with: node --test  (Node 18+)
   Still zero dependency on engine.js — the adapter is exercised with a plain
   fixture object shaped like an engine year result. */

import { test } from 'node:test';
import assert from 'node:assert';
import { composeAnnualFederalTax } from '../federal/composers/annualFederalTax.js';
import { adaptEngineYearToTaxInput } from '../adapters/engineToTaxInput.js';
import { client1040IntakeToComposerInput } from '../adapters/client1040Intake.js';
import { rulesLedger, getRuleById, getRulesByTriggerTag } from '../core/rulesLedger.js';
import { TRIGGER_TAGS } from '../core/constants.js';
import { SPINE_LINE_IDS, LINE_STATUS } from '../core/form1040Lines.js';

const ctx = () => ({
  calculatedAt: '2026-06-14T12:00:00.000Z',
  runId: 'integration_run',
  scenarioId: 'integration_scenario',
  taxYear: 2026,
  lawVersion: '2026_FINAL',
});

function assertSpineComplete(form1040){
  for(const lineId of SPINE_LINE_IDS){
    assert.ok(form1040[lineId], `missing ${lineId}`);
    assert.ok(Object.values(LINE_STATUS).includes(form1040[lineId].status));
  }
}

test('composer emits 1040 spine; line24 equals totalFederalTax (Phase 1 shortcut)', () => {
  const input = { filingStatus: 'single', taxableOrdinaryIncome: 100000 };
  const { result, audits } = composeAnnualFederalTax(input, ctx());

  assertSpineComplete(result.form1040);
  assert.strictEqual(result.form1040.line15.status, LINE_STATUS.SUPPLIED);
  assert.strictEqual(result.form1040.line15.value, 100000);
  assert.strictEqual(result.form1040.line16.status, LINE_STATUS.CALCULATED);
  assert.strictEqual(result.form1040.line16.value, 16712);
  assert.strictEqual(result.form1040.line24.value, 16712);
  assert.strictEqual(result.totalFederalTax, 16712);
  assert.strictEqual(result.totalFederalTax, result.form1040.line24.value);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].ruleId, 'FED_ORDINARY_INCOME_TAX');
});

test('supplied line3a on full spine runs capital gains stacking (1040 line-for-line)', () => {
  const input = client1040IntakeToComposerInput({
    filingStatus: 'single',
    income: { wages: 50000, ordinaryDividends: 500, qualifiedDividends: 500 },
    deductions: { useStandard: true },
  });
  const { result, audits } = composeAnnualFederalTax(input, ctx());

  assert.strictEqual(result.form1040.line3a.value, 500);
  assert.strictEqual(result.form1040.line3b.value, 500);
  assert.strictEqual(result.form1040.line15.value, 34400);
  assert.strictEqual(result.form1040.line16.value, 3820);
  assert.strictEqual(result.totalFederalTax, 3820);
  assert.deepStrictEqual(audits.map(a => a.ruleId), [
    'FED_STANDARD_DEDUCTION',
    'FED_ORDINARY_INCOME_TAX',
    'FED_CAPITAL_GAINS_STACKING',
  ]);
});

test('standard deduction limits the qualified-dividend dollars sent to preferential stacking', () => {
  const input = client1040IntakeToComposerInput({
    filingStatus: 'single',
    income: { ordinaryDividends: 100000, qualifiedDividends: 100000 },
    deductions: { useStandard: true },
  });
  const { result } = composeAnnualFederalTax(input, ctx());

  assert.strictEqual(result.form1040.line15.value, 83900);
  assert.strictEqual(result.incomeTaxComponents.ordinaryIncomeTax, 0);
  assert.strictEqual(result.incomeTaxComponents.preferentialIncomeTax, 5167.50);
  assert.strictEqual(result.form1040.line16.value, 5167.50);
});

test('supplied line7a on full spine runs capital gains stacking (1040 line-for-line)', () => {
  const input = client1040IntakeToComposerInput({
    filingStatus: 'single',
    income: { wages: 50000, capitalGain: 1000 },
    deductions: { useStandard: true },
  });
  const { result, audits } = composeAnnualFederalTax(input, ctx());

  assert.strictEqual(result.form1040.line7a.value, 1000);
  assert.strictEqual(result.form1040.line15.value, 34900);
  assert.strictEqual(result.form1040.line16.value, 3820);
  assert.strictEqual(result.totalFederalTax, 3820);
  assert.deepStrictEqual(audits.map(a => a.ruleId), [
    'FED_STANDARD_DEDUCTION',
    'FED_ORDINARY_INCOME_TAX',
    'FED_CAPITAL_GAINS_STACKING',
  ]);
});

test('capital gains stacks through line16 and line24', () => {
  const input = {
    filingStatus: 'single',
    taxableOrdinaryIncome: 49000,
    capitalGains: {
      netLongTermCapitalGains: 1000,
      qualifiedDividends: 0,
    },
  };
  const { result, audits } = composeAnnualFederalTax(input, ctx());

  assert.strictEqual(result.form1040.line15.value, 50000);
  assert.strictEqual(result.form1040.line7a.value, 1000);
  assert.strictEqual(result.form1040.line16.value, 5714.50);
  assert.strictEqual(result.totalFederalTax, 5714.50);
  assert.deepStrictEqual(audits.map(a => a.ruleId), [
    'FED_ORDINARY_INCOME_TAX',
    'FED_CAPITAL_GAINS_STACKING',
  ]);
});

test('SS and IRA wire through spine and change line15 and total tax', () => {
  const input = {
    filingStatus: 'marriedFilingJointly',
    supplied: { line1z: 38000, line12e: 31500 },
    socialSecurity: {
      socialSecurityBenefits: 10000,
      otherIncome: 38000,
      taxExemptInterest: 2500,
      excludedIncomeAddBacks: 0,
      adjustments: 0,
      livedWithSpouse: true,
    },
    traditionalIra: {
      modifiedAgi: 130000,
      contributionAmount: 7500,
      age: 40,
      taxableCompensation: 100000,
      taxpayerCoveredByWorkplacePlan: true,
      spouseCoveredByWorkplacePlan: false,
      livedWithSpouse: true,
    },
  };
  const { result, audits } = composeAnnualFederalTax(input, ctx());

  assert.strictEqual(result.form1040.line6b.value, 6275);
  assert.strictEqual(result.form1040.line10.value, 7130);
  assert.strictEqual(result.form1040.line15.value, 5645);
  assert.strictEqual(result.form1040.line16.value, 564.50);
  assert.strictEqual(result.totalFederalTax, 564.50);
  assert.deepStrictEqual(audits.map(a => a.ruleId), [
    'FED_TRADITIONAL_IRA_DEDUCTIBILITY',
    'FED_TAXABLE_SOCIAL_SECURITY',
    'FED_ORDINARY_INCOME_TAX',
  ]);
});

test('credits and other taxes are DEFERRED until Phase 3', () => {
  const { result } = composeAnnualFederalTax(
    { filingStatus: 'single', taxableOrdinaryIncome: 50000 },
    ctx()
  );
  assert.strictEqual(result.form1040.line17.status, LINE_STATUS.DEFERRED);
  assert.strictEqual(result.form1040.line19.status, LINE_STATUS.DEFERRED);
  assert.strictEqual(result.form1040.line20.status, LINE_STATUS.DEFERRED);
  assert.strictEqual(result.form1040.line23.status, LINE_STATUS.DEFERRED);
});

test('adapter reshapes an engine-like year fact bundle into the narrow tax input', () => {
  const engineYearResult = {
    age: 67, balance: 1_500_000, withdrawal: 80000,
    filingStatus: 'marriedFilingJointly',
    taxableOrdinaryIncome: 180000,
  };
  const taxInput = adaptEngineYearToTaxInput(engineYearResult);
  assert.deepStrictEqual(taxInput, { filingStatus: 'marriedFilingJointly', taxableOrdinaryIncome: 180000 });

  const { result } = composeAnnualFederalTax(taxInput, ctx());
  assert.strictEqual(result.totalFederalTax, 29024);
  assert.strictEqual(result.form1040.line24.value, 29024);
});

test('adapter throws when a required fact is missing (no silent default)', () => {
  assert.throws(() => adaptEngineYearToTaxInput({ filingStatus: 'single' }));
  assert.throws(() => adaptEngineYearToTaxInput({ taxableOrdinaryIncome: 100000 }));
});

test('every ledger rule satisfies the rule contract', () => {
  assert.ok(rulesLedger.length >= 1);
  for(const rule of rulesLedger){
    assert.strictEqual(typeof rule.calculate, 'function');
    assert.strictEqual(typeof rule.validate, 'function');
    assert.ok(rule.meta && typeof rule.meta.ruleId === 'string');
    assert.ok(Array.isArray(rule.meta.triggerTags));
  }
});

test('every ledger rule uses only controlled trigger tags', () => {
  for(const rule of rulesLedger){
    for(const tag of rule.meta.triggerTags){
      assert.ok(TRIGGER_TAGS.includes(tag),
        `rule ${rule.meta.ruleId} uses unknown trigger tag: ${tag}`);
    }
  }
});

test('ledger is queryable by id and trigger tag', () => {
  assert.ok(getRuleById('FED_ORDINARY_INCOME_TAX'));
  assert.ok(getRuleById('FED_TRADITIONAL_IRA_DEDUCTIBILITY'));
  assert.ok(getRuleById('FED_CAPITAL_GAINS_STACKING'));
  assert.ok(getRuleById('FED_TAXABLE_SOCIAL_SECURITY'));
  assert.strictEqual(getRuleById('NOPE'), null);
  const byTag = getRulesByTriggerTag('bracket_calculation');
  assert.ok(byTag.some(r => r.meta.ruleId === 'FED_ORDINARY_INCOME_TAX'));
  assert.ok(byTag.some(r => r.meta.ruleId === 'FED_CAPITAL_GAINS_STACKING'));
  assert.deepStrictEqual(getRulesByTriggerTag('no_such_tag'), []);
});

test('no tax module file imports engine.js', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for(const name of readdirSync(dir)){
      const full = join(dir, name);
      if(statSync(full).isDirectory()){ walk(full); continue; }
      if(!full.endsWith('.js')) continue;
      const src = readFileSync(full, 'utf8');
      if(/(?:from|import|require)\s*\(?\s*['"][^'"]*engine\.js['"]/.test(src)) offenders.push(full);
    }
  };
  walk(root);
  assert.deepStrictEqual(offenders, [], `tax files referencing engine.js: ${offenders.join(', ')}`);
});
