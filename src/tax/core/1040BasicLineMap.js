/* Basic Form 1040 line coverage for client intake (pre-engine.js integration). */

export const LINE_COVERAGE = {
  CAPTURED: 'CAPTURED',
  CALCULATED: 'CALCULATED',
  PASS_THROUGH: 'PASS_THROUGH',
  UNSUPPORTED_INTENTIONAL: 'UNSUPPORTED_INTENTIONAL',
  ARCHITECTURE_LATER: 'ARCHITECTURE_LATER',
  BUG: 'BUG',
};

/** @typedef {typeof LINE_COVERAGE[keyof typeof LINE_COVERAGE]} LineCoverageStatus */

/**
 * Static map: each entry describes one intake surface and its engine role.
 * `intakePath` — JSON path on client1040 intake documents (line-for-line).
 */
export const FORM1040_BASIC_LINES = [
  { lineId: 'filingStatus', label: 'Filing status', intakePath: 'filingStatus', coverage: LINE_COVERAGE.CAPTURED, notes: 'Required on every intake.' },
  { lineId: 'taxYear', label: 'Tax year', intakePath: 'taxYear', coverage: LINE_COVERAGE.CAPTURED, notes: 'Canonical intake validates explicit 2025 or 2026 law routing.' },

  { lineId: 'line1z', label: 'Total wages (1z)', intakePath: 'income.wages', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line1z', notes: 'Rolls into calculated line 9.' },
  { lineId: 'line2a', label: 'Tax-exempt interest', intakePath: 'income.taxExemptInterest', coverage: LINE_COVERAGE.CAPTURED, notes: 'Captured for Social Security provisional-income inputs; excluded from line 9.' },
  { lineId: 'line2b', label: 'Taxable interest', intakePath: 'income.taxableInterest', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line2b' },
  { lineId: 'line3a', label: 'Qualified dividends', intakePath: 'income.qualifiedDividends', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line3a', notes: 'Feeds preferential-rate stacking on line 16.' },
  { lineId: 'line3b', label: 'Ordinary dividends', intakePath: 'income.ordinaryDividends', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line3b' },
  { lineId: 'line4a', label: 'IRA distributions (gross)', intakePath: 'income.iraDistributions', coverage: LINE_COVERAGE.CAPTURED, notes: 'Captured only; taxable 4b used in spine.' },
  { lineId: 'line4b', label: 'Taxable IRA distributions and Roth conversions', intakePath: 'income.taxableIra', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line4b', notes: 'Canonical intake may add the distinct income.rothConversion component.' },
  { lineId: 'line4bRothConversion', label: 'Roth conversion (taxable component)', intakePath: 'income.rothConversion', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line4b', notes: 'Distinct fully ordinary component added to Form 1040 line 4b.' },
  { lineId: 'line5a', label: 'Pensions and annuities (gross)', intakePath: 'income.pensionAmount', coverage: LINE_COVERAGE.CAPTURED },
  { lineId: 'line5b', label: 'Taxable pensions', intakePath: 'income.taxablePensions', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line5b' },
  { lineId: 'line6a', label: 'Social Security benefits (gross)', intakePath: 'income.socialSecurityBenefits', coverage: LINE_COVERAGE.CAPTURED, notes: 'Use with income.socialSecurity worksheet facts to calculate 6b.' },
  { lineId: 'line6b', label: 'Taxable Social Security', intakePath: 'income.taxableSS', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line6b', notes: 'Supplied directly or calculated via income.socialSecurity rule input.' },
  { lineId: 'line7a', label: 'Capital gain or (loss)', intakePath: 'income.capitalGain', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line7a', notes: 'Feeds preferential stacking when net LTCG; Schedule D ST/LT split is ARCHITECTURE_LATER.' },
  { lineId: 'line8', label: 'Other income (Schedule 1)', intakePath: 'income.otherIncome', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line8', notes: 'Alias: income.schedule1Income.' },

  { lineId: 'line9', label: 'Total income', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line9' },
  { lineId: 'line10', label: 'Adjustments to income', intakePath: 'adjustments.amount', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line10', notes: 'Supplied Schedule 1 line 10 total.' },
  { lineId: 'line10TraditionalIraDeduction', label: 'Traditional IRA deduction', intakePath: 'adjustments.traditionalIraDeduction', coverage: LINE_COVERAGE.CAPTURED, spineLine: 'line10', notes: 'Client-return component routed distinctly from a supplied Schedule 1 total.' },
  { lineId: 'line11a', label: 'Adjusted gross income', intakePath: 'passThrough.line11a', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line11a', notes: 'Calculated; passThrough.line11a used for validation only.' },
  { lineId: 'line12e', label: 'Standard or itemized deduction', intakePath: 'deductions', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line12e', notes: 'Calculated when useStandard; supplied when itemizedAmount.' },
  { lineId: 'line13a', label: 'QBI deduction', intakePath: 'deductions.qbi', coverage: LINE_COVERAGE.PASS_THROUGH, spineLine: 'line13a', notes: 'Pass-through when supplied; QBI rule not built.' },
  { lineId: 'line13b', label: 'Additional deductions (Sch 1-A)', intakePath: 'deductions.additional', coverage: LINE_COVERAGE.PASS_THROUGH, spineLine: 'line13b' },
  { lineId: 'line14', label: 'Total deductions', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line14' },
  { lineId: 'line15', label: 'Taxable income', intakePath: 'passThrough.line15', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line15', notes: 'Calculated; passThrough.line15 used for validation only.' },

  { lineId: 'line16', label: 'Tax', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line16', notes: 'Ordinary + preferential stacking.' },
  { lineId: 'line17', label: 'Schedule 2, line 3', intakePath: 'passThrough.line17', coverage: LINE_COVERAGE.PASS_THROUGH, spineLine: 'line17', notes: 'Not calculated (NIIT/AMT/etc. deferred).' },
  { lineId: 'line18', label: 'Total tax before credits', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line18' },
  { lineId: 'line19', label: 'Child tax credit / other dependents', intakePath: 'passThrough.line19', coverage: LINE_COVERAGE.PASS_THROUGH, spineLine: 'line19' },
  { lineId: 'line20', label: 'Schedule 3, line 8', intakePath: 'passThrough.line20', coverage: LINE_COVERAGE.PASS_THROUGH, spineLine: 'line20' },
  { lineId: 'line21', label: 'Total credits', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line21' },
  { lineId: 'line22', label: 'Tax after credits', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line22' },
  { lineId: 'line23', label: 'Other taxes (Schedule 2, line 21)', intakePath: 'schedule2', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line23', notes: 'Calculated when Schedule SE and the remaining Schedule 2 components are supplied; legacy pass-through remains supported.' },
  { lineId: 'line24', label: 'Total tax', intakePath: 'reconciliation.theirLine24', coverage: LINE_COVERAGE.CALCULATED, spineLine: 'line24', notes: 'Calculated roll-up; includes supplied pass-through tax lines.' },

  { lineId: 'scheduleD', label: 'Schedule D ST/LT detail', intakePath: 'scheduleD', coverage: LINE_COVERAGE.ARCHITECTURE_LATER, notes: 'Needed when line 7 mixes short- and long-term gains.' },
  { lineId: 'niit', label: 'Net investment income tax', coverage: LINE_COVERAGE.UNSUPPORTED_INTENTIONAL },
  { lineId: 'amt', label: 'Alternative minimum tax', coverage: LINE_COVERAGE.UNSUPPORTED_INTENTIONAL },
  { lineId: 'payments', label: 'Withholding / estimated payments (25–33)', intakePath: 'passThrough.payments', coverage: LINE_COVERAGE.PASS_THROUGH, notes: 'Captured for completeness; not used in line 24 calc.' },
];

const INTAKE_PATH_ALIASES = {
  'income.otherIncome': ['income.schedule1Income'],
  'income.taxableSS': ['income.taxableSocialSecurity'],
};

export function getLineMapEntry(lineId){
  return FORM1040_BASIC_LINES.find((entry) => entry.lineId === lineId) ?? null;
}

export function getValueAtPath(obj, path){
  if(!obj || !path) return undefined;
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

export function readIntakeField(intake, intakePath){
  const direct = getValueAtPath(intake, intakePath);
  if(direct !== undefined) return direct;

  const aliases = INTAKE_PATH_ALIASES[intakePath];
  if(!aliases) return undefined;
  for(const alias of aliases){
    const value = getValueAtPath(intake, alias);
    if(value !== undefined) return value;
  }
  return undefined;
}

export function linesByCoverage(coverage){
  return FORM1040_BASIC_LINES.filter((entry) => entry.coverage === coverage);
}
