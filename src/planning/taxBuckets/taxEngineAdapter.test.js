import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateYear, attributeSleeves, sleeveBalances } from './taxEngineAdapter.js';
import { defaultPlan as plan } from '../../../engine.js';

test('taxEngineAdapter evaluates a focus year from demo-shaped plan', async () => {
  const facts = {
    filingStatus: plan.meta?.filingStatus || 'marriedFilingJointly',
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 0,
    otherIncome: 0,
  };
  const levers = {
    taxableWithdrawal: 0,
    deferredWithdrawal: 0,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const result = await evaluateYear({ plan, taxYear: 2026, facts, levers });
  assert.ok(result);
  assert.equal(result.error, undefined);
  assert.equal(typeof result.lawVersion, 'string');
  assert.equal(typeof result.ordinary?.rate, 'number');
  assert.equal(result.irmaa?.scope, 'No IRMAA table in src/tax/');
});

test('taxEngineAdapter returns null when filing status is missing', async () => {
  const result = await evaluateYear({
    plan,
    taxYear: 2026,
    facts: { filingStatus: null, wages: 0 },
    levers: { taxableWithdrawal: 0, deferredWithdrawal: 0, rothConversion: 0, rothWithdrawal: 0, qcd: 0 },
  });
  assert.equal(result, null);
});

test('taxEngineAdapter attributes incremental tax to withdrawal sleeves', async () => {
  const facts = {
    filingStatus: 'marriedFilingJointly',
    livedWithSpouse: false,
    socialSecurityBenefits: 0,
    wages: 120_000,
    otherIncome: 0,
  };
  const levers = {
    taxableWithdrawal: 0,
    deferredWithdrawal: 50_000,
    rothConversion: 0,
    rothWithdrawal: 0,
    qcd: 0,
  };
  const att = await attributeSleeves({ plan, taxYear: 2026, facts, levers });
  assert.ok(att);
  assert.equal(att.error, undefined);
  assert.equal(typeof att.incrementalTax, 'number');
  assert.equal(typeof att.byBucket?.traditional, 'number');
});

test('sleeveBalances reads portfolio fold balances', async () => {
  const caps = await sleeveBalances(plan);
  assert.equal(typeof caps.taxable, 'number');
  assert.equal(typeof caps.traditional, 'number');
  assert.equal(typeof caps.roth, 'number');
});
