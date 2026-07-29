/* RULE: Schedule D classification (FED_SCHEDULE_D_CLASSIFICATION) */

import {
  FILING_STATUSES,
  SCHEDULE_D_CLASSIFICATION_SOURCE,
} from '../../core/constants.js';
import { SCHEDULE_D_CLASSIFICATION_INPUT_SCHEMA, CONTEXT_SCHEMA } from '../../core/schemas.js';
import { validateAgainstSchema, assertOneOf } from '../../core/validators.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';

export const WORKSHEET_TYPES = {
  QUALIFIED_DIVIDENDS_AND_CAPITAL_GAIN: 'QUALIFIED_DIVIDENDS_AND_CAPITAL_GAIN',
  SCHEDULE_D_TAX_WORKSHEET: 'SCHEDULE_D_TAX_WORKSHEET',
};

export const meta = {
  ruleId: 'FED_SCHEDULE_D_CLASSIFICATION',
  ruleVersion: '1.3.0',
  supportedTaxYears: [2025, 2026],
  supportedLawVersions: ['2025_FINAL', '2026_FINAL'],
  jurisdiction: 'federal',
  category: 'capital_gains_classification',
  authority: [
    'IRS 2025 Instructions for Schedule D (Form 1040)',
    'IRC sections 1211(b), 1212(b), and 1222 for the 2026 simple path',
  ],
  dataSourcesRequired: [
    'IRS_2025_SCHEDULE_D_v1.0',
    'IRC_SIMPLE_SCHEDULE_D_2026_v1.0',
  ],
  inputsRequired: ['filingStatus', 'line7', 'line15', 'line16'],
  outputs: [
    'form1040Line7',
    'preferentialScheduleDGain',
    'netLongTermCapitalGains',
    'worksheetType',
    'scheduleDLine16',
    'capitalLossCarryforward',
  ],
  limitations: [
    'Does not run the Schedule D Tax Worksheet when lines 18 or 19 are positive or Form 4952 line 4g has an amount',
    'Does not classify individual transactions; expects Schedule D summary lines',
    'Canonical simple-Schedule-D intake must explicitly confirm that Form 4952 line 4g is zero or not applicable',
    'Any Schedule D loss requires the future-year Capital Loss Carryover Worksheet before an exact carryforward can be reported',
    'The 2026 simple path uses year-neutral statutory netting and loss-limit rules; complete 2026 Schedule D form support remains deferred',
  ],
  triggerTags: ['capital_gains'],
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function capitalLossLimit(filingStatus){
  return filingStatus === 'marriedFilingSeparately' ? 1500 : 3000;
}

function classificationResult({
  filingStatus,
  scheduleDLine16,
  preferentialScheduleDGain,
}){
  let form1040Line7 = 0;
  if(scheduleDLine16 < 0){
    form1040Line7 = -Math.min(
      Math.abs(scheduleDLine16),
      capitalLossLimit(filingStatus)
    );
  } else if(scheduleDLine16 > 0){
    form1040Line7 = scheduleDLine16;
  }

  const appliedLossLimit = scheduleDLine16 < 0
    ? capitalLossLimit(filingStatus)
    : null;
  const capitalLossCarryforward = scheduleDLine16 < 0
    ? {
      status: 'WORKSHEET_REQUIRED',
      exactAmount: null,
      minimumAmount: round2(
        Math.max(0, Math.abs(scheduleDLine16) - appliedLossLimit)
      ),
      reasonCode: 'CAPITAL_LOSS_CARRYFORWARD_WORKSHEET_REQUIRED',
    }
    : {
      status: 'NONE',
      exactAmount: 0,
      minimumAmount: 0,
    };

  return {
    form1040Line7: round2(form1040Line7),
    preferentialScheduleDGain: round2(preferentialScheduleDGain),
    netLongTermCapitalGains: round2(preferentialScheduleDGain),
    worksheetType: WORKSHEET_TYPES.QUALIFIED_DIVIDENDS_AND_CAPITAL_GAIN,
    scheduleDLine16: round2(scheduleDLine16),
    capitalLossLimitApplied: appliedLossLimit,
    capitalLossCarryforward,
  };
}

export function validate(input){
  validateAgainstSchema(input, SCHEDULE_D_CLASSIFICATION_INPUT_SCHEMA, 'scheduleDClassification input');
  assertOneOf(input.filingStatus, FILING_STATUSES, 'filingStatus', 'scheduleDClassification input');
  return input;
}

export function validateManualNetLongTerm(input){
  if(input === null || typeof input !== 'object' || Array.isArray(input)){
    throw new TaxInputError(
      'manual net long-term input must be a plain object'
    );
  }
  const allowedKeys = new Set(['filingStatus', 'netLongTermGainOrLoss']);
  const extraKeys = Object.keys(input).filter(key => !allowedKeys.has(key));
  if(extraKeys.length > 0){
    throw new TaxInputError(
      'manual net long-term input contains unsupported fields',
      { extraKeys }
    );
  }
  assertOneOf(
    input.filingStatus,
    FILING_STATUSES,
    'filingStatus',
    'manual net long-term input'
  );
  if(
    typeof input.netLongTermGainOrLoss !== 'number'
    || !Number.isFinite(input.netLongTermGainOrLoss)
  ){
    throw new TaxInputError(
      'manual net long-term input netLongTermGainOrLoss must be a finite number',
      { value: String(input.netLongTermGainOrLoss) }
    );
  }
  return input;
}

function resolveSource(context){
  const dataSourceId = SCHEDULE_D_CLASSIFICATION_SOURCE[context.lawVersion];
  if(!dataSourceId){
    throw new TaxDataError(
      `No Schedule D classification source for lawVersion: ${context.lawVersion}`
    );
  }
  const dataSource = getDataSource(dataSourceId);
  if(dataSource.taxYear !== context.taxYear
      || dataSource.lawVersion !== context.lawVersion){
    throw new TaxInputError(
      'context does not match the Schedule D classification data source'
    );
  }
  return dataSourceId;
}

export function calculate(input, context){
  validate(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  const dataSourceId = resolveSource(context);
  const dataSource = getDataSource(dataSourceId);

  const {
    filingStatus,
    line7,
    line15,
    line16,
    line18 = 0,
    line19 = 0,
    form4952Line4g = 0,
  } = input;

  const expectedLine16 = round2(line7 + line15);
  if(round2(line16) !== expectedLine16){
    throw new TaxInputError('Schedule D line 16 must equal line 7 plus line 15', {
      line7,
      line15,
      line16,
      expectedLine16,
    });
  }

  if(line18 > 0 || line19 > 0 || form4952Line4g !== 0){
    throw new TaxInputError(
      'Schedule D lines 18 or 19, or a Form 4952 line 4g amount, require the Schedule D Tax Worksheet; basic preferential stacking does not apply.',
      { line18, line19, form4952Line4g }
    );
  }

  let preferentialScheduleDGain = 0;
  if(line15 > 0 && line16 > 0){
    preferentialScheduleDGain = Math.min(line15, line16);
  }

  const result = classificationResult({
    filingStatus,
    scheduleDLine16: line16,
    preferentialScheduleDGain,
  });

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: {
      filingStatus,
      line7,
      line15,
      line16,
      line18,
      line19,
      form4952Line4g,
    },
    dataSourcesUsed: [dataSourceId],
    calculationSteps: [
      { step: 'verify_line16', line7, line15, line16, expectedLine16 },
      { step: 'form1040_line7', value: result.form1040Line7 },
      {
        step: 'capital_loss_carryforward_readiness',
        ...result.capitalLossCarryforward,
      },
      { step: 'preferential_schedule_d_gain', value: result.preferentialScheduleDGain },
    ],
    authority: [dataSource.authority],
    limitations: meta.limitations,
  };

  return { result, audit };
}

export function calculateManualNetLongTerm(input, context){
  validateManualNetLongTerm(input);
  validateAgainstSchema(context, CONTEXT_SCHEMA, 'context');
  const dataSourceId = resolveSource(context);
  const dataSource = getDataSource(dataSourceId);
  const amount = input.netLongTermGainOrLoss;
  const result = classificationResult({
    filingStatus: input.filingStatus,
    scheduleDLine16: amount,
    preferentialScheduleDGain: amount > 0 ? amount : 0,
  });

  const audit = {
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: context.taxYear,
    lawVersion: context.lawVersion,
    calculatedAt: context.calculatedAt,
    runId: context.runId,
    scenarioId: context.scenarioId,
    inputsUsed: {
      inputMode: 'MANUAL_NET_LONG_TERM',
      filingStatus: input.filingStatus,
      netLongTermGainOrLoss: amount,
    },
    dataSourcesUsed: [dataSourceId],
    calculationSteps: [
      {
        step: 'manual_net_long_term_input',
        netLongTermGainOrLoss: amount,
      },
      { step: 'form1040_line7', value: result.form1040Line7 },
      {
        step: 'capital_loss_carryforward_readiness',
        ...result.capitalLossCarryforward,
      },
      {
        step: 'preferential_schedule_d_gain',
        value: result.preferentialScheduleDGain,
      },
    ],
    authority: [dataSource.authority],
    limitations: meta.limitations,
  };

  return { result, audit };
}

export const scheduleDClassification = {
  meta,
  validate,
  validateManualNetLongTerm,
  calculate,
  calculateManualNetLongTerm,
};
