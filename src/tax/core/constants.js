/* ============================================================================
   TAX ENGINE — law data (constants)
   Versioned, citable tax-law values. This file holds DATA, never calculation
   logic. Rules read these tables; they do not hard-code numbers themselves.

   Each table is addressed by a (lawVersion → filingStatus) key and tagged with
   a dataSourceId so a result's audit can name exactly which data produced it.

   ⚠ VERIFICATION: 2025 tables transcribed from Schwab Center for Financial Research
   2025 Tax and Retirement Reference Guide (OBBBA update, July 2025, SCFR 0725-J02L).
   2026 bracket thresholds transcribed from IRS Rev. Proc. 2025-32.
   for CFP / primary-source verification before this rule is trusted for client
   work — mirroring engine.js's treatment of the RMD Uniform Lifetime table.
   The bracket-stacking MATH is independently unit-tested regardless of these
   exact figures; swapping in verified numbers changes only the data, not logic.
   ============================================================================ */

// Recognized filing statuses (the only legal enum the engine accepts).
export const FILING_STATUSES = ['single', 'marriedFilingJointly', 'headOfHousehold', 'marriedFilingSeparately'];

// Recognized law regimes/scenarios. lawVersion separates "what code ran"
// (ruleVersion) from "which legal regime applies."
export const LAW_VERSIONS = ['2025_FINAL', '2026_FINAL'];

// Controlled vocabulary for rule meta.triggerTags. These let Parallax query the
// ledger ("which rules move on a Roth conversion / trigger at age 73 / depend on
// AGI?"). Keeping them in one enum prevents tag drift across rules; the ledger
// test asserts every rule's tags are drawn from this set. Extend deliberately as
// new rules need new tags.
export const TRIGGER_TAGS = [
  'agi_threshold',
  'bracket_calculation',
  'roth_conversion',
  'roth_distribution',
  'charitable_planning',
  'ira_deductibility',
  'retirement_contribution',
  'capital_gains',
  'qualified_dividends',
  'social_security_taxation',
  'provisional_income',
  'standard_deduction',
  'enhanced_senior_deduction',
  'itemized_deduction',
  'medical_expense_deduction',
  'salt_deduction',
  'self_employment_tax',
];

export const IRMAA_MFS_LIVING_ARRANGEMENTS = [
  'lived-together-at-any-time',
  'lived-apart-all-year',
];

// Medicare Part B and Part D income-related monthly adjustment amounts.
// `upTo` follows the published boundary semantics. The penultimate tier is
// exclusive because CMS publishes the final tier as "greater than or equal."
export const IRMAA_TABLES = {
  2026: {
    individual: [
      { tier: 0, upTo: 109000, upperInclusive: true, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { tier: 1, upTo: 137000, upperInclusive: true, partBMonthlyAdjustment: 81.20, partDMonthlyAdjustment: 14.50 },
      { tier: 2, upTo: 171000, upperInclusive: true, partBMonthlyAdjustment: 202.90, partDMonthlyAdjustment: 37.50 },
      { tier: 3, upTo: 205000, upperInclusive: true, partBMonthlyAdjustment: 324.60, partDMonthlyAdjustment: 60.40 },
      { tier: 4, upTo: 500000, upperInclusive: false, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { tier: 5, upTo: Infinity, upperInclusive: true, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 },
    ],
    joint: [
      { tier: 0, upTo: 218000, upperInclusive: true, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { tier: 1, upTo: 274000, upperInclusive: true, partBMonthlyAdjustment: 81.20, partDMonthlyAdjustment: 14.50 },
      { tier: 2, upTo: 342000, upperInclusive: true, partBMonthlyAdjustment: 202.90, partDMonthlyAdjustment: 37.50 },
      { tier: 3, upTo: 410000, upperInclusive: true, partBMonthlyAdjustment: 324.60, partDMonthlyAdjustment: 60.40 },
      { tier: 4, upTo: 750000, upperInclusive: false, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { tier: 5, upTo: Infinity, upperInclusive: true, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 },
    ],
    marriedFilingSeparatelyLivedTogether: [
      { tier: 0, upTo: 109000, upperInclusive: true, partBMonthlyAdjustment: 0, partDMonthlyAdjustment: 0 },
      { tier: 4, upTo: 391000, upperInclusive: false, partBMonthlyAdjustment: 446.30, partDMonthlyAdjustment: 83.30 },
      { tier: 5, upTo: Infinity, upperInclusive: true, partBMonthlyAdjustment: 487.00, partDMonthlyAdjustment: 91.00 },
    ],
  },
};

export const IRMAA_TABLE_SOURCE = {
  2026: 'CMS_2026_MEDICARE_IRMAA_v1.0',
};

export const SELF_EMPLOYMENT_TAX = {
  '2025_FINAL': {
    socialSecurityWageBase: 176100,
    socialSecurityRate: 0.124,
    medicareRate: 0.029,
  },
  '2026_FINAL': {
    socialSecurityWageBase: 184500,
    socialSecurityRate: 0.124,
    medicareRate: 0.029,
  },
};

export const SELF_EMPLOYMENT_TAX_SOURCE = {
  '2025_FINAL': 'IRS_2025_SCHEDULE_SE_v1.0',
  '2026_FINAL': 'IRS_2026_PUBLICATION_505_SCHEDULE_SE_v1.0',
};

// Ordinary-income brackets. Each entry: { rate, upTo } where `upTo` is the
// INCLUSIVE upper bound of taxable ordinary income taxed at `rate`. The final
// bracket uses Infinity. Brackets are ascending and contiguous from 0.
//
// Keyed: ORDINARY_BRACKETS[lawVersion][filingStatus]
export const ORDINARY_BRACKETS = {
  '2025_FINAL': {
    single: [
      { rate: 0.10, upTo: 11925 },
      { rate: 0.12, upTo: 48475 },
      { rate: 0.22, upTo: 103350 },
      { rate: 0.24, upTo: 197300 },
      { rate: 0.32, upTo: 250525 },
      { rate: 0.35, upTo: 626350 },
      { rate: 0.37, upTo: Infinity },
    ],
    marriedFilingJointly: [
      { rate: 0.10, upTo: 23850 },
      { rate: 0.12, upTo: 96950 },
      { rate: 0.22, upTo: 206700 },
      { rate: 0.24, upTo: 394600 },
      { rate: 0.32, upTo: 501050 },
      { rate: 0.35, upTo: 751600 },
      { rate: 0.37, upTo: Infinity },
    ],
    headOfHousehold: [
      { rate: 0.10, upTo: 17000 },
      { rate: 0.12, upTo: 64850 },
      { rate: 0.22, upTo: 103350 },
      { rate: 0.24, upTo: 197300 },
      { rate: 0.32, upTo: 250500 },
      { rate: 0.35, upTo: 626350 },
      { rate: 0.37, upTo: Infinity },
    ],
    marriedFilingSeparately: [
      { rate: 0.10, upTo: 11925 },
      { rate: 0.12, upTo: 48475 },
      { rate: 0.22, upTo: 103350 },
      { rate: 0.24, upTo: 197300 },
      { rate: 0.32, upTo: 250525 },
      { rate: 0.35, upTo: 375800 },
      { rate: 0.37, upTo: Infinity },
    ],
  },
  '2026_FINAL': {
    single: [
      { rate: 0.10, upTo: 12400 },
      { rate: 0.12, upTo: 50400 },
      { rate: 0.22, upTo: 105700 },
      { rate: 0.24, upTo: 201775 },
      { rate: 0.32, upTo: 256225 },
      { rate: 0.35, upTo: 640600 },
      { rate: 0.37, upTo: Infinity },
    ],
    marriedFilingJointly: [
      { rate: 0.10, upTo: 24800 },
      { rate: 0.12, upTo: 100800 },
      { rate: 0.22, upTo: 211400 },
      { rate: 0.24, upTo: 403550 },
      { rate: 0.32, upTo: 512450 },
      { rate: 0.35, upTo: 768700 },
      { rate: 0.37, upTo: Infinity },
    ],
    headOfHousehold: [
      { rate: 0.10, upTo: 17700 },
      { rate: 0.12, upTo: 67450 },
      { rate: 0.22, upTo: 105700 },
      { rate: 0.24, upTo: 201775 },
      { rate: 0.32, upTo: 256200 },
      { rate: 0.35, upTo: 640600 },
      { rate: 0.37, upTo: Infinity },
    ],
    marriedFilingSeparately: [
      { rate: 0.10, upTo: 12400 },
      { rate: 0.12, upTo: 50400 },
      { rate: 0.22, upTo: 105700 },
      { rate: 0.24, upTo: 201775 },
      { rate: 0.32, upTo: 256225 },
      { rate: 0.35, upTo: 384350 },
      { rate: 0.37, upTo: Infinity },
    ],
  },
};

// Maps a lawVersion to the dataSourceId that the bracket table came from. The
// rule records this in its audit (dataSourcesUsed) so the same inputs + same
// lawVersion + same data id reproduce the same result.
export const ORDINARY_BRACKETS_SOURCE = {
  '2025_FINAL': 'IRS_2025_TAX_TABLES_v1.0',
  '2026_FINAL': 'IRS_2026_TAX_TABLES_v1.0',
};

export const CAPITAL_GAINS_THRESHOLDS = {
  '2025_FINAL': {
    single: { zeroRateMax: 48350, fifteenRateMax: 533400 },
    marriedFilingJointly: { zeroRateMax: 96700, fifteenRateMax: 600050 },
    headOfHousehold: { zeroRateMax: 64750, fifteenRateMax: 566700 },
    marriedFilingSeparately: { zeroRateMax: 48350, fifteenRateMax: 300000 },
  },
  '2026_FINAL': {
    single: { zeroRateMax: 49450, fifteenRateMax: 545500 },
    marriedFilingJointly: { zeroRateMax: 98900, fifteenRateMax: 613700 },
    headOfHousehold: { zeroRateMax: 66200, fifteenRateMax: 579600 },
    marriedFilingSeparately: { zeroRateMax: 49450, fifteenRateMax: 306850 },
  },
};

export const CAPITAL_GAINS_THRESHOLDS_SOURCE = {
  '2025_FINAL': 'IRS_2025_CAPITAL_GAINS_RATES_v1.0',
  '2026_FINAL': 'IRS_2026_CAPITAL_GAINS_RATES_v1.0',
};

export const CAPITAL_GAINS_TAX_RATES = Object.freeze({
  zero: 0,
  middle: 0.15,
  top: 0.20,
});

export const SCHEDULE_D_CLASSIFICATION_SOURCE = {
  '2025_FINAL': 'IRS_2025_SCHEDULE_D_v1.0',
  '2026_FINAL': 'IRC_SIMPLE_SCHEDULE_D_2026_v1.0',
};

export const TRADITIONAL_IRA_LIMITS = {
  '2025_FINAL': {
    baseContributionLimit: 7000,
    catchUpAge: 50,
    catchUpContribution: 1000,
    phaseouts: {
      activeParticipant: {
        single: { fullDeductionUpTo: 79000, noDeductionAtOrAbove: 89000 },
        headOfHousehold: { fullDeductionUpTo: 79000, noDeductionAtOrAbove: 89000 },
        marriedFilingJointly: { fullDeductionUpTo: 126000, noDeductionAtOrAbove: 146000 },
        marriedFilingSeparately: { fullDeductionUpTo: 0, noDeductionAtOrAbove: 10000 },
      },
      spouseActiveParticipant: {
        marriedFilingJointly: { fullDeductionUpTo: 236000, noDeductionAtOrAbove: 246000 },
        marriedFilingSeparately: { fullDeductionUpTo: 0, noDeductionAtOrAbove: 10000 },
      },
    },
  },
  '2026_FINAL': {
    baseContributionLimit: 7500,
    catchUpAge: 50,
    catchUpContribution: 1100,
    phaseouts: {
      activeParticipant: {
        single: { fullDeductionUpTo: 81000, noDeductionAtOrAbove: 91000 },
        headOfHousehold: { fullDeductionUpTo: 81000, noDeductionAtOrAbove: 91000 },
        marriedFilingJointly: { fullDeductionUpTo: 129000, noDeductionAtOrAbove: 149000 },
        marriedFilingSeparately: { fullDeductionUpTo: 0, noDeductionAtOrAbove: 10000 },
      },
      spouseActiveParticipant: {
        marriedFilingJointly: { fullDeductionUpTo: 242000, noDeductionAtOrAbove: 252000 },
        marriedFilingSeparately: { fullDeductionUpTo: 0, noDeductionAtOrAbove: 10000 },
      },
    },
  },
};

export const TRADITIONAL_IRA_LIMITS_SOURCE = {
  '2025_FINAL': 'IRS_2025_IRA_LIMITS_v1.0',
  '2026_FINAL': 'IRS_2026_IRA_LIMITS_v1.0',
};

export const SOCIAL_SECURITY_TAXATION_THRESHOLDS = {
  '2025_FINAL': {
    single: { baseAmount: 25000, additionalAmount: 9000 },
    headOfHousehold: { baseAmount: 25000, additionalAmount: 9000 },
    marriedFilingJointly: { baseAmount: 32000, additionalAmount: 12000 },
    marriedFilingSeparatelyLivedApart: { baseAmount: 25000, additionalAmount: 9000 },
    marriedFilingSeparatelyLivedTogether: { baseAmount: 0, additionalAmount: 0 },
  },
  '2026_FINAL': {
    single: { baseAmount: 25000, additionalAmount: 9000 },
    headOfHousehold: { baseAmount: 25000, additionalAmount: 9000 },
    marriedFilingJointly: { baseAmount: 32000, additionalAmount: 12000 },
    marriedFilingSeparatelyLivedApart: { baseAmount: 25000, additionalAmount: 9000 },
    marriedFilingSeparatelyLivedTogether: { baseAmount: 0, additionalAmount: 0 },
  },
};

export const SOCIAL_SECURITY_TAXATION_SOURCE = {
  '2025_FINAL': 'IRS_2025_PUBLICATION_915_SOCIAL_SECURITY_v1.0',
  '2026_FINAL': 'IRS_2026_PUBLICATION_505_SOCIAL_SECURITY_v1.0',
};

export const SOCIAL_SECURITY_TAXATION_RATES = Object.freeze({
  lowerTier: 0.50,
  upperTier: 0.85,
});

export const STANDARD_DEDUCTION = {
  '2025_FINAL': {
    single: 15750,
    marriedFilingJointly: 31500,
    headOfHousehold: 23625,
    marriedFilingSeparately: 15750,
  },
  '2026_FINAL': {
    single: 16100,
    marriedFilingJointly: 32200,
    headOfHousehold: 24150,
    marriedFilingSeparately: 16100,
  },
};

export const STANDARD_DEDUCTION_SOURCE = {
  '2025_FINAL': 'IRS_2025_FORM_1040_STANDARD_DEDUCTION_v2.0',
  '2026_FINAL': 'IRS_2026_PUBLICATION_505_STANDARD_DEDUCTION_v1.0',
};

export const STANDARD_DEDUCTION_AGE_BLIND = {
  '2025_FINAL': {
    unmarriedPerCheck: 2000,
    marriedPerCheck: 1600,
  },
  '2026_FINAL': {
    unmarriedPerCheck: 2050,
    marriedPerCheck: 1650,
  },
};

export const ENHANCED_SENIOR_DEDUCTION = {
  '2025_FINAL': {
    amountPerEligiblePerson: 6000,
    phaseoutRate: 0.06,
    phaseoutStart: {
      single: 75000,
      headOfHousehold: 75000,
      marriedFilingJointly: 150000,
    },
  },
  '2026_FINAL': {
    amountPerEligiblePerson: 6000,
    phaseoutRate: 0.06,
    phaseoutStart: {
      single: 75000,
      headOfHousehold: 75000,
      marriedFilingJointly: 150000,
    },
  },
};

export const ENHANCED_SENIOR_DEDUCTION_SOURCES = {
  '2025_FINAL': [
    'IRS_2025_SCHEDULE_1A_SENIOR_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70103_2025_v1.0',
  ],
  '2026_FINAL': [
    'IRS_2026_PUBLICATION_505_SENIOR_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70103_2026_v1.0',
  ],
};

export const MEDICAL_EXPENSE_DEDUCTION = {
  '2025_FINAL': { adjustedGrossIncomeFloorRate: 0.075 },
  '2026_FINAL': { adjustedGrossIncomeFloorRate: 0.075 },
};

export const MEDICAL_EXPENSE_DEDUCTION_SOURCE = {
  '2025_FINAL': 'IRS_2025_SCHEDULE_A_MEDICAL_v1.0',
  '2026_FINAL': 'IRS_2026_SCHEDULE_A_MEDICAL_v1.0',
};

export const SALT_DEDUCTION = {
  '2025_FINAL': {
    fullCap: 40000,
    fullFloor: 10000,
    phaseoutRate: 0.30,
    phaseoutStart: {
      default: 500000,
      marriedFilingSeparately: 250000,
    },
  },
  '2026_FINAL': {
    fullCap: 40400,
    fullFloor: 10000,
    phaseoutRate: 0.30,
    phaseoutStart: {
      default: 505000,
      marriedFilingSeparately: 252500,
    },
  },
};

export const SALT_DEDUCTION_SOURCES = {
  '2025_FINAL': [
    'IRS_2025_SCHEDULE_A_SALT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70120_2025_v1.0',
  ],
  '2026_FINAL': [
    'IRS_2026_PUBLICATION_505_SALT_v1.0',
    'PUBLIC_LAW_119_21_SECTION_70120_2026_v1.0',
  ],
};

export const ITEMIZED_DEDUCTION_LIMIT = {
  '2025_FINAL': null,
  '2026_FINAL': {
    // IRC section 68 uses the exact fraction; Publication 505 rounds it to
    // 5.4% only for its estimated-tax worksheet.
    reductionNumerator: 2,
    reductionDenominator: 37,
    threshold: {
      single: 640600,
      headOfHousehold: 640600,
      marriedFilingJointly: 768700,
      marriedFilingSeparately: 384350,
    },
  },
};

export const ITEMIZED_DEDUCTION_SOURCE = {
  '2025_FINAL': 'IRS_2025_SCHEDULE_A_ITEMIZED_v1.0',
  '2026_FINAL': 'IRC_68_2026_ITEMIZED_LIMIT_v1.0',
};
