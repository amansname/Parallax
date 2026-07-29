import {
  MEDICAL_EXPENSE_DEDUCTION,
  MEDICAL_EXPENSE_DEDUCTION_SOURCE,
} from '../../core/constants.js';
import { CONTEXT_SCHEMA } from '../../core/schemas.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';
import {
  assertNonNegativeNumber,
  validateAgainstSchema,
} from '../../core/validators.js';

export const meta = {
  ruleId: 'FED_MEDICAL_EXPENSE_DEDUCTION',
  ruleVersion: '1.0.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'medical_expense_deduction',
  authority: [
    'IRC section 213',
    'IRS Instructions for Schedule A',
    'IRS Publication 502',
  ],
  dataSourcesRequired: [
    'IRS_2025_SCHEDULE_A_MEDICAL_v1.0',
    'IRS_2026_SCHEDULE_A_MEDICAL_v1.0',
  ],
  inputsRequired: ['medicalExpensesPaid', 'adjustedGrossIncome'],
  outputs: ['deductibleMedicalExpenses', 'adjustedGrossIncomeFloor'],
  limitations: [
    'Input must already exclude reimbursements and nondeductible medical expenses',
    'Negative AGI uses a zero floor so the deduction never exceeds expenses paid',
  ],
  triggerTags: ['medical_expense_deduction', 'agi_threshold', 'itemized_deduction'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function validate(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError('medicalExpenseDeduction input must be a plain object');
  }
  assertNonNegativeNumber(
    input.medicalExpensesPaid,
    'medicalExpensesPaid',
    'medicalExpenseDeduction input'
  );
  if(typeof input.adjustedGrossIncome !== 'number'
      || !Number.isFinite(input.adjustedGrossIncome)){
    throw new TaxInputError(
      'medicalExpenseDeduction input adjustedGrossIncome must be finite'
    );
  }
  return input;
}

function resolveLaw(context){
  const law = MEDICAL_EXPENSE_DEDUCTION[context.lawVersion];
  const dataSourceId = MEDICAL_EXPENSE_DEDUCTION_SOURCE[context.lawVersion];
  if(!law || !dataSourceId){
    throw new TaxDataError(
      `No medical-expense deduction data for lawVersion: ${context.lawVersion}`
    );
  }
  const dataSource = getDataSource(dataSourceId);
  if(dataSource.taxYear !== context.taxYear
      || dataSource.lawVersion !== context.lawVersion){
    throw new TaxInputError(
      'context does not match the medical-expense deduction data source'
    );
  }
  return { law, dataSourceId };
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  const { law, dataSourceId } = resolveLaw(context);
  const floorBase = Math.max(0, input.adjustedGrossIncome);
  const adjustedGrossIncomeFloor = round2(
    floorBase * law.adjustedGrossIncomeFloorRate
  );
  const deductibleMedicalExpenses = round2(Math.max(
    0,
    input.medicalExpensesPaid - adjustedGrossIncomeFloor
  ));
  const result = {
    medicalExpensesPaid: input.medicalExpensesPaid,
    adjustedGrossIncomeFloor,
    deductibleMedicalExpenses,
  };
  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: { ...input },
    dataSourcesUsed: [dataSourceId],
    calculationSteps: [{
      step: 'medical_agi_floor',
      floorBase,
      rate: law.adjustedGrossIncomeFloorRate,
      adjustedGrossIncomeFloor,
      deductibleMedicalExpenses,
    }],
    authority: meta.authority,
    limitations: meta.limitations,
  };
  return { result, audit };
}

export const medicalExpenseDeduction = { meta, validate, calculate };
