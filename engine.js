import { resolvePortfolioAccounts } from './src/household/resolvePortfolioAccounts.js';
import {
  resolveAccountTaxReportingGap,
  resolveTaxableStartingBasis,
} from './src/household/resolveTaxableStartingBasis.js';
import { getAccountTypeById } from './src/household/accountTypes.js';
import { normalizedIncomeSource } from './src/household/incomeTaxModel.js';
import { goalsFromLegacyExpenses } from './src/household/migrateSpendingToGoals.js';
import {
  ASSET_KEYS,
  ASSET_META,
} from './src/household/investmentAllocation.js';
import {
  createProjectionReturnCache,
  RETURN_SERIES_PROVENANCE,
  weightedAssetReturn,
} from './src/projection/portfolioReturns.js';
import {
  accountBalancesById,
  addProjectionCash,
  aggregateProjectionAccounts,
  applyDirectBucketWithdrawal,
  applyProjectionContributions,
  applyProjectionOwnerRmd,
  applyProjectionYearReturnsAndWithdrawals,
  buildProjectionAccountLedger,
  cloneProjectionAccountLedger,
  fundProjectionGap,
  resolveProjectionReturnFrame,
  rolloverProjectionAccounts,
  snapshotProjectionAccounts,
  syncProjectionAggregates,
  zeroProjectionAccounts,
} from './src/projection/accountLedger.js';

/* ============================================================================
   PARALLAX ENGINE  —  the heart of the model. Treat as SACRED.
   Block-bootstrap Monte Carlo on real (inflation-adjusted) returns, 1928–2025.
   Accounts: taxable / traditional / Roth. Accumulation + pension + LTC.
   Path-consistent: all scenarios can share one return-path bundle.

   RULE: Do not "improve" this casually. It is verified. If you change it,
   the tests in engine.test.js must still pass. Terminal wealth is NOT the
   objective — it is only a ranking/sorting device. The engine reports
   success, depletion, balances over time; the UI decides what to show.
   ============================================================================ */

function fundGap(accounts, gap, taxRates, strategy = 'taxable-first'){
  let remainingNeed = gap;
  const breakdown = { taxable: 0, traditional: 0, roth: 0 };
  const taxBySource = { taxable: 0, traditional: 0 };
  let totalTax = 0;

  const workingBal = {
    taxable:     accounts.taxable.balance,
    traditional: accounts.traditional.balance,
    roth:        accounts.roth.balance
  };
  let workingBasis = accounts.taxable.basis;

  const effRateFor = (type) => {
    if(type === 'taxable'){
      const gainPct = workingBal.taxable > 0
        ? Math.max(0, (workingBal.taxable - workingBasis) / workingBal.taxable)
        : 0;
      return gainPct * taxRates.capitalGains;
    }
    if(type === 'traditional') return taxRates.ordinary;
    return 0;
  };

  const drawFrom = (type, netNeeded) => {
    if(workingBal[type] <= 0.01 || netNeeded <= 0.01) return;
    const rate = effRateFor(type);
    const grossNeeded = rate < 0.999 ? netNeeded / (1 - rate) : netNeeded;
    const withdrawn   = Math.min(grossNeeded, workingBal[type]);
    const tax         = withdrawn * rate;
    breakdown[type]  += withdrawn;
    totalTax         += tax;
    if(type === 'taxable' || type === 'traditional') taxBySource[type] += tax;
    workingBal[type] -= withdrawn;
    remainingNeed    -= (withdrawn - tax);
    if(type === 'taxable' && accounts.taxable.balance > 0){
      const basisPortion = workingBasis / accounts.taxable.balance;
      workingBasis = Math.max(0, workingBasis - withdrawn * basisPortion);
    }
  };

  if(strategy === 'proportional'){
    // Draw from all three proportionally to their current balances.
    // Compute each account's share of total, then draw that share of the need.
    // Overflow from depleted accounts falls through to sequential fallback.
    const total = workingBal.taxable + workingBal.traditional + workingBal.roth;
    if(total > 0.01){
      // For proportional we solve: each account nets its share of the gap.
      // Since each account has a different effective rate, we iterate once:
      // target net from each = gap × (balance / total), gross up by that acct's rate.
      const types = ['taxable', 'traditional', 'roth'];
      types.forEach(type => {
        if(workingBal[type] <= 0.01) return;
        const share = gap * (workingBal[type] / total);
        drawFrom(type, share);
      });
    }
    // Proportional may leave a small residual if accounts were insufficient;
    // fall through to taxable-first for any remainder.
    if(remainingNeed > 0.01){
      for(const type of ['taxable', 'traditional', 'roth']){
        if(remainingNeed <= 0.01) break;
        drawFrom(type, remainingNeed);
      }
    }
  } else {
    // Sequential strategies: taxable-first or traditional-first
    const order = strategy === 'traditional-first'
      ? ['traditional', 'taxable', 'roth']
      : ['taxable', 'traditional', 'roth'];
    for(const type of order){
      if(remainingNeed <= 0.01) break;
      drawFrom(type, remainingNeed);
    }
  }

  return {
    totalWithdrawn: breakdown.taxable + breakdown.traditional + breakdown.roth,
    totalTax,
    breakdown,
    taxBySource,
    shortfall: Math.max(0, remainingNeed)
  };
}

/* hoisted module constants the engine depends on */
const LONGRUN_INFLATION = 0.025;

// Social Security claim-age math (modern Full Retirement Age = 67, born 1960+).
// pia = Primary Insurance Amount = the benefit at FRA. The actual benefit is the
// pia adjusted for when you actually file (the real SSA schedule):
//   • file LATE  → delayed retirement credits, +8%/yr, capped at age 70.
//   • file EARLY → permanent reduction: 5/9 of 1% per month for the first 36
//     months before FRA, then 5/12 of 1% per month beyond that. (62 = 30% cut.)
const SS_FRA = 67;
function ssAdjust(pia, claimAge){
  const c = Math.max(62, Math.min(70, claimAge));
  if(c >= SS_FRA) return pia * (1 + 0.08 * (c - SS_FRA));
  const monthsEarly = (SS_FRA - c) * 12;
  const first36 = Math.min(monthsEarly, 36);
  const beyond  = Math.max(0, monthsEarly - 36);
  return pia * (1 - (first36 * (5/900) + beyond * (5/1200)));
}

const RETURN_DATA = [
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
const EQUITY_MIX = {
  usLarge: .50, usSmall: .10, intlDev: .22, emerging: .08, reit: .10
};
const DEFENSIVE_MIX = {
  usBonds: .75, cash: .17, gold: .08
};
function buildAssetWeights(eqShare){
  const fiShare = 1 - eqShare;
  const w = {};
  ASSET_KEYS.forEach(k => w[k] = 0);
  Object.keys(EQUITY_MIX).forEach(k => w[k] += eqShare * EQUITY_MIX[k]);
  Object.keys(DEFENSIVE_MIX).forEach(k => w[k] += fiShare * DEFENSIVE_MIX[k]);
  return w;
}
const RISK_PROFILES = {
  1: { label:'Conservative',   alloc:'30.00% Growth · 70.00% Defensive', eq:.30000, fi:.70000, weights:buildAssetWeights(.30000) },
  2: { label:'Balanced Cons.', alloc:'45.00% Growth · 55.00% Defensive', eq:.45000, fi:.55000, weights:buildAssetWeights(.45000) },
  3: { label:'Moderate',       alloc:'60.00% Growth · 40.00% Defensive', eq:.60000, fi:.40000, weights:buildAssetWeights(.60000) },
  4: { label:'Growth',         alloc:'75.00% Growth · 25.00% Defensive', eq:.75000, fi:.25000, weights:buildAssetWeights(.75000) },
  5: { label:'Aggressive',     alloc:'90.00% Growth · 10.00% Defensive', eq:.90000, fi:.10000, weights:buildAssetWeights(.90000) },
  6: { label:'All Equity',     alloc:'100.00% Growth · 0.00% Defensive', eq:1.00000, fi:.00000, weights:buildAssetWeights(1.00000) }
};

// ─── Per-asset stats (computed across each asset's available years) ─────
function computeAssetStats(data){
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
const ASSET_STATS = computeAssetStats(RETURN_DATA);

// ─── SECTION 3 — PLAN STATE ──────────────────────────────────────────────
// Portfolio is now a structured account container rather than a single balance.
// Three account types are modeled:
//   • Taxable: standard brokerage. Tracks both balance and cost basis. On
//     withdrawal, only the gain portion (balance minus basis) is taxed, and
//     at the long-term capital gains rate. Returns generate gains but don't
//     change basis, so the gain proportion grows as the account compounds.
//   • Traditional: IRA, 401(k), 403(b), etc. Entire withdrawal is taxed at
//     the ordinary income rate. (RMD modeling deferred to next phase.)
//   • Roth: Roth IRA, Roth 401(k). Withdrawals are tax-free.
//
// Tax rates split into ordinary income (used for traditional IRA withdrawals
// and the 85% taxable portion of Social Security) and long-term capital gains
// (used for the gain portion of taxable account withdrawals).
const plan = {
  meta: { version: 'v3.0-ledger', name: 'Demo Household', householdId: null, primaryName: '', spouseName: '', spouseAge: null, location: '', familyNotes: '', planningAsOfYear: 2026 },
  household: { primary: { currentAge: 65, planEndAge: 95, retirementAge: 65 }, spouse: null },
  portfolio: {
    riskProfile: 3,
    withdrawalStrategy: 'taxable-first',
    accounts: {
      taxable:     { balance: 2000000, basisPct: 0.50 },  // 50% basis, 50% gain
      traditional: { balance: 2000000 },                   // pre-tax retirement
      roth:        { balance: 1000000 }                     // tax-free
    },
    extraAccounts: []   // typed accounts (401k, SEP, …) that fold into a tax sleeve
  },
  savings: { annual: 0, split: { traditional: 1, roth: 0, taxable: 0 } },   // pre-retirement contribution ($/yr) + sleeve split — only applies when retirementAge > currentAge
  income: {
    // Social Security — per person. pia = the benefit at Full Retirement Age
    // (today's dollars), i.e. the number off the SSA statement. claimAge sets
    // when they file (62–70); the engine actuarially adjusts pia for that age.
    // spouse: null when single; otherwise { pia, claimAge }.
    socialSecurity: { primary: { pia: 36000, claimAge: 67 }, spouse: null },
    // Other income — an ARRAY of variable / time-limited streams (rental, part-time,
    // a fixed-period annuity). Each: { label, amount ($/yr, today's dollars),
    // startAge, endAge, realGrowth, taxablePct }.
    //   realGrowth: per-stream REAL growth/yr from its own startAge. 0 = flat real
    //     (the legacy default). Positive = rises above inflation (rent indexed up);
    //     NEGATIVE = phases down in real terms (part-time wind-down).
    //   taxablePct: share taxed at the ordinary rate. 1 = fully taxable (legacy
    //     default); <1 models partly/fully tax-free income (return of capital,
    //     muni interest, gifts received).
    // Both default to the prior flat-real, fully-taxed behavior, so existing plans
    // are unchanged. A legacy single {amount,startAge,endAge} object is still
    // accepted (wrapped into a one-element array).
    other:          [],
    // Pension: a DISCRETE benefit-by-age map taken straight off the plan statement
    // ({ age: annualBenefit, ... }) — the advisor enters only ages they actually
    // have a number for. The engine NEVER interpolates or extrapolates a missing
    // age (that would invent data we don't have). startAge = the chosen collection
    // age; if it isn't a key in benefitByAge the modeled benefit is 0. COLA =
    // nominal annual escalator (0 = none), modeled like the SS COLA. `base` is kept
    // only as a legacy single-amount fallback.
    pension:        { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 }
  },
  incomeTax: { adjustments: [], deductions: [], deductionMode: 'auto' },
  // expenses: the fixed essential scalars PLUS `extra` — an array of discretionary,
  // time-bounded spending lines ({ label, amount, startAge, endAge }). Discretionary
  // extras flex with the spending lever (spendMult), flat-real otherwise. Empty default.
  // healthcareRealGrowth: annual real growth rate for healthcare above general CPI
  // (historically ~2%/yr; 0 = flat real). Applied from retirement age forward.
  expenses:   { living: 188000, housing: 0, debt: 0, healthcare: 12000, extra: [], healthcareRealGrowth: 0.02 },
  // Recurring time-bounded obligations (a mortgage, a car loan, a tuition plan).
  // Each: { label, amount ($/yr, today's dollars), startAge, endAge, colaPct }.
  // colaPct is the NOMINAL annual escalator like the pension: 0 = a fixed-nominal
  // payment, which the real-dollar engine erodes at −LONGRUN_INFLATION (a fixed
  // mortgage gets cheaper in real terms over its term). Empty by default.
  liabilities: [],
  // Properties — real assets, each with an OPTIONAL engine-native mortgage. The
  // engine amortizes the mortgage ({ balance, rate %, termYears }) into a fixed
  // annual payment that runs as a liability until payoff (startAge + termYears),
  // eroding in real terms like any fixed-nominal debt. `value` (current) and
  // `purchasePrice` (cost basis) stay INERT until a sale is triggered.
  //   commissionPct: total agent commission deducted from gross proceeds (default
  //     5%; set 0 for a business or FSBO sale).
  //   appreciation: real growth/yr of the asset's value until sale (default 0 =
  //     holds today's value in real terms).
  // The SALE itself is never stored here — it's an `assetSale` OVERRIDE applied
  // per scenario ({ asset: <index>, age: <saleAge> }), so the Baseline never
  // carries it and there's nothing to "zero out" to compare sell-vs-keep.
  properties: [],
  ltc:        { amount: 0, onsetAge: 85 },   // flat long-term-care cost ($/yr) from onsetAge onward
  // goals — an ARRAY of spend goals ({ name, amount, startAge, endAge }). A recurring
  // goal spans many years; a ONE-TIME goal is a single-year window (startAge===endAge).
  // Applied flat-real. A legacy { vacation, property, gifts } object is still accepted.
  goals:      [
    { name:'Vacation',         amount:15000, startAge:0, endAge:999 },
    { name:'Home improvements', amount:10000, startAge:0, endAge:999 },
    { name:'Gifts',            amount:5000,  startAge:0, endAge:999 },
  ],
  taxes:      { ordinary: 22, capitalGains: 15 },
  simulation: { iterations: 1000 }
};

// Standard fixed-rate amortization → the NOMINAL ANNUAL payment (12 monthly
// payments). `ratePct` is the APR in percent; rate 0 → straight-line. This is the
// ONLY mortgage math the engine derives; the resulting payment is then run through
// the existing (tested) liability cash-flow path, so mortgages add no new sim-loop
// surface. Returns 0 for a paid-off or term-less loan.
function annualMortgagePayment(balance, ratePct, termYears){
  const P = Math.max(0, balance || 0);
  const yrs = Math.max(0, termYears || 0);
  if(P <= 0 || yrs <= 0) return 0;
  const mr = (Math.max(0, ratePct || 0) / 100) / 12;
  const N  = yrs * 12;
  const monthly = (mr < 1e-9) ? P / N : (P * mr) / (1 - Math.pow(1 + mr, -N));
  return monthly * 12;
}

// Remaining NOMINAL balance of an amortizing loan after `yearsElapsed`. Mirrors
// annualMortgagePayment's monthly compounding so the payoff figure when a
// property is SOLD mid-term reconciles with the payment that's been running.
function mortgageBalanceRemaining(balance, ratePct, termYears, yearsElapsed){
  const P = Math.max(0, balance || 0);
  const yrs = Math.max(0, termYears || 0);
  if(P <= 0 || yrs <= 0) return 0;
  const mr = (Math.max(0, ratePct || 0) / 12) / 100;
  const N  = yrs * 12;
  const n  = Math.max(0, Math.min(N, Math.round((yearsElapsed || 0) * 12)));
  if(mr < 1e-9) return P * (1 - n / N);                       // 0% = straight-line
  return P * (Math.pow(1 + mr, N) - Math.pow(1 + mr, n)) / (Math.pow(1 + mr, N) - 1);
}



// Seeded RNG (mulberry32). The bootstrap draws are deterministic so identical
// inputs reproduce an identical success % — no sampling drift on page refresh.
// Distribution is unchanged; this only fixes *which* draws come out. Call
// resetSeed() before generating a bundle to reproduce it; pass a fresh seed
// (e.g. Date.now()) only if you deliberately want a new random bundle.
const DEFAULT_SEED = 0x9e3779b9;
const PROJECTION_EXECUTION_LIMITS = Object.freeze({
  maxIterations: 1000,
  maxHorizonYears: 126,
});
let _rngState = DEFAULT_SEED >>> 0;
function resetSeed(seed = DEFAULT_SEED){ _rngState = seed >>> 0; }
function rand(){
  _rngState = (_rngState + 0x6D2B79F5) >>> 0;
  let t = _rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function projectionRangeError(code, message){
  const error = new RangeError(message);
  error.code = code;
  return error;
}

function validateProjectionHorizon(horizonYears, label = 'projection horizon'){
  if(!Number.isInteger(horizonYears)
      || horizonYears < 1
      || horizonYears > PROJECTION_EXECUTION_LIMITS.maxHorizonYears){
    throw projectionRangeError(
      'PROJECTION_HORIZON_OUT_OF_RANGE',
      `${label} must be an integer between 1 and ${PROJECTION_EXECUTION_LIMITS.maxHorizonYears} years`,
    );
  }
  return horizonYears;
}

function validateProjectionIterations(iterations){
  if(!Number.isInteger(iterations)
      || iterations < 1
      || iterations > PROJECTION_EXECUTION_LIMITS.maxIterations){
    throw projectionRangeError(
      'PROJECTION_ITERATIONS_OUT_OF_RANGE',
      `simulation iterations must be an integer between 1 and ${PROJECTION_EXECUTION_LIMITS.maxIterations}`,
    );
  }
  return iterations;
}

function validateReturnPaths(returnPaths, horizonYears){
  if(!Array.isArray(returnPaths)){
    throw projectionRangeError(
      'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
      'returnPaths must be an array when supplied',
    );
  }
  validateProjectionIterations(returnPaths.length);
  returnPaths.forEach((path, index) => {
    if(!Array.isArray(path)
        || path.length < horizonYears
        || path.length > PROJECTION_EXECUTION_LIMITS.maxHorizonYears){
      throw projectionRangeError(
        'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
        `returnPaths[${index}] must contain between ${horizonYears} and ${PROJECTION_EXECUTION_LIMITS.maxHorizonYears} years`,
      );
    }
  });
}

function generateReturnPath(horizonYears){
  validateProjectionHorizon(horizonYears, 'return path horizon');
  const path = [];
  const minBlock = 3, maxBlock = 5;
  while(path.length < horizonYears){
    const blockLen = minBlock + Math.floor(rand() * (maxBlock - minBlock + 1));
    const maxStart = RETURN_DATA.length - blockLen;
    const startIdx = Math.floor(rand() * (maxStart + 1));
    for(let i = 0; i < blockLen && path.length < horizonYears; i++){
      path.push(RETURN_DATA[startIdx + i]);
    }
  }
  return path;
}


function attachSelectedAccountDiagnostics(analysis, inputs, options){
  const detailedByIndex = new Map();
  for(const [pathKey, compact] of Object.entries(analysis.paths)){
    const index = compact.simIndex;
    let detailed = detailedByIndex.get(index);
    if(!detailed){
      detailed = runSinglePath(inputs, compact.returnPath, {
        ...options,
        includeAccountDiagnostics: true,
      });
      detailed.simIndex = index;
      detailed.returnPath = compact.returnPath;
      detailedByIndex.set(index, detailed);
      analysis.sims[index] = detailed;
    }
    analysis.paths[pathKey] = detailed;
  }
  return analysis;
}

function runSimulation(plan, overrides = {}, returnPaths = null, options = {}){
  const inputs = resolveInputs(plan, overrides);
  if(inputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  if(returnPaths !== null) validateReturnPaths(returnPaths, inputs.horizonYears);
  const sims = [];
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  const runOptions = {
    ...options,
    projectionReturnCache,
  };
  // Monte Carlo selection needs compact numeric rows for every trial, but the
  // account-allocation detail is consumed only by the representative paths.
  // Never materialize internal per-account detail, then re-run the at-most-five
  // selected paths with it.
  // When a return-path bundle is supplied it is authoritative: iterate over
  // exactly those paths so identical inputs + identical paths are reproducible.
  // (Silently generating random fill paths for missing indices broke that.)
  const iterations = returnPaths !== null ? returnPaths.length : inputs.iterations;
  for(let s = 0; s < iterations; s++){
    const returnPath = returnPaths
      ? returnPaths[s]
      : generateReturnPath(inputs.horizonYears);
    let sim;
    try{
      sim = runSinglePath(inputs, returnPath, {
        ...runOptions,
        includeAccountDiagnostics: false,
      });
    }catch(error){
      // A genuinely unresolvable RMD fails CLOSED — it must not escape as an
      // uncontrolled exception (which discards every scenario and leaves the UI
      // with a bare dash), and it must not be treated as zero and quietly
      // produce an authoritative-looking percentage. Callers get a structured
      // result carrying the reason and the rows computed before the stop.
      if(error?.code === 'HOUSEHOLD_RMD_UNAVAILABLE'){
        return {
          projectionStatus: 'unavailable',
          issue: error.rmdIssue || error.code,
          issueAge: error.age ?? null,
          rowsThroughIssue: error.rows || [],
          successRate: null,
        };
      }
      throw error;
    }
    sim.simIndex = s;  // anchor for path-coherent cross-strategy comparison
    sim.returnPath = returnPath;  // preserve coherent path for summary resilience / elasticity diagnostics
    sims.push(sim);
  }
  return attachSelectedAccountDiagnostics(
    analyzeResults(sims, inputs),
    inputs,
    runOptions,
  );
}


const WITHDRAWAL_PLANNER_LEVER_KEYS = Object.freeze([
  'taxableWithdrawal',
  'deferredWithdrawal',
  'rothConversion',
  'rothWithdrawal',
  'qcd',
]);
const TRADITIONAL_WITHDRAWAL_LEVERS = Object.freeze([
  'deferredWithdrawal',
  'rothConversion',
  'qcd',
]);

function finiteAge(value, fallback, path){
  const resolved = value == null ? fallback : value;
  if(typeof resolved !== 'number' || !Number.isFinite(resolved) || !Number.isInteger(resolved)){
    throw new TypeError(`${path} must be a finite integer`);
  }
  return resolved;
}

function finiteOptionalAge(value, path){
  if(value == null) return null;
  if(typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)){
    throw new TypeError(`${path} must be a finite integer or null`);
  }
  return value;
}

function mapPersonAgeToPrimary(primaryCurrentAge, personCurrentAge, personAge){
  return primaryCurrentAge + (personAge - personCurrentAge);
}

function resolveHouseholdTimeline(plan, overrides = {}){
  const clientPlan = plan?.household?.primary;
  if(!clientPlan) throw new TypeError('household.primary is required');
  const spousePlan = plan.household.spouse || null;
  const ss = plan?.income?.socialSecurity || {};
  const retirementDelay = overrides.retireDelay || 0;
  const longevityYears = overrides.longevityYears || 0;
  const currentTaxYear = Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
  if(typeof longevityYears !== 'number' || !Number.isFinite(longevityYears)
      || longevityYears < 0){
    throw new TypeError('longevityYears must be a finite nonnegative number');
  }
  const clientCurrentAge = finiteAge(clientPlan.currentAge, null, 'household.primary.currentAge');
  const clientBirthDateFact = plan?.taxProfiles?.client?.birthDate;
  const clientProfileBirthDate = clientBirthDateFact?.status === 'confirmed'
    ? clientBirthDateFact.value
    : null;
  const clientProfileBirthYear = typeof clientProfileBirthDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(clientProfileBirthDate)
    ? Number(clientProfileBirthDate.slice(0, 4))
    : null;
  const clientHouseholdBirthYear = Number.isInteger(clientPlan.birthYear)
    ? clientPlan.birthYear
    : null;
  const clientBirthYearConflict = clientProfileBirthYear !== null
    && clientHouseholdBirthYear !== null
    && clientProfileBirthYear !== clientHouseholdBirthYear;
  const clientBirthYear = clientProfileBirthYear ?? clientHouseholdBirthYear;
  const clientEarlierPossibleBirthYear = currentTaxYear - clientCurrentAge - 1;
  const clientLaterPossibleBirthYear = currentTaxYear - clientCurrentAge;
  const clientEarlierPossibleRmdAge = clientEarlierPossibleBirthYear >= 1960
    ? 75
    : (clientEarlierPossibleBirthYear >= 1951 ? 73 : 72);
  const clientLaterPossibleRmdAge = clientLaterPossibleBirthYear >= 1960
    ? 75
    : (clientLaterPossibleBirthYear >= 1951 ? 73 : 72);
  const clientBirthYearConsistent = !clientBirthYearConflict
    && (clientBirthYear === null
      || clientCurrentAge === currentTaxYear - clientBirthYear
      || clientCurrentAge === currentTaxYear - clientBirthYear - 1);
  const clientRmdStartAge = !clientBirthYearConsistent
    ? null
    : clientBirthYear === null
    ? (clientEarlierPossibleRmdAge === clientLaterPossibleRmdAge
      ? clientEarlierPossibleRmdAge
      : null)
    : (clientBirthYear >= 1960 ? 75 : (clientBirthYear >= 1951 ? 73 : 72));
  const clientRetirementFact = finiteOptionalAge(
    clientPlan.retirementAge,
    'household.primary.retirementAge'
  );
  const clientRetirementAge = clientRetirementFact === null
    ? null
    : clientRetirementFact + retirementDelay;
  const clientClaimFact = finiteOptionalAge(
    ss.primary?.claimAge,
    'income.socialSecurity.primary.claimAge'
  );
  const clientClaimAge = clientClaimFact === null
    ? null
    : Math.max(62, Math.min(70, clientClaimFact + (overrides.ssDelayYears || 0)));
  const clientBaseEndAge = finiteOptionalAge(
    clientPlan.planEndAge,
    'household.primary.planEndAge'
  );
  if(clientBaseEndAge !== null && clientBaseEndAge < clientCurrentAge){
    throw new RangeError('household.primary.planEndAge cannot precede currentAge');
  }
  const clientEndAge = clientBaseEndAge === null
    ? null
    : clientBaseEndAge + longevityYears;
  const client = Object.freeze({
    currentAge: clientCurrentAge,
    birthYear: clientBirthYear,
    rmdStartAge: clientRmdStartAge,
    retirementAge: clientRetirementAge,
    socialSecurityClaimAge: clientClaimAge,
    planEndAge: clientEndAge,
    retirementAgeOnPrimaryTimeline: clientRetirementAge,
    socialSecurityClaimAgeOnPrimaryTimeline: clientClaimAge,
    planEndAgeOnPrimaryTimeline: clientEndAge,
  });

  let spouse = null;
  if(spousePlan){
    const spouseCurrentAge = finiteOptionalAge(
      spousePlan.currentAge,
      'household.spouse.currentAge'
    );
    const spouseBirthDateFact = plan?.taxProfiles?.spouse?.birthDate;
    const spouseProfileBirthDate = spouseBirthDateFact?.status === 'confirmed'
      ? spouseBirthDateFact.value
      : null;
    const spouseProfileBirthYear = typeof spouseProfileBirthDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(spouseProfileBirthDate)
      ? Number(spouseProfileBirthDate.slice(0, 4))
      : null;
    const spouseHouseholdBirthYear = Number.isInteger(spousePlan.birthYear)
      ? spousePlan.birthYear
      : null;
    const spouseBirthYearConflict = spouseProfileBirthYear !== null
      && spouseHouseholdBirthYear !== null
      && spouseProfileBirthYear !== spouseHouseholdBirthYear;
    const spouseBirthYear = spouseProfileBirthYear ?? spouseHouseholdBirthYear;
    const spouseEarlierPossibleBirthYear = spouseCurrentAge === null
      ? null
      : currentTaxYear - spouseCurrentAge - 1;
    const spouseLaterPossibleBirthYear = spouseCurrentAge === null
      ? null
      : currentTaxYear - spouseCurrentAge;
    const spouseEarlierPossibleRmdAge = spouseEarlierPossibleBirthYear === null
      ? null
      : (spouseEarlierPossibleBirthYear >= 1960
        ? 75
        : (spouseEarlierPossibleBirthYear >= 1951 ? 73 : 72));
    const spouseLaterPossibleRmdAge = spouseLaterPossibleBirthYear === null
      ? null
      : (spouseLaterPossibleBirthYear >= 1960
        ? 75
        : (spouseLaterPossibleBirthYear >= 1951 ? 73 : 72));
    const spouseBirthYearConsistent = !spouseBirthYearConflict
      && (spouseBirthYear === null
        || spouseCurrentAge === currentTaxYear - spouseBirthYear
        || spouseCurrentAge === currentTaxYear - spouseBirthYear - 1);
    const spouseRmdStartAge = !spouseBirthYearConsistent
      ? null
      : spouseBirthYear === null
      ? (spouseEarlierPossibleRmdAge !== null
          && spouseEarlierPossibleRmdAge === spouseLaterPossibleRmdAge
        ? spouseEarlierPossibleRmdAge
        : null)
      : (spouseBirthYear >= 1960 ? 75 : (spouseBirthYear >= 1951 ? 73 : 72));
    const spouseRetirementFact = finiteOptionalAge(
      spousePlan.retirementAge,
      'household.spouse.retirementAge'
    );
    const spouseRetirementAge = spouseCurrentAge === null || spouseRetirementFact === null
      ? null
      : spouseRetirementFact + retirementDelay;
    const spouseClaimFact = finiteOptionalAge(
      ss.spouse?.claimAge,
      'income.socialSecurity.spouse.claimAge'
    );
    const spouseClaimAge = spouseClaimFact === null
      ? null
      : Math.max(62, Math.min(70, spouseClaimFact));
    const spouseBaseEndAge = finiteOptionalAge(
      spousePlan.planEndAge,
      'household.spouse.planEndAge'
    );
    if(spouseCurrentAge !== null && spouseBaseEndAge !== null
        && spouseBaseEndAge < spouseCurrentAge){
      throw new RangeError('household.spouse.planEndAge cannot precede currentAge');
    }
    const spouseEndAge = spouseBaseEndAge === null
      ? null
      : spouseBaseEndAge + longevityYears;
    spouse = Object.freeze({
      currentAge: spouseCurrentAge,
      birthYear: spouseBirthYear,
      rmdStartAge: spouseRmdStartAge,
      retirementAge: spouseRetirementAge,
      socialSecurityClaimAge: spouseClaimAge,
      planEndAge: spouseEndAge,
      retirementAgeOnPrimaryTimeline: spouseCurrentAge === null
        || spouseRetirementAge === null
        ? null
        : mapPersonAgeToPrimary(clientCurrentAge, spouseCurrentAge, spouseRetirementAge),
      socialSecurityClaimAgeOnPrimaryTimeline: spouseCurrentAge === null
        || spouseClaimAge === null
        ? null
        : mapPersonAgeToPrimary(clientCurrentAge, spouseCurrentAge, spouseClaimAge),
      planEndAgeOnPrimaryTimeline: spouseCurrentAge === null || spouseEndAge === null
        ? null
        : mapPersonAgeToPrimary(clientCurrentAge, spouseCurrentAge, spouseEndAge),
    });
  }

  const retirementMilestones = [
    client.retirementAgeOnPrimaryTimeline,
    spouse?.retirementAgeOnPrimaryTimeline,
  ].filter(Number.isFinite);
  const endMilestones = [
    client.planEndAgeOnPrimaryTimeline,
    spouse?.planEndAgeOnPrimaryTimeline,
  ].filter(Number.isFinite);
  const retirementComplete = client.retirementAgeOnPrimaryTimeline !== null
    && (!spouse || spouse.retirementAgeOnPrimaryTimeline !== null);
  const endComplete = client.planEndAgeOnPrimaryTimeline !== null
    && (!spouse || spouse.planEndAgeOnPrimaryTimeline !== null);
  return Object.freeze({
    people: Object.freeze({ client, spouse }),
    householdRetirementAgeOnPrimaryTimeline: retirementComplete
      ? Math.max(...retirementMilestones)
      : null,
    householdEndAgeOnPrimaryTimeline: endComplete
      ? Math.max(...endMilestones)
      : null,
    completeForSimulation: retirementComplete && endComplete,
  });
}

function normalizeWithdrawalPlannerLevers(requested = {}){
  const out = {};
  for(const key of WITHDRAWAL_PLANNER_LEVER_KEYS){
    const value = requested[key] ?? 0;
    if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
      throw new TypeError(`${key} must be a finite nonnegative number`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function resolveWithdrawalPlannerAccountState(
  plan,
  requestedLevers = {},
  accountReservations = {}
){
  const requested = normalizeWithdrawalPlannerLevers(requestedLevers);
  const reservedTraditionalTotal = accountReservations?.traditionalTotal
    ?? accountReservations?.traditional
    ?? 0;
  const reservedRmdEligibleCash = accountReservations?.rmdEligibleCash ?? 0;
  const focusTaxYear = accountReservations?.taxYear
    ?? (Number.isInteger(plan?.meta?.planningAsOfYear)
      ? plan.meta.planningAsOfYear
      : 2026);
  if(typeof reservedTraditionalTotal !== 'number'
      || !Number.isFinite(reservedTraditionalTotal)
      || reservedTraditionalTotal < 0){
    throw new TypeError('accountReservations.traditionalTotal must be a finite nonnegative number');
  }
  if(typeof reservedRmdEligibleCash !== 'number'
      || !Number.isFinite(reservedRmdEligibleCash)
      || reservedRmdEligibleCash < 0
      || reservedRmdEligibleCash > reservedTraditionalTotal){
    throw new TypeError('accountReservations.rmdEligibleCash must be within traditionalTotal');
  }
  if(!Number.isInteger(focusTaxYear)){
    throw new TypeError('accountReservations.taxYear must be an integer');
  }
  let reservedTraditionalByOwner = null;
  if(accountReservations?.traditionalByOwner != null){
    if(typeof accountReservations.traditionalByOwner !== 'object'
        || Array.isArray(accountReservations.traditionalByOwner)){
      throw new TypeError('accountReservations.traditionalByOwner must be an object');
    }
    reservedTraditionalByOwner = {
      client: accountReservations.traditionalByOwner.client ?? 0,
      spouse: accountReservations.traditionalByOwner.spouse ?? 0,
    };
    if(Object.values(reservedTraditionalByOwner).some(value => (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ))){
      throw new TypeError('accountReservations.traditionalByOwner values must be finite and nonnegative');
    }
  }
  let reservedRmdEligibleCashByOwner = null;
  if(accountReservations?.rmdEligibleCashByOwner != null){
    if(typeof accountReservations.rmdEligibleCashByOwner !== 'object'
        || Array.isArray(accountReservations.rmdEligibleCashByOwner)){
      throw new TypeError('accountReservations.rmdEligibleCashByOwner must be an object');
    }
    reservedRmdEligibleCashByOwner = {
      client: accountReservations.rmdEligibleCashByOwner.client ?? 0,
      spouse: accountReservations.rmdEligibleCashByOwner.spouse ?? 0,
    };
    if(Object.values(reservedRmdEligibleCashByOwner).some(value => (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ))){
      throw new TypeError('accountReservations.rmdEligibleCashByOwner values must be finite and nonnegative');
    }
  }
  const fold = resolvePortfolioAccounts(plan);
  const balances = { taxable: 0, traditional: 0, roth: 0 };
  const traditionalBalancesByOwner = { client: 0, spouse: 0 };
  let traditionalBalanceAttributionAvailable = true;
  const excludedAccountIds = [];
  const accountSourceIssues = [];
  const legacyPools = new Set();
  const typedPools = new Set();
  for(const account of fold.accounts){
    const raw = account.sourceKind === 'typed-account'
      ? plan?.portfolio?.extraAccounts?.[account.sourceIndex]
      : null;
    const canonical = account.sourceKind === 'typed-account'
      ? getAccountTypeById(account.typeId)
      : null;
    const reportingGap = account.sourceKind === 'typed-account'
      && canonical?.supportedForTax === true
      ? resolveAccountTaxReportingGap(raw, account, plan)
      : null;
    const ownerAvailable = account.owner !== 'spouse'
      || Boolean(plan?.household?.spouse);
    const eligible = ownerAvailable
      && account.taxBucketGroup
      && !account.strategyRulesPending
      && (account.sourceKind === 'legacy-base'
        || (account.classificationStatus === 'included'
          && canonical?.supportedForTax === true
          && reportingGap === null));
    if(eligible){
      balances[account.taxBucketGroup] += account.balance;
      if(account.taxBucketGroup === 'traditional' && account.balance > 0){
        if(account.sourceKind === 'typed-account'
            && (account.owner === 'client' || account.owner === 'spouse')){
          traditionalBalancesByOwner[account.owner] += account.balance;
        }else{
          traditionalBalanceAttributionAvailable = false;
        }
      }
      if(account.balance > 0){
        (account.sourceKind === 'legacy-base' ? legacyPools : typedPools)
          .add(account.taxBucketGroup);
      }
    }else if(account.balance > 0){
      excludedAccountIds.push(account.id);
      if(!ownerAvailable){
        accountSourceIssues.push(`ACCOUNT_OWNER_UNAVAILABLE:${account.id}`);
      }else if(account.sourceKind === 'typed-account'
          && canonical?.supportedForTax !== true){
        accountSourceIssues.push(`ACCOUNT_TAX_SCOPE_UNAVAILABLE:${account.id}`);
      }else if(reportingGap){
        accountSourceIssues.push(`${reportingGap.code}:${account.id}`);
      }
    }
  }
  const ambiguousPools = new Set(
    [...legacyPools].filter(pool => typedPools.has(pool))
  );

  const availableFor = pool => ambiguousPools.has(pool) ? null : balances[pool];
  const taxableAvailable = availableFor('taxable');
  const traditionalAvailable = availableFor('traditional');
  const rothAvailable = availableFor('roth');
  let rmdStatus = 'not-required';
  let rmdOwner = null;
  let rmdAge = null;
  let rmdApplicableAge = null;
  let rmdPriorYearEndBalance = null;
  let rmdRequired = 0;
  let rmdIssue = null;
  let rmdByOwner = null;
  let rmdContainsEmployerPlan = false;
  if(traditionalAvailable === null){
    rmdStatus = 'unavailable';
    rmdRequired = null;
    rmdIssue = 'ACCOUNT_POOL_AMBIGUOUS';
  }else if(traditionalAvailable > 0.01){
    try{
      const resolved = resolveInputs(plan, {});
      const contract = resolved.rmdContract;
      const baseTaxYear = contract?.planningAsOfYear
        ?? (Number.isInteger(plan?.meta?.planningAsOfYear)
          ? plan.meta.planningAsOfYear
          : 2026);
      const primaryAge = resolved.currentAge + (focusTaxYear - baseTaxYear);
      const householdState = householdTaxStatusAtAge(resolved, primaryAge);
      const ownerContracts = Object.entries(contract?.byOwner || {});
      const exactMultiOwnerFocus = traditionalBalanceAttributionAvailable
        && ownerContracts.length > 1
        && ownerContracts.every(([owner, ownerContract]) => (
          Math.abs(
            ownerContract.balance - (traditionalBalancesByOwner[owner] ?? 0)
          ) <= 0.01
        ));
      if(exactMultiOwnerFocus){
        const evaluated = evaluateRmdByOwner(contract, householdState, {
          focusYearMatchesBase: focusTaxYear === baseTaxYear,
        });
        rmdByOwner = evaluated.byOwner;
        rmdOwner = null;
        rmdAge = null;
        rmdApplicableAge = null;
        rmdPriorYearEndBalance = evaluated.priorYearEndComplete
          ? evaluated.priorYearEndTotal
          : null;
        rmdStatus = evaluated.status;
        rmdRequired = evaluated.requiredTotal;
        rmdIssue = evaluated.issue;
      }else{
        const person = contract?.owner
          ? householdState.people?.[contract.owner]
          : null;
        rmdOwner = contract?.owner ?? null;
        rmdContainsEmployerPlan = contract?.containsEmployerPlan === true;
        rmdAge = person?.age ?? null;
        rmdApplicableAge = contract?.startAge ?? null;
        rmdPriorYearEndBalance = contract?.priorYearEndBalance ?? null;
        if(!contract?.available || !contract.owner){
          const possibleOwners = contract?.owner
            ? [householdState.people?.[contract.owner]].filter(Boolean)
            : Object.values(householdState.people || {}).filter(Boolean);
          const noCurrentRmdExposure = possibleOwners.length > 0
            && possibleOwners.every(candidate => (
              candidate.alive === true
                && typeof candidate.age === 'number'
                && candidate.age < (candidate.rmdStartAge ?? 72)
            ));
          if(noCurrentRmdExposure){
            rmdStatus = 'not-required';
          }else{
            rmdStatus = 'unavailable';
            rmdRequired = null;
            rmdIssue = contract?.issue ?? 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE';
          }
        }else if(!person?.alive){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE';
        }else if(person.age < contract.startAge){
          rmdStatus = 'not-required';
        }else if(focusTaxYear !== baseTaxYear){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'RMD_FOCUS_YEAR_BALANCE_UNAVAILABLE';
        }else if(contract.focusRulesAvailable !== true){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE';
        }else if(contract.containsEmployerPlan && person.retired !== true){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE';
        }else if(contract.priorYearEndBalanceAvailable !== true
            || !Number.isFinite(contract.priorYearEndBalance)){
          rmdStatus = 'unavailable';
          rmdRequired = null;
          rmdIssue = 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE';
        }else{
          rmdStatus = 'known';
          rmdRequired = contract.priorYearEndBalance / rmdDivisor(person.age);
        }
      }
    }catch(error){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = error?.code ?? 'RMD_CONTRACT_UNAVAILABLE';
    }
  }

  let appliedReservedTraditionalTotal = reservedTraditionalTotal;
  let appliedReservedRmdEligibleCash = reservedRmdEligibleCash;
  let traditionalOwnerCapacityIssue = null;
  let traditionalOwnerAttributionMissing = false;
  let rmdOwnerCapacityIssue = null;
  // Aggregate current-return IRA activity can reserve household capacity until
  // an owner-specific RMD obligation makes attribution legally relevant.
  if(rmdByOwner && rmdStatus !== 'not-required'){
    const traditionalOwnerTotal = reservedTraditionalByOwner
      ? reservedTraditionalByOwner.client + reservedTraditionalByOwner.spouse
      : null;
    const rmdCashOwnerTotal = reservedRmdEligibleCashByOwner
      ? reservedRmdEligibleCashByOwner.client + reservedRmdEligibleCashByOwner.spouse
      : null;
    const traditionalOwnerAttributionAvailable = reservedTraditionalTotal === 0
      || (traditionalOwnerTotal !== null
        && Math.abs(traditionalOwnerTotal - reservedTraditionalTotal) <= 0.01);
    const rmdCashOwnerAttributionAvailable = reservedRmdEligibleCash === 0
      || (rmdCashOwnerTotal !== null
        && Math.abs(rmdCashOwnerTotal - reservedRmdEligibleCash) <= 0.01);
    const ownerCashWithinTraditional = reservedTraditionalByOwner
      && reservedRmdEligibleCashByOwner
      ? ['client', 'spouse'].every(owner => (
        reservedRmdEligibleCashByOwner[owner] <= reservedTraditionalByOwner[owner] + 0.01
      ))
      : reservedRmdEligibleCash === 0;
    if(traditionalOwnerAttributionAvailable && reservedTraditionalByOwner){
      appliedReservedTraditionalTotal = reservedTraditionalByOwner.client
        + reservedTraditionalByOwner.spouse;
    }
    if(rmdCashOwnerAttributionAvailable && reservedRmdEligibleCashByOwner){
      appliedReservedRmdEligibleCash = reservedRmdEligibleCashByOwner.client
        + reservedRmdEligibleCashByOwner.spouse;
    }
    traditionalOwnerAttributionMissing = !traditionalOwnerAttributionAvailable
      || !rmdCashOwnerAttributionAvailable
      || !ownerCashWithinTraditional;
    if(traditionalOwnerAttributionMissing && rmdStatus === 'known'){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE';
    }
  }else if(rmdOwner && plan?.household?.spouse){
    const traditionalOwnerTotal = reservedTraditionalByOwner
      ? reservedTraditionalByOwner.client + reservedTraditionalByOwner.spouse
      : null;
    const rmdCashOwnerTotal = reservedRmdEligibleCashByOwner
      ? reservedRmdEligibleCashByOwner.client + reservedRmdEligibleCashByOwner.spouse
      : null;
    const traditionalOwnerAttributionAvailable = reservedTraditionalTotal === 0
      || (traditionalOwnerTotal !== null
        && Math.abs(traditionalOwnerTotal - reservedTraditionalTotal) <= 0.01);
    const rmdCashOwnerAttributionAvailable = reservedRmdEligibleCash === 0
      || (rmdCashOwnerTotal !== null
        && Math.abs(rmdCashOwnerTotal - reservedRmdEligibleCash) <= 0.01);
    const ownerCashWithinTraditional = reservedTraditionalByOwner
      && reservedRmdEligibleCashByOwner
      ? ['client', 'spouse'].every(owner => (
        reservedRmdEligibleCashByOwner[owner] <= reservedTraditionalByOwner[owner] + 0.01
      ))
      : reservedRmdEligibleCash === 0;
    if(traditionalOwnerAttributionAvailable && reservedTraditionalByOwner){
      appliedReservedTraditionalTotal = reservedTraditionalByOwner[rmdOwner];
    }
    if(rmdCashOwnerAttributionAvailable && reservedRmdEligibleCashByOwner){
      appliedReservedRmdEligibleCash = reservedRmdEligibleCashByOwner[rmdOwner];
    }
    if(rmdStatus === 'known'
        && (!traditionalOwnerAttributionAvailable
          || !rmdCashOwnerAttributionAvailable
          || !ownerCashWithinTraditional)){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE';
    }
  }
  if(rmdStatus === 'known'){
    const employerPlanCashOwner = rmdByOwner
      ? Object.entries(rmdByOwner).find(([owner, detail]) => (
        detail.containsEmployerPlan === true
          && (reservedRmdEligibleCashByOwner?.[owner] ?? 0) > 0
      ))?.[0] ?? null
      : (rmdContainsEmployerPlan && appliedReservedRmdEligibleCash > 0
        ? rmdOwner
        : null);
    if(employerPlanCashOwner){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = 'EMPLOYER_PLAN_RMD_CASH_ATTRIBUTION_UNAVAILABLE';
      if(rmdByOwner?.[employerPlanCashOwner]){
        rmdByOwner[employerPlanCashOwner] = {
          ...rmdByOwner[employerPlanCashOwner],
          status: 'unavailable',
          required: null,
          issue: rmdIssue,
        };
      }
    }
  }
  if(rmdByOwner && reservedTraditionalByOwner){
    for(const owner of Object.keys(rmdByOwner)){
      const reserved = reservedTraditionalByOwner[owner] ?? 0;
      const available = traditionalBalancesByOwner[owner] ?? 0;
      if(reserved > available + 0.01){
        traditionalOwnerCapacityIssue = {
          code: 'TRADITIONAL_OWNER_POOL_EXCEEDED',
          owner,
          requested: reserved,
          available,
        };
        break;
      }
    }
  }
  let rmdMinimumCash = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - appliedReservedRmdEligibleCash)
    : 0;
  if(rmdByOwner && rmdStatus === 'known'){
    rmdMinimumCash = 0;
    for(const [owner, detail] of Object.entries(rmdByOwner)){
      const fixedTraditional = reservedTraditionalByOwner?.[owner] ?? 0;
      const fixedCash = reservedRmdEligibleCashByOwner?.[owner] ?? 0;
      const ownerFloor = detail.status === 'known'
        ? Math.max(0, detail.required - fixedCash)
        : 0;
      rmdMinimumCash += ownerFloor;
      if(!traditionalOwnerCapacityIssue
          && fixedTraditional + ownerFloor
            > traditionalBalancesByOwner[owner] + 0.01){
        rmdOwnerCapacityIssue = {
          code: 'RMD_MINIMUM_EXCEEDS_OWNER_TRADITIONAL',
          owner,
          required: ownerFloor,
          reserved: fixedTraditional,
          available: traditionalBalancesByOwner[owner],
        };
      }
    }
    if(rmdOwnerCapacityIssue){
      rmdStatus = 'unavailable';
      rmdRequired = null;
      rmdIssue = rmdOwnerCapacityIssue.code;
      rmdMinimumCash = 0;
    }
  }
  const rmdSatisfiedByFixedCash = rmdStatus === 'known'
    ? (rmdByOwner
      ? Object.entries(rmdByOwner).reduce((sum, [owner, detail]) => (
        sum + (detail.status === 'known'
          ? Math.min(detail.required, reservedRmdEligibleCashByOwner?.[owner] ?? 0)
          : 0)
      ), 0)
      : Math.min(rmdRequired, appliedReservedRmdEligibleCash))
    : (rmdStatus === 'not-required' ? 0 : null);
  const levers = Object.freeze({
    ...requested,
    deferredWithdrawal: Math.max(requested.deferredWithdrawal, rmdMinimumCash),
  });
  const rmdRemaining = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - rmdSatisfiedByFixedCash - levers.deferredWithdrawal)
    : (rmdStatus === 'not-required' ? 0 : null);
  const rmdOwnerDetails = rmdByOwner ?? (rmdOwner
    ? {
      [rmdOwner]: {
        status: rmdStatus,
        age: rmdAge,
        applicableAge: rmdApplicableAge,
        priorYearEndBalance: rmdPriorYearEndBalance,
        required: rmdRequired,
        issue: rmdIssue,
      },
    }
    : null);
  const frozenRmdByOwner = rmdOwnerDetails
    ? Object.freeze(Object.fromEntries(Object.entries(rmdOwnerDetails).map(([owner, detail]) => {
      const fixedCash = rmdStatus === 'unavailable'
        ? null
        : Math.min(
          detail.required ?? 0,
          rmdByOwner
            ? reservedRmdEligibleCashByOwner?.[owner] ?? 0
            : appliedReservedRmdEligibleCash
        );
      const plannerCash = detail.status === 'known' && fixedCash !== null
        ? Math.max(0, detail.required - fixedCash)
        : (detail.status === 'not-required' ? 0 : null);
      return [owner, Object.freeze({
        ...detail,
        satisfiedByFixedCash: fixedCash,
        satisfiedByPlannerCash: plannerCash,
        remaining: detail.status === 'unavailable' || fixedCash === null
          ? null
          : Math.max(0, (detail.required ?? 0) - fixedCash - plannerCash),
      })];
    })))
    : null;
  const rmd = Object.freeze({
    status: rmdStatus,
    owner: rmdOwner,
    age: rmdAge,
    applicableAge: rmdApplicableAge,
    priorYearEndBalance: rmdPriorYearEndBalance,
    required: rmdRequired,
    satisfiedByFixedCash: rmdSatisfiedByFixedCash,
    remaining: rmdRemaining,
    issue: rmdIssue,
    byOwner: frozenRmdByOwner,
  });
  const rmdShortfall = rmdStatus === 'known'
    ? Math.max(0, rmdRequired - rmdSatisfiedByFixedCash - levers.deferredWithdrawal)
    : 0;
  const interactiveTraditionalUsed = TRADITIONAL_WITHDRAWAL_LEVERS
    .reduce((sum, key) => sum + levers[key], 0);
  const traditionalUsed = appliedReservedTraditionalTotal + interactiveTraditionalUsed;
  const traditionalRemaining = traditionalAvailable === null
    ? null
    : Math.max(0, traditionalAvailable - traditionalUsed);
  const traditionalOwnerLimitsUnavailable = Boolean(
    traditionalOwnerCapacityIssue || traditionalOwnerAttributionMissing
  );
  const deferredMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.rothConversion
        - levers.qcd
    );
  const conversionMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
      || rmdStatus === 'unavailable'
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.deferredWithdrawal
        - levers.qcd
        - rmdShortfall
    );
  const qcdMaximum = traditionalAvailable === null
      || traditionalOwnerLimitsUnavailable
    ? null
    : Math.max(
      0,
      traditionalAvailable
        - appliedReservedTraditionalTotal
        - levers.deferredWithdrawal
        - levers.rothConversion
        - rmdShortfall
    );
  const limits = {
    taxableWithdrawal: Object.freeze({
      pool: 'taxable', min: 0, max: taxableAvailable,
      available: taxableAvailable !== null,
    }),
    rothWithdrawal: Object.freeze({
      pool: 'roth', min: 0, max: rothAvailable,
      available: rothAvailable !== null,
    }),
    deferredWithdrawal: Object.freeze({
      pool: 'traditional', min: rmdMinimumCash, max: deferredMaximum,
      available: deferredMaximum !== null,
    }),
    rothConversion: Object.freeze({
      pool: 'traditional', min: 0, max: conversionMaximum,
      available: conversionMaximum !== null,
    }),
    qcd: Object.freeze({
      pool: 'traditional', min: 0, max: qcdMaximum,
      available: qcdMaximum !== null,
    }),
  };

  const issues = [];
  if(traditionalOwnerCapacityIssue){
    issues.push(Object.freeze(traditionalOwnerCapacityIssue));
  }
  if(rmdOwnerCapacityIssue){
    issues.push(Object.freeze(rmdOwnerCapacityIssue));
  }
  if(traditionalOwnerAttributionMissing){
    for(const lever of TRADITIONAL_WITHDRAWAL_LEVERS){
      if(levers[lever] > 0){
        issues.push(Object.freeze({
          code: 'TRADITIONAL_DISTRIBUTION_OWNER_UNAVAILABLE',
          lever,
          requested: levers[lever],
        }));
      }
    }
  }
  const usedByPool = {
    taxable: levers.taxableWithdrawal,
    traditional: traditionalUsed,
    roth: levers.rothWithdrawal,
  };
  for(const pool of ambiguousPools){
    if(usedByPool[pool] > 0){
      issues.push(Object.freeze({
        code: 'ACCOUNT_POOL_AMBIGUOUS',
        pool,
        requested: usedByPool[pool],
      }));
    }
  }
  if(taxableAvailable !== null && levers.taxableWithdrawal > taxableAvailable){
    issues.push(Object.freeze({
      code: 'TAXABLE_POOL_EXCEEDED',
      available: taxableAvailable,
      requested: levers.taxableWithdrawal,
    }));
  }
  if(rothAvailable !== null && levers.rothWithdrawal > rothAvailable){
    issues.push(Object.freeze({
      code: 'ROTH_POOL_EXCEEDED',
      available: rothAvailable,
      requested: levers.rothWithdrawal,
    }));
  }
  if(traditionalAvailable !== null && traditionalUsed > traditionalAvailable){
    issues.push(Object.freeze({
      code: 'TRADITIONAL_POOL_EXCEEDED',
      available: traditionalAvailable,
      requested: traditionalUsed,
    }));
  }
  if(rmdStatus === 'known'
      && deferredMaximum !== null
      && rmdMinimumCash > deferredMaximum){
    issues.push(Object.freeze({
      code: 'RMD_MINIMUM_EXCEEDS_AVAILABLE_TRADITIONAL',
      required: rmdMinimumCash,
      available: deferredMaximum,
    }));
  }
  if(rmdStatus === 'unavailable' && levers.rothConversion > 0){
    issues.push(Object.freeze({
      code: 'RMD_ACCOUNT_LIMIT_UNAVAILABLE',
      lever: 'rothConversion',
      requested: levers.rothConversion,
    }));
  }

  return Object.freeze({
    valid: issues.length === 0,
    requestedLevers: requested,
    levers,
    reservations: Object.freeze({
      traditional: appliedReservedTraditionalTotal,
      traditionalTotal: appliedReservedTraditionalTotal,
      rmdEligibleCash: appliedReservedRmdEligibleCash,
      taxYear: focusTaxYear,
    }),
    balances: Object.freeze({ ...balances }),
    limits: Object.freeze(limits),
    rmd,
    pools: Object.freeze({
      taxable: Object.freeze({
        available: taxableAvailable,
        used: levers.taxableWithdrawal,
        remaining: taxableAvailable === null
          ? null
          : Math.max(0, taxableAvailable - levers.taxableWithdrawal),
      }),
      traditional: Object.freeze({
        available: traditionalAvailable,
        used: traditionalUsed,
        remaining: traditionalRemaining,
      }),
      roth: Object.freeze({
        available: rothAvailable,
        used: levers.rothWithdrawal,
        remaining: rothAvailable === null
          ? null
          : Math.max(0, rothAvailable - levers.rothWithdrawal),
      }),
    }),
    issues: Object.freeze(issues),
    sourceIssues: Object.freeze([...new Set([...fold.issues, ...accountSourceIssues])]),
    ambiguousPools: Object.freeze([...ambiguousPools]),
    excludedAccountIds: Object.freeze(excludedAccountIds),
  });
}

function approveWithdrawalPlannerLeverChange(
  plan,
  currentLevers,
  changedLever,
  requestedValue,
  accountReservations = {}
){
  if(!WITHDRAWAL_PLANNER_LEVER_KEYS.includes(changedLever)){
    throw new TypeError(`Unknown Withdrawal Planner lever: ${changedLever}`);
  }
  if(typeof requestedValue !== 'number' || !Number.isFinite(requestedValue) || requestedValue < 0){
    throw new TypeError('requestedValue must be a finite nonnegative number');
  }
  const currentState = resolveWithdrawalPlannerAccountState(
    plan,
    normalizeWithdrawalPlannerLevers(currentLevers),
    accountReservations
  );
  const current = currentState.levers;
  const minimum = currentState.limits[changedLever].min ?? 0;
  const maximum = currentState.limits[changedLever].max;
  if(maximum === null){
    return Object.freeze({
      approved: false,
      requestedValue,
      approvedValue: current[changedLever],
      clamped: requestedValue !== current[changedLever],
      levers: current,
      state: currentState,
    });
  }
  const approvedValue = Math.max(minimum, Math.min(requestedValue, maximum));
  const levers = Object.freeze({ ...current, [changedLever]: approvedValue });
  const state = resolveWithdrawalPlannerAccountState(plan, levers, accountReservations);
  return Object.freeze({
    approved: state.valid,
    requestedValue,
    approvedValue,
    clamped: approvedValue !== requestedValue,
    levers,
    state,
  });
}

function buildWithdrawalPlannerCashContract(levers, incrementalModeledFederalIncomeTax){
  const normalized = normalizeWithdrawalPlannerLevers(levers);
  if(incrementalModeledFederalIncomeTax !== null
      && (typeof incrementalModeledFederalIncomeTax !== 'number'
        || !Number.isFinite(incrementalModeledFederalIncomeTax))){
    throw new TypeError('incrementalModeledFederalIncomeTax must be finite or null');
  }
  const round2 = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const grossWithdrawalCash = round2(
    normalized.taxableWithdrawal
      + normalized.deferredWithdrawal
      + normalized.rothWithdrawal
  );
  if(incrementalModeledFederalIncomeTax === null){
    return Object.freeze({
      grossWithdrawalCash,
      incrementalModeledFederalIncomeTax: null,
      netAfterIncrementalModeledFederalIncomeTax: null,
    });
  }
  return Object.freeze({
    grossWithdrawalCash,
    incrementalModeledFederalIncomeTax: round2(incrementalModeledFederalIncomeTax),
    netAfterIncrementalModeledFederalIncomeTax: round2(
      grossWithdrawalCash - incrementalModeledFederalIncomeTax
    ),
  });
}

function resolveInputs(plan, ov){
  const profile = RISK_PROFILES[plan.portfolio.riskProfile];
  const timeline = resolveHouseholdTimeline(plan, ov);
  const pCurAge = timeline.people.client.currentAge;
  const spousePlan = plan.household.spouse || null;
  const spouseCurAge = timeline.people.spouse?.currentAge ?? null;
  const primaryEndAge = timeline.people.client.planEndAgeOnPrimaryTimeline;
  const spouseEndAge = timeline.people.spouse?.planEndAgeOnPrimaryTimeline ?? null;
  const householdEndAge = timeline.householdEndAgeOnPrimaryTimeline;
  const horizon = (householdEndAge ?? pCurAge) - pCurAge + 1;
  validateProjectionHorizon(horizon);
  const iterations = validateProjectionIterations(plan?.simulation?.iterations);

  // Social Security — per person. Each benefit is the pia (benefit at FRA, today's
  // dollars) actuarially adjusted for the actual claim age, haircut by any ssCut
  // stress, then mapped onto the PRIMARY's age timeline (the frame the sim runs in)
  // so a spouse of a different age switches on at the right simulation year.
  // ssDelayYears (the SS Start Age lever) is a SIGNED shift to the PRIMARY's claim
  // age; the spouse keeps their own claim age (edited on the input page).
  const ssCfg = plan.income.socialSecurity || {};
  const ssCutMult = 1 - (ov.ssCut || 0);
  const ssBenefits = [];
  const incomeContractIssues = [];
  function addSS(person, owner){
    if(!person || !(person.pia > 0)) return;
    const isPrimary = owner === 'client';
    const personTimeline = timeline.people[owner];
    const claim = personTimeline.socialSecurityClaimAge;
    const personCurAge = personTimeline.currentAge;
    if(claim === null || personCurAge === null){
      incomeContractIssues.push(`SOCIAL_SECURITY_TIMELINE_INCOMPLETE:${owner}`);
      return;
    }
    ssBenefits.push({
      owner,
      amount:   ssAdjust(person.pia, claim) * ssCutMult,
      startAge: pCurAge + (claim - personCurAge),
      endAge: isPrimary ? primaryEndAge : spouseEndAge,
    });
  }
  addSS(ssCfg.primary, 'client');
  if(timeline.people.spouse) addSS(ssCfg.spouse, 'spouse');

  // Spend cut: proportional reduction across all expense categories.
  // spendCut reduces spending (stress); spendBump raises it (elasticity probe).
  for(const key of ['spendCut', 'spendBump']){
    if(Object.prototype.hasOwnProperty.call(ov, key) && !Number.isFinite(ov[key])){
      throw new TypeError(`${key} must be finite`);
    }
  }
  const hasLivingAnnual = Object.prototype.hasOwnProperty.call(ov, 'livingAnnual');
  if(hasLivingAnnual && (!Number.isFinite(ov.livingAnnual) || ov.livingAnnual < 0)){
    throw new TypeError('livingAnnual must be a finite non-negative number');
  }
  const hasSavingsAnnual = Object.prototype.hasOwnProperty.call(ov, 'savingsAnnual');
  if(hasSavingsAnnual && (!Number.isFinite(ov.savingsAnnual) || ov.savingsAnnual < 0)){
    throw new TypeError('savingsAnnual must be a finite non-negative number');
  }
  const spendMult = (1 - Math.max(0, Math.min(0.5, ov.spendCut || 0))) * (1 + Math.max(0, ov.spendBump || 0));

  // Typed accounts (401k, SEP, etc.) retain identity and their saved allocation.
  // Aggregate sleeves remain derived adapters for existing consumers.
  const accountFold = resolvePortfolioAccounts(plan);
  const unavailableOwnerAccount = accountFold.accounts.find(account => (
    account.sourceKind === 'typed-account'
      && account.owner === 'spouse'
      && !spousePlan
      && account.balance > 0
  ));
  if(unavailableOwnerAccount){
    const error = new RangeError('ACCOUNT_OWNER_UNAVAILABLE');
    error.code = 'ACCOUNT_OWNER_UNAVAILABLE';
    error.accountId = unavailableOwnerAccount.id;
    throw error;
  }
  const taxableBasis = resolveTaxableStartingBasis(plan, accountFold);
  const projectionAccounts = buildProjectionAccountLedger({
    plan,
    accountFold,
    taxableBasis,
    initialShock: ov.initialShock || 0,
  });
  const projectionAggregate = aggregateProjectionAccounts(projectionAccounts);
  const accounts = {
    taxable: {
      balance: projectionAggregate.balances.taxable,
      basis: projectionAggregate.taxableBasis,
    },
    traditional: {
      balance: projectionAggregate.balances.traditional,
    },
    roth: {
      balance: projectionAggregate.balances.roth,
    }
  };
  const traditionalOwners = new Set();
  const traditionalOwnerDetails = {
    client: {
      balance: 0,
      priorYearEndBalance: 0,
      priorYearEndBalanceAvailable: true,
      focusRulesAvailable: true,
      containsEmployerPlan: false,
      traditionalIraAccountCount: 0,
      employerPlanAccountCount: 0,
      rmdAccountAttributionAvailable: true,
    },
    spouse: {
      balance: 0,
      priorYearEndBalance: 0,
      priorYearEndBalanceAvailable: true,
      focusRulesAvailable: true,
      containsEmployerPlan: false,
      traditionalIraAccountCount: 0,
      employerPlanAccountCount: 0,
      rmdAccountAttributionAvailable: true,
    },
  };
  let traditionalOwnerKnown = true;
  let traditionalAccountRulesKnown = true;
  let traditionalFocusRulesKnown = true;
  let traditionalContainsEmployerPlan = false;
  const planningAsOfYear = Number.isInteger(plan?.meta?.planningAsOfYear)
    ? plan.meta.planningAsOfYear
    : 2026;
  const requiredPriorYearEndDate = `${planningAsOfYear - 1}-12-31`;
  let traditionalPriorYearEndBalance = 0;
  let traditionalPriorYearEndBalanceAvailable = true;
  // Raw (pre-shock) pre-tax dollars per owner, following the same attribution
  // rule as the RMD ownership resolution below. Seeds the projection's owner
  // buckets and supplies the year-0 prior-Dec-31 RMD basis.
  const rawTraditionalByOwner = emptyTraditionalOwnerBuckets();
  for(const account of accountFold.accounts){
    if(account.engineBucket !== 'traditional' || account.strategyRulesPending
        || account.balance <= 0) continue;
    if(account.sourceKind === 'legacy-base'){
      traditionalFocusRulesKnown = false;
      traditionalPriorYearEndBalanceAvailable = false;
    }else if(account.sourceKind === 'typed-account'){
      const accountType = getAccountTypeById(account.typeId);
      if(accountType?.taxCharacter === 'employer_pretax'){
        traditionalContainsEmployerPlan = true;
      }else if(accountType?.taxCharacter !== 'traditional_ira'){
        traditionalAccountRulesKnown = false;
      }
      if(account.valuationDate === requiredPriorYearEndDate){
        traditionalPriorYearEndBalance += account.balance;
      }else{
        traditionalPriorYearEndBalanceAvailable = false;
      }
      if(account.owner === 'client'
          || (account.owner === 'spouse' && timeline.people.spouse)){
        const ownerDetail = traditionalOwnerDetails[account.owner];
        ownerDetail.balance += account.balance;
        if(accountType?.taxCharacter === 'employer_pretax'){
          ownerDetail.containsEmployerPlan = true;
          ownerDetail.employerPlanAccountCount += 1;
        }else if(accountType?.taxCharacter === 'traditional_ira'){
          ownerDetail.traditionalIraAccountCount += 1;
        }else if(accountType?.taxCharacter !== 'traditional_ira'){
          ownerDetail.focusRulesAvailable = false;
        }
        if(account.valuationDate === requiredPriorYearEndDate){
          ownerDetail.priorYearEndBalance += account.balance;
        }else{
          ownerDetail.priorYearEndBalanceAvailable = false;
        }
      }
    }
    if(account.owner === 'client'
        || (account.owner === 'spouse' && timeline.people.spouse)){
      traditionalOwners.add(account.owner);
      rawTraditionalByOwner[account.owner] += account.balance;
    }else if(!timeline.people.spouse && account.owner !== 'spouse'){
      // No co-client, so unowned pre-tax money (legacy aggregate, joint, trust)
      // can only be the client's. Same rule the RMD ownership resolution uses.
      traditionalOwners.add('client');
      rawTraditionalByOwner.client += account.balance;
    }else{
      // A co-client exists and this money names no person — genuinely ambiguous.
      traditionalOwnerKnown = false;
      rawTraditionalByOwner.unattributed += account.balance;
    }
  }
  let traditionalRmdAccountAttributionKnown = true;
  for(const ownerDetail of Object.values(traditionalOwnerDetails)){
    ownerDetail.rmdAccountAttributionAvailable =
      ownerDetail.employerPlanAccountCount === 0
      || (ownerDetail.employerPlanAccountCount === 1
        && ownerDetail.traditionalIraAccountCount === 0);
    if(ownerDetail.balance > 0
        && !ownerDetail.rmdAccountAttributionAvailable){
      traditionalRmdAccountAttributionKnown = false;
    }
  }
  if(traditionalOwners.size > 1) traditionalOwnerKnown = false;
  const traditionalRmdOwner = traditionalOwnerKnown && traditionalOwners.size === 1
    ? [...traditionalOwners][0]
    : (traditionalOwnerKnown && !timeline.people.spouse ? 'client' : null);

  // ── Owner-level traditional buckets ───────────────────────────────────────
  // RMDs are per owner, so the projection has to keep each person's pre-tax
  // money distinct as it grows, is drawn down, and is contributed to. These
  // buckets are the source of truth; `accounts.traditional.balance` is a derived
  // cache the read sites still use.
  //
  accounts.traditional.byOwner = { ...projectionAggregate.traditionalByOwner };
  reconcileTraditionalTotal(accounts.traditional);

  // ── Accumulation, pension, and LTC resolution (all no-op at plan defaults) ──
  const curAge        = timeline.people.client.currentAge;
  const retirementAge = timeline.householdRetirementAgeOnPrimaryTimeline ?? curAge;
  const savingsAnnual = hasSavingsAnnual
    ? ov.savingsAnnual
    : Math.max(0, ((plan.savings && plan.savings.annual) || 0) * (1 + (ov.savingsBump || 0)));
  // Contribution split — where accumulation savings land across the three sleeves.
  // Default 100% pre-tax (Traditional) so existing plans are byte-identical. Lets
  // high earners model Roth (backdoor) and post-tax brokerage contributions. The
  // ov.savingsSplit override (if given) wins over the plan's split.
  const rawSplit = ov.savingsSplit || (plan.savings && plan.savings.split) || null;
  let savingsSplit;
  if(!rawSplit){
    savingsSplit = { traditional: 1, roth: 0, taxable: 0 };   // back-compat default
  } else {
    // A split object is given (plan or override): missing keys are 0, not 1.
    const _st = Math.max(0, rawSplit.traditional || 0);
    const _sr = Math.max(0, rawSplit.roth || 0);
    const _sx = Math.max(0, rawSplit.taxable || 0);
    const _ssum = _st + _sr + _sx;
    savingsSplit = _ssum > 0
      ? { traditional: _st/_ssum, roth: _sr/_ssum, taxable: _sx/_ssum }
      : { traditional: 1, roth: 0, taxable: 0 };
  }
  const traditionalRmdStartAge = traditionalRmdOwner
    ? timeline.people[traditionalRmdOwner]?.rmdStartAge ?? null
    : null;
  const traditionalRmdSurvivorOwner = traditionalRmdOwner === 'client'
    ? 'spouse'
    : traditionalRmdOwner === 'spouse'
      ? 'client'
      : null;
  const spousalRolloverAvailable = plan?.meta?.filingStatus === 'marriedFilingJointly'
    && Boolean(spousePlan)
    && Boolean(traditionalRmdSurvivorOwner)
    && Number.isFinite(timeline.people[traditionalRmdSurvivorOwner]?.rmdStartAge)
    && traditionalAccountRulesKnown
    && traditionalRmdAccountAttributionKnown
    && traditionalFocusRulesKnown
    && !traditionalContainsEmployerPlan;
  const pen           = plan.income.pension || {};
  // Chosen collection age. The UI computes this (retirement-linked or custom) and
  // passes it as an absolute override; fall back to the plan's startAge (+ legacy
  // pensionDelay) when no absolute age is supplied.
  const penStartAge   = (ov.pensionStartAge != null ? ov.pensionStartAge
                          : (pen.startAge != null ? pen.startAge : 65) + (ov.pensionDelay || 0));
  // Discrete lookup: use ONLY the amount explicitly entered for this exact age.
  // A missing age means no modeled benefit (0) — we never invent the number.
  // `base` remains a legacy fallback for plans that still carry a single amount.
  const byAge         = pen.benefitByAge || {};
  const penEntered    = (byAge[penStartAge] != null) ? byAge[penStartAge] : pen.base;
  const penBase       = Math.max(0, (penEntered || 0));
  // Pension COLA: advisor enters a NOMINAL annual COLA% (like the SS COLA).
  // Engine is real-dollar, so convert to real drift: real = nominalCOLA − inflation.
  // 0% COLA → −inflation (flat-nominal pension erodes); COLA = inflation → flat real.
  const penColaReal = ((pen.colaPct || 0) / 100) - LONGRUN_INFLATION;
  const pensionAmount = penBase;
  const ltc           = plan.ltc || {};

  const savedOtherIncome = Array.isArray(plan.income.other)
    ? plan.income.other
    : (plan.income.other ? [plan.income.other] : []);
  const current1040 = plan.incomeTax?.current1040;
  const current1040MatchesPlanYear = Number(current1040?.taxYear)
    === Number(planningAsOfYear);
  const hasExplicitCurrentWages = current1040?.income
    && Object.prototype.hasOwnProperty.call(current1040.income, 'wages')
    && Number.isFinite(current1040.income.wages)
    && current1040.income.wages >= 0;
  const savedMemberWageOwners = new Set(savedOtherIncome
    .filter(source => source?.typeId === 'wages' || source?.typeId === 'bonus')
    .map(source => source?.owner)
    .filter(owner => owner === 'client' || owner === 'spouse'));
  const singleCurrentWageFallback = !spousePlan
    && savedMemberWageOwners.size === 0
    && current1040MatchesPlanYear
    && hasExplicitCurrentWages
    ? [{
        typeId: 'wages',
        owner: 'client',
        amount: current1040.income.wages,
        realGrowth: 0,
        taxablePct: 1,
      }]
    : [];
  const rawOtherIncome = [...savedOtherIncome, ...singleCurrentWageFallback];
  const wageOwners = new Set([
    ...savedMemberWageOwners,
    ...singleCurrentWageFallback.map(source => source.owner),
  ]);
  if(current1040 && current1040.incomeSourcesComplete !== true){
    for(const [owner, personPlan, personTimeline] of [
      ['client', plan.household.primary, timeline.people.client],
      ['spouse', spousePlan, timeline.people.spouse],
    ]){
      if(!personPlan || !personTimeline) continue;
      const working = personPlan.employmentStatus !== 'retired'
        && personTimeline.currentAge !== null
        && personTimeline.retirementAge !== null
        && personTimeline.currentAge < personTimeline.retirementAge;
      if(working && !wageOwners.has(owner)){
        incomeContractIssues.push(`INCOME_SOURCE_MISSING:${owner}:wages`);
      }
    }
  }
  const otherIncome = rawOtherIncome.map(o => {
    const source = normalizedIncomeSource(plan, o);
    const missingSourceOwner = source.owner === 'spouse' && !spousePlan;
    const spouseOwned = source.owner === 'spouse' && Boolean(spousePlan);
    const unassignedHouseholdWage = Boolean(spousePlan)
      && source.owner === 'joint'
      && (source.typeId === 'wages' || source.typeId === 'bonus');
    const missingOwnerTimeline = missingSourceOwner
      || (spouseOwned && spouseCurAge === null);
    const ownerRetirementAge = source.owner === 'spouse'
      ? timeline.people.spouse?.retirementAge
      : timeline.people.client.retirementAge;
    const missingWorkingEnd = source.timing === 'working'
      && o.endAge == null
      && ownerRetirementAge === null;
    const duplicateSocialSecurity = source.typeId === 'social_security'
      && ssBenefits.some(benefit => benefit.owner === source.owner);
    if(duplicateSocialSecurity){
      incomeContractIssues.push(`SOCIAL_SECURITY_SOURCE_OVERLAP:${source.owner}`);
    }else if(unassignedHouseholdWage){
      incomeContractIssues.push('INCOME_OWNER_UNAVAILABLE:joint:wages');
    }else if(missingSourceOwner){
      incomeContractIssues.push(`INCOME_OWNER_UNAVAILABLE:${source.owner}:${source.typeId}`);
    }else if(missingOwnerTimeline || missingWorkingEnd){
      incomeContractIssues.push(`INCOME_TIMELINE_INCOMPLETE:${source.owner}:${source.typeId}`);
    }
    const mapAge = age => spouseOwned && age !== 999
      ? pCurAge + (age - spouseCurAge)
      : age;
    const ownerEndAge = spouseOwned
      ? spouseEndAge
      : source.owner === 'joint' ? householdEndAge : primaryEndAge;
    return {
      typeId: source.typeId,
      owner: source.owner,
      amount: source.typeId === 'long_term_capital_gain'
        ? source.amount
        : Math.max(0, source.amount || 0),
      startAge: missingOwnerTimeline || missingWorkingEnd || duplicateSocialSecurity
          || unassignedHouseholdWage
        ? Infinity
        : mapAge(source.startAge),
      endAge: missingOwnerTimeline || missingWorkingEnd || duplicateSocialSecurity
          || unassignedHouseholdWage
        ? -Infinity
        : Math.min(mapAge(source.endAge), ownerEndAge ?? 999),
      realGrowth: source.realGrowth,
      taxablePct: source.taxablePct == null
        ? 1
        : Math.max(0, Math.min(1, source.taxablePct)),
      qualifiedPct: Math.max(0, Math.min(1, source.qualifiedPct || 0)),
    };
  });

  // ── Earmarked-asset sale (override-only; never baked into the base plan) ──────
  // ov.assetSale = { asset: <index into plan.properties>, age: <sale age> }. We
  // resolve the NET proceeds here (deterministic — no market randomness), in
  // NOMINAL dollars at the sale year, then deflate to today's dollars for the
  // real-dollar sim. Cap-gains is computed on the NOMINAL appreciation (the
  // real-world basis is historical cost, so inflation is part of the taxable
  // gain). The #5 primary-residence exclusion will subtract from the gain here.
  const capGainsRate = (plan.taxes.capitalGains * (1 + (ov.taxMult || 0))) / 100;
  const saleAsset = (ov.assetSale && ov.assetSale.age != null) ? ov.assetSale.asset : -1;
  const saleAge   = (saleAsset >= 0) ? ov.assetSale.age : null;
  let assetSale = null;
  if(saleAsset >= 0){
    const pr = (plan.properties || [])[saleAsset];
    if(pr && saleAge >= curAge){
      const k        = saleAge - curAge;                       // years from now to sale
      const f        = Math.pow(1 + LONGRUN_INFLATION, k);     // nominal/real bridge
      const apprec   = (pr.appreciation || 0);                 // real appreciation/yr (v1 default 0)
      const realPrice= Math.max(0, pr.value || 0) * Math.pow(1 + apprec, k);   // today's $ at sale
      const nomPrice = realPrice * f;                          // nominal at sale
      const commPct  = Math.max(0, Math.min(1, (pr.commissionPct == null ? 5 : pr.commissionPct) / 100));
      const nomComm  = nomPrice * commPct;
      const M        = pr.mortgage || {};
      const mStart   = (M.startAge != null ? M.startAge : curAge);
      const nomPayoff= mortgageBalanceRemaining(M.balance, M.rate || 0, M.termYears, saleAge - mStart);
      // Cost basis = entered purchasePrice. If none is entered, fall back to the
      // current value (→ zero modeled gain) rather than basis 0 (which would tax
      // the ENTIRE price as gain) — we don't invent a gain we can't substantiate.
      const basis    = (pr.purchasePrice != null && pr.purchasePrice > 0)
                         ? pr.purchasePrice : Math.max(0, pr.value || 0);
      const exclusion= Math.max(0, (ov.saleExclusion || 0));   // #5: §121 primary-residence (nominal)
      const nomGain  = Math.max(0, (nomPrice - nomComm) - basis - exclusion);
      const nomTax   = nomGain * capGainsRate;
      const nomNet   = Math.max(0, nomPrice - nomPayoff - nomComm - nomTax);
      assetSale = {
        age: saleAge, asset: saleAsset,
        netProceeds:  nomNet / f,                              // back to today's dollars
        grossReal:    realPrice,
        capGainsTax:  nomTax / f,
        commission:   nomComm / f,
        mortgagePayoff: nomPayoff / f
      };
    }
  }

  return {
    currentAge: pCurAge,
    retirementAge,
    people: timeline.people,
    simulationAvailable: timeline.completeForSimulation,
    simulationIssues: timeline.completeForSimulation
      ? Object.freeze([])
      : Object.freeze(['HOUSEHOLD_TIMELINE_INCOMPLETE']),
    incomeContractAvailable: incomeContractIssues.length === 0,
    incomeContractIssues: Object.freeze([...incomeContractIssues]),
    savingsAnnual,
    savingsSplit,
    horizonYears: horizon,
    accounts,  // structured account container
    projectionAccounts: Object.freeze(projectionAccounts.map(account => Object.freeze({ ...account }))),
    portfolio: {
      eq: profile.eq, fi: profile.fi,
      label: profile.label, alloc: profile.alloc,
      weights: profile.weights
    },
    returnAdj: (ov.returnAdj || 0) / 100,
    ss: ssBenefits,   // array of { amount, startAge } in the primary's age frame
    // Other income — normalized to an array of timed streams, each carrying its
    // own real growth and taxable share (both defaulting to the legacy flat-real,
    // fully-taxed behavior). Accepts a legacy single object too.
    otherIncome,
    pension:        { amount: pensionAmount, startAge: penStartAge, colaReal: penColaReal },
    rmdContract: Object.freeze({
      available: traditionalOwnerKnown
        && traditionalAccountRulesKnown
        && traditionalRmdAccountAttributionKnown
        && Boolean(traditionalRmdOwner)
        && traditionalRmdStartAge !== null,
      owner: traditionalRmdOwner,
      startAge: traditionalRmdStartAge,
      // Raw, pre-shock pre-tax dollars per owner. This is the year-0 assumed
      // prior-Dec-31 RMD basis: an initial scenario shock reduces the projection
      // sleeve but does not retroactively revise last year's statement. Unlike
      // byOwner[].balance it includes legacy-aggregate money.
      openingBalanceByOwner: Object.freeze({ ...rawTraditionalByOwner }),
      spousalRolloverAvailable,
      containsEmployerPlan: traditionalContainsEmployerPlan,
      focusRulesAvailable: traditionalFocusRulesKnown,
      planningAsOfYear,
      priorYearEndBalance: traditionalPriorYearEndBalanceAvailable
        ? traditionalPriorYearEndBalance
        : null,
      priorYearEndBalanceAvailable: traditionalPriorYearEndBalanceAvailable,
      byOwner: Object.freeze(Object.fromEntries(
        [...traditionalOwners].map(owner => {
          const detail = traditionalOwnerDetails[owner];
          const startAge = timeline.people[owner]?.rmdStartAge ?? null;
          return [owner, Object.freeze({
            available: detail.focusRulesAvailable
              && detail.priorYearEndBalanceAvailable
              && startAge !== null,
            balance: detail.balance,
            startAge,
            containsEmployerPlan: detail.containsEmployerPlan,
            focusRulesAvailable: detail.focusRulesAvailable,
            rmdAccountAttributionAvailable:
              detail.rmdAccountAttributionAvailable,
            priorYearEndBalance: detail.priorYearEndBalanceAvailable
              ? detail.priorYearEndBalance
              : null,
            priorYearEndBalanceAvailable: detail.priorYearEndBalanceAvailable,
          })];
        })
      )),
      issue: !traditionalOwnerKnown || !traditionalRmdOwner
        ? 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE'
        : !traditionalAccountRulesKnown
          ? 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE'
          : !traditionalRmdAccountAttributionKnown
            ? 'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE'
            : traditionalRmdStartAge === null
                ? 'RMD_BIRTH_COHORT_UNAVAILABLE'
                : null,
    }),
    ltc:            { amount: Math.max(0, (ltc.amount || 0) * (1 + (ov.ltcAdj || 0))), onsetAge: (ltc.onsetAge != null ? ltc.onsetAge : 999) },
    expenses: {
      // Absolute living spend is a narrow zero-base scenario seam. It avoids
      // representing a real dollar target as an impossible percent of $0.
      living:     hasLivingAnnual ? ov.livingAnnual : plan.expenses.living * spendMult,
      housing:    plan.expenses.housing    * spendMult,
      debt:       plan.expenses.debt       * spendMult,
      // Healthcare is NOT scaled by spendMult — it's not discretionary lifestyle
      // spending. It has its own healthcareRealGrowth rate applied in the sim loop.
      healthcare: plan.expenses.healthcare,
      // Discretionary, time-bounded extras — flex with the spending lever, flat-real.
      extra: (plan.expenses.extra || []).map(e => ({
        amount:   Math.max(0, e.amount || 0) * spendMult,
        startAge: (e.startAge != null ? e.startAge : 0),
        endAge:   (e.endAge   != null ? e.endAge   : 999)
      }))
    },
    // Recurring liabilities (e.g. a mortgage). NOT scaled by spendMult — a fixed
    // obligation isn't discretionary spending. colaReal mirrors the pension:
    // nominal escalator − inflation, so a 0%-COLA debt erodes in real terms.
    // Property mortgages are amortized to a fixed annual payment and APPENDED here
    // as ordinary fixed-nominal liabilities (payment from the loan's start age until
    // payoff = startAge + termYears), so they reuse the same tested cash-flow path.
    liabilities: [
      ...(plan.liabilities || []).map(L => ({
        amount:   Math.max(0, L.amount || 0),
        startAge: (L.startAge != null ? L.startAge : 0),
        endAge:   (L.endAge   != null ? L.endAge   : 999),
        colaReal: ((L.colaPct || 0) / 100) - LONGRUN_INFLATION
      })),
      ...(plan.properties || [])
        .map((pr, idx) => ({ pr, idx }))
        .filter(({pr}) => pr && pr.mortgage && (pr.mortgage.balance > 0) && (pr.mortgage.termYears > 0))
        .map(({pr, idx}) => {
          const M = pr.mortgage;
          const start = (M.startAge != null ? M.startAge : curAge);
          let endAge = start + M.termYears;          // payoff
          // If THIS property is sold before payoff, the mortgage is settled from
          // the proceeds. Payments stop the year BEFORE the sale (endAge = saleAge−1):
          // the remaining balance at the sale is the payoff we deduct from proceeds
          // (computed at saleAge−mStart years elapsed), so paying in the sale year too
          // would double-count that year's payment.
          if(idx === saleAsset && saleAge != null && saleAge <= endAge) endAge = saleAge - 1;
          return {
            amount:   annualMortgagePayment(M.balance, M.rate || 0, M.termYears),
            startAge: start,
            endAge,
            colaReal: -LONGRUN_INFLATION              // fixed-nominal payment erodes in real terms
          };
        })
    ],
    assetSale,   // resolved net-proceeds object, or null when no sale override
    healthcareMult: 1 + (ov.healthcareAdj || 0),
    healthcareRealGrowth: Math.max(0, plan.expenses.healthcareRealGrowth ?? 0.02),
    // Goals — normalized to an array of timed entries. A legacy
    // { vacation, property, gifts } object is converted to always-on entries.
    //
    // Two fields carry what used to live in plan.expenses:
    //   realGrowth        annual growth ABOVE general inflation, compounding
    //                     from the goal's start age. 0 = flat real dollars,
    //                     which is every ordinary goal. Healthcare uses 0.02.
    //   startsAtRetirement  bind the start age to the household's retirement
    //                     age instead of a fixed number. Resolved here, so it
    //                     follows the retireAge lever per scenario rather than
    //                     silently desyncing when a scenario retires earlier.
    goals: [
      ...(Array.isArray(plan.goals)
            ? plan.goals
            : Object.keys(plan.goals || {}).map(k => ({ name:k, amount:plan.goals[k], startAge:0, endAge:999 }))),
      // A plan saved before spending moved onto the Goals page still carries
      // plan.expenses. Fold it in here rather than trusting that the
      // persistence migration ran — an un-migrated plan must never silently
      // lose the spending the engine used to charge it.
      ...(plan.meta?.spendingSchemaVersion ? [] : (goalsFromLegacyExpenses(plan) || [])),
    ]
      // The absolute essentials override is a zero-base seam: it has to work on
      // a household whose essentials are still $0, which is precisely when no
      // Essentials goal exists yet. Give it something to land on.
      .concat(
        hasLivingAnnual
          && !(Array.isArray(plan.goals) && plan.goals.some(g => g?.system === 'essentials'))
          && !((goalsFromLegacyExpenses(plan) || []).some(g => g.system === 'essentials'))
          ? [{ id: 'system:essentials', system: 'essentials', name: 'Essentials',
               amount: 0, startsAtRetirement: true, endAge: 999,
               realGrowth: 0, flexesWithSpending: true }]
          : []
      )
      .map(g => {
        const entered = Math.max(0, g.amount || 0);
        // The spending lever scales DISCRETIONARY spending only. Healthcare was
        // explicitly exempt before this moved onto goals ("not discretionary
        // lifestyle spending"), and plan.goals never flexed at all — so the
        // flag defaults off and only the migrated expense channels carry it.
        const flexes = g.flexesWithSpending === true;
        // Absolute essentials override: a zero-base seam, so a real dollar
        // target isn't expressed as an impossible percentage of $0. Replaces
        // the amount rather than scaling it, exactly as livingAnnual did.
        const amount = (g.system === 'essentials' && hasLivingAnnual)
          ? ov.livingAnnual
          : (flexes ? entered * spendMult : entered);
        return {
          name:     g.name || '',
          id:       g.id,
          system:   g.system,
          amount,
          startAge: g.startsAtRetirement === true
                      ? retirementAge
                      : (g.startAge != null ? g.startAge : 0),
          endAge:   (g.endAge   != null ? g.endAge   : 999),
          realGrowth: Math.max(0, g.realGrowth || 0),
          startsAtRetirement: g.startsAtRetirement === true,
          flexesWithSpending: flexes,
          fundFromPortfolioBeforeRetirement: g.fundFromPortfolioBeforeRetirement === true,
        };
      }),
    // Tax rates split: ordinary income (for traditional withdrawals and SS),
    // and long-term capital gains (for taxable account gains).
    // The taxMult override scales both rates proportionally for stress testing.
    taxRates: {
      ordinary:     (plan.taxes.ordinary     * (1 + (ov.taxMult || 0))) / 100,
      capitalGains: (plan.taxes.capitalGains * (1 + (ov.taxMult || 0))) / 100
    },
    // Withdrawal strategy — drives account sequencing in fundGap
    withdrawalStrategy: plan.portfolio.withdrawalStrategy || 'taxable-first',
    // One-time cash shock injected at a specific year (fragility probe).
    lumpSum:     Math.max(0, ov.lumpSum || 0),
    lumpSumYear: (ov.lumpSumYear != null ? ov.lumpSumYear : -1),
    iterations,
    survival: {
      initialFilingStatus: plan.meta?.filingStatus ?? null,
      primaryEndAge,
      spouseEndAge,
    }
  };
}


// ── RMDs (Required Minimum Distributions) ───────────────────────────────────
// SECURE 2.0: the pre-tax (Traditional) sleeve must distribute a minimum each
// year from the owner's cohort-specific applicable age. Roth is exempt. The
// distribution is ordinary income and is modeled as spent in full. Required
// distributions never silently move into the taxable sleeve.
//
// ── Owner-level traditional sleeve ──────────────────────────────────────────
// The traditional sleeve is tracked per owner because RMDs are per owner: each
// spouse's requirement runs off their own balance and their own age, and one
// spouse's withdrawal can never satisfy the other's requirement.
//
// `byOwner` is the source of truth. `.balance` is a derived cache kept only so
// the many read sites (accountTotal, row emission, funding breakdown) stay
// untouched — nothing outside these helpers may assign it.
const TRADITIONAL_OWNER_KEYS = Object.freeze(['client', 'spouse', 'unattributed']);
const TRADITIONAL_PERSON_OWNERS = Object.freeze(['client', 'spouse']);

function emptyTraditionalOwnerBuckets(){
  return { client: 0, spouse: 0, unattributed: 0 };
}

// Shared read-only zero buckets. resolveOpeningRmd returns "nothing due" on the
// large majority of the ~40,000 year-evaluations in a 1,000-path run, and
// allocating a fresh object each time is pure overhead on a loop the audit
// already flags as blocking the UI thread (PX-AUD-028 — the durable fix is to
// move the projection off the UI thread, which is tracked separately).
//
// MUST NOT be mutated: it is shared across every caller, and
// applyTraditionalMidyearWithdrawal compares against it by identity to take its
// no-draw fast path. Frozen so a future refactor fails loudly in strict mode
// rather than silently corrupting every projection; locked by a unit test.
const ZERO_TRADITIONAL_OWNER_BUCKETS = Object.freeze({ client: 0, spouse: 0, unattributed: 0 });

// 72 is the pre-SECURE-2.0 floor: used only to ask "could anyone owe yet?", never
// to compute an amount. A real applicable age is still required for that.
function belowApplicableAge(person){
  return person?.alive === true
    && typeof person.age === 'number'
    && person.age < (person.rmdStartAge ?? 72);
}

function cloneTraditionalOwnerBuckets(byOwner){
  return {
    client: byOwner?.client ?? 0,
    spouse: byOwner?.spouse ?? 0,
    unattributed: byOwner?.unattributed ?? 0,
  };
}

// Recompute the derived total. Every mutation helper ends here. Unrolled: this
// runs on every secant iteration of every year of every path.
function reconcileTraditionalTotal(traditional){
  const b = traditional.byOwner;
  const total = b.client + b.spouse + b.unattributed;
  traditional.balance = total;
  return total;
}

function clampTraditionalNonNegative(traditional){
  for(const owner of TRADITIONAL_OWNER_KEYS){
    if(!(traditional.byOwner[owner] > 0)) traditional.byOwner[owner] = 0;
  }
  return reconcileTraditionalTotal(traditional);
}

function zeroTraditionalOwners(traditional){
  traditional.byOwner = emptyTraditionalOwnerBuckets();
  return reconcileTraditionalTotal(traditional);
}

// Growth is proportional, so ownership shares are unchanged by returns.
function growTraditional(traditional, r){
  const b = traditional.byOwner;
  const g = 1 + r;
  b.client *= g;
  b.spouse *= g;
  b.unattributed *= g;
  return reconcileTraditionalTotal(traditional);
}

/**
 * Split a gross traditional distribution across owners: RMD-first, then pro
 * rata over what's left.
 *
 * Pro-rata-only would be wrong. If the client owes a $10k RMD, the spouse owes
 * nothing, and the plan needs $10k from the traditional sleeve, splitting
 * $5k/$5k leaves $5k of the client's RMD unsatisfied — which then gets forced
 * out on top, pulling $15k out of tax-deferred money instead of $10k.
 *
 * Returns gross by owner. This is the figure RMD satisfaction and Form 1040
 * reporting use; it deliberately does NOT touch balances, because the sleeve's
 * mid-year timing math is a separate concern (see applyTraditionalMidyearWithdrawal).
 */
function allocateTraditionalDistribution({ traditional, grossAmount, requiredByOwner = null }){
  // Shared frozen result when there is nothing to split — callers only read it.
  if(!(grossAmount > 0)) return ZERO_TRADITIONAL_OWNER_BUCKETS;
  const allocation = emptyTraditionalOwnerBuckets();
  let remaining = grossAmount;

  const available = {};
  for(const owner of TRADITIONAL_OWNER_KEYS){
    available[owner] = Math.max(0, traditional.byOwner[owner] ?? 0);
  }

  // 1. Satisfy each owner's own outstanding RMD first, capped by their balance.
  if(requiredByOwner){
    for(const owner of TRADITIONAL_PERSON_OWNERS){
      const required = requiredByOwner[owner];
      if(!(required > 0)) continue;
      const take = Math.min(required, available[owner], remaining);
      if(take > 0){
        allocation[owner] += take;
        available[owner] -= take;
        remaining -= take;
      }
      if(!(remaining > 0)) break;
    }
  }

  // 2. Anything left is pro rata across remaining attributable balances.
  if(remaining > 0){
    let pool = 0;
    for(const owner of TRADITIONAL_OWNER_KEYS) pool += available[owner];
    if(pool > 0){
      let assigned = 0;
      const ordered = TRADITIONAL_OWNER_KEYS.filter(owner => available[owner] > 0);
      ordered.forEach((owner, index) => {
        const isLast = index === ordered.length - 1;
        // Last bucket takes "whatever is left" rather than its own computed
        // share, so floating-point error in the earlier shares cannot leave a
        // residual. Without this the per-owner parts drift from the gross by
        // fractions of a cent, and that gap compounds across 40 years into a
        // real discrepancy against the sleeve total.
        const take = isLast
          ? Math.min(available[owner], remaining - assigned)
          : Math.min(available[owner], (available[owner] / pool) * remaining);
        if(take > 0){
          allocation[owner] += take;
          assigned += take;
        }
      });
      remaining -= assigned;
    }
  }

  return allocation;
}

/**
 * Apply an ordinary spending withdrawal using the engine's existing mid-year
 * convention — end = start*(1+r) − (amount/12)*factor — per owner. Keeping this
 * separate from allocation is what preserves single-owner parity: the gross
 * figure feeds tax, the timing math feeds balances, and they are not the same
 * number.
 */
function applyTraditionalMidyearWithdrawal({ traditional, returnRate, factor, grossByOwner }){
  // No draw at all is the common case (taxable-first strategies spend other
  // sleeves for years), and it reduces to pure growth.
  if(!grossByOwner || grossByOwner === ZERO_TRADITIONAL_OWNER_BUCKETS){
    return growTraditional(traditional, returnRate);
  }
  const b = traditional.byOwner;
  const g = 1 + returnRate;
  const spread = factor / 12;
  b.client = b.client * g - grossByOwner.client * spread;
  b.spouse = b.spouse * g - grossByOwner.spouse * spread;
  b.unattributed = b.unattributed * g - grossByOwner.unattributed * spread;
  return reconcileTraditionalTotal(traditional);
}

// Accumulation-phase contribution, mid-year spread, allocated by owner policy.
function applyTraditionalContribution({ traditional, returnRate, contributionByOwner }){
  for(const owner of TRADITIONAL_OWNER_KEYS){
    const start = traditional.byOwner[owner] ?? 0;
    traditional.byOwner[owner] = start * (1 + returnRate)
      + (contributionByOwner?.[owner] ?? 0);
  }
  return reconcileTraditionalTotal(traditional);
}

// Direct-subtraction draw spread pro rata across owners. Used for liquidations
// that are not RMD-driven (capital outlays), where no owner has a claim.
function withdrawTraditionalProRata(traditional, amount){
  const allocation = allocateTraditionalDistribution({ traditional, grossAmount: amount });
  let taken = 0;
  for(const owner of TRADITIONAL_OWNER_KEYS){
    const available = Math.max(0, traditional.byOwner[owner] ?? 0);
    const take = Math.min(allocation[owner], available);
    traditional.byOwner[owner] = available - take;
    taken += take;
  }
  reconcileTraditionalTotal(traditional);
  return taken;
}

// Forced RMD keeps the engine's existing year-end convention: a direct
// subtraction, taken from that owner's own bucket.
function withdrawTraditionalForced(traditional, owner, amount){
  const available = Math.max(0, traditional.byOwner[owner] ?? 0);
  const taken = Math.min(Math.max(0, amount), available);
  traditional.byOwner[owner] = available - taken;
  reconcileTraditionalTotal(traditional);
  return taken;
}

// Spousal rollover at a death-year boundary: one transfer, decedent zeroed.
function rolloverTraditional(traditional, from, to){
  const moved = Math.max(0, traditional.byOwner[from] ?? 0);
  if(moved > 0){
    traditional.byOwner[from] = 0;
    traditional.byOwner[to] = (traditional.byOwner[to] ?? 0) + moved;
  }
  reconcileTraditionalTotal(traditional);
  return moved;
}

/**
 * Is a spousal rollover of `from`'s pre-tax balance to `to` supportable?
 *
 * Both sides are inspected for attributable balances and supported RMD rules.
 * Employer-plan status does not prevent the death-boundary transfer: the
 * surviving spouse owns the transferred pre-tax balance after the rollover.
 *
 * Deliberately NOT derived from `rmdContract.spousalRolloverAvailable`, which is
 * computed off the single-owner `traditionalRmdOwner` and is therefore always
 * false in exactly the two-owner households this needs to serve.
 */
function spousalRolloverSupported(p, contract, from, to){
  const fromContract = contract?.byOwner?.[from];
  if(!fromContract) return false;
  if(fromContract.focusRulesAvailable !== true) return false;
  if(fromContract.rmdAccountAttributionAvailable !== true) return false;

  // The survivor need not already hold pre-tax accounts — inheriting one is the
  // normal case — so their eligibility comes from the timeline, not from a
  // byOwner entry that may legitimately not exist. Where they do have one, it
  // has to be clean too.
  const toContract = contract?.byOwner?.[to];
  if(toContract){
    if(toContract.focusRulesAvailable !== true) return false;
    if(toContract.rmdAccountAttributionAvailable !== true) return false;
  }
  return Number.isFinite(p.people?.[to]?.rmdStartAge);
}

/**
 * Transfer a decedent's remaining pre-tax balance to the surviving spouse at
 * the closing boundary of their final living year. One move, no proration.
 */
function applyDeathBoundaryRollover(p, age, traditional, rolledOverOwners){
  // Spousal rollover needs a spouse, not a particular filing status — a
  // surviving spouse may roll over regardless of how the couple filed.
  if(!p.people?.spouse) return null;
  const priorYear = householdTaxStatusAtAge(p, age - 1);
  const thisYear = householdTaxStatusAtAge(p, age);

  for(const owner of TRADITIONAL_PERSON_OWNERS){
    if(rolledOverOwners.has(owner)) continue;
    const aliveBefore = priorYear.people?.[owner]?.alive === true;
    const aliveNow = thisYear.people?.[owner]?.alive === true;
    if(!aliveBefore || aliveNow) continue;          // they did not just die
    if(!((traditional.byOwner[owner] ?? 0) > 0.01)){
      rolledOverOwners.add(owner);
      continue;
    }
    const survivor = owner === 'client' ? 'spouse' : 'client';
    if(thisYear.people?.[survivor]?.alive !== true) continue;   // no survivor to receive it
    if(!spousalRolloverSupported(p, p.rmdContract, owner, survivor)) continue;  // fail closed
    rolloverTraditional(traditional, owner, survivor);
    rolledOverOwners.add(owner);
    return { from: owner, to: survivor, age };
  }
  return null;
}

/**
 * Per-owner RMD requirement for one projection year.
 *
 * Short-circuits when there is no pre-tax money, and stays quiet while everyone
 * is below their applicable age — an unresolvable owner only matters once a
 * distribution is actually due.
 */
function resolveOpeningRmd(p, age, traditional, yearIndex){
  // `available` / `owner` are retained for the existing row contract. `owner`
  // identifies whose pre-tax money this is — which is why it follows the
  // balances rather than the plan's contract: after a spousal rollover the
  // survivor owns it. It is null when two people hold pre-tax money, because
  // then there is no single household RMD owner, which is the point of all this.
  const clientHolds = (traditional.byOwner.client ?? 0) > 0.01;
  const spouseHolds = (traditional.byOwner.spouse ?? 0) > 0.01;
  const rowOwner = clientHolds && spouseHolds
    ? null                                        // two owners: no single one
    : (clientHolds ? 'client'
      : (spouseHolds ? 'spouse' : (p.rmdContract?.owner ?? null)));

  // `requiredByOwner` on the not-required paths is shared and frozen: this
  // function runs ~40,000 times in a 1,000-path projection and is "nothing due"
  // for most of them, so per-call allocation is pure overhead on a loop the
  // audit already flags as blocking the UI thread (PX-AUD-028).
  const empty = {
    status: 'not-required',
    available: true,
    owner: rowOwner,
    required: 0,
    requiredByOwner: ZERO_TRADITIONAL_OWNER_BUCKETS,
    issue: null,
    basisSource: null,
  };
  if(!(traditional.balance > 0.01)) return empty;

  const contract = p.rmdContract;
  const householdState = householdTaxStatusAtAge(p, age);

  // Hot path — this runs for every year of every path, so the age gates below
  // read the two people directly instead of building and filtering arrays.
  const clientPerson = householdState.people?.client ?? null;
  const spousePerson = householdState.people?.spouse ?? null;
  const hasUnattributed = (traditional.byOwner.unattributed ?? 0) > 0.01;

  // Nobody in the household has reached an applicable age — nothing is due, so
  // ownership gaps are not yet a problem.
  if((clientPerson || spousePerson)
    && (!clientPerson || belowApplicableAge(clientPerson))
    && (!spousePerson || belowApplicableAge(spousePerson))){
    return empty;
  }

  // Someone is old enough, but a distribution is only owed by a person who
  // actually holds pre-tax money. An older spouse with no IRA of their own does
  // not force resolution of the younger owner's cohort.
  if((clientHolds || spouseHolds)
    && (!clientHolds || belowApplicableAge(clientPerson))
    && (!spouseHolds || belowApplicableAge(spousePerson))
    && !hasUnattributed){
    return empty;
  }

  // Pre-tax money nobody owns cannot produce a defensible RMD.
  if(hasUnattributed){
    return {
      ...empty,
      status: 'unavailable',
      available: false,
      owner: null,
      required: null,
      issue: 'TRADITIONAL_ACCOUNT_OWNER_UNAVAILABLE',
    };
  }

  const basisSource = yearIndex === 0
    ? 'opening-balance-assumption'
    : 'simulated-prior-year-close';

  // A survivor who inherited a spouse's IRA now holds pre-tax money without
  // having an entry in the plan-derived contract. Synthesize one from the
  // timeline so the inherited balance still produces an RMD instead of silently
  // escaping the requirement.
  let effectiveContract = contract;
  const missingOwners = [];
  if(clientHolds && !contract?.byOwner?.client) missingOwners.push('client');
  if(spouseHolds && !contract?.byOwner?.spouse) missingOwners.push('spouse');
  if(missingOwners.length > 0){
    const byOwner = { ...(contract?.byOwner || {}) };
    for(const owner of missingOwners){
      byOwner[owner] = {
        available: true,
        balance: traditional.byOwner[owner],
        startAge: p.people?.[owner]?.rmdStartAge ?? null,
        containsEmployerPlan: false,
        focusRulesAvailable: true,
        rmdAccountAttributionAvailable: true,
        priorYearEndBalance: traditional.byOwner[owner],
        priorYearEndBalanceAvailable: true,
      };
    }
    effectiveContract = { ...contract, byOwner };
  }

  const evaluated = evaluateRmdByOwner(effectiveContract, householdState, {
    priorYearEndBalanceForOwner: (owner) => (
      yearIndex === 0
        ? (contract?.openingBalanceByOwner?.[owner] ?? 0)   // raw, pre-shock
        : (traditional.byOwner[owner] ?? 0)                 // prior year's close
    ),
  });

  const requiredByOwner = emptyTraditionalOwnerBuckets();
  for(const owner of TRADITIONAL_PERSON_OWNERS){
    const detail = evaluated.byOwner[owner];
    requiredByOwner[owner] = detail && detail.required > 0 ? detail.required : 0;
  }

  return {
    status: evaluated.status,
    available: evaluated.status !== 'unavailable',
    owner: rowOwner,
    required: evaluated.requiredTotal,
    requiredByOwner,
    issue: evaluated.issue,
    basisSource,
    byOwner: evaluated.byOwner,
  };
}

// Divisors: IRS Uniform Lifetime Table (Pub 590-B, Table III), current 2026.
const UNIFORM_LIFETIME = {
  72:27.4, 73:26.5, 74:25.5, 75:24.6, 76:23.7, 77:22.9, 78:22.0, 79:21.1, 80:20.2,
  81:19.4, 82:18.5, 83:17.7, 84:16.8, 85:16.0, 86:15.2, 87:14.4, 88:13.7,
  89:12.9, 90:12.2, 91:11.5, 92:10.8, 93:10.1, 94:9.5, 95:8.9, 96:8.4,
  97:7.8, 98:7.3, 99:6.8, 100:6.4, 101:6.0, 102:5.6, 103:5.2, 104:4.9,
  105:4.6, 106:4.3, 107:4.1, 108:3.9, 109:3.7, 110:3.5, 111:3.4, 112:3.3,
  113:3.1, 114:3.0, 115:2.9, 116:2.8, 117:2.7, 118:2.5, 119:2.3, 120:2.0
};
function rmdDivisor(age){
  if(age < 72) return Infinity;                     // no RMD → required = 0
  return UNIFORM_LIFETIME[Math.min(age, 120)];      // table floors at 120+
}

/**
 * THE authoritative per-owner RMD evaluator. RMDs are legally per owner — you
 * cannot satisfy your spouse's RMD out of your IRA — so every caller that needs
 * a required amount comes through here.
 *
 * `priorYearEndBalanceForOwner` lets a caller supply the basis it actually has.
 * The Withdrawal Planner has only the plan's recorded prior-Dec-31 figure, so it
 * passes nothing and the contract's own `priorYearEndBalance` is used. The
 * projection simulates each year, so from year 1 on it supplies that owner's
 * real prior-year closing balance — which is why the planner's focus-year guard
 * is a parameter rather than a hard rule.
 */
function evaluateRmdByOwner(contract, householdState, {
  priorYearEndBalanceForOwner = null,
  focusYearMatchesBase = true,
} = {}){
  const suppliedBasis = typeof priorYearEndBalanceForOwner === 'function';
  const details = {};
  let anyKnown = false;
  let anyUnavailable = false;
  let requiredTotal = 0;
  let priorYearEndTotal = 0;
  let priorYearEndComplete = true;

  const contractOwners = contract?.byOwner;
  for(const owner of TRADITIONAL_PERSON_OWNERS){
    const ownerContract = contractOwners?.[owner];
    if(!ownerContract) continue;
    const ownerPerson = householdState.people?.[owner] ?? null;
    let status = 'not-required';
    let required = 0;
    let issue = null;
    const basis = suppliedBasis
      ? priorYearEndBalanceForOwner(owner, ownerContract)
      : ownerContract.priorYearEndBalance;
    const basisAvailable = suppliedBasis
      ? Number.isFinite(basis)
      : (ownerContract.priorYearEndBalanceAvailable === true && Number.isFinite(basis));

    if(suppliedBasis && !(basis > 0.01)){
      // Projection mode: this owner holds no pre-tax dollars this year, so
      // there is nothing to distribute and nothing to resolve. Most often a
      // decedent whose balance already rolled to the survivor — they must not
      // keep failing the lifecycle check forever after.
      status = 'not-required';
      required = 0;
    }else if(!ownerPerson?.alive){
      status = 'unavailable';
      required = null;
      issue = 'TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE';
    }else if(ownerContract.startAge === null){
      status = 'unavailable';
      required = null;
      issue = 'RMD_BIRTH_COHORT_UNAVAILABLE';
    }else if(ownerPerson.age >= ownerContract.startAge){
      if(!focusYearMatchesBase){
        status = 'unavailable';
        required = null;
        issue = 'RMD_FOCUS_YEAR_BALANCE_UNAVAILABLE';
      }else if(ownerContract.rmdAccountAttributionAvailable !== true){
        status = 'unavailable';
        required = null;
        issue = 'EMPLOYER_PLAN_RMD_ACCOUNT_ATTRIBUTION_UNAVAILABLE';
      }else if(ownerContract.focusRulesAvailable !== true){
        status = 'unavailable';
        required = null;
        issue = 'TRADITIONAL_ACCOUNT_RMD_RULE_UNAVAILABLE';
      }else if(ownerContract.containsEmployerPlan
          && ownerPerson.retired !== true){
        status = 'unavailable';
        required = null;
        issue = 'EMPLOYER_PLAN_RMD_RULE_UNAVAILABLE';
      }else if(!basisAvailable){
        status = 'unavailable';
        required = null;
        issue = 'RMD_PRIOR_YEAR_END_BALANCE_UNAVAILABLE';
      }else{
        status = 'known';
        required = basis / rmdDivisor(ownerPerson.age);
      }
    }

    if(status === 'known') anyKnown = true;
    if(status === 'unavailable') anyUnavailable = true;
    if(required !== null) requiredTotal += required;
    if(Number.isFinite(basis)){
      priorYearEndTotal += basis;
    }else{
      priorYearEndComplete = false;
    }
    details[owner] = {
      status,
      age: ownerPerson?.age ?? null,
      applicableAge: ownerContract.startAge,
      priorYearEndBalance: Number.isFinite(basis) ? basis : null,
      containsEmployerPlan: ownerContract.containsEmployerPlan === true,
      required,
      issue,
    };
  }

  return {
    byOwner: details,
    requiredTotal: anyUnavailable ? null : requiredTotal,
    status: anyUnavailable ? 'unavailable' : (anyKnown ? 'known' : 'not-required'),
    issue: anyUnavailable
      ? (Object.values(details).find(detail => detail.issue)?.issue
        ?? 'RMD_CONTRACT_UNAVAILABLE')
      : null,
    priorYearEndTotal,
    priorYearEndComplete,
  };
}

/**
 * A goal's cost in THIS year, in today's dollars.
 *
 * Most goals are flat real: the same purchasing power every year they run, so
 * realGrowth is 0 and this returns the entered amount. Healthcare is the case
 * that isn't — it rises faster than general inflation, so it compounds above
 * CPI from its own start age. Same curve the engine previously applied to
 * plan.expenses.healthcare, now a property of the goal rather than a hardcoded
 * special case in the year loop.
 */
function goalAmountAtAge(goal, age){
  if(!(goal.realGrowth > 0)) return goal.amount;
  const yearsRunning = Math.max(0, age - goal.startAge);
  return goal.amount * Math.pow(1 + goal.realGrowth, yearsRunning);
}

function externalIncomeAtAge(p, age){
  let ssInc = 0;
  for(const b of p.ss){ if(age >= b.startAge && (b.endAge == null || age <= b.endAge)) ssInc += b.amount; }
  let oiInc = 0, oiTaxable = 0;
  const taxIncome = {};
  const add = (key, value) => {
    if(value !== 0) taxIncome[key] = (taxIncome[key] || 0) + value;
  };
  for(const o of p.otherIncome){
    if(age >= o.startAge && age <= o.endAge){
      const amt = o.amount * Math.pow(1 + o.realGrowth, age - o.startAge);
      const taxable = amt * o.taxablePct;
      if(o.typeId === 'social_security'){
        ssInc += amt;
        continue;
      }
      oiInc     += amt;
      oiTaxable += taxable;
      if(o.typeId === 'wages' || o.typeId === 'bonus') add('wages', amt);
      else if(o.typeId === 'interest'){
        add('taxableInterest', taxable);
        add('taxExemptInterest', amt - taxable);
      }else if(o.typeId === 'tax_exempt_interest') add('taxExemptInterest', amt);
      else if(o.typeId === 'dividends'){
        add('ordinaryDividends', taxable);
        add('qualifiedDividends', taxable * o.qualifiedPct);
      }else if(o.typeId === 'pension' || o.typeId === 'annuity'){
        add('pensionAmount', amt);
        add('taxablePensions', taxable);
      }else if(o.typeId === 'ira_distribution'){
        add('iraDistributions', amt);
        add('iraCashDistributions', amt);
        add('taxableIra', taxable);
        if(o.owner === 'client' || o.owner === 'spouse'){
          taxIncome.iraDistributionsByOwner ??= { client: 0, spouse: 0 };
          taxIncome.iraCashDistributionsByOwner ??= { client: 0, spouse: 0 };
          taxIncome.iraDistributionsByOwner[o.owner] += amt;
          taxIncome.iraCashDistributionsByOwner[o.owner] += amt;
        }
      }else if(o.typeId === 'roth_conversion'){
        add('iraDistributions', amt);
        add('rothConversions', amt);
        add('taxableIra', taxable);
        if(o.owner === 'client' || o.owner === 'spouse'){
          taxIncome.iraDistributionsByOwner ??= { client: 0, spouse: 0 };
          taxIncome.rothConversionsByOwner ??= { client: 0, spouse: 0 };
          taxIncome.iraDistributionsByOwner[o.owner] += amt;
          taxIncome.rothConversionsByOwner[o.owner] += amt;
        }
      }else if(o.typeId === 'long_term_capital_gain') add('capitalGain', amt);
      else add('otherIncome', taxable);
    }
  }
  const penInc = (p.pension && age >= p.pension.startAge)
    ? p.pension.amount * Math.pow(1 + (p.pension.colaReal || 0), age - p.pension.startAge) : 0;
  add('socialSecurityBenefits', ssInc);
  if(penInc !== 0){
    add('pensionAmount', penInc);
    add('taxablePensions', penInc);
  }
  return { ssInc, oiInc, oiTaxable, penInc, taxIncome };
}

function householdStateAtYear(p, yearIndex){
  if(typeof yearIndex !== 'number' || !Number.isFinite(yearIndex)){
    throw new TypeError('yearIndex must be a finite number');
  }
  const people = p?.people;
  if(!people?.client){
    throw new TypeError('resolved household people are required');
  }

  const stateFor = person => {
    if(!person) return null;
    const age = person.currentAge === null ? null : person.currentAge + yearIndex;
    const alive = age === null || person.planEndAge === null
      ? (yearIndex <= 0 ? true : null)
      : age <= person.planEndAge;
    return Object.freeze({
      age,
      alive,
      rmdStartAge: person.rmdStartAge,
      retired: alive === null || person.retirementAge === null
        ? null
        : alive && age >= person.retirementAge,
      claimingSocialSecurity: alive === null || person.socialSecurityClaimAge === null
        ? null
        : alive && age >= person.socialSecurityClaimAge,
    });
  };
  const client = stateFor(people.client);
  const spouse = stateFor(people.spouse);
  const hasSpouseTimeline = spouse !== null;
  const survivor = hasSpouseTimeline
    && typeof client.alive === 'boolean'
    && typeof spouse.alive === 'boolean'
    && client.alive !== spouse.alive;
  const survivingOwner = survivor
    ? (client.alive ? 'client' : 'spouse')
    : null;
  const ages = spouse
    ? Object.freeze({ client: client.age, spouse: spouse.age })
    : Object.freeze({ client: client.age });

  const filingStatus = !hasSpouseTimeline
    ? (client.alive === true ? p.survival?.initialFilingStatus ?? null : null)
    : client.alive === true && spouse.alive === true
      ? p.survival?.initialFilingStatus ?? null
      : (client.alive === true && spouse.alive === false)
          || (client.alive === false && spouse.alive === true)
        ? 'single'
        : null;

  return Object.freeze({
    ages,
    people: Object.freeze({ client, spouse }),
    filingStatus,
    survivor,
    survivingOwner,
  });
}

function householdIncomeAtYear(p, yearIndex){
  const age = p.currentAge + yearIndex;
  const income = externalIncomeAtAge(p, age);
  const taxIncome = { ...income.taxIncome };
  const wages = taxIncome.wages || 0;
  const grossOtherIncome = income.oiInc - wages + income.penInc;
  const householdState = householdStateAtYear(p, yearIndex);
  const socialSecurityAvailable = !(p.incomeContractIssues || []).some(issue => (
    String(issue).startsWith('SOCIAL_SECURITY_TIMELINE_INCOMPLETE:')
  ));
  const unavailableIncomeTypes = new Set((p.incomeContractIssues || [])
    .filter(issue => (
      String(issue).startsWith('INCOME_OWNER_UNAVAILABLE:')
        || String(issue).startsWith('INCOME_TIMELINE_INCOMPLETE:')
    ))
    .map(issue => String(issue).split(':').at(-1)));
  const missingWageOwners = (p.incomeContractIssues || [])
    .filter(issue => String(issue).startsWith('INCOME_SOURCE_MISSING:')
      && String(issue).endsWith(':wages'))
    .map(issue => String(issue).split(':')[1]);
  const wagesAvailable = !unavailableIncomeTypes.has('wages')
    && !unavailableIncomeTypes.has('bonus')
    && missingWageOwners.every(owner => (
      householdState.people?.[owner]?.retired !== false
    ));
  const otherIncomeAvailable = [...unavailableIncomeTypes].every(typeId => (
    typeId === 'wages' || typeId === 'bonus' || typeId === 'social_security'
  ));
  const pensionAvailable = !unavailableIncomeTypes.has('pension')
    && !unavailableIncomeTypes.has('annuity');
  return Object.freeze({
    ...householdState,
    ...taxIncome,
    available: householdState.filingStatus !== null,
    incomeIssues: p.incomeContractIssues ?? Object.freeze([]),
    age,
    socialSecurityBenefits: socialSecurityAvailable
      ? taxIncome.socialSecurityBenefits || 0
      : null,
    wages: wagesAvailable ? wages : null,
    otherIncome: otherIncomeAvailable ? taxIncome.otherIncome || 0 : null,
    taxableOtherIncome: otherIncomeAvailable ? taxIncome.otherIncome || 0 : null,
    grossSupplementalIncome: otherIncomeAvailable ? income.oiInc : null,
    grossOtherIncome: otherIncomeAvailable ? grossOtherIncome : null,
    pensionAmount: pensionAvailable ? taxIncome.pensionAmount || 0 : null,
    taxablePensions: pensionAvailable ? taxIncome.taxablePensions || 0 : null,
  });
}

function householdTaxStatusAtAge(p, age){
  return householdStateAtYear(p, age - p.currentAge);
}

function shortcutTaxOnExternalIncome(p, { ssInc, oiTaxable, penInc }){
  const taxOnSS  = ssInc * 0.85 * p.taxRates.ordinary;
  const taxOnOI  = oiTaxable * p.taxRates.ordinary;
  const taxOnPen = penInc * p.taxRates.ordinary;
  return {
    taxOnSS, taxOnOI, taxOnPen,
    shortcutTax: taxOnSS + taxOnOI + taxOnPen,
  };
}

const FEDERAL_FUNDING_CONVERGENCE_TOLERANCE = 0.01;
const FEDERAL_FUNDING_MAX_ITERATIONS = 32;

function assertFiniteFederalFundingInputs(age, values){
  const invalid = Object.entries(values)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([name, value]) => `${name}=${String(value)}`);
  if(invalid.length){
    throw new TypeError(
      `Federal funding inputs must be finite at age ${age}: ${invalid.join(', ')}`
    );
  }
}

function cloneEngineAccounts(accounts){
  const projectionAccounts = cloneProjectionAccountLedger(accounts.projectionAccounts);
  const cloned = {
    taxable: {
      balance: 0,
      basis: 0,
    },
    traditional: {
      balance: 0,
      byOwner: emptyTraditionalOwnerBuckets(),
    },
    roth: { balance: 0 },
    projectionAccounts,
  };
  syncProjectionAggregates(projectionAccounts, cloned);
  return cloned;
}

function midyearWithdrawalFactor(returnRate){
  return Math.abs(returnRate) < 1e-7
    ? 12
    : returnRate / (Math.pow(1 + returnRate, 1 / 12) - 1);
}

// Ordinary retirement draws are spread through the year. With a negative
// annual return, less than the opening balance can actually be delivered under
// that timing convention. Scale every sleeve (and taxable basis) by the same
// capacity factor so fundGap reports the deliverable draw and explicit
// shortfall instead of funding from money lost before later installments.
function buildMidyearFundingProxy(accounts, returnRate, factor){
  const rawScale = Number.isFinite(factor) && factor > 0
    ? ((1 + returnRate) * 12) / factor
    : 0;
  const scale = Math.max(0, Math.min(1, rawScale));
  const traditionalByOwner = Object.fromEntries(
    TRADITIONAL_OWNER_KEYS.map(owner => [
      owner,
      Math.max(0, accounts.traditional.byOwner[owner] ?? 0) * scale,
    ])
  );
  return {
    taxable: {
      balance: Math.max(0, accounts.taxable.balance) * scale,
      basis: Math.max(0, accounts.taxable.basis) * scale,
    },
    traditional: {
      balance: Object.values(traditionalByOwner).reduce((sum, value) => sum + value, 0),
      byOwner: traditionalByOwner,
    },
    roth: { balance: Math.max(0, accounts.roth.balance) * scale },
  };
}

function emptyFunding(){
  return {
    totalWithdrawn: 0,
    totalTax: 0,
    breakdown: { taxable: 0, traditional: 0, roth: 0 },
    taxBySource: { taxable: 0, traditional: 0 },
    shortfall: 0,
  };
}

function accountTotal(accounts){
  return accounts.taxable.balance
    + accounts.traditional.balance
    + accounts.roth.balance;
}

function combineAccountAmounts(...maps){
  const combined = {};
  for(const map of maps){
    for(const [accountId, amount] of Object.entries(map ?? {})){
      combined[accountId] = (combined[accountId] ?? 0) + amount;
    }
  }
  return combined;
}

function traditionalWithdrawalsByOwner(ledger, withdrawalsById){
  if(!withdrawalsById || Object.keys(withdrawalsById).length === 0){
    return ZERO_TRADITIONAL_OWNER_BUCKETS;
  }
  const byOwner = emptyTraditionalOwnerBuckets();
  for(const account of ledger){
    if(account.bucket === 'traditional'){
      byOwner[account.owner] += withdrawalsById?.[account.id] ?? 0;
    }
  }
  return byOwner;
}

function appendFailedTailRows(rows, p, failedYearIndex){
  for(let z = failedYearIndex + 1; z < p.horizonYears; z++){
    rows.push({
      year:z+1, age:p.currentAge+z, source:null, returnRate:0, returnDollars:0,
      ...householdStateAtYear(p, z),
      socialSecurity:0, otherIncome:0, withdrawal:0,
      expenses:0, goals:0, taxes:0,
      startBalance:0, wdRate:0, netCashflow:0, balance:0, failed:true,
      fundingShortfall:0,
      accountBreakdown: { taxable:0, traditional:0, roth:0 },
      accountBalances:  { taxable:0, traditional:0, roth:0 }
    });
  }
}

/**
 * Rebuild one retirement year from the same opening account state for a
 * candidate federal-tax funding adjustment. The ordinary engine gap already
 * includes its shortcut tax assumptions, so the signed adjustment is the
 * difference between modeled federal tax and that candidate's shortcut tax.
 * Replaying from the opening state is what lets a lower federal liability
 * reduce withdrawals instead of pretending the savings arrived after them.
 */
function buildFederalFundingCandidate({
  openingAccounts,
  p,
  rp,
  y,
  age,
  r,
  returnFrame,
  saleProceeds,
  ssInc,
  oiInc,
  oiTaxable,
  penInc,
  taxIncome,
  expenses,
  goalsY,
  liabCost,
  lumpY,
  gap,
  taxOnSS,
  taxOnOI,
  taxOnPen,
  preFederalFunding,
  openingRmd,
  includeAccountDiagnostics,
}, taxFundingAdjustment){
  const accounts = cloneEngineAccounts(openingAccounts);
  const startBalance = accountTotal(accounts);
  const accountStartingBalances = {
    taxable: accounts.taxable.balance,
    traditional: accounts.traditional.balance,
    roth: accounts.roth.balance,
  };
  const taxableStartingBasis = accounts.taxable.basis;
  // The requirement is a function of the OPENING state, which is identical for
  // every secant candidate — so the caller resolves it once per year and passes
  // it in rather than each candidate re-deriving the same number.
  const rmdRequiredByOwner = openingRmd.requiredByOwner;
  const rmdRequired = openingRmd.required;

  const adjustedGap = gap + taxFundingAdjustment;
  const funding = adjustedGap > 0
    ? fundProjectionGap(
        accounts.projectionAccounts,
        returnFrame,
        adjustedGap,
        p.taxRates,
        p.withdrawalStrategy,
        rmdRequiredByOwner,
      )
    : emptyFunding();
  const withdrawal = funding.totalWithdrawn;
  const appliedFunding = applyProjectionYearReturnsAndWithdrawals(
    accounts.projectionAccounts,
    returnFrame,
    funding.grossById,
  );
  syncProjectionAggregates(accounts.projectionAccounts, accounts);
  const traditionalGrossByOwner = funding.traditionalGrossByOwner
    ?? emptyTraditionalOwnerBuckets();

  const taxableCapitalGain = appliedFunding.taxableCapitalGain;

  let rmdForced = 0;
  let rmdTax = 0;
  let rmdWithdrawalsById = {};
  if(rmdRequired > 0){
    // Net each owner's requirement against what THEY actually withdrew. One
    // spouse's spending draw can never satisfy the other's RMD.
    const outstandingByOwner = Object.fromEntries(
      TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
        0,
        (rmdRequiredByOwner[owner] ?? 0) - (traditionalGrossByOwner[owner] ?? 0),
      )]),
    );
    const forced = applyProjectionOwnerRmd(
      accounts.projectionAccounts,
      outstandingByOwner,
    );
    rmdForced = forced.total;
    rmdWithdrawalsById = forced.byId;
    if(rmdForced > 0.01){
      rmdTax = rmdForced * p.taxRates.ordinary;
    }
    syncProjectionAggregates(accounts.projectionAccounts, accounts);
  }

  // Save the gross lower-tax surplus for the converged solver. Attribution to
  // a forced gross-spent RMD needs the final policy liability, so crediting
  // taxable cash here would be both premature and wrong for custom policies.
  const grossTaxSavingsReinvested = Math.max(
    0,
    -(Math.max(0, gap) + taxFundingAdjustment)
  );

  const shortcutTax = taxOnSS + taxOnOI + taxOnPen + funding.totalTax + rmdTax;
  const wdRate = startBalance > 0.01 && withdrawal > 0
    ? (withdrawal / startBalance) * 100
    : 0;
  const taxableGainFraction = funding.breakdown.taxable > 0.01
    ? taxableCapitalGain / funding.breakdown.taxable
    : undefined;
  const policyRow = {
    year: y + 1,
    age,
    ...householdTaxStatusAtAge(p, age),
    source: rp.y,
    returnRate: r,
    returnDollars: returnFrame.returnDollars,
    ...(includeAccountDiagnostics ? {
      accountReturns: returnFrame.accountReturns,
      householdEffectiveAllocation: returnFrame.householdAllocation,
    } : {}),
    nominalReturn: (rp && rp.proxyNominalReturn != null) ? rp.proxyNominalReturn : null,
    inflationRate: (rp && rp.proxyInflationRate != null) ? rp.proxyInflationRate : null,
    realReturnUsed: r,
    socialSecurity: ssInc,
    otherIncome: oiInc,
    pension: penInc,
    incomeTaxFacts: { ...taxIncome },
    withdrawal,
    ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
    rmd: rmdForced,
    rmdRequired,
    rmdAvailable: openingRmd.available,
    rmdOwner: openingRmd.owner,
    rmdIssue: openingRmd.issue,
    // New per-owner detail. `rmd` above stays forced-only — the tax adapter
    // computes accountBreakdown.traditional + row.rmd, so redefining it would
    // double-count the ordinary draw on Form 1040.
    rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
    rmdGrossByOwner: { ...traditionalGrossByOwner },
    rmdBasisSource: openingRmd.basisSource,
    assetSale: saleProceeds,
    expenses,
    goals: goalsY,
    liabilities: liabCost,
    taxes: shortcutTax,
    lumpSum: lumpY,
    startBalance,
    wdRate,
    netCashflow: (ssInc + oiInc + penInc + saleProceeds)
      - (expenses + goalsY + liabCost + shortcutTax),
    balance: accountTotal(accounts),
    failed: false,
    fundingShortfall: funding.shortfall,
    accountBreakdown: { ...funding.breakdown },
    preTaxDeltaAccountBreakdown: { ...preFederalFunding.breakdown },
    accountStartingBalances: { ...accountStartingBalances },
    taxableStartingBasis,
    taxableCapitalGain,
    accountBalances: {
      taxable: accounts.taxable.balance,
      traditional: accounts.traditional.balance,
      roth: accounts.roth.balance,
    },
    ...(includeAccountDiagnostics ? {
      accountBalancesById: accountBalancesById(accounts.projectionAccounts),
      accountStates: snapshotProjectionAccounts(accounts.projectionAccounts),
      accountWithdrawalsById: combineAccountAmounts(
        funding.grossById,
        rmdWithdrawalsById,
      ),
    } : {}),
    taxableEndingBasis: accounts.taxable.basis,
    ...(taxableGainFraction !== undefined ? { taxableGainFraction } : {}),
    taxBySource: {
      ss: taxOnSS,
      oi: taxOnOI,
      traditional: funding.taxBySource.traditional,
      taxable: funding.taxBySource.taxable,
    },
  };

  return {
    accounts,
    funding,
    policyRow,
    shortcutTax,
    grossTaxSavingsReinvested,
    rmdShortcutTax: rmdTax,
  };
}

function solveFederalFundingYear(args, taxPolicy){
  const preFederalFunding = args.gap > 0
    ? fundProjectionGap(
        args.openingAccounts.projectionAccounts,
        args.returnFrame,
        args.gap,
        args.p.taxRates,
        args.p.withdrawalStrategy,
        args.openingRmd.requiredByOwner,
      )
    : emptyFunding();
  let adjustment = 0;
  let lowerBracket = null;
  let upperBracket = null;
  let previousEvaluation = null;

  for(let iteration = 1; iteration <= FEDERAL_FUNDING_MAX_ITERATIONS; iteration++){
    const candidate = buildFederalFundingCandidate(
      { ...args, preFederalFunding },
      adjustment
    );
    const resolvedTax = taxPolicy(candidate.policyRow, {
      shortcutTax: candidate.shortcutTax,
      yearIndex: args.y,
    });
    if(!Number.isFinite(resolvedTax) || resolvedTax < 0){
      throw new TypeError('taxPolicy must return a finite non-negative tax');
    }
    const targetAdjustment = resolvedTax - candidate.shortcutTax;
    const residual = targetAdjustment - adjustment;
    if(Math.abs(residual) <= FEDERAL_FUNDING_CONVERGENCE_TOLERANCE){
      const accounts = candidate.accounts;
      let taxSavingsReinvested = candidate.grossTaxSavingsReinvested;
      if(candidate.policyRow.rmd > 0.01 && taxSavingsReinvested > 0){
        const shortcutTaxWithoutForcedRmd = Math.max(
          0,
          candidate.shortcutTax - candidate.rmdShortcutTax,
        );
        const counterfactualTax = taxPolicy({
          ...candidate.policyRow,
          rmd: 0,
          taxes: shortcutTaxWithoutForcedRmd,
          netCashflow: (
            args.ssInc + args.oiInc + args.penInc + args.saleProceeds
          ) - (args.expenses + args.goalsY + args.liabCost + shortcutTaxWithoutForcedRmd),
        }, {
          shortcutTax: shortcutTaxWithoutForcedRmd,
          yearIndex: args.y,
        });
        if(!Number.isFinite(counterfactualTax) || counterfactualTax < 0){
          throw new TypeError('taxPolicy must return a finite non-negative tax');
        }
        const actualRmdMarginalTax = Math.max(0, resolvedTax - counterfactualTax);
        const rmdTaxSaving = Math.max(
          0,
          candidate.rmdShortcutTax - actualRmdMarginalTax,
        );
        taxSavingsReinvested = Math.max(0, taxSavingsReinvested - rmdTaxSaving);
      }
      if(taxSavingsReinvested > 0){
        addProjectionCash(
          accounts.projectionAccounts,
          'taxable',
          taxSavingsReinvested,
          taxSavingsReinvested,
        );
        syncProjectionAggregates(accounts.projectionAccounts, accounts);
      }
      for(const account of accounts.projectionAccounts){
        if(account.balance < 0) account.balance = 0;
      }
      syncProjectionAggregates(accounts.projectionAccounts, accounts);
      const failed = candidate.funding.shortfall > 0.01;
      if(failed){
        zeroProjectionAccounts(accounts.projectionAccounts);
        syncProjectionAggregates(accounts.projectionAccounts, accounts);
      }
      const row = {
        ...candidate.policyRow,
        taxes: resolvedTax,
        netCashflow: (
          args.ssInc + args.oiInc + args.penInc + args.saleProceeds
        ) - (args.expenses + args.goalsY + args.liabCost + resolvedTax),
        balance: accountTotal(accounts),
        failed,
        accountBalances: {
          taxable: accounts.taxable.balance,
          traditional: accounts.traditional.balance,
          roth: accounts.roth.balance,
        },
        ...(args.includeAccountDiagnostics ? {
          accountBalancesById: accountBalancesById(accounts.projectionAccounts),
          accountStates: snapshotProjectionAccounts(accounts.projectionAccounts),
        } : {}),
        taxableEndingBasis: accounts.taxable.basis,
        taxFundingConvergence: {
          status: 'converged',
          iterations: iteration,
          tolerance: FEDERAL_FUNDING_CONVERGENCE_TOLERANCE,
          residual,
          fundingAdjustment: adjustment,
          taxSavingsReinvested,
        },
      };
      return { accounts, row, failed };
    }
    if(residual > 0){
      if(!lowerBracket || adjustment > lowerBracket.adjustment){
        lowerBracket = { adjustment, residual };
      }
    }else if(!upperBracket || adjustment < upperBracket.adjustment){
      upperBracket = { adjustment, residual };
    }
    let nextAdjustment = targetAdjustment;
    if(previousEvaluation){
      const residualDelta = residual - previousEvaluation.residual;
      if(Math.abs(residualDelta) > Number.EPSILON){
        const secant = adjustment - residual
          * (adjustment - previousEvaluation.adjustment)
          / residualDelta;
        if(Number.isFinite(secant)) nextAdjustment = secant;
      }
    }
    if(lowerBracket && upperBracket){
      const low = Math.min(lowerBracket.adjustment, upperBracket.adjustment);
      const high = Math.max(lowerBracket.adjustment, upperBracket.adjustment);
      if(!(nextAdjustment > low && nextAdjustment < high)){
        nextAdjustment = (low + high) / 2;
      }
    }
    previousEvaluation = { adjustment, residual };
    adjustment = nextAdjustment;
  }

  const error = new RangeError('TAX_POLICY_FUNDING_DID_NOT_CONVERGE');
  error.code = 'TAX_POLICY_FUNDING_DID_NOT_CONVERGE';
  throw error;
}

function runSinglePath(p, returnPath, options = {}){
  if(p.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  validateProjectionHorizon(p.horizonYears);
  validateReturnPaths([returnPath], p.horizonYears);
  const taxPolicy = options.taxPolicy ?? null;
  const fundTaxPolicyDelta = options.fundTaxPolicyDelta === true;
  const includeAccountDiagnostics = options.includeAccountDiagnostics !== false;
  const projectionReturnCache = options.projectionReturnCache
    ?? createProjectionReturnCache();
  if(taxPolicy !== null && typeof taxPolicy !== 'function'){
    throw new TypeError('options.taxPolicy must be a function');
  }
  // Each path gets its own evolving account ledger. Aggregate tax sleeves are
  // derived adapters retained for existing row and planning contracts.
  const projectionAccounts = cloneProjectionAccountLedger(p.projectionAccounts);
  const accounts = {
    taxable: { balance: 0, basis: 0 },
    traditional: { balance: 0, byOwner: emptyTraditionalOwnerBuckets() },
    roth: { balance: 0 },
    projectionAccounts,
  };
  syncProjectionAggregates(projectionAccounts, accounts);

  let returnProduct = 1;
  let failed        = false;
  let lifetimeTax   = 0;  // cumulative taxes paid across all years of this path
  const rows = [];

  // Total balance across all accounts — what we report as "portfolio balance".
  const totalBalance = () => accounts.taxable.balance + accounts.traditional.balance + accounts.roth.balance;

  // Path-level risk metrics (against total portfolio balance).
  let minBalance      = totalBalance();
  let peakBalance     = totalBalance();
  let maxDrawdown     = 0;
  let depletionAge    = null;
  let first10Product  = 1;
  let balanceAt10     = 0;
  let balanceAtRet10  = 0;
  // Owners already rolled over, so a death boundary transfers exactly once.
  const rolledOverOwners = new Set();

  for(let y = 0; y < p.horizonYears; y++){
    const age = p.currentAge + y;
    const rp  = returnPath[y];

    // ── Earmarked-asset sale ──────────────────────────────────────────────
    // Net proceeds land in the TAXABLE sleeve as after-tax cash (basis = full
    // proceeds) at the sale age, then invest and compound from here forward —
    // works in either phase. Applied via the assetSale override only; the base
    // plan is never mutated, so the Baseline column never sees it.
    const saleProceeds = (p.assetSale && age === p.assetSale.age) ? p.assetSale.netProceeds : 0;
    if(saleProceeds > 0){
      addProjectionCash(projectionAccounts, 'taxable', saleProceeds, saleProceeds);
      syncProjectionAggregates(projectionAccounts, accounts);
    }

    // ── Death boundary: spousal rollover ──────────────────────────────────
    // Applied at the opening of the year following a death, which is the same
    // instant as the closing boundary of the decedent's final living year — but
    // reachable from one place, since the retirement branches below exit via
    // `continue`. The decedent's year-of-death RMD was therefore already
    // computed and satisfied last iteration, off their own balance and age.
    // From here the survivor owns the combined balance under their own age.
    if(y > 0){
      const rollover = applyDeathBoundaryRollover(
        p,
        age,
        accounts.traditional,
        rolledOverOwners,
      );
      if(rollover){
        rolloverProjectionAccounts(projectionAccounts, rollover.from, rollover.to);
        syncProjectionAggregates(projectionAccounts, accounts);
      }
    }

    const returnFrame = resolveProjectionReturnFrame(
      projectionAccounts,
      rp,
      p.returnAdj,
      { includeAccountDiagnostics, projectionReturnCache },
    );
    const r = returnFrame.returnRate;

    // ── Per-owner RMD for the year ────────────────────────────────────────
    // Basis convention: year 0 uses each owner's raw pre-shock opening balance
    // as the assumed prior-Dec-31 figure (an initial market shock is a drop
    // occurring during the projection, not a revision of last year's
    // statement); every later year uses that owner's actual simulated prior
    // year-end close, which is exactly what `byOwner` holds right now.
    const openingRmd = resolveOpeningRmd(p, age, accounts.traditional, y);
    if(openingRmd.status === 'unavailable'){
      const error = new RangeError('HOUSEHOLD_RMD_UNAVAILABLE');
      error.code = 'HOUSEHOLD_RMD_UNAVAILABLE';
      error.rmdIssue = openingRmd.issue;
      error.age = age;
      error.rows = rows;          // keep diagnostic rows for the fail-closed result
      throw error;
    }

    // ── ACCUMULATION PHASE (age < retirementAge) ──────────────────────────
    // Still working: portfolio grows and receives savings; no retirement
    // spending or withdrawals yet. Timed external income (wages, etc.) is
    // reported on rows for Cash Flow; recurring living costs are still assumed
    // covered off-books while working. No-op at default (retirementAge==currentAge).
    if(age < p.retirementAge){
      const { ssInc, oiInc, oiTaxable, penInc, taxIncome } = externalIncomeAtAge(p, age);
      returnProduct *= (1 + r);
      if(y < 10) first10Product *= (1 + r);
      const startBalanceA = totalBalance();
      const contributionsById = applyProjectionContributions(
        projectionAccounts,
        returnFrame,
        {
          taxable: p.savingsAnnual * p.savingsSplit.taxable,
          traditional: p.savingsAnnual * p.savingsSplit.traditional,
          roth: p.savingsAnnual * p.savingsSplit.roth,
        },
      );
      syncProjectionAggregates(projectionAccounts, accounts);
      let rmdForcedA = 0;
      let rmdTaxA = 0;
      let rmdWithdrawalsByIdA = {};
      // One-time capital outlay (e.g. a home purchase) during working years. The
      // engine assumes salary covers recurring costs while working, but a large
      // purchase is funded by liquidating investments — taxable first, then
      // traditional, then Roth. (Simplification: principal only, no cap-gains tax
      // on the sale — small vs the outlay and consistent with the accum model.)
      const lumpA = (p.lumpSum > 0 && y === p.lumpSumYear) ? p.lumpSum : 0;
      // Parallax does not run a working-year household budget. A goal remains
      // off-book before both clients retire unless the advisor explicitly marks
      // it as portfolio-funded.
      let goalsA = 0;
      for(const g of p.goals){
        if(g.fundFromPortfolioBeforeRetirement && age >= g.startAge && age <= g.endAge){
          goalsA += goalAmountAtAge(g, age);
        }
      }
      const outlayA = lumpA + goalsA;
      // Working-year portfolio outlays use the same explicit funding result as
      // retirement. Zero tax rates preserve the existing principal-only
      // simplification while exposing every draw and unmet required dollar.
      const accumulationFunding = outlayA > 0
        ? fundGap(accounts, outlayA, { ordinary: 0, capitalGains: 0 }, 'taxable-first')
        : emptyFunding();
      const taxableStartingBasisA = accounts.taxable.basis;
      let taxableCapitalGainA = 0;
      let outlayWithdrawalsByIdA = {};
      if(outlayA > 0){
        for(const bucket of ['taxable', 'traditional', 'roth']){
          const direct = applyDirectBucketWithdrawal(
            projectionAccounts,
            bucket,
            accumulationFunding.breakdown[bucket],
          );
          taxableCapitalGainA += direct.taxableCapitalGain;
          outlayWithdrawalsByIdA = combineAccountAmounts(
            outlayWithdrawalsByIdA,
            direct.withdrawalsById,
          );
        }
        syncProjectionAggregates(projectionAccounts, accounts);
      }
      const traditionalOutlayByOwner = accumulationFunding.breakdown.traditional > 0.01
        && (openingRmd.required > 0 || includeAccountDiagnostics)
        ? traditionalWithdrawalsByOwner(projectionAccounts, outlayWithdrawalsByIdA)
        : ZERO_TRADITIONAL_OWNER_BUCKETS;
      if(openingRmd.required > 0){
        // A Traditional outlay already distributed by a given owner satisfies
        // that owner's RMD. Force only the remaining owner-level top-up.
        const outstandingByOwner = Object.fromEntries(
          TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
            0,
            (openingRmd.requiredByOwner[owner] ?? 0)
              - (traditionalOutlayByOwner[owner] ?? 0),
          )]),
        );
        const forcedA = applyProjectionOwnerRmd(
          projectionAccounts,
          outstandingByOwner,
        );
        rmdForcedA = forcedA.total;
        rmdWithdrawalsByIdA = forcedA.byId;
        const rmdSatisfied = TRADITIONAL_PERSON_OWNERS.reduce((sum, owner) => (
          sum + Math.min(
            openingRmd.requiredByOwner[owner] ?? 0,
            (traditionalOutlayByOwner[owner] ?? 0) + (forcedA.byOwner[owner] ?? 0),
          )
        ), 0);
        if(rmdSatisfied > 0.01){
          rmdTaxA = rmdSatisfied * p.taxRates.ordinary;
        }
        syncProjectionAggregates(projectionAccounts, accounts);
      }
      const taxableGainFractionA = accumulationFunding.breakdown.taxable > 0.01
        ? taxableCapitalGainA / accumulationFunding.breakdown.taxable
        : undefined;
      const accumulationFailed = accumulationFunding.shortfall > 0.01;
      if(accumulationFailed){
        zeroProjectionAccounts(projectionAccounts);
        syncProjectionAggregates(projectionAccounts, accounts);
        failed = true;
        if(depletionAge === null) depletionAge = age;
      }
      const endBalanceA = totalBalance();
      if(y === 9) balanceAt10 = endBalanceA;
      if(endBalanceA < minBalance) minBalance = endBalanceA;
      if(endBalanceA > peakBalance) peakBalance = endBalanceA;
      if(peakBalance > 0){ const dd = (peakBalance - endBalanceA) / peakBalance; if(dd > maxDrawdown) maxDrawdown = dd; }
      const { taxOnSS, taxOnOI, taxOnPen, shortcutTax } = shortcutTaxOnExternalIncome(p, { ssInc, oiTaxable, penInc });
      const rowShortcutTax = shortcutTax + rmdTaxA;
      const row = {
        year: y+1, age, source: rp.y, returnRate: r, phase: 'accum',
        ...householdTaxStatusAtAge(p, age),
        returnDollars: returnFrame.returnDollars,
        ...(includeAccountDiagnostics ? {
          accountReturns: returnFrame.accountReturns,
          householdEffectiveAllocation: returnFrame.householdAllocation,
        } : {}),
        socialSecurity: ssInc, otherIncome: oiInc, pension: penInc,
        incomeTaxFacts: { ...taxIncome }, withdrawal: accumulationFunding.totalWithdrawn,
        rmd: rmdForcedA,
        rmdRequired: openingRmd.required,
        ...(includeAccountDiagnostics ? {
          rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
          rmdGrossByOwner: { ...traditionalOutlayByOwner },
        } : {}),
        rmdAvailable: true,
        rmdOwner: openingRmd.owner,
        rmdIssue: null,
        assetSale: saleProceeds,
        ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
        expenses: 0, goals: goalsA, liabilities: 0, taxes: rowShortcutTax, savings: p.savingsAnnual, lumpSum: lumpA,
        startBalance: startBalanceA, wdRate: 0,
        netCashflow: saleProceeds - lumpA - goalsA,
        balance: endBalanceA, failed: accumulationFailed,
        fundingShortfall: accumulationFunding.shortfall,
        accountBreakdown: { ...accumulationFunding.breakdown },
        taxableStartingBasis: taxableStartingBasisA,
        taxableCapitalGain: taxableCapitalGainA,
        ...(taxableGainFractionA !== undefined ? { taxableGainFraction: taxableGainFractionA } : {}),
        accountBalances: { taxable: accounts.taxable.balance, traditional: accounts.traditional.balance, roth: accounts.roth.balance },
        ...(includeAccountDiagnostics ? {
          accountBalancesById: accountBalancesById(projectionAccounts),
          accountStates: snapshotProjectionAccounts(projectionAccounts),
          accountContributionsById: contributionsById,
          accountWithdrawalsById: combineAccountAmounts(
            outlayWithdrawalsByIdA,
            rmdWithdrawalsByIdA,
          ),
        } : {}),
        traditionalEndingBalancesByOwner: cloneTraditionalOwnerBuckets(accounts.traditional.byOwner),
        taxableEndingBasis: accounts.taxable.basis,
        taxBySource: { ss: taxOnSS, oi: taxOnOI, traditional: rmdTaxA, taxable: 0 }
      };
      // Reporting-only federal reruns (T7/T8). Income tax during working years is
      // display-only — it does not fund from the portfolio and fundTaxPolicyDelta
      // remains retirement-only.
      if(taxPolicy){
        const reportingTax = taxPolicy(row, { shortcutTax: rowShortcutTax, yearIndex: y });
        if(!Number.isFinite(reportingTax) || reportingTax < 0){
          throw new TypeError('taxPolicy must return a finite non-negative tax');
        }
        row.taxes = reportingTax;
        lifetimeTax += reportingTax;
      }else{
        lifetimeTax += rowShortcutTax;
      }
      rows.push(row);
      if(accumulationFailed){
        appendFailedTailRows(rows, p, y);
        break;
      }
      continue;
    }

    const { ssInc, oiInc, oiTaxable, penInc, taxIncome } = externalIncomeAtAge(p, age);
    const ltcCost = (p.ltc && age >= p.ltc.onsetAge) ? p.ltc.amount : 0;
    // All spending is entered on the Goals page and read from p.goals only.
    // plan.expenses is retired — living/housing/debt/healthcare/extra are goals
    // now (migrateSpendingToGoals.js), so summing them here too would
    // double-count. LTC is unrelated: it lives on plan.ltc with its own
    // onset-age model.
    //
    // The split below is presentational, not a second channel: the pre-loaded
    // Essentials and Healthcare goals report as `expenses` so Cash Flow keeps a
    // meaningful ESSENTIAL column, and everything else reports as `goals`.
    let goalsY = 0;
    let essentialsY = 0;
    for(const g of p.goals){
      if(age < g.startAge || age > g.endAge) continue;
      const amount = goalAmountAtAge(g, age);
      if(g.system) essentialsY += amount;
      else goalsY += amount;
    }
    const expenses = essentialsY + ltcCost;
    // Recurring liabilities active at this age, each eroded in real terms from
    // its OWN start age (a fixed mortgage started years ago is already cheaper).
    const liabCost = p.liabilities.reduce((s, L) =>
      (age >= L.startAge && age <= L.endAge)
        ? s + L.amount * Math.pow(1 + L.colaReal, age - L.startAge)
        : s, 0);

    // Tax on external income: 85% of SS, the taxable share of OI, 100% of pension,
    // at the ordinary rate.
    const taxOnSS    = ssInc * 0.85 * p.taxRates.ordinary;
    const taxOnOI    = oiTaxable * p.taxRates.ordinary;
    const taxOnPen   = penInc * p.taxRates.ordinary;
    const taxOnInc   = taxOnSS + taxOnOI + taxOnPen;
    const netInc     = (ssInc + oiInc + penInc) - taxOnInc;

    // One-time cash shock (e.g. medical/family event) lands as extra need.
    const lumpY = (p.lumpSum > 0 && y === p.lumpSumYear) ? p.lumpSum : 0;

    // After-tax gap the portfolio must cover.
    const gap = (expenses + goalsY + liabCost + lumpY) - netInc;

    if(taxPolicy && fundTaxPolicyDelta){
      // Validates what actually feeds the calculation. The old plan.expenses
      // fields are deliberately absent: they no longer reach the engine, so
      // rejecting a plan over junk in a retired field would block a run for a
      // value nothing reads.
      assertFiniteFederalFundingInputs(age, {
        essentials: essentialsY,
        ltcCost,
        expenses,
        goalsY,
        liabCost,
        lumpY,
        netInc,
        gap,
      });
    }

    const startBalance = totalBalance();
    // Reporting-only opening facts for planning/tax counterfactuals. Captured
    // after any asset sale and before funding, return, RMD, or tax-delta draws.
    const accountStartingBalances = {
      taxable: accounts.taxable.balance,
      traditional: accounts.traditional.balance,
      roth: accounts.roth.balance
    };
    const taxableStartingBasis = accounts.taxable.basis;
    const rmd = openingRmd;
    const rmdRequired = rmd.required;

    if(taxPolicy && fundTaxPolicyDelta){
      const solved = solveFederalFundingYear({
        openingAccounts: accounts,
        p,
        rp,
        y,
        age,
        r,
        returnFrame,
        saleProceeds,
        ssInc,
        oiInc,
        oiTaxable,
        penInc,
        taxIncome,
        expenses,
        goalsY,
        liabCost,
        lumpY,
        gap,
        taxOnSS,
        taxOnOI,
        taxOnPen,
        openingRmd,
        includeAccountDiagnostics,
      }, taxPolicy);
      projectionAccounts.splice(
        0,
        projectionAccounts.length,
        ...cloneProjectionAccountLedger(solved.accounts.projectionAccounts),
      );
      accounts.projectionAccounts = projectionAccounts;
      syncProjectionAggregates(projectionAccounts, accounts);
      failed = solved.failed;
      if(failed && depletionAge === null) depletionAge = age;
      lifetimeTax += solved.row.taxes;

      returnProduct *= (1 + r);
      if(y < 10) first10Product *= (1 + r);
      const endBalance = solved.row.balance;
      if(y === 9) balanceAt10 = endBalance;
      if(age >= p.retirementAge && age <= p.retirementAge + 9){
        balanceAtRet10 = endBalance;
      }
      if(endBalance < minBalance) minBalance = endBalance;
      if(endBalance > peakBalance) peakBalance = endBalance;
      if(peakBalance > 0){
        const dd = (peakBalance - endBalance) / peakBalance;
        if(dd > maxDrawdown) maxDrawdown = dd;
      }
      rows.push(solved.row);

      if(failed){
        appendFailedTailRows(rows, p, y);
        break;
      }
      continue;
    }

    // Compute the withdrawal breakdown without mutating accounts. Capacity is
    // adjusted for the same mid-year timing used below so a negative return
    // cannot turn an undeliverable draw into a funded result.
    const funding = gap > 0
      ? fundProjectionGap(
          projectionAccounts,
          returnFrame,
          gap,
          p.taxRates,
          p.withdrawalStrategy,
          openingRmd.requiredByOwner,
        )
      : { totalWithdrawn: 0, totalTax: 0, breakdown: { taxable: 0, traditional: 0, roth: 0 }, taxBySource: { taxable: 0, traditional: 0 }, shortfall: 0 };
    // Preserve the spending/goal draw before a later federal-tax delta can add
    // a second funding tranche to the same mutable breakdown.
    const preTaxDeltaAccountBreakdown = { ...funding.breakdown };

    let withdrawal = funding.totalWithdrawn;
    const totalTax   = taxOnInc + funding.totalTax;
    lifetimeTax     += totalTax;
    let wdRate = (startBalance > 0.01 && withdrawal > 0)
                 ? (withdrawal / startBalance) * 100 : 0;

    returnProduct *= (1 + r);
    if(y < 10) first10Product *= (1 + r);

    // Mid-year withdrawal factor — spreads withdrawals across the year while
    // the balance is earning the annual return. Same formula as the original
    // single-account engine; we just apply it per-account now.
    // Capture the START-of-year values for basis math. We need these before
    // we modify the balance, because basis consumption is based on the
    // withdrawal's share of the starting balance — not the ending balance.
    const appliedFunding = applyProjectionYearReturnsAndWithdrawals(
      projectionAccounts,
      returnFrame,
      funding.grossById,
    );
    syncProjectionAggregates(projectionAccounts, accounts);
    const traditionalGrossByOwner = funding.traditionalGrossByOwner
      ?? emptyTraditionalOwnerBuckets();

    // Consume basis proportionally to the gross taxable withdrawal. If you
    // pull X dollars from a taxable account with starting balance B and
    // basis P, the dollars carry P/B basis with them: basis_consumed = X * P/B.
    // Basis doesn't earn returns — only the appreciation does — so timing
    // doesn't change this proportion.
    let taxableCapitalGain = appliedFunding.taxableCapitalGain;

    // Start-of-year gain share for adapter/tax attach — read-only fact, not tax math.
    const taxableWithdrawal = funding.breakdown.taxable;
    let taxableGainFraction = taxableWithdrawal > 0.01
      ? taxableCapitalGain / taxableWithdrawal
      : undefined;

    // ── RMD: force out any required distribution beyond what spending pulled ──
    // Spending may already have drawn from Traditional (funding.breakdown). Only
    // the shortfall to the required amount is forced. It's taxed as ordinary
    // income and the full gross distribution is treated as spent. It does not
    // silently enter the taxable sleeve.
    let rmdForced = 0, rmdTax = 0;
    let rmdWithdrawalsById = {};
    if(rmdRequired > 0){
      // Net per owner: the spending draw only counts against the RMD of the
      // owner it actually came from.
      const outstandingByOwner = Object.fromEntries(
        TRADITIONAL_PERSON_OWNERS.map(owner => [owner, Math.max(
          0,
          (openingRmd.requiredByOwner[owner] ?? 0) - (traditionalGrossByOwner[owner] ?? 0),
        )]),
      );
      const forced = applyProjectionOwnerRmd(projectionAccounts, outstandingByOwner);
      rmdForced = forced.total;
      rmdWithdrawalsById = forced.byId;
      if(rmdForced > 0.01){
        rmdTax = rmdForced * p.taxRates.ordinary;
        lifetimeTax += rmdTax;
      }
      syncProjectionAggregates(projectionAccounts, accounts);
    }

    const shortcutTax = totalTax + rmdTax;
    let resolvedTax = shortcutTax;

    // Floor any depleted accounts at zero.
    for(const account of projectionAccounts){
      if(account.balance < 0) account.balance = 0;
    }
    syncProjectionAggregates(projectionAccounts, accounts);

    // A path fails only when a required cash flow is not funded. Reaching
    // exactly zero after the terminal obligation is a valid funded outcome.
    if(funding.shortfall > 0.01){
      zeroProjectionAccounts(projectionAccounts);
      syncProjectionAggregates(projectionAccounts, accounts);
      failed = true;
      if(depletionAge === null) depletionAge = age;
    }

    const endBalance = totalBalance();

    if(y === 9) balanceAt10 = endBalance;

    // Retirement-relative sequence-stress probe: hold the end-of-year balance
    // for each of the first 10 RETIREMENT years (age retirementAge … +9). Unlike
    // balanceAt10 (plan-year indexed), this isolates early-retirement sequence
    // risk and is unaffected by accumulation years when retirementAge > currentAge.
    // A sim that depletes early lands at 0 here (failure zeroes the balance above),
    // so early failures sort to the bottom; a short horizon leaves the last
    // available retirement-year balance.
    if(age >= p.retirementAge && age <= p.retirementAge + 9) balanceAtRet10 = endBalance;

    if(endBalance < minBalance) minBalance = endBalance;
    if(endBalance > peakBalance) peakBalance = endBalance;
    if(peakBalance > 0){
      const dd = (peakBalance - endBalance) / peakBalance;
      if(dd > maxDrawdown) maxDrawdown = dd;
    }

    const row = {
      year: y+1, age, source: rp.y, returnRate: r,
      ...householdTaxStatusAtAge(p, age),
      returnDollars: returnFrame.returnDollars,
      ...(includeAccountDiagnostics ? {
        accountReturns: returnFrame.accountReturns,
        householdEffectiveAllocation: returnFrame.householdAllocation,
      } : {}),
      nominalReturn: (rp && rp.proxyNominalReturn != null) ? rp.proxyNominalReturn : null,
      inflationRate: (rp && rp.proxyInflationRate != null) ? rp.proxyInflationRate : null,
      realReturnUsed: r,
      socialSecurity: ssInc, otherIncome: oiInc, pension: penInc,
      incomeTaxFacts: { ...taxIncome }, withdrawal,
      ...(oiInc > 0 ? { otherIncomeTaxable: oiTaxable } : {}),
      rmd: rmdForced, rmdRequired,
      rmdAvailable: rmd.available,
      rmdOwner: rmd.owner,
      rmdIssue: rmd.issue,
      rmdRequiredByOwner: { ...openingRmd.requiredByOwner },
      rmdGrossByOwner: { ...traditionalGrossByOwner },
      rmdBasisSource: openingRmd.basisSource,
      assetSale: saleProceeds,
      expenses, goals: goalsY, liabilities: liabCost, taxes: resolvedTax, lumpSum: lumpY,
      startBalance, wdRate,
      netCashflow: (ssInc + oiInc + penInc + saleProceeds)
                   - (expenses + goalsY + liabCost + resolvedTax),
      balance: endBalance, failed,
      fundingShortfall: funding.shortfall,
      accountBreakdown: { ...funding.breakdown },
      preTaxDeltaAccountBreakdown: { ...preTaxDeltaAccountBreakdown },
      accountStartingBalances: { ...accountStartingBalances },
      taxableStartingBasis,
      taxableCapitalGain,
      accountBalances: {
        taxable: accounts.taxable.balance,
        traditional: accounts.traditional.balance,
        roth: accounts.roth.balance
      },
      ...(includeAccountDiagnostics ? {
        accountBalancesById: accountBalancesById(projectionAccounts),
        accountStates: snapshotProjectionAccounts(projectionAccounts),
        accountWithdrawalsById: combineAccountAmounts(
          funding.grossById,
          rmdWithdrawalsById,
        ),
      } : {}),
      taxableEndingBasis: accounts.taxable.basis,
      ...(taxableGainFraction !== undefined ? { taxableGainFraction } : {}),
      taxBySource: {
        ss: taxOnSS, oi: taxOnOI,
        traditional: funding.taxBySource.traditional,
        taxable: funding.taxBySource.taxable
      }
    };

    // Reporting-only mode remains the T6/T7 default. T8 opts into the earlier
    // funding branch explicitly, so existing callers retain identical paths.
    if(taxPolicy && !fundTaxPolicyDelta){
      const reportingTax = taxPolicy(row, { shortcutTax, yearIndex: y });
      if(!Number.isFinite(reportingTax) || reportingTax < 0){
        throw new TypeError('taxPolicy must return a finite non-negative tax');
      }
      if(reportingTax !== shortcutTax){
        lifetimeTax += reportingTax - shortcutTax;
        row.taxes = reportingTax;
        row.netCashflow = (ssInc + oiInc + penInc + saleProceeds)
                          - (expenses + goalsY + liabCost + reportingTax);
      }
    }

    rows.push(row);

    if(failed){
      appendFailedTailRows(rows, p, y);
      break;
    }
  }

  const cagr = Math.pow(returnProduct, 1 / p.horizonYears) - 1;
  const first10Years = Math.min(10, p.horizonYears);
  const first10Cagr = first10Years > 0
    ? Math.pow(first10Product, 1 / first10Years) - 1
    : 0;
  return { rows, failed, cagr, terminalBalance: totalBalance(),
           minBalance, maxDrawdown, depletionAge, first10Cagr, balanceAt10,
           balanceAtRet10, lifetimeTax,
           returnSeriesProvenance: RETURN_SERIES_PROVENANCE,
           assumptions: [] };
}


function analyzeResults(sims, p){
  const ns = sims.length;
  const survived = sims.filter(s => !s.failed).length;

  // Total starting balance across all three accounts — used as the envelope
  // origin point and as the comparison baseline for "above starting" metrics.
  const startingTotal = p.accounts.taxable.balance + p.accounts.traditional.balance + p.accounts.roth.balance;

  // Year-by-year percentile envelope — computed FIRST so we can use it for
  // path centrality selection below. At each year, sort all simulation balances
  // and take percentile cuts. Note: envelope is NOT a coherent path; it's the
  // boundary of outcomes at each year.
  const horizon = p.horizonYears;
  const envelope = [{
    year: 0,
    p10: startingTotal, p25: startingTotal,
    p50: startingTotal, p75: startingTotal,
    p90: startingTotal
  }];
  for(let y = 0; y < horizon; y++){
    const bals = sims.map(s => s.rows[y] ? s.rows[y].balance : 0).sort((a,b)=>a-b);
    envelope.push({
      year: y + 1,
      p10: bals[Math.floor(ns * 0.10)],
      p25: bals[Math.floor(ns * 0.25)],
      p50: bals[Math.floor(ns * 0.50)],
      p75: bals[Math.floor(ns * 0.75)],
      p90: bals[Math.floor(ns * 0.90)]
    });
  }

  // Path selection for Stressed/Favorable: sort by balance after 10 RETIREMENT years.
  // Stressed = worst early sequence → surfaces the sequence-risk story clients need
  // to understand. Bad early returns during withdrawals are the primary retirement risk.
  // Favorable = best early sequence → shows what good early compounding looks like.
  // Uses balanceAtRet10 (retirement-relative), so accumulation years do not drive the
  // ranking when retirementAge > currentAge. Terminal balance is correct for the Summary
  // distribution but wrong here — Plan Drivers is sequence-of-returns risk, not final
  // outcome ranking. Terminal balance only breaks ties (e.g. two early-failed sims at 0).
  const bySequence = sims.slice().sort((a, b) => {
    if(a.balanceAtRet10 !== b.balanceAtRet10) return a.balanceAtRet10 - b.balanceAtRet10;
    return a.terminalBalance - b.terminalBalance;
  });
  const byCagr = sims.slice().sort((a, b) => a.cagr - b.cagr);

  // Centrality score: sum of proportional deviations from year-by-year median.
  // Proportional (rather than absolute) so later high-balance years don't dominate.
  // The most central path is the one that tracks the median envelope closest.
  function centrality(sim){
    let score = 0;
    for(let y = 0; y < sim.rows.length; y++){
      const med = envelope[y + 1].p50;
      if(med > 0.01){
        score += Math.abs(sim.rows[y].balance - med) / med;
      }
    }
    return score;
  }
  const withCent = sims.map((s, i) => ({ sim: s, i, c: centrality(s) }));
  withCent.sort((a, b) => a.c - b.c);

  // Two-stage MEDOID so the representative (p50) path is central AND realistically
  // bumpy — a median *sequence*, never a balance-central-but-volatility outlier
  // (e.g. a crash-then-lucky-recovery path that only lands median at the very end):
  //   Stage 1: keep the most central-by-outcome decile (paths whose whole trajectory
  //            tracks the median envelope) — that's what makes it "typical".
  //   Stage 2: within that set, take the path whose year-to-year return volatility is
  //            closest to the median, so it still reads like a real market, not a
  //            smoothed line.
  // Display-only: this changes WHICH sample path the cash-flow table surfaces; it does
  // NOT touch successRate, terminal, or the envelope (the truth math is untouched).
  function returnStdDev(sim){
    const rs = sim.rows.map(r => r.realReturnUsed ?? r.returnRate ?? 0);
    if(!rs.length) return 0;
    const m = rs.reduce((a, b) => a + b, 0) / rs.length;
    return Math.sqrt(rs.reduce((s, r) => s + (r - m) ** 2, 0) / rs.length);
  }
  const sdAll = sims.map(returnStdDev);
  const medianSd = sdAll.slice().sort((a, b) => a - b)[Math.floor(sdAll.length / 2)];
  const centralCount = Math.max(1, Math.ceil(withCent.length * 0.10));
  let centralIdx = withCent[0].i, bestSdGap = Infinity;
  for(let k = 0; k < centralCount; k++){
    const g = Math.abs(sdAll[withCent[k].i] - medianSd);
    if(g < bestSdGap){ bestSdGap = g; centralIdx = withCent[k].i; }
  }
  const typicalPath = sims[centralIdx];

  const paths = {
    p10: bySequence[Math.floor(ns * 0.10)],
    p25: bySequence[Math.floor(ns * 0.25)],
    p50: typicalPath,
    p75: bySequence[Math.floor(ns * 0.75)],
    p90: bySequence[Math.floor(ns * 0.90)]
  };

  // Terminal balance distribution — independent of path selection sort.
  const terms = sims.map(s => s.terminalBalance).sort((a, b) => a - b);
  const terminal = {
    p10: terms[Math.floor(ns * 0.10)],
    p25: terms[Math.floor(ns * 0.25)],
    p50: terms[Math.floor(ns * 0.50)],
    p75: terms[Math.floor(ns * 0.75)],
    p90: terms[Math.floor(ns * 0.90)]
  };

  // Aggregate risk metrics.
  const failedSims    = sims.filter(s => s.failed);
  const survivorSims  = sims.filter(s => !s.failed);

  // Depletion age — already scoped to failed paths.
  const deplAges = failedSims.map(s => s.depletionAge).filter(a => a !== null).sort((a,b)=>a-b);
  const medianDepletionAge = deplAges.length > 0
    ? deplAges[Math.floor(deplAges.length / 2)]
    : null;

  // Min balance and max drawdown — scoped to SURVIVORS only.
  // Including failed paths makes these metrics collapse to $0 / 100% on stressed
  // plans, which is uninformative (a failed path always hits zero by definition).
  // Among survivors, these answer "of the plans that worked, how close did
  // they come to failure?" — a real sequence-risk signal.
  const sMinBals = survivorSims.map(s => s.minBalance).sort((a,b)=>a-b);
  const medianMinBalanceSurvivors = sMinBals.length > 0
    ? sMinBals[Math.floor(sMinBals.length / 2)]
    : null;

  const sDDs = survivorSims.map(s => s.maxDrawdown).sort((a,b)=>a-b);
  const medianMaxDrawdownSurvivors = sDDs.length > 0
    ? sDDs[Math.floor(sDDs.length / 2)]
    : null;

  // Worst overall drawdown across all paths (not just survivors). Useful even
  // when failures exist because it indicates how steep the worst case got.
  const worstMaxDrawdown = sims.reduce((m, s) => s.maxDrawdown > m ? s.maxDrawdown : m, -Infinity);

  const worstFirst10Cagr = sims.reduce((m, s) => s.first10Cagr < m ? s.first10Cagr : m, Infinity);

  // Years underwater — median count of years a path's balance sits below its
  // starting (real) capital. A direct sequence-risk read: how long the plan
  // spends in a hole. Failed-path filler rows (balance 0) count as underwater.
  const uwCounts = sims.map(s => s.rows.filter(r => r.balance < startingTotal - 0.01).length).sort((a,b)=>a-b);
  const medianYearsUnderwater = uwCounts.length ? uwCounts[Math.floor(uwCounts.length / 2)] : 0;

  // Derived probability counts — power the connective-tissue text strip.
  const aboveStartCount   = sims.filter(s => s.terminalBalance > startingTotal).length;
  const doubledCount      = sims.filter(s => s.terminalBalance > 2 * startingTotal).length;
  const bigDrawdownCount  = sims.filter(s => s.maxDrawdown > 0.40).length;

  const taxAmounts = sims.map(s => s.lifetimeTax).sort((a,b) => a - b);
  const medianLifetimeTax = taxAmounts[Math.floor(ns * 0.50)];

  return {
    paths, terminal, envelope,
    sims,
    returnSeriesProvenance: RETURN_SERIES_PROVENANCE,
    successRate: (survived / ns) * 100,
    // Union of the modeling assumptions any path had to make, so a caller can
    // show what a number depends on instead of presenting it as unqualified.
    assumptions: [...new Set(sims.flatMap(s => s.assumptions || []))],
    survived, total: ns,
    medianCagr: byCagr[Math.floor(ns * 0.50)].cagr,
    horizonYears: p.horizonYears,
    iterations: ns,
    params: p,
    medianLifetimeTax,
    metrics: {
      medianDepletionAge,
      medianMinBalanceSurvivors,
      medianMaxDrawdownSurvivors,
      medianYearsUnderwater,
      worstMaxDrawdown,
      worstFirst10Cagr,
      aboveStartCount,
      doubledCount,
      bigDrawdownCount
    }
  };
}


function runHistoricalPath(plan, startYear, strategy, transform, overrides, options = {}){
  // `overrides` flows through the SAME resolveInputs lever mapping the Monte
  // Carlo path uses (retireDelay, ssDelayYears, spendBump, lumpSum, savingsBump,
  // pensionStartAge, …) so a chosen scenario is sequenced faithfully, not just
  // its allocation. Defaults to {} → behavior identical to the original.
  const rawInputs = resolveInputs(plan, overrides || {});
  if(rawInputs.simulationAvailable === false){
    const error = new RangeError('HOUSEHOLD_TIMELINE_INCOMPLETE');
    error.code = 'HOUSEHOLD_TIMELINE_INCOMPLETE';
    throw error;
  }
  // Override strategy for this run
  rawInputs.withdrawalStrategy = strategy;

  // Build the path from startYear forward. When we reach the end of the real
  // record (2025) we WRAP back to its start rather than truncate — the same
  // cyclic treatment the block-bootstrap Monte Carlo uses, so a recent
  // retirement year (2000, 2008) still gets a FULL real-return horizon instead
  // of a stub that ends mid-retirement. Every return remains a real historical
  // year; only the calendar contiguity breaks at the wrap (invisible on an
  // age-based axis). The first decade — where sequence risk lives — is always
  // pre-wrap and fully real.
  const startIdx = RETURN_DATA.findIndex(r => r.y === startYear);
  if(startIdx < 0) return null;
  const path = [];
  for(let i = 0; i < rawInputs.horizonYears; i++){
    const row = RETURN_DATA[(startIdx + i) % RETURN_DATA.length];
    path.push(row);
  }
  if(path.length === 0) return null;

  // Optional ORDER transform (e.g. reverse): reorders the SAME real return
  // rows before the single-path runner walks them. The returns are unchanged —
  // only their sequence is. Used by the Sequencing tab to isolate order. When
  // omitted, behavior is byte-identical to the original forward run.
  const ordered = typeof transform === 'function' ? transform(path.slice()) : path;

  // Adjust horizon to actual data available
  const inputs = { ...rawInputs, horizonYears: ordered.length };
  const result = runSinglePath(inputs, ordered, options);
  result.actualYears  = ordered.length;
  result.requestedYrs = rawInputs.horizonYears;
  result.startYear    = startYear;
  result.endYear      = startYear + ordered.length - 1;
  return result;
}

/* ── PATH DIGEST ─────────────────────────────────────────────────────────────
   Pure read-only summary of ONE simulation result (Monte Carlo path or
   historical run). Computes the aggregates the narrative surfaces print, so
   every number on screen is engine output rather than UI math. No state, no
   mutation: same input → same digest. `params` (a resolveInputs result) is
   optional and only unlocks spendShareOfStart. */
function pathDigest(sim, params){
  const rows    = (sim && sim.rows) ? sim.rows : [];
  // Real rows exclude post-depletion filler (source === null after failure).
  const real    = rows.filter(r => r.source != null);
  const retRows = real.filter(r => r.phase !== 'accum');
  const wdRows  = retRows.filter(r => r.wdRate > 0);

  // Withdrawal pressure — wdRate is stored in PERCENT on the row.
  let peakWdRate = 0, peakWdAge = null, wdSum = 0;
  for(const r of wdRows){
    wdSum += r.wdRate;
    if(r.wdRate > peakWdRate){ peakWdRate = r.wdRate; peakWdAge = r.age; }
  }
  const avgWdRate = wdRows.length ? wdSum / wdRows.length : 0;

  // Early sequence — the first 10 retirement years, where sequence risk lives.
  const early = retRows.slice(0, 10);
  const negEarlyYears = early.filter(r => r.returnRate < 0).length;

  // Damage window — longest run of retirement years the cumulative return sat
  // below its retirement-day level. (Same definition the Sequencing prints use.)
  let g = 1, cur = 0, underwaterSpellMax = 0;
  for(const r of retRows){
    g *= (1 + r.returnRate);
    if(g < 1){ cur++; if(cur > underwaterSpellMax) underwaterSpellMax = cur; }
    else cur = 0;
  }

  // Real-portfolio stress — balances in the Projection Engine are already in
  // today's dollars. These aggregates deliberately use portfolio values, not
  // the return-only damage window above: withdrawals and taxes are part of the
  // path the household actually experiences.
  const portfolioStartingRealBalance = Number.isFinite(retRows[0]?.startBalance)
    && retRows[0].startBalance >= 0
    ? retRows[0].startBalance
    : null;
  let maxRealDrawdownPct = null;
  let maxRealDrawdownTroughAge = null;
  let portfolioUnderwaterYearsMax = null;
  let portfolioRecoveryPeriodStatus = null;
  let portfolioRecoveryPeriodYears = null;
  if(portfolioStartingRealBalance !== null){
    let runningPeak = portfolioStartingRealBalance;
    let maxDrawdown = 0;
    let underwaterYears = 0;
    let longestClosedUnderwaterYears = 0;
    let dippedBelowStart = false;
    portfolioUnderwaterYearsMax = 0;
    for(const r of retRows){
      if(!Number.isFinite(r.balance) || r.balance < 0) continue;
      if(r.balance > runningPeak) runningPeak = r.balance;
      const drawdown = runningPeak > 0
        ? ((runningPeak - r.balance) / runningPeak) * 100
        : 0;
      if(drawdown > maxDrawdown){
        maxDrawdown = drawdown;
        maxRealDrawdownTroughAge = Number.isFinite(r.age) ? r.age : null;
      }
      if(r.balance < portfolioStartingRealBalance - 0.01){
        dippedBelowStart = true;
        underwaterYears += 1;
        if(underwaterYears > portfolioUnderwaterYearsMax){
          portfolioUnderwaterYearsMax = underwaterYears;
        }
      }else{
        if(underwaterYears > longestClosedUnderwaterYears){
          longestClosedUnderwaterYears = underwaterYears;
        }
        underwaterYears = 0;
      }
    }
    maxRealDrawdownPct = maxDrawdown;
    if(!dippedBelowStart){
      portfolioRecoveryPeriodStatus = 'no-dip';
      portfolioRecoveryPeriodYears = 0;
    }else if(underwaterYears > 0){
      portfolioRecoveryPeriodStatus = 'never';
    }else{
      portfolioRecoveryPeriodStatus = 'recovered';
      portfolioRecoveryPeriodYears = longestClosedUnderwaterYears;
    }
  }

  const yearsAboveSixPctWdRate = retRows.filter(
    r => Number.isFinite(r.wdRate) && r.wdRate > 6
  ).length;
  const age80Rows = real.filter(r => r.age === 80 && Number.isFinite(r.balance) && r.balance >= 0);
  const realBalanceAtAge80 = age80Rows.length === 1 ? age80Rows[0].balance : null;

  // Funding margin converts a surviving terminal dollar figure into a
  // conservative, zero-return runway at the final modeled gross portfolio
  // draw. Failed paths instead report the exact number of plan years missed.
  // A zero final draw is not treated as infinite runway.
  const resolvedPlanEndAges = [
    params?.people?.client?.planEndAgeOnPrimaryTimeline,
    params?.people?.spouse?.planEndAgeOnPrimaryTimeline,
  ].filter(Number.isFinite);
  const planEndAge = resolvedPlanEndAges.length > 0
    ? Math.max(...resolvedPlanEndAges)
    : (Number.isFinite(rows.at(-1)?.age) ? rows.at(-1).age : null);
  const firstUnderfundedRow = retRows.find(r => (
    (Number.isFinite(r.fundingShortfall) && r.fundingShortfall > 0.01)
      || r.failed === true
  )) ?? null;
  const fullyFundedRetirementRows = retRows.filter(r => (
    Number.isFinite(r.fundingShortfall)
      && r.fundingShortfall <= 0.01
      && r.failed !== true
      && Number.isFinite(r.age)
  ));
  const lastFundedRetirementRow = fullyFundedRetirementRows.at(-1) ?? null;
  const fundedThroughAge = Number.isFinite(lastFundedRetirementRow?.age)
    ? lastFundedRetirementRow.age
    : (Number.isFinite(firstUnderfundedRow?.age) ? firstUnderfundedRow.age - 1 : null);
  let fundingMarginYears = null;
  let fundingMarginKind = 'unavailable';
  if(firstUnderfundedRow){
    if(Number.isFinite(fundedThroughAge) && Number.isFinite(planEndAge)){
      fundingMarginYears = fundedThroughAge - planEndAge;
    }
    fundingMarginKind = 'years-short';
  }else{
    const finalRetirementRow = retRows.at(-1) ?? null;
    if(Number.isFinite(finalRetirementRow?.withdrawal) && finalRetirementRow.withdrawal > 0
        && Number.isFinite(finalRetirementRow.balance) && finalRetirementRow.balance >= 0){
      fundingMarginYears = finalRetirementRow.balance / finalRetirementRow.withdrawal;
      fundingMarginKind = 'zero-return-runway';
    }else if(finalRetirementRow
        && Number.isFinite(finalRetirementRow?.withdrawal)
        && finalRetirementRow.withdrawal === 0){
      fundingMarginKind = 'no-portfolio-draw';
    }
  }

  // Taxes by source. Row taxBySource covers SS / other income / funding
  // withdrawals; forced-RMD tax is inside row.taxes but not the breakdown, so
  // traditional is taken as the residual — RMD tax lands where it belongs.
  let taxTotal = 0, ssTax = 0, oiTax = 0, taxableTax = 0;
  for(const r of retRows){
    taxTotal   += (r.taxes || 0);
    if(r.taxBySource){
      ssTax      += (r.taxBySource.ss      || 0);
      oiTax      += (r.taxBySource.oi      || 0);
      taxableTax += (r.taxBySource.taxable || 0);
    }
  }
  const tradTax = Math.max(0, taxTotal - ssTax - oiTax - taxableTax);
  const taxSourceTotals = { socialSecurity: ssTax, otherIncome: oiTax, traditional: tradTax, taxable: taxableTax };
  const taxSourceShares = {};
  let dominantTaxSource = null, dominantTaxShare = 0;
  for(const k of Object.keys(taxSourceTotals)){
    const share = taxTotal > 0 ? taxSourceTotals[k] / taxTotal : 0;
    taxSourceShares[k] = share;
    if(share > dominantTaxShare){ dominantTaxShare = share; dominantTaxSource = k; }
  }

  // Guaranteed-income coverage — SS + pension over all retirement outflows.
  let guaranteed = 0, outflows = 0;
  for(const r of retRows){
    guaranteed += (r.socialSecurity || 0) + (r.pension || 0);
    outflows   += (r.expenses || 0) + (r.goals || 0) + (r.liabilities || 0) + (r.taxes || 0);
  }
  const fixedIncomeShare = outflows > 0 ? guaranteed / outflows : null;

  // Core annual spend vs starting assets — needs resolved params.
  let spendShareOfStart = null;
  if(params && params.expenses && params.accounts){
    let spend = 0;
    for(const v of Object.values(params.expenses)) if(typeof v === 'number') spend += v;
    const start = params.accounts.taxable.balance + params.accounts.traditional.balance + params.accounts.roth.balance;
    spendShareOfStart = start > 0 ? spend / start : null;
  }

  return {
    startBalance: rows.length ? rows[0].startBalance : null,
    endBalance:   sim.terminalBalance,
    realCagr:     sim.cagr,
    first10Cagr:  sim.first10Cagr,
    first10Supports: sim.first10Cagr >= 0,
    minBalance:   sim.minBalance,
    failed:       !!sim.failed,
    depletionAge: sim.depletionAge != null ? sim.depletionAge : null,
    withdrawalYears: wdRows.length,
    avgWdRate, peakWdRate, peakWdAge,
    earlyWindowYears: early.length,
    negEarlyYears,
    underwaterSpellMax,
    portfolioStartingRealBalance,
    maxRealDrawdownPct,
    maxRealDrawdownTroughAge,
    yearsAboveSixPctWdRate,
    portfolioUnderwaterYearsMax,
    portfolioRecoveryPeriodStatus,
    portfolioRecoveryPeriodYears,
    realBalanceAtAge80,
    fundedThroughAge,
    planEndAge,
    fundingMarginYears,
    fundingMarginKind,
    lifetimeTax: sim.lifetimeTax,
    avgTax: retRows.length ? taxTotal / retRows.length : 0,
    taxSourceTotals, taxSourceShares, dominantTaxSource, dominantTaxShare,
    fixedIncomeShare, spendShareOfStart
  };
}

/* ── PLAN ASSESSMENT ─────────────────────────────────────────────────────────
   Rule table applied to an analyzeResults() object. Emits facts only —
   which observations apply and the numbers behind them. The UI maps ids to
   fixed sentences; nothing here recommends an action. Thresholds live in one
   place so they are visible, testable, and arguable. */
const ASSESSMENT_RULES = {
  lowFixedSpending:  { maxSpendShareOfStart: 0.045 },  // core spend ≤ 4.5% of starting assets
  taxDiversified:    { minBucketShare: 0.15, minBuckets: 2 },
  highSuccess:       { minSuccessRate: 85 },
  withdrawalLoad:    { peakWdRatePct: 10 },            // wdRate rows are in percent
  portfolioFunded:   { minFixedIncomeShare: 0.33 }
};

function assessPlan(analysis){
  const p   = analysis.params;
  const mid = pathDigest(analysis.paths.p50, p);
  const low = pathDigest(analysis.paths.p10, p);
  const strengths = [], pressures = [], tossups = [];

  if(mid.spendShareOfStart != null && mid.spendShareOfStart <= ASSESSMENT_RULES.lowFixedSpending.maxSpendShareOfStart){
    strengths.push({ id:'low-fixed-spending', value: mid.spendShareOfStart });
  }
  const startTotal = p.accounts.taxable.balance + p.accounts.traditional.balance + p.accounts.roth.balance;
  if(startTotal > 0){
    const shares = ['taxable','traditional','roth'].map(k => p.accounts[k].balance / startTotal);
    const buckets = shares.filter(s => s >= ASSESSMENT_RULES.taxDiversified.minBucketShare).length;
    if(buckets >= ASSESSMENT_RULES.taxDiversified.minBuckets){
      strengths.push({ id:'tax-diversified', value: buckets });
    }
  }
  if(analysis.successRate >= ASSESSMENT_RULES.highSuccess.minSuccessRate){
    strengths.push({ id:'high-success', value: analysis.successRate });
  }
  if(mid.peakWdRate >= ASSESSMENT_RULES.withdrawalLoad.peakWdRatePct){
    pressures.push({ id:'withdrawal-load', value: { avg: mid.avgWdRate, peak: mid.peakWdRate, age: mid.peakWdAge } });
  }
  if(mid.fixedIncomeShare != null && mid.fixedIncomeShare < ASSESSMENT_RULES.portfolioFunded.minFixedIncomeShare){
    pressures.push({ id:'portfolio-funded-spending', value: mid.fixedIncomeShare });
  }
  if(low.failed && !mid.failed){
    tossups.push({ id:'return-timing', value: { stressedDepletionAge: low.depletionAge } });
  }
  return { strengths, pressures, tossups };
}

/* ---- exports (so the UI and tests import instead of sharing globals) ---- */
export {
  RETURN_DATA, ASSET_META, ASSET_KEYS, EQUITY_MIX, DEFENSIVE_MIX,
  RETURN_SERIES_PROVENANCE,
  RISK_PROFILES, ASSET_STATS, LONGRUN_INFLATION, PROJECTION_EXECUTION_LIMITS,
  buildAssetWeights, computeAssetStats, generateReturnPath, resetSeed, weightedAssetReturn,
  ssAdjust,
  runSimulation, resolveInputs, resolveHouseholdTimeline, householdStateAtYear,
  householdIncomeAtYear, resolveWithdrawalPlannerAccountState,
  approveWithdrawalPlannerLeverChange, buildWithdrawalPlannerCashContract,
  runSinglePath, analyzeResults, runHistoricalPath,
  annualMortgagePayment,
  pathDigest, assessPlan, ASSESSMENT_RULES,
  plan as defaultPlan
};
