import {
  CLIENT_1040_INTAKE_SCHEMA_VERSION,
  CLIENT_1040_SUPPORTED_TAX_YEARS,
} from '../../tax/annual1040.js';
import {
  isSourceActiveNow,
  normalizedIncomeSource,
} from '../../household/incomeTaxModel.js';

export const CURRENT_1040_PLANNING_SCHEMA_VERSION = 1;

const hasOwn = (value, key) =>
  Boolean(value)
  && Object.prototype.hasOwnProperty.call(value, key);

const isRecord = value =>
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

const clone = value => structuredClone(value);

const CONFIRMED_ZERO_INCOME_FIELDS = Object.freeze([
  'wages',
  'taxableInterest',
  'taxExemptInterest',
  'ordinaryDividends',
  'qualifiedDividends',
  'iraDistributions',
  'taxableIra',
  'rothConversion',
  'pensionAmount',
  'taxablePensions',
  'otherIncome',
]);

function makeGap(code, path, message){
  return Object.freeze({ code, path, message });
}

function addAmount(target, key, amount){
  target[key] = (hasOwn(target, key) ? target[key] : 0) + amount;
}

function hasExplicitSocialSecuritySource(income){
  return isRecord(income) && hasOwn(income, 'socialSecurity');
}

function materializeConfirmedZeroIncome(
  income,
  { explicitSocialSecuritySource, activePlanningSocialSecurity }
){
  if(!isRecord(income)) return income;
  for(const field of CONFIRMED_ZERO_INCOME_FIELDS){
    if(!hasOwn(income, field)) income[field] = 0;
  }
  const hasAnySocialSecurityFact = explicitSocialSecuritySource
    || hasOwn(income, 'socialSecurityBenefits')
    || hasOwn(income, 'taxableSS');
  if(!hasAnySocialSecurityFact && !activePlanningSocialSecurity){
    income.socialSecurityBenefits = 0;
    income.taxableSS = 0;
    income.socialSecurity = { mode: 'supplied-form1040-lines' };
  }
  return income;
}

function mergeCanonicalIncome(explicitIncome, mappedIncome, gaps){
  if(explicitIncome === undefined) return mappedIncome;
  if(!isRecord(explicitIncome)) return clone(explicitIncome);

  const merged = clone(explicitIncome);
  for(const [field, value] of Object.entries(mappedIncome)){
    if(hasOwn(explicitIncome, field)){
      delete merged[field];
      gaps.push(makeGap(
        'CURRENT_1040_INCOME_SOURCE_CONFLICT',
        `incomeTax.current1040.income.${field}`,
        `income.${field} cannot be supplied by both current1040 and mapped planning rows`
      ));
      continue;
    }
    merged[field] = value;
  }
  return merged;
}

function canonicalEnteredIncomeTotal(income, scheduleD){
  if(!isRecord(income)) return null;
  if(income.socialSecurity?.mode === 'calculate-taxable-benefits'){
    return null;
  }

  const amount = (field, fallbackField = null) => {
    const selected = hasOwn(income, field)
      ? income[field]
      : fallbackField && hasOwn(income, fallbackField)
        ? income[fallbackField]
        : 0;
    return typeof selected === 'number' && Number.isFinite(selected)
      ? selected
      : null;
  };
  const amounts = [
    amount('wages'),
    amount('taxableInterest'),
    amount('ordinaryDividends'),
    amount('taxableIra'),
    amount('rothConversion'),
    amount('taxablePensions'),
    amount('taxableSS'),
    amount('otherIncome'),
  ];
  if(amounts.some(value => value === null)) return null;

  let total = amounts.reduce((sum, value) => sum + value, 0);
  if(isRecord(scheduleD)){
    const scheduleDAmount = scheduleD.mode === 'simple-net-long-term'
      ? scheduleD.netLongTermGainOrLoss
      : scheduleD.mode === 'supplied-form1040-line7'
        ? scheduleD.amount
        : 0;
    if(typeof scheduleDAmount !== 'number'
        || !Number.isFinite(scheduleDAmount)){
      return null;
    }
    if(scheduleD.mode === 'simple-net-long-term' && scheduleDAmount < 0){
      // The federal rule owns the filing-status loss cap. The planning adapter
      // cannot claim a line-9 total until that rule has resolved Form 1040 line 7.
      return null;
    }
    total += scheduleDAmount;
  }
  return total;
}

function hasIncomeGap(gaps){
  return gaps.some(({ path }) =>
    path === 'income'
    || path.startsWith('income.')
    || path === 'incomeTax.current1040.income'
    || path.startsWith('incomeTax.current1040.income')
    || path === 'incomeTax.current1040.scheduleD'
    || path.startsWith('incomeTax.current1040.scheduleD.')
  );
}

function activeReturnOwners(filingStatus, modeledTaxpayer){
  if(filingStatus === 'marriedFilingJointly'){
    return new Set(['client', 'spouse', 'joint']);
  }
  if(filingStatus === 'marriedFilingSeparately'){
    return new Set(
      modeledTaxpayer === 'client' || modeledTaxpayer === 'spouse'
        ? [modeledTaxpayer]
        : []
    );
  }
  return new Set(['client']);
}

function fraction(value, fallback, path, gaps){
  const resolved = value == null ? fallback : value;
  if(typeof resolved !== 'number'
      || !Number.isFinite(resolved)
      || resolved < 0
      || resolved > 1){
    gaps.push(makeGap(
      'CURRENT_1040_INVALID_FRACTION',
      path,
      `${path} must be a number from 0 through 1`
    ));
    return null;
  }
  return resolved;
}

function relevantActiveSources(plan, filingStatus, modeledTaxpayer, gaps){
  const owners = activeReturnOwners(filingStatus, modeledTaxpayer);
  const rows = [];
  for(const [index, raw] of (plan.income?.other || []).entries()){
    if(!isSourceActiveNow(plan, raw)) continue;
    const path = `income.other.${index}`;
    if(!hasOwn(raw, 'owner')
        || !['client', 'spouse', 'joint'].includes(raw.owner)){
      gaps.push(makeGap(
        'CURRENT_1040_INCOME_OWNER_REQUIRED',
        `${path}.owner`,
        'Every canonical current-return income source needs an explicit owner'
      ));
      continue;
    }
    if(filingStatus === 'marriedFilingSeparately' && raw.owner === 'joint'){
      gaps.push(makeGap(
        'CURRENT_1040_MFS_JOINT_INCOME_UNATTRIBUTED',
        `${path}.owner`,
        'Joint income cannot be assigned to one modeled MFS taxpayer'
      ));
      continue;
    }
    if((filingStatus === 'single' || filingStatus === 'headOfHousehold')
        && raw.owner !== 'client'){
      gaps.push(makeGap(
        'CURRENT_1040_INCOME_OUTSIDE_MODELED_RETURN',
        `${path}.owner`,
        'This income owner is outside the modeled return'
      ));
      continue;
    }
    if(!owners.has(raw.owner)) continue;
    if(typeof raw.amount !== 'number' || !Number.isFinite(raw.amount)){
      gaps.push(makeGap(
        'CURRENT_1040_INCOME_AMOUNT_REQUIRED',
        `${path}.amount`,
        'Every canonical current-return income amount must be a finite number'
      ));
      continue;
    }
    const normalized = normalizedIncomeSource(plan, raw);
    if(raw.amount < 0 && normalized.typeId !== 'long_term_capital_gain'){
      gaps.push(makeGap(
        'CURRENT_1040_NEGATIVE_INCOME_UNSUPPORTED',
        `${path}.amount`,
        'Only the confirmed simple long-term gain or loss path accepts a signed amount'
      ));
      continue;
    }
    rows.push({ raw, normalized, path });
  }
  return rows;
}

function mapIncomeRows(rows, gaps, explicitSocialSecuritySource){
  const income = {};
  for(const { raw, normalized: source, path } of rows){
    const amount = source.amount;
    switch(source.typeId){
      case 'wages':
      case 'bonus':
        addAmount(income, 'wages', amount);
        break;
      case 'interest': {
        const taxablePct = fraction(
          raw.taxablePct,
          1,
          `${path}.taxablePct`,
          gaps
        );
        if(taxablePct === null) break;
        addAmount(income, 'taxableInterest', amount * taxablePct);
        addAmount(income, 'taxExemptInterest', amount * (1 - taxablePct));
        break;
      }
      case 'tax_exempt_interest':
        addAmount(income, 'taxExemptInterest', amount);
        break;
      case 'dividends': {
        const qualifiedPct = fraction(
          raw.qualifiedPct,
          0,
          `${path}.qualifiedPct`,
          gaps
        );
        if(qualifiedPct === null) break;
        addAmount(income, 'ordinaryDividends', amount);
        addAmount(income, 'qualifiedDividends', amount * qualifiedPct);
        break;
      }
      case 'ira_distribution': {
        const taxablePct = fraction(
          raw.taxablePct,
          1,
          `${path}.taxablePct`,
          gaps
        );
        if(taxablePct === null) break;
        addAmount(income, 'iraDistributions', amount);
        addAmount(income, 'taxableIra', amount * taxablePct);
        break;
      }
      case 'roth_conversion':
        addAmount(income, 'rothConversion', amount);
        break;
      case 'pension':
      case 'annuity': {
        const taxablePct = fraction(
          raw.taxablePct,
          1,
          `${path}.taxablePct`,
          gaps
        );
        if(taxablePct === null) break;
        addAmount(income, 'pensionAmount', amount);
        addAmount(income, 'taxablePensions', amount * taxablePct);
        break;
      }
      case 'social_security':
        if(!explicitSocialSecuritySource){
          gaps.push(makeGap(
            'CURRENT_1040_SOCIAL_SECURITY_RETURN_FACTS_REQUIRED',
            path,
            'A planning Social Security row is not a Form 1040 benefits or worksheet fact'
          ));
        }
        break;
      case 'short_term_capital_gain':
      case 'long_term_capital_gain':
        break;
      default: {
        const taxablePct = fraction(
          raw.taxablePct,
          1,
          `${path}.taxablePct`,
          gaps
        );
        if(taxablePct !== null){
          addAmount(income, 'otherIncome', amount * taxablePct);
        }
      }
    }
  }
  return income;
}

function activePlanningSocialSecurity(plan, owners){
  const socialSecurity = plan.income?.socialSecurity || {};
  const facts = [
    ['client', plan.household?.primary, socialSecurity.primary],
    ['spouse', plan.household?.spouse, socialSecurity.spouse],
  ];
  return facts.some(([owner, person, benefit]) => {
    if(!owners.has(owner) || !person || !benefit) return false;
    return Number(benefit.pia) > 0
      && Number(person.currentAge) >= Number(benefit.claimAge ?? 67);
  });
}

function buildScheduleD(source, rows, gaps){
  const capitalRows = rows.filter(({ normalized }) =>
    normalized.typeId === 'short_term_capital_gain'
    || normalized.typeId === 'long_term_capital_gain'
  );
  if(source === undefined){
    if(capitalRows.length > 0){
      gaps.push(makeGap(
        'CURRENT_1040_SCHEDULE_D_MODE_REQUIRED',
        'incomeTax.current1040.scheduleD',
        'Capital-gain rows require an explicit canonical Schedule D source mode'
      ));
    }
    return undefined;
  }
  if(!isRecord(source)) return clone(source);

  if(source.mode === 'simple-net-long-term'){
    const shortTermRows = capitalRows.filter(({ normalized }) =>
      normalized.typeId === 'short_term_capital_gain'
    );
    if(shortTermRows.some(({ normalized }) => normalized.amount !== 0)){
      gaps.push(makeGap(
        'CURRENT_1040_SIMPLE_SCHEDULE_D_SHORT_TERM_NOT_ZERO',
        'income.other',
        'The simple Schedule D path requires confirmed zero short-term gain or loss'
      ));
    }
    const longTermRows = capitalRows.filter(({ normalized }) =>
      normalized.typeId === 'long_term_capital_gain'
    );
    const suppliedAmountPresent = hasOwn(source, 'netLongTermGainOrLoss');
    if(longTermRows.length > 0 && suppliedAmountPresent){
      gaps.push(makeGap(
        'CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT',
        'incomeTax.current1040.scheduleD',
        'Choose either owned Household long-term rows or a supplied Schedule D amount'
      ));
    }
    if(longTermRows.length === 0 && !suppliedAmountPresent){
      gaps.push(makeGap(
        'CURRENT_1040_SCHEDULE_D_AMOUNT_REQUIRED',
        'incomeTax.current1040.scheduleD.netLongTermGainOrLoss',
        'The simple Schedule D path needs an explicit signed long-term amount'
      ));
    }
    const amount = suppliedAmountPresent
      ? source.netLongTermGainOrLoss
      : longTermRows.reduce(
          (sum, { normalized }) => sum + normalized.amount,
          0
        );
    return {
      mode: source.mode,
      netLongTermGainOrLoss: amount,
      ...(hasOwn(source, 'confirmations')
        ? { confirmations: clone(source.confirmations) }
        : {}),
    };
  }

  if(capitalRows.length > 0){
    gaps.push(makeGap(
      'CURRENT_1040_SCHEDULE_D_SOURCE_CONFLICT',
      'incomeTax.current1040.scheduleD',
      'Owned Household gain rows cannot be mixed with a supplied Form 1040 line 7'
    ));
  }
  return clone(source);
}

function copyOwn(source, target, key){
  if(hasOwn(source, key)) target[key] = clone(source[key]);
}

export function hasCurrent1040PlanningEnvelope(plan){
  return hasOwn(plan?.incomeTax, 'current1040');
}

/**
 * Build canonical client-1040 intake from explicitly selected current-return
 * planning facts. The opt-in envelope is intentionally separate from the
 * legacy auto-summary so old Household records retain their existing route.
 */
export function buildCurrent1040Intake(plan){
  const gaps = [];
  const source = plan?.incomeTax?.current1040;
  if(!isRecord(source)){
    return Object.freeze({
      intake: null,
      totalIncome: 0,
      gaps: Object.freeze([
        makeGap(
          'CURRENT_1040_ENVELOPE_REQUIRED',
          'incomeTax.current1040',
          'A canonical current-1040 planning envelope is required'
        ),
      ]),
    });
  }
  if(source.schemaVersion !== CURRENT_1040_PLANNING_SCHEMA_VERSION){
    gaps.push(makeGap(
      'CURRENT_1040_SCHEMA_VERSION_UNSUPPORTED',
      'incomeTax.current1040.schemaVersion',
      `Current-1040 planning schemaVersion must be ${CURRENT_1040_PLANNING_SCHEMA_VERSION}`
    ));
  }
  if(!CLIENT_1040_SUPPORTED_TAX_YEARS.includes(source.taxYear)){
    gaps.push(makeGap(
      'CURRENT_1040_TAX_YEAR_REQUIRED',
      'incomeTax.current1040.taxYear',
      'Current-1040 taxYear must explicitly select 2025 or 2026'
    ));
  }
  if(source.incomeSourcesComplete !== true){
    gaps.push(makeGap(
      'CURRENT_1040_INCOME_SOURCES_INCOMPLETE',
      'incomeTax.current1040.incomeSourcesComplete',
      'Confirm that current1040 income and active owned planning rows completely describe this return'
    ));
  }

  const filingStatus = plan?.meta?.filingStatus;
  const returnScope = isRecord(source.returnScope)
    ? clone(source.returnScope)
    : source.returnScope;
  const modeledTaxpayer = returnScope?.modeledTaxpayer;
  const explicitIncomePresent = hasOwn(source, 'income');
  const explicitIncome = explicitIncomePresent ? source.income : undefined;
  if(explicitIncomePresent && !isRecord(explicitIncome)){
    gaps.push(makeGap(
      'CURRENT_1040_INCOME_OBJECT_REQUIRED',
      'incomeTax.current1040.income',
      'current1040.income must be a plain object when supplied'
    ));
  }
  const explicitSocialSecuritySource =
    hasExplicitSocialSecuritySource(explicitIncome);
  const rows = relevantActiveSources(
    plan,
    filingStatus,
    modeledTaxpayer,
    gaps
  );
  const mappedIncome = mapIncomeRows(
    rows,
    gaps,
    explicitSocialSecuritySource
  );
  const income = mergeCanonicalIncome(explicitIncome, mappedIncome, gaps);
  const owners = activeReturnOwners(filingStatus, modeledTaxpayer);
  const hasActivePlanningSocialSecurity =
    activePlanningSocialSecurity(plan, owners);
  if(hasActivePlanningSocialSecurity
      && !explicitSocialSecuritySource){
    gaps.push(makeGap(
      'CURRENT_1040_SOCIAL_SECURITY_RETURN_FACTS_REQUIRED',
      'income.socialSecurity',
      'SSA planning benefits cannot be used as Form 1040 Social Security facts'
    ));
  }
  if(source.incomeSourcesComplete === true && !hasIncomeGap(gaps)){
    materializeConfirmedZeroIncome(income, {
      explicitSocialSecuritySource,
      activePlanningSocialSecurity: hasActivePlanningSocialSecurity,
    });
  }

  const intake = {
    schemaVersion: CLIENT_1040_INTAKE_SCHEMA_VERSION,
    taxYear: source.taxYear,
    filingStatus,
    returnScope,
    income,
  };
  for(const key of [
    'lawVersion',
    'taxpayers',
    'adjustments',
    'deductions',
    'passThrough',
    'scheduleSE',
    'schedule2',
    'accounts',
    'reconciliation',
    'id',
    'label',
  ]){
    copyOwn(source, intake, key);
  }
  let scheduleD = buildScheduleD(source.scheduleD, rows, gaps);
  const hasMappedCapitalRows = rows.some(({ normalized }) =>
    normalized.typeId === 'short_term_capital_gain'
    || normalized.typeId === 'long_term_capital_gain'
  );
  if(scheduleD === undefined
      && source.incomeSourcesComplete === true
      && !hasMappedCapitalRows
      && !hasIncomeGap(gaps)){
    scheduleD = {
      mode: 'supplied-form1040-line7',
      amount: 0,
    };
  }
  if(scheduleD !== undefined) intake.scheduleD = scheduleD;
  const totalIncome = hasIncomeGap(gaps)
    ? null
    : canonicalEnteredIncomeTotal(income, scheduleD);

  return Object.freeze({
    intake: Object.freeze(intake),
    totalIncome,
    gaps: Object.freeze(gaps),
  });
}
