// Projection Engine implementation; public consumers import engine.js.
import { ASSET_KEYS } from '../../household/investmentAllocation.js';

/* hoisted module constants the engine depends on */
export const LONGRUN_INFLATION = 0.025;

export const RETURN_DATA = [
  {y:1928, usLarge:+0.4630, usSmall:+0.6495, intlDev:null   , emerging:null   , usBonds:+0.0258, cash:+0.0486, reit:null   , gold:+0.0183},
  {y:1929, usLarge:-0.0830, usSmall:-0.4608, intlDev:null   , emerging:null   , usBonds:+0.0420, cash:+0.0316, reit:null   , gold:-0.0015},
  {y:1930, usLarge:-0.2336, usSmall:-0.4713, intlDev:null   , emerging:null   , usBonds:+0.0700, cash:+0.0701, reit:null   , gold:+0.0246},
  {y:1931, usLarge:-0.3835, usSmall:-0.3811, intlDev:null   , emerging:null   , usBonds:+0.0692, cash:+0.1231, reit:null   , gold:-0.0931},
  {y:1932, usLarge:+0.0185, usSmall:+0.4342, intlDev:null   , emerging:null   , usBonds:+0.2134, cash:+0.1268, reit:null   , gold:+0.3535},
  {y:1933, usLarge:+0.5821, usSmall:+1.6019, intlDev:null   , emerging:null   , usBonds:+0.0745, cash:+0.0650, reit:null   , gold:+0.3447},
  {y:1934, usLarge:-0.0453, usSmall:+0.1891, intlDev:null   , emerging:null   , usBonds:+0.0431, cash:-0.0311, reit:null   , gold:+0.2729},
  {y:1935, usLarge:+0.4302, usSmall:+0.5097, intlDev:null   , emerging:null   , usBonds:+0.0182, cash:-0.0237, reit:null   , gold:-0.0211},
  {y:1936, usLarge:+0.3063, usSmall:+0.9447, intlDev:null   , emerging:null   , usBonds:+0.0398, cash:-0.0082, reit:null   , gold:-0.0090},
  {y:1937, usLarge:-0.3765, usSmall:-0.5558, intlDev:null   , emerging:null   , usBonds:-0.0224, cash:-0.0330, reit:null   , gold:-0.0408},
  {y:1938, usLarge:+0.3204, usSmall:+0.0721, intlDev:null   , emerging:null   , usBonds:+0.0645, cash:+0.0212, reit:null   , gold:+0.0212},
  {y:1939, usLarge:+0.0020, usSmall:-0.0361, intlDev:null   , emerging:null   , usBonds:+0.0578, cash:+0.0137, reit:null   , gold:+0.0008},
  {y:1940, usLarge:-0.1132, usSmall:-0.3335, intlDev:null   , emerging:null   , usBonds:+0.0467, cash:-0.0066, reit:null   , gold:-0.0234},
  {y:1941, usLarge:-0.1692, usSmall:-0.1119, intlDev:null   , emerging:null   , usBonds:-0.0669, cash:-0.0464, reit:null   , gold:-0.0476},
  {y:1942, usLarge:+0.0746, usSmall:+0.4699, intlDev:null   , emerging:null   , usBonds:-0.0776, cash:-0.0964, reit:null   , gold:-0.0983},
  {y:1943, usLarge:+0.1786, usSmall:+1.2904, intlDev:null   , emerging:null   , usBonds:-0.0341, cash:-0.0539, reit:null   , gold:-0.0575},
  {y:1944, usLarge:+0.1716, usSmall:+0.6845, intlDev:null   , emerging:null   , usBonds:+0.0096, cash:-0.0118, reit:null   , gold:-0.0157},
  {y:1945, usLarge:+0.3266, usSmall:+0.9003, intlDev:null   , emerging:null   , usBonds:+0.0147, cash:-0.0185, reit:null   , gold:+0.0023},
  {y:1946, usLarge:-0.1560, usSmall:-0.2049, intlDev:null   , emerging:null   , usBonds:-0.0495, cash:-0.0748, reit:null   , gold:-0.0783},
  {y:1947, usLarge:-0.0805, usSmall:-0.1413, intlDev:null   , emerging:null   , usBonds:-0.1180, cash:-0.1207, reit:null   , gold:-0.1259},
  {y:1948, usLarge:-0.0222, usSmall:-0.0750, intlDev:null   , emerging:null   , usBonds:-0.0569, cash:-0.0671, reit:null   , gold:-0.0749},
  {y:1949, usLarge:+0.1973, usSmall:+0.2915, intlDev:null   , emerging:null   , usBonds:+0.0593, cash:+0.0235, reit:null   , gold:-0.0780},
  {y:1950, usLarge:+0.2933, usSmall:+0.5085, intlDev:null   , emerging:null   , usBonds:-0.0086, cash:-0.0010, reit:null   , gold:+0.0815},
  {y:1951, usLarge:+0.1463, usSmall:-0.0373, intlDev:null   , emerging:null   , usBonds:-0.0741, cash:-0.0592, reit:null   , gold:-0.0732},
  {y:1952, usLarge:+0.1559, usSmall:-0.0115, intlDev:null   , emerging:null   , usBonds:+0.0007, cash:-0.0047, reit:null   , gold:-0.0250},
  {y:1953, usLarge:-0.0199, usSmall:-0.0671, intlDev:null   , emerging:null   , usBonds:+0.0331, cash:+0.0108, reit:null   , gold:-0.0011},
  {y:1954, usLarge:+0.5210, usSmall:+0.6450, intlDev:null   , emerging:null   , usBonds:+0.0298, cash:+0.0064, reit:null   , gold:+0.0027},
  {y:1955, usLarge:+0.3299, usSmall:+0.2710, intlDev:null   , emerging:null   , usBonds:-0.0104, cash:+0.0202, reit:null   , gold:+0.0027},
  {y:1956, usLarge:+0.0585, usSmall:-0.0235, intlDev:null   , emerging:null   , usBonds:-0.0370, cash:+0.0110, reit:null   , gold:-0.0159},
  {y:1957, usLarge:-0.1335, usSmall:-0.1791, intlDev:null   , emerging:null   , usBonds:+0.0339, cash:-0.0008, reit:null   , gold:-0.0398},
  {y:1958, usLarge:+0.3979, usSmall:+0.6420, intlDev:null   , emerging:null   , usBonds:-0.0477, cash:-0.0100, reit:null   , gold:-0.0231},
  {y:1959, usLarge:+0.1129, usSmall:+0.1191, intlDev:null   , emerging:null   , usBonds:-0.0333, cash:+0.0267, reit:null   , gold:-0.0070},
  {y:1960, usLarge:-0.0133, usSmall:-0.0518, intlDev:null   , emerging:null   , usBonds:+0.0978, cash:+0.0115, reit:null   , gold:-0.0120},
  {y:1961, usLarge:+0.2538, usSmall:+0.2817, intlDev:null   , emerging:null   , usBonds:+0.0105, cash:+0.0134, reit:null   , gold:-0.0105},
  {y:1962, usLarge:-0.0971, usSmall:-0.1067, intlDev:null   , emerging:null   , usBonds:+0.0464, cash:+0.0175, reit:null   , gold:-0.0105},
  {y:1963, usLarge:+0.2107, usSmall:+0.1813, intlDev:null   , emerging:null   , usBonds:+0.0038, cash:+0.0184, reit:null   , gold:-0.0167},
  {y:1964, usLarge:+0.1493, usSmall:+0.2167, intlDev:null   , emerging:null   , usBonds:+0.0240, cash:+0.0222, reit:null   , gold:-0.0125},
  {y:1965, usLarge:+0.1063, usSmall:+0.4295, intlDev:null   , emerging:null   , usBonds:-0.0087, cash:+0.0231, reit:null   , gold:-0.0142},
  {y:1966, usLarge:-0.1250, usSmall:-0.1202, intlDev:null   , emerging:null   , usBonds:+0.0001, cash:+0.0190, reit:null   , gold:-0.0269},
  {y:1967, usLarge:+0.2007, usSmall:+1.0844, intlDev:null   , emerging:null   , usBonds:-0.0455, cash:+0.0115, reit:null   , gold:-0.0350},
  {y:1968, usLarge:+0.0634, usSmall:+0.5421, intlDev:null   , emerging:null   , usBonds:-0.0089, cash:+0.0118, reit:null   , gold:+0.0813},
  {y:1969, usLarge:-0.1303, usSmall:-0.3645, intlDev:null   , emerging:null   , usBonds:-0.0996, cash:+0.0111, reit:null   , gold:-0.0047},
  {y:1970, usLarge:-0.0202, usSmall:-0.2308, intlDev:null   , emerging:null   , usBonds:+0.1045, cash:+0.0066, reit:null   , gold:-0.1432},
  {y:1971, usLarge:+0.0941, usSmall:+0.1108, intlDev:null   , emerging:null   , usBonds:+0.0517, cash:-0.0007, reit:null   , gold:+0.1177},
  {y:1972, usLarge:+0.1507, usSmall:-0.0314, intlDev:null   , emerging:null   , usBonds:-0.0037, cash:+0.0083, reit:null   , gold:+0.4416},
  {y:1973, usLarge:-0.1931, usSmall:-0.4237, intlDev:null   , emerging:null   , usBonds:-0.0239, cash:+0.0079, reit:null   , gold:+0.6286},
  {y:1974, usLarge:-0.3324, usSmall:-0.3414, intlDev:null   , emerging:null   , usBonds:-0.0812, cash:-0.0284, reit:null   , gold:+0.4969},
  {y:1975, usLarge:+0.2548, usSmall:+0.4636, intlDev:null   , emerging:null   , usBonds:-0.0503, cash:-0.0294, reit:null   , gold:-0.3107},
  {y:1976, usLarge:+0.1707, usSmall:+0.4047, intlDev:null   , emerging:null   , usBonds:+0.0962, cash:-0.0078, reit:null   , gold:-0.0936},
  {y:1977, usLarge:-0.1265, usSmall:+0.2234, intlDev:null   , emerging:null   , usBonds:-0.0489, cash:+0.0011, reit:null   , gold:+0.1515},
  {y:1978, usLarge:-0.0102, usSmall:+0.1980, intlDev:null   , emerging:null   , usBonds:-0.0779, cash:-0.0040, reit:null   , gold:+0.2742},
  {y:1979, usLarge:+0.0649, usSmall:+0.2702, intlDev:null   , emerging:null   , usBonds:-0.0955, cash:-0.0238, reit:null   , gold:+1.0355},
  {y:1980, usLarge:+0.1607, usSmall:+0.2504, intlDev:null   , emerging:null   , usBonds:-0.1453, cash:-0.0186, reit:null   , gold:+0.0148},
  {y:1981, usLarge:-0.1370, usSmall:-0.1322, intlDev:null   , emerging:null   , usBonds:-0.0190, cash:+0.0339, reit:null   , gold:-0.3877},
  {y:1982, usLarge:+0.1339, usSmall:+0.1944, intlDev:null   , emerging:null   , usBonds:+0.2486, cash:+0.0460, reit:null   , gold:+0.0887},
  {y:1983, usLarge:+0.1854, usSmall:+0.3010, intlDev:null   , emerging:null   , usBonds:+0.0000, cash:+0.0556, reit:null   , gold:-0.1939},
  {y:1984, usLarge:+0.0177, usSmall:-0.1898, intlDev:null   , emerging:null   , usBonds:+0.0904, cash:+0.0539, reit:null   , gold:-0.2281},
  {y:1985, usLarge:+0.2640, usSmall:+0.2620, intlDev:+0.5030, emerging:+0.2290, usBonds:+0.1760, cash:+0.0380, reit:+0.1460, gold:+0.0170},
  {y:1986, usLarge:+0.1680, usSmall:+0.0450, intlDev:+0.6750, emerging:+0.1040, usBonds:+0.1390, cash:+0.0500, reit:+0.1770, gold:+0.1790},
  {y:1987, usLarge:+0.0030, usSmall:-0.1270, intlDev:+0.1930, emerging:+0.0930, usBonds:-0.0280, cash:+0.0130, reit:-0.0780, gold:+0.1900},
  {y:1988, usLarge:+0.1130, usSmall:+0.1970, intlDev:+0.2280, emerging:+0.3390, usBonds:+0.0280, cash:+0.0210, reit:+0.0860, gold:-0.1960},
  {y:1989, usLarge:+0.2550, usSmall:+0.1100, intlDev:+0.0560, emerging:+0.5690, usBonds:+0.0860, cash:+0.0370, reit:+0.0390, gold:-0.0680},
  {y:1990, usLarge:-0.0890, usSmall:-0.2280, intlDev:-0.2790, emerging:-0.1610, usBonds:+0.0240, cash:+0.0160, reit:-0.2030, gold:-0.0830},
  {y:1991, usLarge:+0.2630, usSmall:+0.4090, intlDev:+0.0870, emerging:+0.5450, usBonds:+0.1180, cash:+0.0250, reit:+0.3150, gold:-0.1250},
  {y:1992, usLarge:+0.0440, usSmall:+0.1490, intlDev:-0.1470, emerging:+0.0780, usBonds:+0.0410, cash:+0.0060, reit:+0.1120, gold:-0.0870},
  {y:1993, usLarge:+0.0700, usSmall:+0.1550, intlDev:+0.2890, emerging:+0.6940, usBonds:+0.0670, cash:+0.0020, reit:+0.1630, gold:+0.1390},
  {y:1994, usLarge:-0.0150, usSmall:-0.0310, intlDev:+0.0490, emerging:-0.1010, usBonds:-0.0520, cash:+0.0130, reit:+0.0040, gold:-0.0490},
  {y:1995, usLarge:+0.3400, usSmall:+0.2560, intlDev:+0.0840, emerging:-0.0190, usBonds:+0.1530, cash:+0.0310, reit:+0.1000, gold:-0.0170},
  {y:1996, usLarge:+0.1890, usSmall:+0.1430, intlDev:+0.0260, emerging:+0.1210, usBonds:+0.0030, cash:+0.0190, reit:+0.3140, gold:-0.0770},
  {y:1997, usLarge:+0.3100, usSmall:+0.2250, intlDev:+0.0000, emerging:-0.1820, usBonds:+0.0760, cash:+0.0350, reit:+0.1680, gold:-0.2320},
  {y:1998, usLarge:+0.2660, usSmall:-0.0420, intlDev:+0.1800, emerging:-0.1940, usBonds:+0.0690, cash:+0.0350, reit:-0.1770, gold:-0.0240},
  {y:1999, usLarge:+0.1790, usSmall:+0.1990, intlDev:+0.2360, emerging:+0.5730, usBonds:-0.0340, cash:+0.0200, reit:-0.0650, gold:-0.0170},
  {y:2000, usLarge:-0.1200, usSmall:-0.0580, intlDev:-0.1710, emerging:-0.2990, usBonds:+0.0770, cash:+0.0250, reit:+0.2220, gold:-0.0960},
  {y:2001, usLarge:-0.1330, usSmall:+0.0160, intlDev:-0.2310, emerging:-0.0440, usBonds:+0.0680, cash:+0.0260, reit:+0.1070, gold:-0.0040},
  {y:2002, usLarge:-0.2390, usSmall:-0.2180, intlDev:-0.1760, emerging:-0.0960, usBonds:+0.0580, cash:-0.0070, reit:+0.0130, gold:+0.2080},
  {y:2003, usLarge:+0.2620, usSmall:+0.4310, intlDev:+0.3610, emerging:+0.5470, usBonds:+0.0210, cash:-0.0090, reit:+0.3330, gold:+0.1920},
  {y:2004, usLarge:+0.0730, usSmall:+0.1620, intlDev:+0.1650, emerging:+0.2210, usBonds:+0.0100, cash:-0.0200, reit:+0.2670, gold:+0.0140},
  {y:2005, usLarge:+0.0140, usSmall:+0.0390, intlDev:+0.0980, emerging:+0.2770, usBonds:-0.0090, cash:-0.0050, reit:+0.0830, gold:+0.1300},
  {y:2006, usLarge:+0.1290, usSmall:+0.1290, intlDev:+0.2310, emerging:+0.2630, usBonds:+0.0180, cash:+0.0210, reit:+0.3180, gold:+0.1930},
  {y:2007, usLarge:+0.0130, usSmall:-0.0270, intlDev:+0.0680, emerging:+0.3360, usBonds:+0.0280, cash:+0.0070, reit:-0.1970, gold:+0.2580},
  {y:2008, usLarge:-0.3700, usSmall:-0.3610, intlDev:-0.4130, emerging:-0.5280, usBonds:+0.0510, cash:+0.0200, reit:-0.3700, gold:+0.0540},
  {y:2009, usLarge:+0.2330, usSmall:+0.3270, intlDev:+0.2490, emerging:+0.7150, usBonds:+0.0320, cash:-0.0240, reit:+0.2630, gold:+0.2020},
  {y:2010, usLarge:+0.1340, usSmall:+0.2600, intlDev:+0.0680, emerging:+0.1720, usBonds:+0.0500, cash:-0.0150, reit:+0.2660, gold:+0.2600},
  {y:2011, usLarge:-0.0090, usSmall:-0.0550, intlDev:-0.1500, emerging:-0.2100, usBonds:+0.0460, cash:-0.0290, reit:+0.0550, gold:+0.0550},
  {y:2012, usLarge:+0.1400, usSmall:+0.1620, intlDev:+0.1650, emerging:+0.1680, usBonds:+0.0240, cash:-0.0170, reit:+0.1570, gold:+0.0650},
  {y:2013, usLarge:+0.3040, usSmall:+0.3580, intlDev:+0.2030, emerging:-0.0640, usBonds:-0.0360, cash:-0.0150, reit:+0.0090, gold:-0.2900},
  {y:2014, usLarge:+0.1280, usSmall:+0.0670, intlDev:-0.0640, emerging:-0.0020, usBonds:+0.0510, cash:-0.0070, reit:+0.2930, gold:-0.0120},
  {y:2015, usLarge:+0.0060, usSmall:-0.0430, intlDev:-0.0090, emerging:-0.1600, usBonds:-0.0030, cash:-0.0070, reit:+0.0160, gold:-0.1230},
  {y:2016, usLarge:+0.0970, usSmall:+0.1590, intlDev:+0.0040, emerging:+0.0950, usBonds:+0.0050, cash:-0.0180, reit:+0.0630, gold:+0.0660},
  {y:2017, usLarge:+0.1930, usSmall:+0.1380, intlDev:+0.2380, emerging:+0.2870, usBonds:+0.0140, cash:-0.0130, reit:+0.0280, gold:+0.0930},
  {y:2018, usLarge:-0.0620, usSmall:-0.1100, intlDev:-0.1610, emerging:-0.1620, usBonds:-0.0190, cash:-0.0010, reit:-0.0770, gold:-0.0320},
  {y:2019, usLarge:+0.2850, usSmall:+0.2450, intlDev:+0.1930, emerging:+0.1760, usBonds:+0.0630, cash:-0.0010, reit:+0.2610, gold:+0.1590},
  {y:2020, usLarge:+0.1670, usSmall:+0.1750, intlDev:+0.0870, emerging:+0.1360, usBonds:+0.0610, cash:-0.0090, reit:-0.0600, gold:+0.2330},
  {y:2021, usLarge:+0.2020, usSmall:+0.1000, intlDev:+0.0410, emerging:-0.0580, usBonds:-0.0830, cash:-0.0650, reit:+0.3120, gold:-0.1030},
  {y:2022, usLarge:-0.2360, usSmall:-0.2310, intlDev:-0.2090, emerging:-0.2320, usBonds:-0.1900, cash:-0.0520, reit:-0.3110, gold:-0.0720},
  {y:2023, usLarge:+0.2210, usSmall:+0.1560, intlDev:+0.1380, emerging:+0.0520, usBonds:+0.0230, cash:+0.0160, reit:+0.0940, gold:+0.0910},
  {y:2024, usLarge:+0.2140, usSmall:+0.0980, intlDev:+0.0010, emerging:+0.0820, usBonds:-0.0160, cash:+0.0230, reit:+0.0070, gold:+0.2330},
  {y:2025, usLarge:+0.1480, usSmall:+0.0983, intlDev:+0.2775, emerging:+0.3087, usBonds:+0.0448, cash:+0.0156, reit:-0.0039, gold:+0.6066}
];

// ─── SECTION 2 — ASSET CLASS DEFINITIONS ─────────────────────────────────
// Equity (growth) and defensive sleeve mixes — renormalized for 8-asset universe.
export const EQUITY_MIX = {
  usLarge: .50, usSmall: .10, intlDev: .22, emerging: .08, reit: .10
};

export const DEFENSIVE_MIX = {
  usBonds: .75, cash: .17, gold: .08
};

export function buildAssetWeights(eqShare){
  const fiShare = 1 - eqShare;
  const w = {};
  ASSET_KEYS.forEach(k => w[k] = 0);
  Object.keys(EQUITY_MIX).forEach(k => w[k] += eqShare * EQUITY_MIX[k]);
  Object.keys(DEFENSIVE_MIX).forEach(k => w[k] += fiShare * DEFENSIVE_MIX[k]);
  return w;
}

export const RISK_PROFILES = {
  1: { label:'Conservative',   alloc:'30.00% Growth · 70.00% Defensive', eq:.30000, fi:.70000, weights:buildAssetWeights(.30000) },
  2: { label:'Balanced Cons.', alloc:'45.00% Growth · 55.00% Defensive', eq:.45000, fi:.55000, weights:buildAssetWeights(.45000) },
  3: { label:'Moderate',       alloc:'60.00% Growth · 40.00% Defensive', eq:.60000, fi:.40000, weights:buildAssetWeights(.60000) },
  4: { label:'Growth',         alloc:'75.00% Growth · 25.00% Defensive', eq:.75000, fi:.25000, weights:buildAssetWeights(.75000) },
  5: { label:'Aggressive',     alloc:'90.00% Growth · 10.00% Defensive', eq:.90000, fi:.10000, weights:buildAssetWeights(.90000) },
  6: { label:'All Equity',     alloc:'100.00% Growth · 0.00% Defensive', eq:1.00000, fi:.00000, weights:buildAssetWeights(1.00000) }
};

// ─── Per-asset stats (computed across each asset's available years) ─────
export function computeAssetStats(data){
  const out = {};
  ASSET_KEYS.forEach(k => {
    const vals = data.map(r => r[k]).filter(v => v !== null && v !== undefined);
    const n = vals.length;
    if(n === 0){ out[k] = {mean:0, stdev:0, cagr:0, n:0, min:0, max:0}; return; }
    const mean = vals.reduce((a,b)=>a+b,0) / n;
    const variance = vals.reduce((a,b)=>a + Math.pow(b-mean,2),0) / Math.max(n-1,1);
    const cagr = Math.pow(vals.reduce((p,v)=>p*(1+v),1), 1/n) - 1;
    out[k] = {
      mean, stdev: Math.sqrt(variance), cagr, n,
      min: Math.min(...vals), max: Math.max(...vals)
    };
  });
  return out;
}

export const ASSET_STATS = computeAssetStats(RETURN_DATA);
