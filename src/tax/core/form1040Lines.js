/* Form 1040 line model — spine vocabulary and line-object factory. */

export const LINE_STATUS = {
  CALCULATED: 'CALCULATED',
  SUPPLIED: 'SUPPLIED',
  DEFERRED: 'DEFERRED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
};

// NOT_APPLICABLE = genuinely inapplicable to THIS return. Never "not built yet."
export const SPINE_LINE_IDS = [
  'line1z', 'line9', 'line10', 'line11a', 'line11b', 'line12e', 'line13a', 'line13b',
  'line14', 'line15', 'line16', 'line17', 'line18', 'line19', 'line20', 'line21',
  'line22', 'line23', 'line24',
];

export const SPINE_LINE_LABELS = {
  line2a: 'Tax-exempt interest',
  line1z: 'Total wages and other earned income (lines 1a–1h)',
  line9: 'Total income',
  line10: 'Adjustments to income (Schedule 1, line 26)',
  line11a: 'Adjusted gross income',
  line11b: 'Adjusted gross income (amount from line 11a)',
  line12e: 'Standard deduction or itemized deductions',
  line13a: 'Qualified business income deduction',
  line13b: 'Additional deductions (Schedule 1-A, line 38)',
  line14: 'Total deductions',
  line15: 'Taxable income',
  line16: 'Tax',
  line17: 'Amount from Schedule 2, line 3',
  line18: 'Total tax before credits',
  line19: 'Child tax credit or credit for other dependents',
  line20: 'Amount from Schedule 3, line 8',
  line21: 'Total credits',
  line22: 'Tax after credits',
  line23: 'Other taxes (Schedule 2, line 21)',
  line24: 'Total tax',
};

export const INCOME_DETAIL_LINE_IDS = ['line2a', 'line3a', 'line3b', 'line4a', 'line5a', 'line6a', 'line6b', 'line7a'];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function makeLine(lineId, { value = null, status, ruleId = null, auditIndex = null }){
  return {
    lineId,
    label: SPINE_LINE_LABELS[lineId] || lineId,
    value: value === null ? null : round2(value),
    status,
    ruleId,
    auditIndex,
  };
}

export function suppliedLine(lineId, value){
  return makeLine(lineId, { value, status: LINE_STATUS.SUPPLIED });
}

export function passThroughLine(lineId, value){
  return makeLine(lineId, { value, status: LINE_STATUS.SUPPLIED, ruleId: 'INTAKE_PASS_THROUGH' });
}

export function calculatedLine(lineId, value, { ruleId = null, auditIndex = null } = {}){
  return makeLine(lineId, { value, status: LINE_STATUS.CALCULATED, ruleId, auditIndex });
}

export function deferredLine(lineId){
  return makeLine(lineId, { value: null, status: LINE_STATUS.DEFERRED });
}

export function notApplicableLine(lineId){
  return makeLine(lineId, { value: 0, status: LINE_STATUS.NOT_APPLICABLE });
}

export function lineAmount(line){
  if(line.status === LINE_STATUS.DEFERRED) return 0;
  return line.value ?? 0;
}

export const TAX_TOTAL_SCOPE = {
  FULL_1040: 'FULL_1040',
  INCOME_TAX_ONLY: 'INCOME_TAX_ONLY',
};

const PARTIAL_TOTAL_DEFERRED_LINES = ['line17', 'line19', 'line20', 'line23'];

export function resolveTaxTotalScope(form1040){
  const hasDeferredTaxLines = PARTIAL_TOTAL_DEFERRED_LINES.some(
    (lineId) => form1040[lineId]?.status === LINE_STATUS.DEFERRED
  );
  return hasDeferredTaxLines ? TAX_TOTAL_SCOPE.INCOME_TAX_ONLY : TAX_TOTAL_SCOPE.FULL_1040;
}

export function assertAllSpineLines(form1040){
  for(const lineId of SPINE_LINE_IDS){
    if(!form1040[lineId]) throw new Error(`form1040 missing required spine line: ${lineId}`);
    if(!Object.values(LINE_STATUS).includes(form1040[lineId].status)){
      throw new Error(`form1040.${lineId} has invalid status: ${form1040[lineId].status}`);
    }
  }
  return form1040;
}
