import {
  ASSET_KEYS,
  ASSET_META,
  snapshotAssetWeights,
  validateAssetWeights,
} from '../household/investmentAllocation.js';

const ZERO_TOLERANCE = 1e-9;
export const INVALID_RETURN_ROW = 'INVALID_RETURN_ROW';
const OBSERVATION_SHA256 = '4a4fa018fe4d1542ea0fcc5d3d1502103db7d84552334c0a8ff376e6c9e4ccc3';
const COVERAGE_SHA256 = 'c3fc0cbadf2417a425cf555d63e3e5aac2b5ac4fafa147aa1bc292ab90e85f35';

function freezeSource(source){
  return Object.freeze({ ...source });
}

export const RETURN_SERIES_PROVENANCE = Object.freeze({
  datasetId: 'parallax-real-asset-returns-1928-2025',
  version: `sha256:${OBSERVATION_SHA256}`,
  coverageVersion: `sha256:${COVERAGE_SHA256}`,
  asOfYear: 2025,
  units: 'decimal annual total return',
  basis: 'real',
  currency: 'source local currency for 1985-2024; FX effects excluded',
  representativeTickersAreIllustrations: true,
  assets: Object.freeze(Object.fromEntries(ASSET_KEYS.map(key => [key, Object.freeze({
    label: ASSET_META[key].label,
    representativeTicker: ASSET_META[key].ticker,
    coverageStart: ASSET_META[key].era === 'post1985' ? 1985 : 1928,
    coverageEnd: 2025,
  })]))),
  segments: Object.freeze([
    freezeSource({
      startYear: 1928,
      endYear: 1984,
      status: 'verified-derivation',
      source: 'Aswath Damodaran, NYU Stern Historical Returns on Stocks, Bonds and Bills workbook',
      derivation: 'Supported nominal series are converted to real returns using the embedded inflation bridge; unavailable asset classes remain null.',
      applicableAssets: Object.freeze(['usLarge', 'usSmall', 'usBonds', 'cash', 'gold']),
    }),
    freezeSource({
      startYear: 1985,
      endYear: 2024,
      status: 'verified-source',
      source: 'The Measure of a Plan, Investment Returns by Asset Class (1985 to 2024)',
      sourceUpdated: '2025-01-08',
      derivation: 'Real total returns retained in local currency; foreign-exchange changes excluded by the publisher.',
      applicableAssets: ASSET_KEYS,
    }),
    freezeSource({
      startYear: 2025,
      endYear: 2025,
      status: 'unverified',
      source: 'source not recorded',
      firstRepositoryCommit: 'd738f4e227e13d8826d7df1eb44e5d1835fdcdb3',
      applicableAssets: ASSET_KEYS,
    }),
  ]),
});

function available(row, key){
  return row?.[key] !== null && row?.[key] !== undefined;
}

function returnRowError(message){
  const error = new RangeError(message);
  error.code = INVALID_RETURN_ROW;
  return error;
}

export function validateAssetReturnRow(row){
  if(!row || typeof row !== 'object' || Array.isArray(row)){
    throw returnRowError('Return row must be an object');
  }
  if(!Number.isInteger(row.y)){
    throw returnRowError('Return row year must be an integer');
  }
  for(const key of ASSET_KEYS){
    if(!Object.prototype.hasOwnProperty.call(row, key)){
      throw returnRowError(`Return row is missing ${key}`);
    }
    const value = row[key];
    if(value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= -1)){
      throw returnRowError(`Return row ${key} must be null or a finite return greater than -1`);
    }
  }
  return true;
}

export function resolveEffectiveAssetAllocation(row, requestedWeights){
  validateAssetWeights(requestedWeights);
  validateAssetReturnRow(row);

  const effective = Object.fromEntries(ASSET_KEYS.map(key => [key, 0]));
  const unavailableAssetKeys = ASSET_KEYS.filter(key => !available(row, key));
  const sleeves = [
    ASSET_KEYS.filter(key => ASSET_META[key].bucket === 'growth'),
    ASSET_KEYS.filter(key => ASSET_META[key].bucket !== 'growth'),
  ];
  let unresolvedWeight = 0;
  let withinSleeveRedistributed = false;
  let returnRate = 0;

  for(const keys of sleeves){
    const targetWeight = keys.reduce((sum, key) => sum + requestedWeights[key], 0);
    if(targetWeight <= ZERO_TOLERANCE) continue;
    const availableKeys = keys.filter(key => available(row, key));
    const availableWeight = availableKeys.reduce((sum, key) => sum + requestedWeights[key], 0);
    if(availableWeight <= ZERO_TOLERANCE){
      unresolvedWeight += targetWeight;
      continue;
    }
    const requestedKeys = keys.filter(key => requestedWeights[key] > ZERO_TOLERANCE);
    if(availableKeys.filter(key => requestedWeights[key] > ZERO_TOLERANCE).length !== requestedKeys.length){
      withinSleeveRedistributed = true;
    }
    for(const key of availableKeys){
      const effectiveWeight = targetWeight * (requestedWeights[key] / availableWeight);
      effective[key] += effectiveWeight;
      returnRate += effectiveWeight * row[key];
    }
  }

  let wholePortfolioRedistributed = false;
  if(unresolvedWeight > ZERO_TOLERANCE){
    const availableKeys = ASSET_KEYS.filter(key => available(row, key));
    const availableWeight = availableKeys.reduce((sum, key) => sum + requestedWeights[key], 0);
    if(availableWeight <= ZERO_TOLERANCE){
      const error = new RangeError('RETURN_ROW_HAS_NO_SUPPORTED_ALLOCATION');
      error.code = 'RETURN_ROW_HAS_NO_SUPPORTED_ALLOCATION';
      throw error;
    }
    wholePortfolioRedistributed = true;
    for(const key of availableKeys){
      const effectiveWeight = unresolvedWeight * (requestedWeights[key] / availableWeight);
      effective[key] += effectiveWeight;
      returnRate += effectiveWeight * row[key];
    }
  }

  const effectiveWeights = snapshotAssetWeights(effective);
  return Object.freeze({
    sourceYear: Number.isInteger(row.y) ? row.y : null,
    requestedWeights: snapshotAssetWeights(requestedWeights),
    effectiveWeights,
    unavailableAssetKeys: Object.freeze(unavailableAssetKeys),
    redistributionKind: wholePortfolioRedistributed
      ? 'whole-portfolio'
      : withinSleeveRedistributed
        ? 'within-sleeve'
        : 'none',
    baseRealReturn: returnRate,
  });
}

export function weightedAssetReturn(row, weights){
  return resolveEffectiveAssetAllocation(row, weights).baseRealReturn;
}
