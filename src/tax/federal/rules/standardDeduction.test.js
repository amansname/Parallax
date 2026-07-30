import { test } from 'node:test';
import assert from 'node:assert';
import { standardDeduction, meta } from './standardDeduction.js';

const ctx = (taxYear = 2026) => ({
  calculatedAt: '2026-06-21T12:00:00.000Z',
  runId: 'std_ded_test',
  scenarioId: 'std_ded_scenario',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
});

test('meta contract', () => {
  assert.strictEqual(meta.ruleId, 'FED_STANDARD_DEDUCTION');
  assert.ok(meta.dataSourcesRequired.includes(
    'IRS_2025_FORM_1040_STANDARD_DEDUCTION_v2.0'
  ));
  assert.ok(meta.dataSourcesRequired.includes(
    'IRS_2026_PUBLICATION_505_STANDARD_DEDUCTION_v1.0'
  ));
});

test('base standard deduction routes exact 2025 and 2026 values', () => {
  const cases = [
    [2025, 'single', 15750],
    [2025, 'marriedFilingJointly', 31500],
    [2025, 'headOfHousehold', 23625],
    [2025, 'marriedFilingSeparately', 15750],
    [2026, 'single', 16100],
    [2026, 'marriedFilingJointly', 32200],
    [2026, 'headOfHousehold', 24150],
    [2026, 'marriedFilingSeparately', 16100],
  ];
  for(const [taxYear, filingStatus, expected] of cases){
    const { result } = standardDeduction.calculate(
      { filingStatus },
      ctx(taxYear)
    );
    assert.strictEqual(
      result.standardDeduction,
      expected,
      `${taxYear} ${filingStatus}`
    );
  }
});

test('audit is serializable and carries the data source', () => {
  const { audit } = standardDeduction.calculate({ filingStatus: 'single' }, ctx());
  assert.doesNotThrow(() => JSON.stringify(audit));
  assert.ok(audit.dataSourcesUsed.includes(
    'IRS_2026_PUBLICATION_505_STANDARD_DEDUCTION_v1.0'
  ));
});

test('age/blind additions apply per check with the January 1 age convention', () => {
  const baseInput = {
    filingStatus: 'single',
    taxpayers: {
      client: {
        birthDate: '1962-01-01',
        blind: true,
      },
    },
    standardEligibility: {
      anyActiveTaxpayerCanBeClaimedAsDependent: false,
      anyActiveTaxpayerIsDualStatusAlien: false,
    },
  };
  const jan1 = standardDeduction.calculate(baseInput, ctx(2026)).result;
  assert.strictEqual(jan1.ageBlindCheckCount, 2);
  assert.strictEqual(jan1.additionalStandardDeduction, 4100);
  assert.strictEqual(jan1.standardDeduction, 20200);

  const jan2 = standardDeduction.calculate({
    ...baseInput,
    taxpayers: {
      client: {
        birthDate: '1962-01-02',
        blind: false,
      },
    },
  }, ctx(2026)).result;
  assert.strictEqual(jan2.ageBlindCheckCount, 0);
  assert.strictEqual(jan2.standardDeduction, 16100);

  for(const [taxYear, base, perCheck] of [
    [2025, 31500, 1600],
    [2026, 32200, 1650],
  ]){
    const married = standardDeduction.calculate({
      filingStatus: 'marriedFilingJointly',
      taxpayers: {
        client: {
          birthDate: '1960-06-15',
          blind: false,
        },
        spouse: {
          birthDate: '1970-06-15',
          blind: true,
        },
      },
      standardEligibility: {
        anyActiveTaxpayerCanBeClaimedAsDependent: false,
        anyActiveTaxpayerIsDualStatusAlien: false,
      },
    }, ctx(taxYear)).result;
    assert.strictEqual(married.ageBlindCheckCount, 2, `${taxYear} checks`);
    assert.strictEqual(
      married.additionalStandardDeduction,
      perCheck * 2,
      `${taxYear} married addition`
    );
    assert.strictEqual(
      married.standardDeduction,
      base + (perCheck * 2),
      `${taxYear} married total`
    );
  }
});

test('dependent-taxpayer and dual-status facts fail closed', () => {
  const baseInput = {
    filingStatus: 'single',
    taxpayers: {
      client: {
        birthDate: '1960-06-15',
        blind: false,
      },
    },
    standardEligibility: {
      anyActiveTaxpayerCanBeClaimedAsDependent: false,
      anyActiveTaxpayerIsDualStatusAlien: false,
    },
  };

  assert.throws(
    () => standardDeduction.calculate({
      ...baseInput,
      standardEligibility: {
        ...baseInput.standardEligibility,
        anyActiveTaxpayerCanBeClaimedAsDependent: true,
      },
    }, ctx()),
    /dependent standard-deduction calculation is not supported/
  );
  assert.throws(
    () => standardDeduction.calculate({
      ...baseInput,
      standardEligibility: {
        ...baseInput.standardEligibility,
        anyActiveTaxpayerIsDualStatusAlien: true,
      },
    }, ctx()),
    /dual-status standard-deduction calculation is not supported/
  );
});

test('MFS calculated facts require explicit spouse-itemizes status', () => {
  const input = {
    filingStatus: 'marriedFilingSeparately',
    modeledTaxpayer: 'client',
    taxpayers: {
      client: {
        birthDate: '1965-01-01',
        blind: false,
      },
    },
    standardEligibility: {
      anyActiveTaxpayerCanBeClaimedAsDependent: false,
      anyActiveTaxpayerIsDualStatusAlien: false,
    },
  };
  assert.throws(
    () => standardDeduction.calculate(input, ctx()),
    /spouseItemizes must be an explicit boolean/
  );
  assert.strictEqual(
    standardDeduction.calculate(
      { ...input, spouseItemizes: false },
      ctx()
    ).result.standardDeduction,
    16100
  );
  const disallowed = standardDeduction.calculate(
    { ...input, spouseItemizes: true },
    ctx()
  ).result;
  assert.strictEqual(disallowed.standardDeduction, 0);
  assert.strictEqual(disallowed.spouseItemizesDisallowance, true);
});

test('base-and-age calculates only DOB-proven age additions for supported statuses', () => {
  const cases = [
    [2025, 'single', { client: { birthDate: '1960-06-15' } }, 17750],
    [2025, 'headOfHousehold', { client: { birthDate: '1960-06-15' } }, 25625],
    [2026, 'single', { client: { birthDate: '1962-01-01' } }, 18150],
    [2026, 'headOfHousehold', { client: { birthDate: '1962-01-01' } }, 26200],
    [
      2026,
      'marriedFilingJointly',
      {
        client: { birthDate: '1950-01-01' },
        spouse: { birthDate: '1955-12-31' },
      },
      35500,
    ],
  ];
  for(const [taxYear, filingStatus, taxpayers, expected] of cases){
    const { result, audit } = standardDeduction.calculate({
      filingStatus,
      standardScope: 'base-and-age',
      taxpayers,
    }, ctx(taxYear));
    assert.strictEqual(result.standardDeduction, expected);
    assert.strictEqual(
      audit.inputsUsed.standardScope,
      'base-and-age'
    );
    assert.strictEqual(Object.hasOwn(audit.inputsUsed, 'standardEligibility'), false);
    assert.strictEqual(Object.hasOwn(audit.inputsUsed, 'spouseItemizes'), false);
    assert.ok(
      audit.calculationSteps
        .filter(step => step.step === 'age_checks')
        .every(step => !Object.hasOwn(step, 'blind'))
    );
  }

  const jan2 = standardDeduction.calculate({
    filingStatus: 'single',
    standardScope: 'base-and-age',
    taxpayers: { client: { birthDate: '1962-01-02' } },
  }, ctx(2026)).result;
  assert.strictEqual(jan2.standardDeduction, 16100);

  const retainedInactiveSpouse = standardDeduction.calculate({
    filingStatus: 'single',
    standardScope: 'base-and-age',
    taxpayers: {
      client: { birthDate: '1960-06-15' },
      spouse: {
        birthDate: '1960-06-15',
        blind: false,
        unrelatedRetainedFact: 'not-used',
      },
    },
  }, ctx(2026));
  assert.strictEqual(retainedInactiveSpouse.result.standardDeduction, 18150);
  assert.deepStrictEqual(retainedInactiveSpouse.audit.inputsUsed.taxpayers, {
    client: { birthDate: '1960-06-15' },
  });
});

test('base-and-age rejects unsupported statuses and strict-only facts', () => {
  const base = {
    filingStatus: 'single',
    standardScope: 'base-and-age',
    taxpayers: { client: { birthDate: '1960-06-15' } },
  };
  const invalidInputs = [
    { ...base, standardScope: 'unknown' },
    { ...base, standardEligibility: {} },
    { ...base, spouseItemizes: false },
    {
      ...base,
      taxpayers: { client: { birthDate: '1960-06-15', blind: false } },
    },
    {
      ...base,
      taxpayers: { client: {} },
    },
    {
      ...base,
      filingStatus: 'marriedFilingSeparately',
      modeledTaxpayer: 'client',
    },
    {
      ...base,
      filingStatus: 'qualifyingSurvivingSpouse',
    },
  ];
  for(const input of invalidInputs){
    assert.throws(
      () => standardDeduction.calculate(input, ctx()),
      /standardDeduction/
    );
  }
});

test('omitting standardScope preserves the strict calculated-facts contract', () => {
  const strict = {
    filingStatus: 'single',
    taxpayers: {
      client: {
        birthDate: '1960-06-15',
      },
    },
    standardEligibility: {
      anyActiveTaxpayerCanBeClaimedAsDependent: false,
      anyActiveTaxpayerIsDualStatusAlien: false,
    },
  };
  assert.throws(
    () => standardDeduction.calculate(strict, ctx()),
    /blind must be a boolean/
  );
});

test('bad inputs throw', () => {
  assert.throws(() => standardDeduction.calculate({ filingStatus: 'martian' }, ctx()));
  assert.throws(() => standardDeduction.calculate({}, ctx()));
});
