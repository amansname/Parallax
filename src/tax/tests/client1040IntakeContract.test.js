import { test } from 'node:test';
import assert from 'node:assert';
import {
  CLIENT_1040_COMPATIBILITY_MODES,
  CLIENT_1040_FIELD_DISPOSITIONS,
  CLIENT_1040_INTAKE_CONTRACT_ID,
  CLIENT_1040_INTAKE_CONTRACT_VERSION,
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
  CLIENT_1040_LIMITATIONS,
  CLIENT_1040_SUPPORTED_TAX_YEARS,
  deriveAccountTaxTreatment,
  describeClient1040IntakeContract,
  validateClient1040Contract,
} from '../core/client1040IntakeContract.js';
import { client1040IntakeToComposerInput } from '../adapters/client1040Intake.js';
import { validateClient1040Intake } from '../adapters/client1040IntakeValidate.js';
import {
  calculateAnnualFederalTaxLiability,
  runClient1040Intake,
} from '../annual1040.js';
import { composeAnnualFederalTax } from '../federal/composers/annualFederalTax.js';

const context = (taxYear = 2026) => ({
  calculatedAt: '2026-07-28T12:00:00.000Z',
  runId: 'client_contract',
  scenarioId: 'contract',
  taxYear,
  lawVersion: `${taxYear}_FINAL`,
});

function completeCanonicalIncome(overrides = {}){
  return {
    wages: 0,
    taxableInterest: 0,
    taxExemptInterest: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    iraDistributions: 0,
    taxableIra: 0,
    rothConversion: 0,
    pensionAmount: 0,
    taxablePensions: 0,
    socialSecurityBenefits: 0,
    taxableSS: 0,
    socialSecurity: { mode: 'supplied-form1040-lines' },
    otherIncome: 0,
    ...overrides,
  };
}

function canonical(overrides = {}){
  return {
    schemaVersion: CLIENT_1040_INTAKE_SCHEMA_VERSION,
    taxYear: 2026,
    filingStatus: 'single',
    returnScope: { modeledTaxpayer: 'client' },
    taxpayers: {
      client: {},
    },
    income: completeCanonicalIncome({ wages: 75000 }),
    scheduleD: {
      mode: 'supplied-form1040-line7',
      amount: 0,
    },
    adjustments: {
      mode: 'supplied-line10',
      amount: 0,
    },
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 15750,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    ...overrides,
  };
}

function validationCountedCanonical(){
  let labelReads = 0;
  const intake = canonical();
  Object.defineProperty(intake, 'label', {
    enumerable: true,
    get(){
      labelReads += 1;
      return 'validation-counted';
    },
  });
  return {
    intake,
    labelReads: () => labelReads,
  };
}

function codes(intake, taxContext = context(intake?.taxYear ?? 2026)){
  return validateClient1040Intake(intake, taxContext).errors.map(error => error.code);
}

function contractCodes(intake, taxContext = context(intake?.taxYear ?? 2026)){
  return validateClient1040Contract(intake, taxContext).errors.map(error => error.code);
}

test('contract descriptor separates canonical and unversioned compatibility modes', () => {
  const current = describeClient1040IntakeContract(canonical());
  const legacy = describeClient1040IntakeContract({
    filingStatus: 'single',
    deductions: { useStandard: true },
  });

  assert.strictEqual(current.id, CLIENT_1040_INTAKE_CONTRACT_ID);
  assert.strictEqual(current.contractVersion, CLIENT_1040_INTAKE_CONTRACT_VERSION);
  assert.strictEqual(current.compatibilityMode, CLIENT_1040_COMPATIBILITY_MODES.CANONICAL);
  assert.strictEqual(current.taxYear, 2026);
  assert.strictEqual(current.expectedLawVersion, '2026_FINAL');
  assert.strictEqual(legacy.sourceSchemaVersion, null);
  assert.strictEqual(legacy.sourceSchemaVersionPresent, false);
  assert.strictEqual(
    legacy.compatibilityMode,
    CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED
  );
  assert.deepStrictEqual(CLIENT_1040_SUPPORTED_TAX_YEARS, [2025, 2026]);
  assert.ok(Object.isFrozen(CLIENT_1040_FIELD_DISPOSITIONS));
  for(const invalidVersion of [null, undefined, '1']){
    const versioned = { ...canonical(), schemaVersion: invalidVersion };
    assert.strictEqual(
      describeClient1040IntakeContract(versioned).compatibilityMode,
      CLIENT_1040_COMPATIBILITY_MODES.UNSUPPORTED
    );
    assert.ok(codes(versioned).includes('UNSUPPORTED_INTAKE_SCHEMA_VERSION'));
  }
});

test('pipeline receipt preserves modeled return and source-mode provenance', () => {
  const intake = canonical({
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 1000,
      confirmations: {
        shortTermNetIsZero: true,
        noCapitalLossCarryovers: true,
        line18NotApplicable: true,
        line19NotApplicable: true,
        form4952Line4gIsZeroOrNotApplicable: true,
      },
    },
  });
  const pipeline = runClient1040Intake(intake, context());

  assert.strictEqual(pipeline.report.contract.selections.modeledTaxpayer, 'client');
  assert.strictEqual(pipeline.report.contract.selections.schedule1AMode, 'supplied-line13b');
  assert.strictEqual(pipeline.report.contract.selections.scheduleDMode, 'simple-net-long-term');
  assert.strictEqual(pipeline.report.contract.selections.simpleScheduleDConfirmed, true);
  assert.deepStrictEqual(pipeline.report.contract.limitations, [
    CLIENT_1040_LIMITATIONS.SIMPLE_SCHEDULE_D_ONLY,
  ]);
  assert.deepStrictEqual(pipeline.report.limitations, pipeline.report.contract.limitations);
  assert.deepStrictEqual(
    pipeline.annual1040Result.limitations,
    pipeline.report.contract.limitations
  );
  assert.ok(pipeline.validation.warnings
    .some(entry => entry.code === 'SIMPLE_SCHEDULE_D_ONLY'));
  assert.deepStrictEqual(
    pipeline.annual1040Result.contract,
    pipeline.report.contract
  );
});

test('full and compact pipelines validate each intake once before mapping', () => {
  const standalone = validationCountedCanonical();
  assert.strictEqual(
    client1040IntakeToComposerInput(standalone.intake).filingStatus,
    'single'
  );
  assert.strictEqual(standalone.labelReads(), 1);

  const full = validationCountedCanonical();
  const fullResult = runClient1040Intake(full.intake, context());
  assert.ok(Number.isFinite(fullResult.result.form1040.line24.value));
  assert.strictEqual(full.labelReads(), 1);

  const compact = validationCountedCanonical();
  assert.strictEqual(
    calculateAnnualFederalTaxLiability(compact.intake, context()),
    fullResult.result.form1040.line24.value
  );
  assert.strictEqual(compact.labelReads(), 1);
});

test('canonical intake requires the supported year and exact context year', () => {
  assert.deepStrictEqual(codes(canonical()), []);
  assert.ok(codes(canonical({ taxYear: undefined })).includes('UNSUPPORTED_TAX_YEAR'));
  assert.ok(codes(canonical({ taxYear: 2027 }), context(2027))
    .includes('UNSUPPORTED_TAX_YEAR'));
  assert.ok(codes(canonical({ taxYear: 2025 }), context(2026))
    .includes('TAX_YEAR_CONTEXT_MISMATCH'));
  assert.ok(codes({ ...canonical(), schemaVersion: 99 })
    .includes('UNSUPPORTED_INTAKE_SCHEMA_VERSION'));
  assert.ok(codes(canonical(), {
    ...context(),
    lawVersion: '2025_FINAL',
  }).includes('LAW_VERSION_CONTEXT_MISMATCH'));
  assert.ok(codes({
    ...canonical(),
    lawVersion: '2025_FINAL',
  }).includes('INTAKE_LAW_VERSION_MISMATCH'));
});

test('canonical intake rejects null and non-finite numbers instead of treating them as absent', () => {
  assert.ok(codes(canonical({
    income: { wages: null },
  })).includes('NULL_NOT_ALLOWED'));
  assert.ok(codes(canonical({
    income: { wages: Number.NaN },
  })).includes('NONFINITE_NUMBER'));
  assert.ok(codes(canonical({
    income: { wages: Number.POSITIVE_INFINITY },
  })).includes('NONFINITE_NUMBER'));
  assert.ok(codes(canonical({
    income: { taxableInterest: '500' },
  })).includes('INVALID_NONNEGATIVE_AMOUNT'));
  assert.ok(codes(canonical({
    income: { taxableInterst: 500 },
  })).includes('UNKNOWN_CANONICAL_FIELD'));
});

test('every finalized wizard income field is preserved by canonical mapping', () => {
  const intake = canonical({
    income: {
      wages: 100000,
      taxableInterest: 500,
      taxExemptInterest: 250,
      ordinaryDividends: 1000,
      qualifiedDividends: 600,
      iraDistributions: 12000,
      taxableIra: 7000,
      rothConversion: 3000,
      pensionAmount: 9000,
      taxablePensions: 8000,
      socialSecurityBenefits: 20000,
      taxableSS: 5000,
      socialSecurity: { mode: 'supplied-form1040-lines' },
      otherIncome: 400,
    },
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 2000,
      confirmations: {
        shortTermNetIsZero: true,
        noCapitalLossCarryovers: true,
        line18NotApplicable: true,
        line19NotApplicable: true,
        form4952Line4gIsZeroOrNotApplicable: true,
      },
    },
  });
  assert.deepStrictEqual(codes(intake), []);

  const input = client1040IntakeToComposerInput(intake);
  assert.strictEqual(input.supplied.line1z, 100000);
  assert.strictEqual(input.supplied.line2a, 250);
  assert.strictEqual(input.supplied.line2b, 500);
  assert.strictEqual(input.supplied.line3a, 600);
  assert.strictEqual(input.supplied.line3b, 1000);
  assert.strictEqual(input.supplied.line4a, 12000);
  assert.strictEqual(input.supplied.line4b, 10000);
  assert.strictEqual(input.supplied.line5a, 9000);
  assert.strictEqual(input.supplied.line5b, 8000);
  assert.strictEqual(input.supplied.line6a, 20000);
  assert.strictEqual(input.supplied.line6b, 5000);
  assert.strictEqual(input.supplied.line8, 400);

  const pipeline = runClient1040Intake(intake, context());
  assert.strictEqual(pipeline.result.form1040.line2a.value, 250);
  assert.strictEqual(pipeline.result.form1040.line4b.value, 10000);
  assert.ok(pipeline.report.captured
    .some(row => row.intakePath === 'income.rothConversion' && row.value === 3000));
});

test('line 4b components require explicit completeness instead of assuming missing zero', () => {
  for(const income of [
    { taxableIra: 7000 },
    { rothConversion: 3000 },
  ]){
    const intake = canonical({ income });
    assert.ok(codes(intake).includes('LINE4B_COMPONENTS_INCOMPLETE'));
    assert.throws(
      () => client1040IntakeToComposerInput(intake),
      error => error.validation.errors
        .some(entry => entry.code === 'LINE4B_COMPONENTS_INCOMPLETE')
    );
  }

  const explicitZero = canonical({
    income: { taxableIra: 0, rothConversion: 3000 },
  });
  assert.deepStrictEqual(codes(explicitZero), []);
  assert.strictEqual(
    client1040IntakeToComposerInput(explicitZero).supplied.line4b,
    3000
  );
});

test('canonical adjustments preserve supplied-total versus IRA-component provenance', () => {
  const total = canonical({
    adjustments: { mode: 'supplied-line10', amount: 2500 },
  });
  assert.deepStrictEqual(codes(total), []);
  assert.strictEqual(
    client1040IntakeToComposerInput(total).supplied.line10,
    2500
  );

  const iraComponent = canonical({
    adjustments: {
      mode: 'supplied-traditional-ira-deduction',
      traditionalIraDeduction: 1800,
    },
  });
  assert.deepStrictEqual(codes(iraComponent), []);
  const pipeline = runClient1040Intake(iraComponent, context());
  assert.deepStrictEqual(pipeline.input.adjustmentComponents, {
    traditionalIraDeduction: 1800,
  });
  assert.strictEqual(pipeline.input.supplied?.line10, undefined);
  assert.strictEqual(pipeline.result.form1040.line10.value, 1800);
  assert.strictEqual(
    pipeline.report.contract.selections.adjustmentMode,
    'supplied-traditional-ira-deduction'
  );
  assert.ok(pipeline.report.captured.some(row =>
    row.intakePath === 'adjustments.traditionalIraDeduction'
      && row.value === 1800));

  assert.ok(codes(canonical({
    adjustments: {
      mode: 'supplied-traditional-ira-deduction',
      traditionalIraDeduction: 1800,
      amount: 1800,
    },
  })).includes('ADJUSTMENT_SOURCE_CONFLICT'));
});

test('canonical IRA engine mode and its facts remain fail-closed', () => {
  const engineMode = canonical({
    adjustments: {
      mode: 'Engine rule from MAGI',
      magi: 100000,
      iraCovered1: true,
      iraCovered2: false,
    },
  });
  assert.deepStrictEqual(
    contractCodes(engineMode),
    ['INVALID_ADJUSTMENTS_MODE']
  );
  assert.throws(
    () => client1040IntakeToComposerInput(engineMode),
    error => error.validation.errors
      .some(entry => entry.code === 'INVALID_ADJUSTMENTS_MODE')
  );

  for(const adjustments of [
    {
      mode: 'supplied-line10',
      amount: 0,
      magi: 100000,
      iraCovered1: true,
      iraCovered2: false,
    },
    {
      mode: 'supplied-traditional-ira-deduction',
      traditionalIraDeduction: 0,
      magi: 100000,
      iraCovered1: true,
      iraCovered2: false,
    },
  ]){
    const intake = canonical({ adjustments });
    const validation = validateClient1040Contract(intake, context());
    const conflict = validation.errors.find(
      entry => entry.code === 'ADJUSTMENT_SOURCE_CONFLICT'
    );
    assert.ok(conflict);
    assert.deepStrictEqual(conflict.details.unexpected, [
      'magi',
      'iraCovered1',
      'iraCovered2',
    ]);
    assert.throws(
      () => client1040IntakeToComposerInput(intake),
      error => error.validation.errors
        .some(entry => entry.code === 'ADJUSTMENT_SOURCE_CONFLICT')
    );
  }
});

test('canonical deduction method and source are explicit and mutually exclusive', () => {
  assert.ok(codes(canonical({
    deductions: { source: 'calculated' },
  })).includes('MISSING_DEDUCTION_METHOD'));
  assert.ok(codes(canonical({
    deductions: { method: 'standard' },
  })).includes('MISSING_DEDUCTION_SOURCE'));
  assert.ok(codes(canonical({
    deductions: {
      method: 'standard',
      source: 'calculated',
      line12e: 20000,
    },
  })).includes('DEDUCTION_SOURCE_CONFLICT'));
  assert.ok(codes(canonical({
    deductions: {
      method: 'itemized',
      source: 'supplied-line12e',
      line12e: 0,
      itemized: {},
    },
  })).includes('DEDUCTION_SOURCE_CONFLICT'));
  assert.ok(codes({
    ...canonical({
      taxpayers: { client: {} },
      deductions: {
        method: 'standard',
        source: 'supplied-line12e',
        line12e: 20000,
      },
    }),
    supplied: { line12e: 21000 },
  }).includes('DEDUCTION_SOURCE_CONFLICT'));

  const suppliedZero = canonical({
    taxpayers: { client: {} },
    deductions: {
      method: 'itemized',
      source: 'supplied-line12e',
      line12e: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(suppliedZero), []);
  const input = client1040IntakeToComposerInput(suppliedZero);
  assert.strictEqual(input.supplied.line12e, 0);
  assert.strictEqual(input.supplied.line13b, 0);
});

test('canonical source precedence rejects legacy line 1, 10, 12e, 13b, and 23 overrides', () => {
  assert.ok(codes({
    ...canonical(),
    supplied: { line1z: 999999 },
  }).includes('LEGACY_ALIAS_CONTAINER_IN_CANONICAL'));

  assert.ok(codes(canonical({
    adjustments: {
      mode: 'supplied-line10',
      amount: 0,
      total: 1000,
    },
  })).includes('LINE10_SOURCE_CONFLICT'));

  assert.ok(codes({
    ...canonical({
      taxpayers: { client: {} },
      deductions: {
        method: 'standard',
        source: 'supplied-line12e',
        line12e: 20000,
        schedule1A: { mode: 'supplied-line13b', amount: 0 },
      },
    }),
    supplied: { line12e: 21000, line13b: 6000 },
  }).includes('DEDUCTION_SOURCE_CONFLICT'));
  assert.ok(codes({
    ...canonical({
      taxpayers: { client: {} },
      deductions: {
        method: 'standard',
        source: 'supplied-line12e',
        line12e: 20000,
        schedule1A: { mode: 'supplied-line13b', amount: 0 },
      },
    }),
    supplied: { line12e: 21000, line13b: 6000 },
  }).includes('SCHEDULE_1A_SOURCE_CONFLICT'));

  const scheduleSe = canonical({
    scheduleSE: [{
      taxpayerOwner: 'client',
      netEarningsFromSelfEmployment: 10000,
      socialSecurityWagesAndTips: 0,
      socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    }],
    schedule2: {
      netInvestmentIncomeTax: 0,
      additionalMedicareTax: 0,
      otherPartIITaxes: 0,
    },
    passThrough: { line23: 0 },
  });
  assert.ok(codes(scheduleSe).includes('SCHEDULE_2_SOURCE_CONFLICT'));
});

test('legacy unversioned intake remains valid and preserves explicit zero', () => {
  const legacy = {
    filingStatus: 'single',
    income: { wages: 0 },
    deductions: { useStandard: true, additional: 0 },
    passThrough: { line23: 0 },
  };
  const validation = validateClient1040Intake(legacy);
  const input = client1040IntakeToComposerInput(legacy);

  assert.deepStrictEqual(validation.errors, []);
  assert.strictEqual(
    validation.contract.compatibilityMode,
    CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED
  );
  assert.strictEqual(input.supplied.line1z, 0);
  assert.strictEqual(input.supplied.line13b, 0);
  assert.strictEqual(input.passThrough.line23, 0);
});

test('legacy full-income composition without a deductions object keeps the default standard deduction', () => {
  const composition = composeAnnualFederalTax({
    filingStatus: 'single',
    supplied: { line1z: 50000 },
  }, context());
  assert.strictEqual(composition.result.form1040.line12e.status, 'CALCULATED');
  assert.strictEqual(composition.result.form1040.line12e.value, 16100);
});

test('legacy compatibility keeps null-as-absent while still rejecting non-finite values', () => {
  const nullWages = {
    filingStatus: 'single',
    income: { wages: null },
    deductions: { useStandard: true },
  };
  const infiniteLine23 = {
    filingStatus: 'single',
    income: { wages: 50000 },
    deductions: { useStandard: true },
    passThrough: { line23: Number.POSITIVE_INFINITY },
  };

  assert.deepStrictEqual(validateClient1040Intake(nullWages).errors, []);
  assert.ok(validateClient1040Intake(infiniteLine23).errors
    .some(error => error.code === 'INVALID_PASS_THROUGH'));
  assert.strictEqual(
    runClient1040Intake(nullWages, context()).result.form1040.line1z.status,
    'DEFERRED'
  );
  assert.throws(() => runClient1040Intake(infiniteLine23, context()));
});

test('canonical errors always gate composition while legacy strict:false remains reportable', () => {
  const invalid = canonical({
    deductions: { source: 'calculated' },
  });
  assert.throws(
    () => runClient1040Intake(invalid, context()),
    error => error.validation.errors.some(entry => entry.code === 'MISSING_DEDUCTION_METHOD')
  );
  assert.throws(
    () => runClient1040Intake(invalid, context(), { strict: false }),
    error => error.validation.errors
      .some(entry => entry.code === 'MISSING_DEDUCTION_METHOD')
  );

  const aliasOverride = {
    ...canonical(),
    supplied: { line1z: 999999 },
  };
  assert.throws(
    () => runClient1040Intake(aliasOverride, context(), { strict: false }),
    error => error.validation.errors
      .some(entry => entry.code === 'LEGACY_ALIAS_CONTAINER_IN_CANONICAL')
  );
  assert.throws(
    () => client1040IntakeToComposerInput(aliasOverride),
    error => error.validation.errors
      .some(entry => entry.code === 'LEGACY_ALIAS_CONTAINER_IN_CANONICAL')
  );

  const unconfirmedScheduleD = canonical({
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 1000,
      confirmations: {
        shortTermNetIsZero: false,
        noCapitalLossCarryovers: true,
        line18NotApplicable: true,
        line19NotApplicable: true,
        form4952Line4gIsZeroOrNotApplicable: true,
      },
    },
  });
  assert.throws(
    () => runClient1040Intake(
      unconfirmedScheduleD,
      context(),
      { strict: false }
    ),
    error => error.validation.errors
      .some(entry => entry.code === 'MISSING_SIMPLE_SCHEDULE_D_CONFIRMATION')
  );
  assert.throws(
    () => client1040IntakeToComposerInput(unconfirmedScheduleD),
    error => error.validation.errors
      .some(entry => entry.code === 'MISSING_SIMPLE_SCHEDULE_D_CONFIRMATION')
  );

  const legacyInvalid = {
    filingStatus: 'single',
    income: { ordinaryDividends: 100, qualifiedDividends: 200 },
    deductions: { useStandard: true },
  };
  const reported = runClient1040Intake(
    legacyInvalid,
    context(),
    { strict: false }
  );
  assert.ok(reported.validation.errors
    .some(entry => entry.code === 'QD_EXCEEDS_ORDINARY'));
  assert.strictEqual(
    reported.report.contract.compatibilityMode,
    CLIENT_1040_COMPATIBILITY_MODES.LEGACY_UNVERSIONED
  );
});

test('MFS requires one modeled taxpayer and spouse-itemizes evidence for calculated standard', () => {
  const base = canonical({
    filingStatus: 'marriedFilingSeparately',
    returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
    taxpayers: {
      client: { birthDate: '1955-01-01', blind: false },
      spouse: { birthDate: '1957-02-01', blind: false },
    },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardEligibility: {
        anyActiveTaxpayerCanBeClaimedAsDependent: false,
        anyActiveTaxpayerIsDualStatusAlien: false,
      },
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(base), []);
  const calculated = runClient1040Intake(base, context());
  assert.strictEqual(calculated.result.form1040.line12e.status, 'CALCULATED');
  assert.strictEqual(calculated.result.form1040.line12e.value, 17750);
  assert.strictEqual(calculated.result.form1040.line15.value, 57250);

  assert.ok(codes({
    ...base,
    returnScope: { modeledTaxpayer: 'jointReturn', spouseItemizes: false },
  }).includes('MFS_MODELED_TAXPAYER_REQUIRED'));
  assert.ok(codes({
    ...base,
    returnScope: { modeledTaxpayer: 'client' },
  }).includes('MFS_SPOUSE_ITEMIZES_REQUIRED'));
  assert.ok(codes({
    ...base,
    returnScope: { modeledTaxpayer: 'client', spouseItemizes: true },
  }).includes('MFS_STANDARD_DEDUCTION_NOT_ALLOWED'));
});

test('calculated standard deduction never assumes missing age or blindness facts', () => {
  assert.ok(codes(canonical({
    taxpayers: { client: { blind: false } },
    deductions: {
      method: 'standard',
      source: 'calculated',
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  })).includes('MISSING_TAXPAYER_BIRTH_DATE'));
  assert.ok(codes(canonical({
    taxpayers: { client: { birthDate: '1960-06-15' } },
    deductions: {
      method: 'standard',
      source: 'calculated',
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  })).includes('MISSING_TAXPAYER_BLIND_STATUS'));

  const supplied = canonical({
    taxpayers: { client: {} },
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 20000,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(supplied), []);
});

test('canonical calculated standard deduction blocks dependent and dual-status cases', () => {
  const base = canonical({
    taxpayers: {
      client: {
        birthDate: '1960-06-15',
        blind: false,
      },
    },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardEligibility: {
        anyActiveTaxpayerCanBeClaimedAsDependent: false,
        anyActiveTaxpayerIsDualStatusAlien: false,
      },
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  const cases = [
    {
      field: 'anyActiveTaxpayerCanBeClaimedAsDependent',
      code: 'DEPENDENT_STANDARD_DEDUCTION_DEFERRED',
    },
    {
      field: 'anyActiveTaxpayerIsDualStatusAlien',
      code: 'DUAL_STATUS_STANDARD_DEDUCTION_DEFERRED',
    },
  ];

  for(const { field, code } of cases){
    const intake = {
      ...base,
      deductions: {
        ...base.deductions,
        standardEligibility: {
          ...base.deductions.standardEligibility,
          [field]: true,
        },
      },
    };
    assert.ok(contractCodes(intake).includes(code));
    assert.ok(codes(intake).includes(code));
    assert.throws(
      () => runClient1040Intake(intake, context(), { strict: false }),
      error => error.validation.errors.some(entry => entry.code === code)
    );
  }
});

test('base-and-age calculates only DOB-proven standard-deduction amounts', () => {
  const single = canonical({
    taxpayers: {
      client: { birthDate: '1960-06-15' },
    },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(single), []);
  const singleInput = client1040IntakeToComposerInput(single);
  assert.strictEqual(singleInput.deductions.standardScope, 'base-and-age');
  assert.ok(!Object.hasOwn(singleInput.supplied, 'line12e'));
  const singlePipeline = runClient1040Intake(single, context());
  assert.strictEqual(singlePipeline.result.form1040.line12e.status, 'CALCULATED');
  assert.strictEqual(singlePipeline.result.form1040.line12e.value, 18150);

  const joint = canonical({
    filingStatus: 'marriedFilingJointly',
    returnScope: { modeledTaxpayer: 'jointReturn' },
    taxpayers: {
      client: { birthDate: '1950-01-01' },
      spouse: { birthDate: '1955-12-31' },
    },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(joint), []);
  assert.strictEqual(
    runClient1040Intake(joint, context()).result.form1040.line12e.value,
    35500
  );
});

test('base-and-age rejects incompatible statuses, sources, and strict facts', () => {
  const base = canonical({
    taxpayers: {
      client: { birthDate: '1960-06-15' },
    },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardScope: 'base-and-age',
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });

  const cases = [
    {
      intake: {
        ...base,
        deductions: {
          ...base.deductions,
          source: 'supplied-line12e',
          line12e: 0,
        },
      },
      code: 'DEDUCTION_SOURCE_CONFLICT',
    },
    {
      intake: {
        ...base,
        deductions: {
          ...base.deductions,
          method: 'itemized',
        },
      },
      code: 'DEDUCTION_SOURCE_CONFLICT',
    },
    {
      intake: {
        ...base,
        deductions: {
          ...base.deductions,
          standardEligibility: {
            anyActiveTaxpayerCanBeClaimedAsDependent: false,
            anyActiveTaxpayerIsDualStatusAlien: false,
          },
        },
      },
      code: 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
    },
    {
      intake: {
        ...base,
        taxpayers: {
          client: { ...base.taxpayers.client, blind: false },
        },
      },
      code: 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
    },
    {
      intake: {
        ...base,
        returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
      },
      code: 'STANDARD_DEDUCTION_SCOPE_CONFLICT',
    },
    {
      intake: {
        ...base,
        deductions: { ...base.deductions, standardScope: null },
      },
      code: 'INVALID_STANDARD_DEDUCTION_SCOPE',
    },
    {
      intake: {
        ...base,
        taxpayers: { client: {} },
      },
      code: 'MISSING_TAXPAYER_BIRTH_DATE',
    },
    {
      intake: {
        ...base,
        filingStatus: 'marriedFilingSeparately',
        returnScope: { modeledTaxpayer: 'client' },
      },
      code: 'BASE_AND_AGE_STANDARD_DEDUCTION_FILING_STATUS_UNSUPPORTED',
    },
    {
      intake: {
        ...base,
        filingStatus: 'qualifyingSurvivingSpouse',
      },
      code: 'BASE_AND_AGE_STANDARD_DEDUCTION_FILING_STATUS_UNSUPPORTED',
    },
  ];

  for(const { intake, code } of cases){
    assert.ok(contractCodes(intake).includes(code), code);
    assert.throws(
      () => runClient1040Intake(intake, context(), { strict: false }),
      error => error.validation.errors.some(entry => entry.code === code),
      code
    );
  }

  const strict = canonical({
    taxpayers: { client: { birthDate: '1960-06-15' } },
    deductions: {
      method: 'standard',
      source: 'calculated',
      standardEligibility: {},
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.ok(codes(strict).includes('MISSING_TAXPAYER_BLIND_STATUS'));
  assert.ok(codes(strict).includes('DEPENDENT_STANDARD_DEDUCTION_DEFERRED'));
  assert.ok(codes(strict).includes('DUAL_STATUS_STANDARD_DEDUCTION_DEFERRED'));
});

test('MFS calculated Social Security uses the federal default when living status is omitted', () => {
  const mfs = canonical({
    filingStatus: 'marriedFilingSeparately',
    returnScope: { modeledTaxpayer: 'spouse' },
    taxpayers: { client: {}, spouse: {} },
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 20000,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    income: {
      socialSecurityBenefits: 20000,
      taxExemptInterest: 0,
      socialSecurity: {
        mode: 'calculate-taxable-benefits',
        otherIncome: 10000,
        excludedIncomeAddBacks: 0,
        adjustments: 0,
      },
    },
  });
  assert.deepStrictEqual(codes(mfs), []);
  const mapped = client1040IntakeToComposerInput(mfs);
  assert.strictEqual(mapped.socialSecurity.livedWithSpouse, false);
  const calculated = runClient1040Intake(mfs, context());
  assert.strictEqual(calculated.result.form1040.line6b.status, 'CALCULATED');

  const supplied = {
    ...mfs,
    income: {
      socialSecurityBenefits: 20000,
      taxableSS: 5000,
      socialSecurity: { mode: 'supplied-form1040-lines' },
    },
  };
  assert.deepStrictEqual(codes(supplied), []);
});

test('non-MFS calculated Social Security needs no living-status fact and rejects mixed sources', () => {
  const calculated = canonical({
    income: {
      socialSecurityBenefits: 20000,
      taxExemptInterest: 250,
      socialSecurity: {
        mode: 'calculate-taxable-benefits',
        otherIncome: 10000,
        excludedIncomeAddBacks: 0,
        adjustments: 0,
      },
    },
  });
  assert.deepStrictEqual(codes(calculated), []);
  const mapped = client1040IntakeToComposerInput(calculated);
  assert.strictEqual(mapped.socialSecurity.livedWithSpouse, false);
  assert.strictEqual(mapped.supplied.line6a, 20000);
  assert.strictEqual(mapped.supplied.line2a, 250);
  const pipeline = runClient1040Intake(calculated, context());
  assert.strictEqual(pipeline.result.form1040.line6b.status, 'CALCULATED');

  const signedLoss = structuredClone(calculated);
  signedLoss.income.socialSecurity.otherIncome = -5000;
  assert.deepStrictEqual(codes(signedLoss), []);
  assert.strictEqual(
    runClient1040Intake(signedLoss, context())
      .result.form1040.line6b.value,
    0
  );

  const mixed = canonical({
    income: {
      socialSecurityBenefits: 20000,
      taxableSS: 5000,
      taxExemptInterest: 999,
      socialSecurity: {
        mode: 'calculate-taxable-benefits',
        otherIncome: 10000,
        excludedIncomeAddBacks: 0,
        adjustments: 0,
      },
    },
  });
  assert.ok(codes(mixed).includes('SOCIAL_SECURITY_SOURCE_CONFLICT'));
  assert.throws(
    () => client1040IntakeToComposerInput(mixed),
    error => error.validation.errors
      .some(entry => entry.code === 'SOCIAL_SECURITY_SOURCE_CONFLICT')
  );

  const duplicatedWorksheetFacts = canonical({
    income: {
      socialSecurityBenefits: 20000,
      taxExemptInterest: 250,
      socialSecurity: {
        mode: 'calculate-taxable-benefits',
        socialSecurityBenefits: 22000,
        taxExemptInterest: 999,
        otherIncome: 10000,
        excludedIncomeAddBacks: 0,
        adjustments: 0,
      },
    },
  });
  assert.ok(codes(duplicatedWorksheetFacts)
    .includes('SOCIAL_SECURITY_SOURCE_CONFLICT'));

  const missingMode = canonical({
    income: { socialSecurityBenefits: 20000, taxableSS: 5000 },
  });
  assert.ok(codes(missingMode).includes('MISSING_SOCIAL_SECURITY_MODE'));
});

test('Schedule 1-A modes enforce supplied precedence and senior-only confirmations', () => {
  const senior = canonical({
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 15750,
      qbi: 0,
      schedule1A: {
        mode: 'calculate-enhanced-senior',
        magi: {
          mode: 'line11b-no-exclusions',
          noForeignOrTerritorialExclusionsConfirmed: true,
          completeReturnIncomeConfirmed: true,
        },
        noOtherSchedule1ADeductionsConfirmed: true,
      },
    },
    taxpayers: {
      client: {
        birthDate: '1950-01-01',
        blind: false,
        validSsnForEnhancedSeniorDeduction: true,
      },
    },
  });
  assert.deepStrictEqual(codes(senior), []);
  const seniorPipeline = runClient1040Intake(senior, context());
  assert.strictEqual(
    seniorPipeline.result.form1040.line13b.status,
    'CALCULATED'
  );
  assert.strictEqual(seniorPipeline.result.form1040.line13b.value, 6000);
  assert.strictEqual(seniorPipeline.result.form1040.line15.value, 53250);

  const missingSsn = structuredClone(senior);
  delete missingSsn.taxpayers.client.validSsnForEnhancedSeniorDeduction;
  assert.ok(codes(missingSsn).includes('MISSING_ENHANCED_SENIOR_SSN_CONFIRMATION'));

  const missingCompleteReturn = structuredClone(senior);
  delete missingCompleteReturn.deductions.schedule1A.magi
    .completeReturnIncomeConfirmed;
  assert.ok(codes(missingCompleteReturn)
    .includes('MISSING_LINE11B_COMPLETENESS_CONFIRMATION'));

  const crossModeAmount = structuredClone(senior);
  crossModeAmount.deductions.schedule1A.amount = 6000;
  assert.ok(codes(crossModeAmount).includes('SCHEDULE_1A_SOURCE_CONFLICT'));

  const mixed = {
    ...senior,
    supplied: { line13b: 6000 },
  };
  assert.ok(codes(mixed).includes('SCHEDULE_1A_SOURCE_CONFLICT'));

  const provenanceBypass = structuredClone(senior);
  provenanceBypass.deductions.schedule1A = { mode: 'confirmed-none' };
  assert.ok(codes(provenanceBypass).includes('INVALID_SCHEDULE_1A_MODE'));

  const legacyBypass = canonical();
  delete legacyBypass.deductions.schedule1A;
  legacyBypass.deductions.additional = 0;
  assert.ok(codes(legacyBypass).includes('LEGACY_SCHEDULE_1A_FIELD_IN_CANONICAL'));

  const mfsSenior = {
    ...senior,
    filingStatus: 'marriedFilingSeparately',
    returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
    taxpayers: {
      client: senior.taxpayers.client,
      spouse: { birthDate: '1950-01-01', blind: false },
    },
  };
  assert.ok(codes(mfsSenior).includes('MFS_ENHANCED_SENIOR_DEDUCTION_UNAVAILABLE'));

  const oneSeniorMfj = {
    ...senior,
    filingStatus: 'marriedFilingJointly',
    returnScope: { modeledTaxpayer: 'jointReturn' },
    taxpayers: {
      client: senior.taxpayers.client,
      spouse: {
        birthDate: '1970-01-01',
        blind: false,
      },
    },
  };
  assert.deepStrictEqual(
    codes(oneSeniorMfj),
    []
  );
  assert.strictEqual(
    runClient1040Intake(oneSeniorMfj, context())
      .result.form1040.line13b.value,
    6000
  );
});

test('calculated itemized SALT requires an explicit MAGI source and exclusion evidence', () => {
  const itemized = canonical({
    taxpayers: { client: {} },
    deductions: {
      method: 'itemized',
      source: 'calculated',
      qbi: 0,
      itemized: {
        medicalExpensesPaid: 10000,
        salt: {
          eligibleTaxesPaid: 50000,
          magi: {
            mode: 'line11b-no-exclusions',
            noForeignOrTerritorialExclusionsConfirmed: true,
            completeReturnIncomeConfirmed: true,
          },
        },
        mortgageInterestDeductible: 12000,
        charitableContributionsDeductible: 3000,
        otherItemizedDeductions: 0,
      },
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  assert.deepStrictEqual(codes(itemized), []);
  const itemizedPipeline = runClient1040Intake(itemized, context());
  assert.strictEqual(
    itemizedPipeline.result.form1040.line12e.status,
    'CALCULATED'
  );
  assert.strictEqual(itemizedPipeline.result.form1040.line12e.value, 59775);
  assert.strictEqual(itemizedPipeline.result.form1040.line15.value, 15225);
  assert.ok(itemizedPipeline.report.limitations
    .some(entry => entry.code === 'ITEMIZED_COMPONENTS_ALREADY_LIMITED'));

  const missingConfirmation = structuredClone(itemized);
  delete missingConfirmation.deductions.itemized.salt.magi
    .noForeignOrTerritorialExclusionsConfirmed;
  assert.ok(codes(missingConfirmation)
    .includes('MISSING_MAGI_EXCLUSION_CONFIRMATION'));

  const incompleteReturn = structuredClone(itemized);
  delete incompleteReturn.deductions.itemized.salt.magi
    .completeReturnIncomeConfirmed;
  assert.ok(codes(incompleteReturn)
    .includes('MISSING_LINE11B_COMPLETENESS_CONFIRMATION'));

  const suppliedMagi = structuredClone(itemized);
  suppliedMagi.deductions.itemized.salt.magi = {
    mode: 'supplied-magi',
    amount: 600000,
  };
  assert.deepStrictEqual(codes(suppliedMagi), []);

  const itemized2025 = {
    ...structuredClone(itemized),
    taxYear: 2025,
  };
  assert.deepStrictEqual(codes(itemized2025, context(2025)), []);
  const pipeline2025 = runClient1040Intake(itemized2025, context(2025));
  assert.strictEqual(pipeline2025.result.form1040.line12e.value, 59375);
  assert.ok(pipeline2025.report.limitations
    .some(entry => entry.code === 'ITEMIZED_COMPONENTS_ALREADY_LIMITED'));
});

test('high-AGI calculated itemized preserves missing QBI and Schedule 1-A as deferred', () => {
  const complete = canonical({
    income: completeCanonicalIncome({ wages: 700000 }),
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
    deductions: {
      method: 'itemized',
      source: 'calculated',
      qbi: 0,
      itemized: {
        medicalExpensesPaid: 0,
        salt: {
          eligibleTaxesPaid: 1000,
          magi: {
            mode: 'line11b-no-exclusions',
            noForeignOrTerritorialExclusionsConfirmed: true,
            completeReturnIncomeConfirmed: true,
          },
        },
        mortgageInterestDeductible: 1000,
        charitableContributionsDeductible: 0,
        otherItemizedDeductions: 0,
      },
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  });
  const resolved = runClient1040Intake(complete, context());
  assert.strictEqual(resolved.result.form1040.line12e.status, 'CALCULATED');
  assert.strictEqual(resolved.result.taxTotalScope, 'FULL_1040');

  const cases = [
    {
      remove: intake => { delete intake.deductions.qbi; },
      sourceLine: 'line13a',
      limitation: 'MISSING_QBI_DEFERRED',
    },
    {
      remove: intake => { delete intake.deductions.schedule1A; },
      sourceLine: 'line13b',
      limitation: 'MISSING_SCHEDULE_1A_DEFERRED',
    },
  ];
  for(const entry of cases){
    const intake = structuredClone(complete);
    entry.remove(intake);
    const pipeline = runClient1040Intake(intake, context());
    for(const lineId of [
      'line12e',
      entry.sourceLine,
      'line14',
      'line15',
      'line16',
      'line24',
    ]){
      assert.strictEqual(
        pipeline.result.form1040[lineId].status,
        'DEFERRED',
        `${entry.sourceLine}:${lineId}`
      );
    }
    assert.strictEqual(pipeline.result.totalFederalTax, null);
    assert.strictEqual(pipeline.result.taxTotalScope, 'NOT_CALCULABLE');
    assert.deepStrictEqual(
      pipeline.annual1040Result.readiness.unresolvedTaxableIncomeLines,
      ['line12e', entry.sourceLine]
    );
    assert.ok(pipeline.report.limitations
      .some(limitation => limitation.code === entry.limitation));
  }
});

test('manual net long-term mode preserves signed values without confirmation facts', () => {
  for(const amount of [-5000, 0, 5000]){
    const intake = canonical({
      scheduleD: {
        mode: 'manual-net-long-term',
        netLongTermGainOrLoss: amount,
      },
    });
    assert.deepStrictEqual(codes(intake), []);

    const mapped = client1040IntakeToComposerInput(intake);
    assert.deepStrictEqual(mapped.scheduleD, {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: amount,
    });
    assert.strictEqual(Object.hasOwn(mapped.supplied, 'line7a'), false);

    const pipeline = runClient1040Intake(intake, context());
    assert.deepStrictEqual(pipeline.report.contract.limitations, []);
    if(amount < 0){
      assert.strictEqual(pipeline.result.form1040.line7a.value, -3000);
      assert.strictEqual(
        pipeline.annual1040Result.federalSummary.preferentialIncome,
        0
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness.capitalLossCarryforward.status,
        'WORKSHEET_REQUIRED'
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness.capitalLossCarryforward.exactAmount,
        null
      );
    } else {
      assert.strictEqual(pipeline.result.form1040.line7a.value, amount);
      assert.strictEqual(
        pipeline.annual1040Result.federalSummary.preferentialIncome,
        amount
      );
    }
  }

  for(const invalid of [undefined, null, '5000', Number.NaN, Infinity]){
    const intake = canonical({
      scheduleD: {
        mode: 'manual-net-long-term',
        netLongTermGainOrLoss: invalid,
      },
    });
    assert.ok(codes(intake).includes('INVALID_SIGNED_AMOUNT'));
  }

  const extraFacts = canonical({
    scheduleD: {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: 5000,
      confirmations: {},
    },
  });
  assert.ok(codes(extraFacts).includes('SCHEDULE_D_SOURCE_CONFLICT'));

  const competing = canonical({
    income: completeCanonicalIncome({ capitalGain: 5000 }),
    scheduleD: {
      mode: 'manual-net-long-term',
      netLongTermGainOrLoss: 5000,
    },
  });
  assert.ok(codes(competing).includes('FORM1040_LINE7_SOURCE_CONFLICT'));
});

test('simple Schedule D requires every zero/not-applicable confirmation for either sign', () => {
  const confirmations = {
    shortTermNetIsZero: true,
    noCapitalLossCarryovers: true,
    line18NotApplicable: true,
    line19NotApplicable: true,
    form4952Line4gIsZeroOrNotApplicable: true,
  };
  for(const amount of [-5000, 5000]){
    const intake = canonical({
      scheduleD: {
        mode: 'simple-net-long-term',
        netLongTermGainOrLoss: amount,
        confirmations,
      },
    });
    assert.deepStrictEqual(codes(intake), []);
    assert.deepStrictEqual(client1040IntakeToComposerInput(intake).scheduleD, {
      line7: 0,
      line15: amount,
      line16: amount,
      line18: 0,
      line19: 0,
      form4952Line4g: 0,
    });
    const pipeline = runClient1040Intake(intake, context());
    if(amount < 0){
      assert.strictEqual(pipeline.result.form1040.line7a.value, -3000);
      assert.strictEqual(
        pipeline.annual1040Result.readiness
          .capitalLossCarryforward.status,
        'WORKSHEET_REQUIRED'
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness
          .capitalLossCarryforward.exactAmount,
        null
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness
          .capitalLossCarryforward.minimumAmount,
        2000
      );
    } else {
      assert.strictEqual(
        pipeline.annual1040Result.federalSummary.preferentialIncome,
        5000
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness
          .capitalLossCarryforward.status,
        'NONE'
      );
      assert.strictEqual(
        pipeline.annual1040Result.readiness
          .capitalLossCarryforward.exactAmount,
        0
      );
    }
  }

  const incomplete = canonical({
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: -5000,
      confirmations: { ...confirmations, shortTermNetIsZero: false },
    },
  });
  assert.ok(codes(incomplete).includes('MISSING_SIMPLE_SCHEDULE_D_CONFIRMATION'));

  const missingForm4952Confirmation = canonical({
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 5000,
      confirmations: {
        ...confirmations,
        form4952Line4gIsZeroOrNotApplicable: false,
      },
    },
  });
  const validation = validateClient1040Intake(
    missingForm4952Confirmation,
    context()
  );
  assert.ok(validation.errors.some(error =>
    error.code === 'MISSING_SIMPLE_SCHEDULE_D_CONFIRMATION'
      && error.path
        === 'scheduleD.confirmations.form4952Line4gIsZeroOrNotApplicable'
  ));
});

test('canonical defers full Schedule D while legacy summary mapping remains compatible', () => {
  const summary = canonical({
    scheduleD: {
      mode: 'schedule-d-summary',
      line7: -1000,
      line15: 4000,
      line16: 3000,
      line18: 0,
      line19: 0,
    },
  });
  assert.ok(codes(summary).includes('INVALID_SCHEDULE_D_MODE'));
  assert.throws(
    () => client1040IntakeToComposerInput(summary),
    error => error.validation.errors
      .some(entry => entry.code === 'INVALID_SCHEDULE_D_MODE')
  );

  const legacySummary = {
    filingStatus: 'single',
    income: { wages: 50000 },
    deductions: { useStandard: true },
    scheduleD: {
      mode: 'schedule-d-summary',
      line7: -1000,
      line15: 4000,
      line16: 3000,
      line18: 0,
      line19: 0,
    },
  };
  assert.strictEqual(
    client1040IntakeToComposerInput(legacySummary).scheduleD.line16,
    3000
  );

  for(const amount of [-3000, 0, 3000]){
    const supplied = canonical({
      scheduleD: { mode: 'supplied-form1040-line7', amount },
    });
    assert.deepStrictEqual(codes(supplied), []);
    const mapped = client1040IntakeToComposerInput(supplied);
    assert.strictEqual(mapped.supplied.line7a, amount);
    assert.strictEqual(mapped.capitalGains.netLongTermCapitalGains, 0);
    const pipeline = runClient1040Intake(supplied, context());
    assert.strictEqual(pipeline.result.form1040.line7a.value, amount);
    assert.deepStrictEqual(pipeline.report.contract.limitations, []);
    assert.strictEqual(
      pipeline.annual1040Result.federalSummary.preferentialIncome,
      0
    );
    assert.ok(!pipeline.audits
      .some(audit => audit.ruleId === 'FED_CAPITAL_GAINS_STACKING'));
  }

  const mixed = canonical({
    income: { wages: 50000, capitalGain: 1000 },
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 1000,
      confirmations: {
        shortTermNetIsZero: true,
        noCapitalLossCarryovers: true,
        line18NotApplicable: true,
        line19NotApplicable: true,
        form4952Line4gIsZeroOrNotApplicable: true,
      },
    },
  });
  assert.ok(codes(mixed).includes('FORM1040_LINE7_SOURCE_CONFLICT'));

  const contradictorySimple = canonical({
    scheduleD: {
      mode: 'simple-net-long-term',
      netLongTermGainOrLoss: 1000,
      line7: 1000,
      confirmations: {
        shortTermNetIsZero: true,
        noCapitalLossCarryovers: true,
        line18NotApplicable: true,
        line19NotApplicable: true,
        form4952Line4gIsZeroOrNotApplicable: true,
      },
    },
  });
  assert.ok(codes(contradictorySimple).includes('SCHEDULE_D_SOURCE_CONFLICT'));
});

test('pass-through absence stays missing while explicit zero completes lines 17, 19, 20, and 23', () => {
  const explicitZero = canonical({
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
  });
  assert.deepStrictEqual(codes(explicitZero), []);
  const mapped = client1040IntakeToComposerInput(explicitZero);
  for(const lineId of ['line17', 'line19', 'line20', 'line23']){
    assert.strictEqual(mapped.passThrough[lineId], 0);
  }
  const complete = runClient1040Intake(explicitZero, context());
  for(const lineId of ['line17', 'line19', 'line20', 'line23']){
    assert.strictEqual(complete.result.form1040[lineId].value, 0);
    assert.strictEqual(complete.result.form1040[lineId].status, 'SUPPLIED');
  }
  assert.strictEqual(complete.result.taxTotalScope, 'FULL_1040');

  const missing = runClient1040Intake(canonical(), context());
  for(const lineId of ['line17', 'line19', 'line20', 'line23']){
    assert.strictEqual(missing.result.form1040[lineId].status, 'DEFERRED');
  }
  assert.strictEqual(missing.result.taxTotalScope, 'INCOME_TAX_ONLY');
});

test('canonical pre-tax dependencies preserve missing versus explicit zero through line 24', () => {
  const completeIntake = canonical({
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
  });
  const complete = runClient1040Intake(completeIntake, context());
  for(const lineId of ['line10', 'line12e', 'line13a', 'line13b']){
    assert.notStrictEqual(complete.result.form1040[lineId].status, 'DEFERRED');
  }
  assert.strictEqual(complete.result.taxTotalScope, 'FULL_1040');
  assert.strictEqual(complete.result.form1040.line16.status, 'CALCULATED');

  const missingAdjustment = structuredClone(completeIntake);
  delete missingAdjustment.adjustments;
  const adjustmentResult = runClient1040Intake(
    missingAdjustment,
    context()
  );
  for(const lineId of ['line10', 'line11a', 'line11b', 'line15', 'line16', 'line24']){
    assert.strictEqual(
      adjustmentResult.result.form1040[lineId].status,
      'DEFERRED',
      lineId
    );
  }
  assert.strictEqual(adjustmentResult.result.totalFederalTax, null);
  assert.strictEqual(adjustmentResult.result.taxTotalScope, 'NOT_CALCULABLE');
  assert.deepStrictEqual(
    adjustmentResult.annual1040Result.readiness.unresolvedTaxableIncomeLines,
    ['line10']
  );

  const missingQbi = structuredClone(completeIntake);
  delete missingQbi.deductions.qbi;
  const qbiResult = runClient1040Intake(missingQbi, context());
  for(const lineId of ['line13a', 'line14', 'line15', 'line16', 'line24']){
    assert.strictEqual(qbiResult.result.form1040[lineId].status, 'DEFERRED');
  }
  assert.strictEqual(qbiResult.result.taxTotalScope, 'NOT_CALCULABLE');
  assert.ok(qbiResult.report.limitations
    .some(entry => entry.code === 'MISSING_QBI_DEFERRED'));

  const missingSchedule1A = structuredClone(completeIntake);
  delete missingSchedule1A.deductions.schedule1A;
  const schedule1AResult = runClient1040Intake(
    missingSchedule1A,
    context()
  );
  for(const lineId of ['line13b', 'line14', 'line15', 'line16', 'line24']){
    assert.strictEqual(
      schedule1AResult.result.form1040[lineId].status,
      'DEFERRED'
    );
  }
  assert.strictEqual(
    schedule1AResult.result.taxTotalScope,
    'NOT_CALCULABLE'
  );

  const missingLine12eInput = client1040IntakeToComposerInput(completeIntake);
  delete missingLine12eInput.supplied.line12e;
  delete missingLine12eInput.deductions.line12e;
  const missingLine12e = composeAnnualFederalTax(
    missingLine12eInput,
    context()
  ).result;
  for(const lineId of ['line12e', 'line14', 'line15', 'line16', 'line24']){
    assert.strictEqual(missingLine12e.form1040[lineId].status, 'DEFERRED');
  }
  assert.strictEqual(missingLine12e.taxTotalScope, 'NOT_CALCULABLE');

  const explicitZeroLine12e = runClient1040Intake(canonical({
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 0,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
  }), context());
  assert.strictEqual(
    explicitZeroLine12e.result.form1040.line12e.status,
    'SUPPLIED'
  );
  assert.strictEqual(explicitZeroLine12e.result.form1040.line12e.value, 0);
  assert.strictEqual(
    explicitZeroLine12e.result.form1040.line16.status,
    'CALCULATED'
  );

  const legacy = runClient1040Intake({
    filingStatus: 'single',
    income: { wages: 75000 },
    deductions: { useStandard: true },
  }, context());
  assert.strictEqual(legacy.result.form1040.line15.status, 'CALCULATED');
  assert.notStrictEqual(legacy.result.taxTotalScope, 'NOT_CALCULABLE');
  assert.deepStrictEqual(legacy.report.contract.limitations, []);
});

test('every omitted canonical line-9 component defers the authoritative tax result', () => {
  const cases = [
    {
      label: 'wages',
      sourceLine: 'line1z',
      remove: intake => { delete intake.income.wages; },
    },
    {
      label: 'taxable interest',
      sourceLine: 'line2b',
      remove: intake => { delete intake.income.taxableInterest; },
    },
    {
      label: 'ordinary dividends',
      sourceLine: 'line3b',
      remove: intake => { delete intake.income.ordinaryDividends; },
    },
    {
      label: 'IRA and Roth line 4b components',
      sourceLine: 'line4b',
      remove: intake => {
        delete intake.income.taxableIra;
        delete intake.income.rothConversion;
      },
    },
    {
      label: 'taxable pensions',
      sourceLine: 'line5b',
      remove: intake => { delete intake.income.taxablePensions; },
    },
    {
      label: 'Social Security source',
      sourceLine: 'line6b',
      remove: intake => {
        delete intake.income.socialSecurityBenefits;
        delete intake.income.taxableSS;
        delete intake.income.socialSecurity;
      },
    },
    {
      label: 'Form 1040 line 7 source',
      sourceLine: 'line7a',
      remove: intake => { delete intake.scheduleD; },
    },
    {
      label: 'other income',
      sourceLine: 'line8',
      remove: intake => { delete intake.income.otherIncome; },
    },
  ];

  for(const entry of cases){
    const intake = canonical({
      passThrough: {
        line17: 0,
        line19: 0,
        line20: 0,
        line23: 0,
      },
    });
    entry.remove(intake);
    assert.deepStrictEqual(codes(intake), [], entry.label);

    const pipeline = runClient1040Intake(intake, context());
    assert.strictEqual(
      pipeline.result.form1040[entry.sourceLine].status,
      'DEFERRED',
      entry.label
    );
    for(const lineId of ['line9', 'line11a', 'line11b', 'line15', 'line16', 'line24']){
      assert.strictEqual(
        pipeline.result.form1040[lineId].status,
        'DEFERRED',
        `${entry.label}:${lineId}`
      );
    }
    assert.strictEqual(pipeline.result.totalFederalTax, null, entry.label);
    assert.strictEqual(
      pipeline.annual1040Result.lines.line9.status,
      'DEFERRED',
      entry.label
    );
    assert.strictEqual(
      pipeline.annual1040Result.lines.line9.value,
      null,
      entry.label
    );
    assert.strictEqual(
      pipeline.result.taxTotalScope,
      'NOT_CALCULABLE',
      entry.label
    );
    assert.ok(
      pipeline.annual1040Result.readiness.unresolvedTaxableIncomeLines
        .includes('line9'),
      entry.label
    );
  }

  const explicitZeros = canonical({
    income: {
      wages: 0,
      taxableInterest: 0,
      taxExemptInterest: 0,
      ordinaryDividends: 0,
      qualifiedDividends: 0,
      iraDistributions: 0,
      taxableIra: 0,
      rothConversion: 0,
      pensionAmount: 0,
      taxablePensions: 0,
      socialSecurityBenefits: 0,
      taxableSS: 0,
      socialSecurity: { mode: 'supplied-form1040-lines' },
      otherIncome: 0,
    },
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
  });
  const complete = runClient1040Intake(explicitZeros, context());
  assert.strictEqual(complete.result.form1040.line9.value, 0);
  assert.strictEqual(complete.annual1040Result.lines.line9.value, 0);
  assert.strictEqual(complete.result.taxTotalScope, 'FULL_1040');
});

test('missing canonical qualified-dividend classification defers tax but preserves line 9', () => {
  const intake = canonical({
    income: completeCanonicalIncome({
      wages: 75000,
      ordinaryDividends: 1000,
    }),
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
      line23: 0,
    },
  });
  delete intake.income.qualifiedDividends;
  assert.deepStrictEqual(codes(intake), []);

  const pipeline = runClient1040Intake(intake, context());
  assert.strictEqual(pipeline.result.form1040.line3a.status, 'DEFERRED');
  assert.strictEqual(pipeline.result.form1040.line9.status, 'CALCULATED');
  assert.strictEqual(pipeline.result.form1040.line9.value, 76000);
  assert.strictEqual(pipeline.result.form1040.line16.status, 'DEFERRED');
  assert.strictEqual(pipeline.result.form1040.line24.status, 'DEFERRED');
  assert.strictEqual(pipeline.result.preferentialIncome, null);
  assert.strictEqual(pipeline.result.totalFederalTax, null);
  assert.strictEqual(pipeline.result.taxTotalScope, 'NOT_CALCULABLE');
  assert.ok(
    pipeline.annual1040Result.readiness.unresolvedTaxableIncomeLines
      .includes('line3a')
  );
});

test('standalone Schedule 2 components preserve line 23 source presence', () => {
  const components = {
    netInvestmentIncomeTax: 100,
    additionalMedicareTax: 200,
    otherPartIITaxes: 300,
  };
  const intake = canonical({
    passThrough: {
      line17: 0,
      line19: 0,
      line20: 0,
    },
    schedule2: components,
  });
  assert.deepStrictEqual(codes(intake), []);

  const pipeline = runClient1040Intake(intake, context());
  assert.strictEqual(pipeline.result.form1040.line23.status, 'CALCULATED');
  assert.strictEqual(pipeline.result.form1040.line23.value, 600);
  assert.strictEqual(
    pipeline.result.form1040.line23.ruleId,
    'SCHEDULE_2_SUPPLIED_TAXES'
  );
  assert.strictEqual(
    pipeline.result.form1040.line24.value,
    pipeline.result.form1040.line22.value + 600
  );
  for(const [intakePath, value] of [
    ['schedule2.netInvestmentIncomeTax', 100],
    ['schedule2.additionalMedicareTax', 200],
    ['schedule2.otherPartIITaxes', 300],
  ]){
    assert.ok(pipeline.report.captured.some(
      row => row.intakePath === intakePath && row.value === value
    ));
  }
  assert.ok(!pipeline.report.unsupportedIntentional.some(
    row => row.lineId === 'niit'
  ));

  const explicitZero = structuredClone(intake);
  explicitZero.schedule2 = {
    netInvestmentIncomeTax: 0,
    additionalMedicareTax: 0,
    otherPartIITaxes: 0,
  };
  const zeroPipeline = runClient1040Intake(explicitZero, context());
  assert.strictEqual(zeroPipeline.result.form1040.line23.status, 'CALCULATED');
  assert.strictEqual(zeroPipeline.result.form1040.line23.value, 0);

  const absent = structuredClone(intake);
  delete absent.schedule2;
  const absentPipeline = runClient1040Intake(absent, context());
  assert.strictEqual(absentPipeline.result.form1040.line23.status, 'DEFERRED');

  for(const field of [
    'netInvestmentIncomeTax',
    'additionalMedicareTax',
    'otherPartIITaxes',
  ]){
    const incomplete = structuredClone(intake);
    delete incomplete.schedule2[field];
    const validation = validateClient1040Contract(incomplete, context());
    assert.ok(validation.errors.some(entry =>
      entry.code === 'INVALID_NONNEGATIVE_AMOUNT'
        && entry.path === `schedule2.${field}`
    ));
    assert.throws(
      () => runClient1040Intake(incomplete, context()),
      error => error.validation.errors.some(entry =>
        entry.code === 'INVALID_NONNEGATIVE_AMOUNT'
          && entry.path === `schedule2.${field}`
      )
    );
  }

  const incompleteComposerInput =
    client1040IntakeToComposerInput(canonical());
  incompleteComposerInput.schedule2 = {
    netInvestmentIncomeTax: 0,
    additionalMedicareTax: 0,
  };
  const incompleteComposition = composeAnnualFederalTax(
    incompleteComposerInput,
    context()
  );
  assert.strictEqual(
    incompleteComposition.result.form1040.line23.status,
    'DEFERRED'
  );
});

test('Schedule 2 conflicts fail hard and Schedule SE is added exactly once', () => {
  const components = {
    netInvestmentIncomeTax: 100,
    additionalMedicareTax: 200,
    otherPartIITaxes: 300,
  };
  const conflict = canonical({
    schedule2: components,
    passThrough: { line23: 0 },
  });
  assert.ok(codes(conflict).includes('SCHEDULE_2_SOURCE_CONFLICT'));
  assert.throws(
    () => runClient1040Intake(conflict, context()),
    error => error.validation.errors
      .some(entry => entry.code === 'SCHEDULE_2_SOURCE_CONFLICT')
  );

  const directConflictInput = client1040IntakeToComposerInput(canonical({
    passThrough: { line23: 0 },
  }));
  directConflictInput.schedule2 = components;
  assert.throws(
    () => composeAnnualFederalTax(directConflictInput, context()),
    error => error.details?.code === 'SCHEDULE_2_SOURCE_CONFLICT'
  );

  const combined = canonical({
    scheduleSE: [{
      taxpayerOwner: 'client',
      netEarningsFromSelfEmployment: 10000,
      socialSecurityWagesAndTips: 0,
      socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    }],
    schedule2: components,
  });
  delete combined.adjustments;
  assert.deepStrictEqual(codes(combined), []);
  const combinedPipeline = runClient1040Intake(combined, context());
  assert.strictEqual(combinedPipeline.result.form1040.line23.value, 2130);
  assert.strictEqual(
    combinedPipeline.result.form1040.line23.ruleId,
    'FED_SELF_EMPLOYMENT_TAX+SCHEDULE_2_SUPPLIED_TAXES'
  );
  assert.strictEqual(
    combinedPipeline.audits.filter(
      audit => audit.ruleId === 'FED_SELF_EMPLOYMENT_TAX'
    ).length,
    1
  );
});

test('Schedule SE is per taxpayer, rejects duplicates, and maps owner into the rule input', () => {
  const mfj = canonical({
    taxYear: 2025,
    filingStatus: 'marriedFilingJointly',
    returnScope: { modeledTaxpayer: 'jointReturn' },
    taxpayers: {
      client: { birthDate: '1960-01-01', blind: false },
      spouse: { birthDate: '1962-01-01', blind: false },
    },
    scheduleSE: [
      {
        taxpayerOwner: 'client',
        netEarningsFromSelfEmployment: 50000,
        socialSecurityWagesAndTips: 0,
        socialSecurityWagesAndTipsIsScheduleSELine8d: true,
      },
      {
        taxpayerOwner: 'spouse',
        netEarningsFromSelfEmployment: 30000,
        socialSecurityWagesAndTips: 10000,
        socialSecurityWagesAndTipsIsScheduleSELine8d: true,
      },
    ],
    schedule2: {
      netInvestmentIncomeTax: 0,
      additionalMedicareTax: 0,
      otherPartIITaxes: 0,
    },
  });
  assert.deepStrictEqual(codes(mfj), []);
  assert.ok(describeClient1040IntakeContract(mfj).limitations
    .includes(CLIENT_1040_LIMITATIONS.SCHEDULE_SE_RESOLVED_LINE_6_ONLY));
  const mapped = client1040IntakeToComposerInput(mfj).scheduleSE;
  assert.deepStrictEqual(mapped.map(entry => entry.taxpayer), ['client', 'spouse']);

  const duplicate = structuredClone(mfj);
  duplicate.scheduleSE[1].taxpayerOwner = 'client';
  assert.ok(codes(duplicate).includes('DUPLICATE_SCHEDULE_SE_TAXPAYER'));

  const missingOwner = structuredClone(mfj);
  delete missingOwner.scheduleSE[0].taxpayerOwner;
  assert.ok(codes(missingOwner).includes('MISSING_SCHEDULE_SE_TAXPAYER'));

  const mixedLine23 = {
    ...mfj,
    passThrough: { line23: 0 },
  };
  assert.ok(codes(mixedLine23).includes('SCHEDULE_2_SOURCE_CONFLICT'));

  const mfs = {
    ...mfj,
    filingStatus: 'marriedFilingSeparately',
    returnScope: { modeledTaxpayer: 'client', spouseItemizes: false },
  };
  assert.ok(codes(mfs).includes('SCHEDULE_SE_OUTSIDE_MODELED_RETURN'));

  assert.ok(contractCodes(canonical({ scheduleSE: [] }))
    .includes('INVALID_SCHEDULE_SE'));
  const nonFinite = structuredClone(mfj);
  nonFinite.scheduleSE[0].netEarningsFromSelfEmployment =
    Number.POSITIVE_INFINITY;
  assert.ok(contractCodes(nonFinite, context(2025))
    .includes('INVALID_NONNEGATIVE_AMOUNT'));
  const missingAmount = structuredClone(mfj);
  delete missingAmount.scheduleSE[0].socialSecurityWagesAndTips;
  assert.ok(contractCodes(missingAmount, context(2025))
    .includes('INVALID_NONNEGATIVE_AMOUNT'));

  const unresolvedLine8d = structuredClone(mfj);
  delete unresolvedLine8d.scheduleSE[0]
    .socialSecurityWagesAndTipsIsScheduleSELine8d;
  assert.ok(contractCodes(unresolvedLine8d, context(2025))
    .includes('UNRESOLVED_SCHEDULE_SE_LINE_8D'));
  const falseLine8d = structuredClone(mfj);
  falseLine8d.scheduleSE[0]
    .socialSecurityWagesAndTipsIsScheduleSELine8d = false;
  assert.ok(contractCodes(falseLine8d, context(2025))
    .includes('UNRESOLVED_SCHEDULE_SE_LINE_8D'));
});

test('2026 Social Security uses its legal adjustment subset and adds half-SE tax once', () => {
  const intake = canonical({
    income: {
      wages: 0,
      taxableInterest: 0,
      taxExemptInterest: 0,
      ordinaryDividends: 0,
      qualifiedDividends: 0,
      iraDistributions: 0,
      taxableIra: 0,
      rothConversion: 0,
      pensionAmount: 0,
      taxablePensions: 0,
      socialSecurityBenefits: 30000,
      otherIncome: 30000,
      socialSecurity: {
        mode: 'calculate-taxable-benefits',
        otherIncome: 30000,
        excludedIncomeAddBacks: 0,
        adjustments: 0,
      },
    },
    deductions: {
      method: 'standard',
      source: 'supplied-line12e',
      line12e: 16100,
      qbi: 0,
      schedule1A: { mode: 'supplied-line13b', amount: 0 },
    },
    scheduleSE: [{
      taxpayerOwner: 'client',
      netEarningsFromSelfEmployment: 10000,
      socialSecurityWagesAndTips: 0,
      socialSecurityWagesAndTipsIsScheduleSELine8d: true,
    }],
    schedule2: {
      netInvestmentIncomeTax: 0,
      additionalMedicareTax: 0,
      otherPartIITaxes: 0,
    },
  });
  delete intake.adjustments;

  assert.deepStrictEqual(codes(intake), []);
  const pipeline = runClient1040Intake(intake, context());
  assert.strictEqual(pipeline.result.form1040.line10.status, 'CALCULATED');
  assert.strictEqual(pipeline.result.form1040.line10.value, 765);
  assert.strictEqual(pipeline.result.form1040.line6b.status, 'CALCULATED');
  assert.strictEqual(pipeline.result.form1040.line6b.value, 13199.75);
  assert.strictEqual(pipeline.result.form1040.line23.value, 1530);
  assert.ok(pipeline.report.limitations.some(limitation =>
    limitation.code === 'SOCIAL_SECURITY_WORKSHEET_ADJUSTMENT_SUBSET'
  ));
  assert.ok(pipeline.report.limitations.some(limitation =>
    limitation.code === 'SCHEDULE_SE_RESOLVED_LINE_6_ONLY'
  ));
  assert.strictEqual(
    pipeline.audits.filter(
      audit => audit.ruleId === 'FED_SELF_EMPLOYMENT_TAX'
    ).length,
    1
  );
  assert.strictEqual(
    pipeline.audits.find(
      audit => audit.ruleId === 'FED_TAXABLE_SOCIAL_SECURITY'
    ).inputsUsed.adjustments,
    765
  );

  const suppliedLine10 = structuredClone(intake);
  suppliedLine10.adjustments = {
    mode: 'supplied-line10',
    amount: 1765,
  };
  assert.deepStrictEqual(codes(suppliedLine10), []);
  const suppliedPipeline = runClient1040Intake(suppliedLine10, context());
  assert.strictEqual(suppliedPipeline.result.form1040.line10.status, 'SUPPLIED');
  assert.strictEqual(suppliedPipeline.result.form1040.line10.value, 1765);
  assert.strictEqual(suppliedPipeline.result.form1040.line23.value, 1530);
  assert.strictEqual(
    suppliedPipeline.audits.find(
      audit => audit.ruleId === 'FED_TAXABLE_SOCIAL_SECURITY'
    ).inputsUsed.adjustments,
    765,
    'the extra line-10 amount is excluded from the Social Security worksheet'
  );

  const impossibleLine10 = structuredClone(suppliedLine10);
  impossibleLine10.adjustments.amount = 764;
  assert.throws(
    () => runClient1040Intake(impossibleLine10, context()),
    /less than the Social Security worksheet-eligible adjustments/
  );
});

test('account treatment is derived from canonical type and cannot be overridden', () => {
  assert.strictEqual(deriveAccountTaxTreatment('brokerage_taxable'), 'taxable');
  assert.strictEqual(deriveAccountTaxTreatment('traditional_ira'), 'taxDeferred');
  assert.strictEqual(deriveAccountTaxTreatment('roth_ira'), 'roth');
  assert.strictEqual(deriveAccountTaxTreatment('hsa'), 'hsa');
  assert.strictEqual(deriveAccountTaxTreatment('not-real'), null);

  const clientReporting = {
    inclusion: 'household-return',
    reportingTaxpayer: 'client',
    householdReturnShare: 1,
  };
  const valid = canonical({
    accounts: [{
      typeId: 'roth_ira',
      owner: 'client',
      bucket: 'roth',
      taxReporting: clientReporting,
    }],
  });
  assert.deepStrictEqual(codes(valid), []);

  const overridden = canonical({
    accounts: [{
      typeId: 'roth_ira',
      owner: 'client',
      bucket: 'traditional',
      taxTreatment: 'Taxable',
      taxReporting: clientReporting,
    }],
  });
  const overriddenCodes = codes(overridden);
  assert.ok(overriddenCodes.includes('ACCOUNT_TREATMENT_NOT_INPUT'));
  assert.ok(overriddenCodes.includes('ACCOUNT_BUCKET_CONFLICT'));

  assert.ok(codes(canonical({
    accounts: [{
      typeId: 'hsa',
      owner: 'client',
      bucket: 'roth',
      taxReporting: clientReporting,
    }],
  })).includes('ACCOUNT_TAX_TREATMENT_UNSUPPORTED'));
  assert.ok(codes(canonical({
    accounts: [{
      typeId: 'other',
      owner: 'client',
      taxReporting: clientReporting,
    }],
  })).includes('UNKNOWN_ACCOUNT_TYPE'));

  const mfs = canonical({
    filingStatus: 'marriedFilingSeparately',
    returnScope: { modeledTaxpayer: 'client' },
    taxpayers: { client: {} },
    accounts: [{
      typeId: 'traditional_ira',
      owner: 'spouse',
      bucket: 'traditional',
      taxReporting: {
        inclusion: 'separate-return',
        reportingTaxpayer: 'spouse',
        householdReturnShare: 1,
      },
    }],
  });
  assert.ok(codes(mfs).includes('MFS_RETURN_TAXPAYER_UNATTRIBUTED'));

  const impossibleJointIra = canonical({
    filingStatus: 'marriedFilingJointly',
    returnScope: { modeledTaxpayer: 'jointReturn' },
    taxpayers: { client: {}, spouse: {} },
    accounts: [{
      typeId: 'traditional_ira',
      owner: 'joint',
      bucket: 'traditional',
      taxReporting: {
        inclusion: 'household-return',
        reportingTaxpayer: 'return-level',
        householdReturnShare: 1,
      },
    }],
  });
  assert.ok(codes(impossibleJointIra).includes('ACCOUNT_OWNER_TYPE_CONFLICT'));

  const fractional = canonical({
    accounts: [{
      typeId: 'roth_ira',
      owner: 'client',
      bucket: 'roth',
      taxReporting: {
        inclusion: 'household-return',
        reportingTaxpayer: 'client',
        householdReturnShare: 0.5,
      },
    }],
  });
  assert.ok(codes(fractional).includes('ACCOUNT_RETURN_SHARE_INCOMPLETE'));
});
