/* ============================================================================
   TAX ENGINE — schemas
   Shapes only — no calculation logic.
   ============================================================================ */

export const CONTEXT_SCHEMA = {
  fields: {
    calculatedAt: 'string',
    runId:        'string',
    scenarioId:   'string',
    taxYear:      'number',
    lawVersion:   'string',
  },
  required: ['calculatedAt', 'runId', 'scenarioId', 'taxYear', 'lawVersion'],
};

export const ORDINARY_INCOME_INPUT_SCHEMA = {
  fields: {
    filingStatus:         'string',
    taxableOrdinaryIncome: 'number',
  },
  required: ['filingStatus', 'taxableOrdinaryIncome'],
};

export const CAPITAL_GAINS_STACKING_INPUT_SCHEMA = {
  fields: {
    filingStatus:             'string',
    ordinaryTaxableIncome:    'number',
    netLongTermCapitalGains:  'number',
    qualifiedDividends:       'number',
  },
  required: ['filingStatus', 'ordinaryTaxableIncome', 'netLongTermCapitalGains', 'qualifiedDividends'],
};

export const TRADITIONAL_IRA_DEDUCTIBILITY_INPUT_SCHEMA = {
  fields: {
    filingStatus:                     'string',
    modifiedAgi:                      'number',
    contributionAmount:               'number',
    age:                              'number',
    taxableCompensation:              'number',
    taxpayerCoveredByWorkplacePlan:   'boolean',
    spouseCoveredByWorkplacePlan:     'boolean',
    livedWithSpouse:                  'boolean',
  },
  required: [
    'filingStatus',
    'modifiedAgi',
    'contributionAmount',
    'age',
    'taxableCompensation',
    'taxpayerCoveredByWorkplacePlan',
    'spouseCoveredByWorkplacePlan',
    'livedWithSpouse',
  ],
};

export const TAXABLE_SOCIAL_SECURITY_INPUT_SCHEMA = {
  fields: {
    filingStatus:             'string',
    socialSecurityBenefits:   'number',
    otherIncome:              'number',
    taxExemptInterest:        'number',
    excludedIncomeAddBacks:   'number',
    adjustments:              'number',
    livedWithSpouse:          'boolean',
  },
  required: [
    'filingStatus',
    'socialSecurityBenefits',
    'otherIncome',
    'taxExemptInterest',
    'excludedIncomeAddBacks',
    'adjustments',
    'livedWithSpouse',
  ],
};

export const STANDARD_DEDUCTION_INPUT_SCHEMA = {
  fields: {
    filingStatus:        'string',
    modeledTaxpayer:     'string',
    spouseItemizes:      'boolean',
    taxpayers:           'object',
    standardEligibility: 'object',
  },
  required: ['filingStatus'],
};

export const SCHEDULE_D_CLASSIFICATION_INPUT_SCHEMA = {
  fields: {
    filingStatus: 'string',
    line7:  'number',
    line15: 'number',
    line16: 'number',
    line18: 'number',
    line19: 'number',
    form4952Line4g: 'number',
  },
  required: ['filingStatus', 'line7', 'line15', 'line16'],
};

export const SELF_EMPLOYMENT_TAX_INPUT_SCHEMA = {
  fields: {
    taxpayer:                                           'string',
    netEarningsFromSelfEmployment:                      'number',
    socialSecurityWagesAndTips:                         'number',
    socialSecurityWagesAndTipsIsScheduleSELine8d:       'boolean',
  },
  required: [
    'netEarningsFromSelfEmployment',
    'socialSecurityWagesAndTips',
    'socialSecurityWagesAndTipsIsScheduleSELine8d',
  ],
};

export const FORM1040_LINE_STATUSES = ['CALCULATED', 'SUPPLIED', 'DEFERRED', 'NOT_APPLICABLE'];

export const ANNUAL_FEDERAL_TAX_INPUT_SCHEMA = {
  fields: {
    filingStatus:           'string',
    taxableOrdinaryIncome:  'number',
    ordinaryTaxableIncome:  'number',
    supplied:               'object',
    adjustmentComponents:   'object',
    deductions:             'object',
    socialSecurity:         'object',
    traditionalIra:         'object',
    capitalGains:           'object',
    scheduleSE:             'object',
    schedule2:              'object',
  },
  required: ['filingStatus'],
};
