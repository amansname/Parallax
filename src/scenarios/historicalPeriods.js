export const TYPICAL_CASH_FLOW_PATH_ID = 'typical';

const PERIODS = [
  { id: 'historical-1929', startYear: 1929, name: 'Great Depression', tone: '#c6a662', sequencingDefault: false },
  { id: 'historical-1937', startYear: 1937, name: 'Double-Dip Recession', tone: '#a66e5e', sequencingDefault: false },
  { id: 'historical-1966', startYear: 1966, name: 'Lost Decade', tone: '#8b94a8', sequencingDefault: true },
  { id: 'historical-1973', startYear: 1973, name: 'Stagflation', tone: '#cd9a52', sequencingDefault: true },
  { id: 'historical-1995', startYear: 1995, name: '90s Boom', tone: '#8fa57e', sequencingDefault: true },
  { id: 'historical-2000', startYear: 2000, name: 'Dot-com Crash', tone: '#c0795f', sequencingDefault: true },
  { id: 'historical-2008', startYear: 2008, name: 'Financial Crisis', tone: '#9a8fb0', sequencingDefault: false },
  { id: 'historical-2009', startYear: 2009, name: 'Recovery Bull', tone: '#d8c084', sequencingDefault: false },
  { id: 'historical-2022', startYear: 2022, name: 'Inflation & Rate Shock', tone: '#7f8797', sequencingDefault: false },
];

export const HISTORICAL_PERIODS = Object.freeze(PERIODS.map(period => Object.freeze({
  ...period,
  label: `${period.startYear} · ${period.name}`,
})));

const PERIOD_BY_ID = new Map(HISTORICAL_PERIODS.map(period => [period.id, period]));

export const CASH_FLOW_PATH_OPTIONS = Object.freeze([
  Object.freeze({
    id: TYPICAL_CASH_FLOW_PATH_ID,
    label: 'Typical path',
    kind: 'typical',
  }),
  ...HISTORICAL_PERIODS.map(period => Object.freeze({
    id: period.id,
    label: period.label,
    kind: 'historical',
  })),
]);

function selectionCandidate(value){
  if(typeof value === 'string') return value;
  if(value && typeof value === 'object' && !Array.isArray(value)){
    return value.id ?? value.pathId ?? value.mode ?? null;
  }
  return null;
}

export function normalizeCashFlowPathId(value){
  const candidate = selectionCandidate(value);
  if(typeof candidate !== 'string') return TYPICAL_CASH_FLOW_PATH_ID;
  const normalized = candidate.trim().toLowerCase();
  if(normalized === TYPICAL_CASH_FLOW_PATH_ID){
    return TYPICAL_CASH_FLOW_PATH_ID;
  }
  return PERIOD_BY_ID.has(normalized)
    ? normalized
    : TYPICAL_CASH_FLOW_PATH_ID;
}

export function historicalPeriodById(value){
  return PERIOD_BY_ID.get(normalizeCashFlowPathId(value)) ?? null;
}
