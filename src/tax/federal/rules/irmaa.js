import {
  FILING_STATUSES,
  IRMAA_MFS_LIVING_ARRANGEMENTS,
  IRMAA_TABLE_SOURCE,
  IRMAA_TABLES,
} from '../../core/constants.js';
import { getDataSource } from '../../core/dataSourceRegistry.js';
import { TaxDataError, TaxInputError } from '../../core/errors.js';

export const meta = {
  ruleId: 'FED_MEDICARE_IRMAA',
  ruleVersion: '1.0.0',
  supportedPremiumYears: [2026],
  jurisdiction: 'federal',
  category: 'medicare_irmaa',
  authority: [
    'Social Security Act sections 1839(i) and 1860D-13(i)',
    'CMS 2026 Medicare Parts A & B Premiums and Deductibles',
  ],
  dataSourcesRequired: ['CMS_2026_MEDICARE_IRMAA_v1.0'],
  inputsRequired: ['magi', 'filingStatus', 'premiumYear'],
  outputs: [
    'tier',
    'nextTier',
    'roomToNext',
    'partBMonthlyAdjustment',
    'partDMonthlyAdjustment',
    'annualAdjustmentPerPerson',
  ],
  limitations: [
    'Uses the latest published table for premium years after 2026',
    'Excludes the standard Part B premium and the selected Part D plan premium',
  ],
  triggerTags: [
    'agi_threshold',
    'roth_conversion',
    'capital_gains',
    'charitable_planning',
  ],
};

const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

function assertPlainObject(value, label){
  if(!value || typeof value !== 'object' || Array.isArray(value)){
    throw new TaxInputError(`${label} must be a plain object`);
  }
}

export function validate(input){
  assertPlainObject(input, 'irmaa input');
  if(typeof input.magi !== 'number' || !Number.isFinite(input.magi)){
    throw new TaxInputError('magi must be a finite number', { field: 'magi' });
  }
  if(!FILING_STATUSES.includes(input.filingStatus)){
    throw new TaxInputError('filingStatus is not supported', {
      field: 'filingStatus',
      filingStatus: input.filingStatus,
    });
  }
  if(!Number.isInteger(input.premiumYear) || input.premiumYear < 2026){
    throw new TaxInputError('premiumYear must be 2026 or later', {
      field: 'premiumYear',
      premiumYear: input.premiumYear,
    });
  }
  if(input.filingStatus === 'marriedFilingSeparately'
      && !IRMAA_MFS_LIVING_ARRANGEMENTS.includes(
        input.mfsLivingArrangement,
      )){
    throw new TaxInputError(
      'mfsLivingArrangement is required for married filing separately',
      { field: 'mfsLivingArrangement' },
    );
  }
  return input;
}

function latestTableYear(premiumYear){
  const year = Object.keys(IRMAA_TABLES)
    .map(Number)
    .filter(candidate => candidate <= premiumYear)
    .sort((a, b) => b - a)[0];
  if(!year){
    throw new TaxDataError(
      `No IRMAA table is available for premium year ${premiumYear}`,
      { premiumYear },
    );
  }
  return year;
}

function tableKey(input){
  if(input.filingStatus === 'marriedFilingJointly') return 'joint';
  if(input.filingStatus !== 'marriedFilingSeparately') return 'individual';
  return input.mfsLivingArrangement === 'lived-apart-all-year'
    ? 'individual'
    : 'marriedFilingSeparatelyLivedTogether';
}

function rowContains(row, magi){
  return row.upperInclusive ? magi <= row.upTo : magi < row.upTo;
}

export function calculate(input, context = {}){
  validate(input);
  const tableYear = latestTableYear(input.premiumYear);
  const sourceId = IRMAA_TABLE_SOURCE[tableYear];
  const source = getDataSource(sourceId);
  const key = tableKey(input);
  const rows = IRMAA_TABLES[tableYear]?.[key];
  if(!Array.isArray(rows) || rows.length === 0){
    throw new TaxDataError('IRMAA filing-status table is unavailable', {
      tableYear,
      tableKey: key,
    });
  }
  const rowIndex = rows.findIndex(row => rowContains(row, input.magi));
  if(rowIndex < 0){
    throw new TaxDataError('IRMAA tier could not be resolved', {
      tableYear,
      magi: input.magi,
    });
  }
  const row = rows[rowIndex];
  const next = rows[rowIndex + 1] ?? null;
  const nextThreshold = Number.isFinite(row.upTo) ? row.upTo : null;
  const combinedMonthlyAdjustment = round2(
    row.partBMonthlyAdjustment + row.partDMonthlyAdjustment,
  );
  const ladder = rows.map(entry => Object.freeze({
    tier: entry.tier,
    upTo: Number.isFinite(entry.upTo) ? entry.upTo : null,
    upperInclusive: entry.upperInclusive,
    partBMonthlyAdjustment: entry.partBMonthlyAdjustment,
    partDMonthlyAdjustment: entry.partDMonthlyAdjustment,
  }));
  const result = Object.freeze({
    magi: round2(input.magi),
    tier: row.tier,
    nextTier: next?.tier ?? null,
    nextThreshold,
    roomToNext: nextThreshold === null
      ? null
      : round2(Math.max(0, nextThreshold - input.magi)),
    partBMonthlyAdjustment: row.partBMonthlyAdjustment,
    partDMonthlyAdjustment: row.partDMonthlyAdjustment,
    combinedMonthlyAdjustment,
    annualAdjustmentPerPerson: round2(combinedMonthlyAdjustment * 12),
    premiumYear: input.premiumYear,
    tableYear,
    ladder: Object.freeze(ladder),
  });
  const audit = Object.freeze({
    ruleId: meta.ruleId,
    ruleVersion: meta.ruleVersion,
    taxYear: input.premiumYear - 2,
    premiumYear: input.premiumYear,
    tableYear,
    calculatedAt: context.calculatedAt ?? null,
    runId: context.runId ?? null,
    scenarioId: context.scenarioId ?? null,
    inputsUsed: Object.freeze({
      magi: input.magi,
      filingStatus: input.filingStatus,
      ...(input.filingStatus === 'marriedFilingSeparately'
        ? { mfsLivingArrangement: input.mfsLivingArrangement }
        : {}),
    }),
    dataSourcesUsed: Object.freeze([sourceId]),
    calculationSteps: Object.freeze([
      Object.freeze({
        tableKey: key,
        tier: row.tier,
        annualAdjustmentPerPerson: result.annualAdjustmentPerPerson,
      }),
    ]),
    authority: Object.freeze([source.authority]),
    limitations: Object.freeze([...meta.limitations]),
  });
  return { result, audit };
}

export const irmaa = { meta, validate, calculate };
