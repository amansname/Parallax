export const CLIENT_1040_INTAKE_CONTRACT_ID = 'parallax.client-1040-intake';
export const CLIENT_1040_INTAKE_SCHEMA_VERSION = 1;
export const CLIENT_1040_INTAKE_CONTRACT_VERSION = '1.0.0';
export const CLIENT_1040_SUPPORTED_TAX_YEARS = Object.freeze([2025, 2026]);

export const CLIENT_1040_COMPATIBILITY_MODES = Object.freeze({
  CANONICAL: 'canonical',
  LEGACY_UNVERSIONED: 'legacy-unversioned',
  UNSUPPORTED: 'unsupported',
});

export const CLIENT_1040_DEDUCTION_METHODS = Object.freeze(['standard', 'itemized']);
export const CLIENT_1040_DEDUCTION_SOURCES = Object.freeze([
  'calculated',
  'supplied-line12e',
]);
export const CLIENT_1040_MODELED_TAXPAYERS = Object.freeze([
  'client',
  'spouse',
  'jointReturn',
]);
export const CLIENT_1040_MAGI_MODES = Object.freeze([
  'supplied-magi',
  'line11b-no-exclusions',
]);
export const CLIENT_1040_SCHEDULE_1A_MODES = Object.freeze([
  'supplied-line13b',
  'calculate-enhanced-senior',
]);
export const CLIENT_1040_SCHEDULE_D_MODES = Object.freeze([
  'simple-net-long-term',
  'supplied-form1040-line7',
]);
export const CLIENT_1040_SOCIAL_SECURITY_MODES = Object.freeze([
  'supplied-form1040-lines',
  'calculate-taxable-benefits',
]);
export const CLIENT_1040_ADJUSTMENT_MODES = Object.freeze([
  'supplied-line10',
  'supplied-traditional-ira-deduction',
]);
export const CLIENT_1040_LIMITATIONS = Object.freeze({
  SIMPLE_SCHEDULE_D_ONLY: Object.freeze({
    code: 'SIMPLE_SCHEDULE_D_ONLY',
    message: 'The simple Schedule D path requires confirmed zero short-term net, no carryovers, and no lines 18 or 19; all other Schedule D returns are deferred.',
  }),
});

export const CLIENT_1040_FIELD_DISPOSITIONS = Object.freeze({
  taxYear: 'CALCULATED_INPUT',
  filingStatus: 'CALCULATED_INPUT',
  returnScope: 'CALCULATED_INPUT',
  taxpayers: 'CALCULATED_INPUT',
  income: 'CALCULATED_INPUT',
  adjustments: 'SUPPLIED_OR_CALCULATED_INPUT',
  deductions: 'SUPPLIED_OR_CALCULATED_INPUT',
  scheduleD: 'SUPPLIED_OR_CALCULATED_INPUT',
  scheduleSE: 'CALCULATED_INPUT',
  schedule2: 'SUPPLIED',
  passThrough: 'SUPPLIED',
  accounts: 'READINESS_ASSERTION',
  reconciliation: 'UI_ONLY',
});

export const SIMPLE_SCHEDULE_D_CONFIRMATIONS = Object.freeze([
  'shortTermNetIsZero',
  'noCapitalLossCarryovers',
  'line18NotApplicable',
  'line19NotApplicable',
]);

export const ITEMIZED_AMOUNT_FIELDS = Object.freeze([
  'medicalExpensesPaid',
  'mortgageInterestDeductible',
  'charitableContributionsDeductible',
  'otherItemizedDeductions',
]);

export const FORBIDDEN_ACCOUNT_TREATMENT_FIELDS = Object.freeze([
  'taxTreatment',
  'treatment',
  'taxCharacter',
]);

export const LEGACY_CANONICAL_TOP_LEVEL_FIELDS = Object.freeze([
  'supplied',
  'taxableOrdinaryIncome',
  'capitalGains',
  'traditionalIra',
  'socialSecurity',
]);

export const LEGACY_CANONICAL_INCOME_FIELDS = Object.freeze([
  'schedule1Income',
  'taxableSocialSecurity',
  'netLongTermCapitalGains',
  'capitalGain',
]);

export const NONNEGATIVE_CANONICAL_INCOME_FIELDS = Object.freeze([
  'wages',
  'taxableInterest',
  'taxExemptInterest',
  'ordinaryDividends',
  'qualifiedDividends',
  'iraDistributions',
  'taxableIra',
  'rothConversion',
  'pensionAmount',
  'taxablePensions',
  'socialSecurityBenefits',
  'taxableSS',
]);
