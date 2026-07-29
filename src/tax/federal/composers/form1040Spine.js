/* ============================================================================
   Form 1040 spine — income and deduction lines (1z → 15).
   ============================================================================ */

import {
  LINE_STATUS,
  SPINE_LINE_IDS,
  assertAllSpineLines,
  calculatedLine,
  deferredLine,
  lineAmount,
  passThroughLine,
  suppliedLine,
} from '../../core/form1040Lines.js';
import { taxableSocialSecurity } from '../rules/taxableSocialSecurity.js';
import { traditionalIraDeductibility } from '../rules/traditionalIraDeductibility.js';
import { standardDeduction } from '../rules/standardDeduction.js';
import { scheduleDClassification } from '../rules/scheduleDClassification.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const INCOME_COMPONENT_IDS = ['line1z', 'line2b', 'line3b', 'line4b', 'line5b', 'line6b', 'line7a', 'line8'];

function readSupplied(input, lineId){
  const fromMap = input.supplied?.[lineId];
  if(fromMap !== undefined && fromMap !== null) return fromMap;
  return undefined;
}

function isFullIncomePath(input){
  if(input.supplied){
    for(const id of INCOME_COMPONENT_IDS){
      if(readSupplied(input, id) !== undefined) return true;
    }
  }
  return Boolean(input.socialSecurity || input.traditionalIra);
}

function isLine15Shortcut(input){
  return input.taxableOrdinaryIncome !== undefined && !isFullIncomePath(input);
}

function resolveIncomeComponent(lineId, value, { ruleId = null, auditIndex = null } = {}){
  if(value === undefined) return deferredLine(lineId);
  if(ruleId) return calculatedLine(lineId, value, { ruleId, auditIndex });
  return suppliedLine(lineId, value);
}

function buildLine6b(input, context, audits){
  const supplied = readSupplied(input, 'line6b');
  if(supplied !== undefined) return suppliedLine('line6b', supplied);

  if(input.socialSecurity){
    const ss = taxableSocialSecurity.calculate({
      filingStatus: input.filingStatus,
      ...input.socialSecurity,
    }, context);
    audits.push(ss.audit);
    return calculatedLine('line6b', ss.result.taxableBenefits, {
      ruleId: 'FED_TAXABLE_SOCIAL_SECURITY',
      auditIndex: audits.length - 1,
    });
  }

  return deferredLine('line6b');
}

function resolveScheduleDClassification(input, context, audits){
  if(!input.scheduleD) return null;
  const classified = scheduleDClassification.calculate({
    filingStatus: input.filingStatus,
    line7: input.scheduleD.line7,
    line15: input.scheduleD.line15,
    line16: input.scheduleD.line16,
    line18: input.scheduleD.line18 ?? 0,
    line19: input.scheduleD.line19 ?? 0,
  }, context);
  audits.push(classified.audit);
  return {
    ...classified.result,
    auditIndex: audits.length - 1,
  };
}

function buildLine7a(input, context, audits, scheduleDClassificationResult){
  const supplied = readSupplied(input, 'line7a');
  if(supplied !== undefined) return suppliedLine('line7a', supplied);

  if(scheduleDClassificationResult){
    return calculatedLine('line7a', scheduleDClassificationResult.form1040Line7, {
      ruleId: 'FED_SCHEDULE_D_CLASSIFICATION',
      auditIndex: scheduleDClassificationResult.auditIndex,
    });
  }

  if(input.capitalGains?.netLongTermCapitalGains !== undefined){
    return calculatedLine('line7a', input.capitalGains.netLongTermCapitalGains, {
      ruleId: 'COMPOSER_CAPITAL_GAINS',
    });
  }
  return deferredLine('line7a');
}

function buildLine3a(input){
  const supplied = readSupplied(input, 'line3a');
  if(supplied !== undefined) return suppliedLine('line3a', supplied);
  if(input.capitalGains?.qualifiedDividends !== undefined){
    return calculatedLine('line3a', input.capitalGains.qualifiedDividends, {
      ruleId: 'COMPOSER_QUALIFIED_DIVIDENDS',
    });
  }
  return deferredLine('line3a');
}

function buildLine3b(input){
  const supplied = readSupplied(input, 'line3b');
  if(supplied !== undefined) return suppliedLine('line3b', supplied);
  return deferredLine('line3b');
}

function buildLine10(input, context, audits){
  const supplied = readSupplied(input, 'line10');
  const suppliedTraditionalIraDeduction =
    input.adjustmentComponents?.traditionalIraDeduction;
  if(supplied !== undefined && suppliedTraditionalIraDeduction !== undefined){
    throw new Error(
      'Form 1040 line 10 cannot mix a supplied total with a supplied traditional IRA component'
    );
  }
  let total = supplied ?? 0;

  if(input.traditionalIra){
    const ira = traditionalIraDeductibility.calculate({
      filingStatus: input.filingStatus,
      ...input.traditionalIra,
    }, context);
    audits.push(ira.audit);
    total = round2(total + ira.result.deductibleContribution);
    return calculatedLine('line10', total, {
      ruleId: 'FED_TRADITIONAL_IRA_DEDUCTIBILITY',
      auditIndex: audits.length - 1,
    });
  }

  if(suppliedTraditionalIraDeduction !== undefined){
    return suppliedLine('line10', suppliedTraditionalIraDeduction);
  }
  if(supplied !== undefined) return suppliedLine('line10', supplied);
  return deferredLine('line10');
}

function wantsStandardDeduction(input){
  if(input.deductions?.useStandard === false) return false;
  if(input.deductions?.useStandard === true) return true;
  if(input.deductions?.itemizedAmount !== undefined) return false;
  if(readSupplied(input, 'line12e') !== undefined) return false;
  return isFullIncomePath(input);
}

function buildLine12e(input, context, audits){
  const supplied = readSupplied(input, 'line12e');
  if(supplied !== undefined) return suppliedLine('line12e', supplied);

  if(input.deductions?.itemizedAmount !== undefined){
    return suppliedLine('line12e', input.deductions.itemizedAmount);
  }

  if(wantsStandardDeduction(input)){
    const std = standardDeduction.calculate({ filingStatus: input.filingStatus }, context);
    audits.push(std.audit);
    return calculatedLine('line12e', std.result.standardDeduction, {
      ruleId: 'FED_STANDARD_DEDUCTION',
      auditIndex: audits.length - 1,
    });
  }

  return deferredLine('line12e');
}

/** Resolve preferential amounts for line 16 from explicit rule input or 1040 spine lines. */
export function resolvePreferentialComponents(input, scheduleDClassificationResult = null){
  const cg = input.capitalGains;

  let netLongTermCapitalGains = 0;
  if(scheduleDClassificationResult){
    netLongTermCapitalGains = scheduleDClassificationResult.preferentialScheduleDGain;
  } else if(cg?.netLongTermCapitalGains !== undefined){
    netLongTermCapitalGains = cg.netLongTermCapitalGains;
  } else {
    const line7 = readSupplied(input, 'line7a');
    if(line7 !== undefined && line7 > 0) netLongTermCapitalGains = line7;
  }

  let qualifiedDividends = 0;
  if(cg?.qualifiedDividends !== undefined){
    qualifiedDividends = cg.qualifiedDividends;
  } else {
    const line3a = readSupplied(input, 'line3a');
    if(line3a !== undefined) qualifiedDividends = line3a;
  }

  return {
    netLongTermCapitalGains,
    qualifiedDividends,
    total: round2(netLongTermCapitalGains + qualifiedDividends),
    scheduleDClassification: scheduleDClassificationResult,
  };
}

function preferentialIncome(input, scheduleDClassificationResult = null){
  return resolvePreferentialComponents(input, scheduleDClassificationResult).total;
}

function buildIncomeAndDeductionLines(input, context, audits){
  const scheduleDClassificationResult = resolveScheduleDClassification(input, context, audits);

  if(isLine15Shortcut(input)){
    const pref = preferentialIncome(input, scheduleDClassificationResult);
    const line15Value = pref > 0
      ? round2(input.taxableOrdinaryIncome + pref)
      : input.taxableOrdinaryIncome;
    const ordinaryTaxableIncome = pref > 0
      ? input.taxableOrdinaryIncome
      : input.taxableOrdinaryIncome;

    const form1040 = {};
    for(const lineId of SPINE_LINE_IDS){
      if(lineId === 'line15'){
        form1040.line15 = suppliedLine('line15', line15Value);
      } else if(['line12e', 'line13a', 'line13b'].includes(lineId)){
        const v = readSupplied(input, lineId);
        form1040[lineId] = v !== undefined ? suppliedLine(lineId, v) : deferredLine(lineId);
      } else if(['line16', 'line17', 'line18', 'line19', 'line20', 'line21', 'line22', 'line23', 'line24'].includes(lineId)){
        form1040[lineId] = deferredLine(lineId);
      } else {
        form1040[lineId] = deferredLine(lineId);
      }
    }

    const suppliedLine7 = readSupplied(input, 'line7a');
    if(suppliedLine7 !== undefined){
      form1040.line7a = suppliedLine('line7a', suppliedLine7);
    } else if(scheduleDClassificationResult){
      form1040.line7a = calculatedLine('line7a', scheduleDClassificationResult.form1040Line7, {
        ruleId: 'FED_SCHEDULE_D_CLASSIFICATION',
        auditIndex: scheduleDClassificationResult.auditIndex,
      });
    } else if(input.capitalGains?.netLongTermCapitalGains !== undefined){
      form1040.line7a = calculatedLine('line7a', input.capitalGains.netLongTermCapitalGains, {
        ruleId: 'COMPOSER_CAPITAL_GAINS',
      });
    }
    const suppliedLine3a = readSupplied(input, 'line3a');
    if(suppliedLine3a !== undefined){
      form1040.line3a = suppliedLine('line3a', suppliedLine3a);
    } else if(input.capitalGains?.qualifiedDividends !== undefined){
      form1040.line3a = calculatedLine('line3a', input.capitalGains.qualifiedDividends, {
        ruleId: 'COMPOSER_QUALIFIED_DIVIDENDS',
      });
    }

    return {
      form1040: assertAllSpineLines(form1040),
      ordinaryTaxableIncome: Math.max(0, ordinaryTaxableIncome),
      preferentialIncome: pref,
      shortcut: true,
      scheduleDClassification: scheduleDClassificationResult,
    };
  }

  const line3a = buildLine3a(input);
  const incomeLines = {
    line1z: resolveIncomeComponent('line1z', readSupplied(input, 'line1z')),
    line2b: resolveIncomeComponent('line2b', readSupplied(input, 'line2b')),
    line3b: buildLine3b(input),
    line4b: resolveIncomeComponent('line4b', readSupplied(input, 'line4b')),
    line5b: resolveIncomeComponent('line5b', readSupplied(input, 'line5b')),
    line6b: buildLine6b(input, context, audits),
    line7a: buildLine7a(input, context, audits, scheduleDClassificationResult),
    line8: resolveIncomeComponent('line8', readSupplied(input, 'line8')),
  };

  const line9Value = round2(
    INCOME_COMPONENT_IDS.reduce((sum, id) => sum + lineAmount(incomeLines[id]), 0)
  );
  const line9 = calculatedLine('line9', line9Value);

  const line10 = buildLine10(input, context, audits);
  const line11aValue = round2(lineAmount(line9) - lineAmount(line10));
  const line11a = calculatedLine('line11a', line11aValue);
  const line11b = calculatedLine('line11b', line11aValue);

  const line12e = buildLine12e(input, context, audits);
  const line13a = readSupplied(input, 'line13a') !== undefined
    ? passThroughLine('line13a', readSupplied(input, 'line13a'))
    : deferredLine('line13a');
  const line13b = readSupplied(input, 'line13b') !== undefined
    ? passThroughLine('line13b', readSupplied(input, 'line13b'))
    : deferredLine('line13b');

  const line14Value = round2(lineAmount(line12e) + lineAmount(line13a) + lineAmount(line13b));
  const line14 = calculatedLine('line14', line14Value);

  const line15Value = Math.max(0, round2(lineAmount(line11b) - lineAmount(line14)));
  const line15 = calculatedLine('line15', line15Value);

  const pref = preferentialIncome(input, scheduleDClassificationResult);
  const ordinaryTaxableIncome = input.ordinaryTaxableIncome !== undefined
    ? input.ordinaryTaxableIncome
    : Math.max(0, round2(line15Value - pref));

  const form1040 = assertAllSpineLines({
    ...incomeLines,
    line3a,
    line9,
    line10,
    line11a,
    line11b,
    line12e,
    line13a,
    line13b,
    line14,
    line15,
    line16: deferredLine('line16'),
    line17: deferredLine('line17'),
    line18: deferredLine('line18'),
    line19: deferredLine('line19'),
    line20: deferredLine('line20'),
    line21: deferredLine('line21'),
    line22: deferredLine('line22'),
    line23: deferredLine('line23'),
    line24: deferredLine('line24'),
  });

  for(const detailId of ['line2a', 'line4a', 'line5a', 'line6a']){
    const detailValue = readSupplied(input, detailId);
    if(detailValue !== undefined){
      form1040[detailId] = suppliedLine(detailId, detailValue);
    }
  }

  return {
    form1040,
    ordinaryTaxableIncome,
    preferentialIncome: pref,
    shortcut: false,
    scheduleDClassification: scheduleDClassificationResult,
  };
}

export function buildForm1040IncomeSpine(input, context){
  const audits = [];
  return { ...buildIncomeAndDeductionLines(input, context, audits), audits };
}

export { isLine15Shortcut, isFullIncomePath, preferentialIncome };
