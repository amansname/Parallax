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
import { enhancedSeniorDeduction } from '../rules/enhancedSeniorDeduction.js';
import { selfEmploymentTax } from '../rules/selfEmploymentTax.js';
import {
  OVERALL_ITEMIZED_DEPENDENCIES_MISSING,
} from '../rules/overallItemizedDeductionLimit.js';
import { calculateItemizedDeduction } from './calculatedItemizedDeduction.js';
import {
  CLIENT_1040_COMPATIBILITY_MODES,
} from '../../core/client1040IntakeContractConstants.js';
import { TaxInputError } from '../../core/errors.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const INCOME_COMPONENT_IDS = ['line1z', 'line2b', 'line3b', 'line4b', 'line5b', 'line6b', 'line7a', 'line8'];

function isCanonicalComposerInput(input){
  return input.intakeCompatibilityMode
    === CLIENT_1040_COMPATIBILITY_MODES.CANONICAL;
}

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

function buildLine6b(
  input,
  context,
  audits,
  scheduleSETotals,
  scheduleDClassificationResult
){
  const supplied = readSupplied(input, 'line6b');
  if(supplied !== undefined) return suppliedLine('line6b', supplied);

  if(input.socialSecurity){
    const {
      addResolvedScheduleDLine7ToOtherIncome,
      ...socialSecurity
    } = input.socialSecurity;
    if(addResolvedScheduleDLine7ToOtherIncome
        && !scheduleDClassificationResult){
      throw new TaxInputError(
        'Social Security requested a resolved Schedule D line 7 without Schedule D facts'
      );
    }
    const scheduleDLine7 = addResolvedScheduleDLine7ToOtherIncome
      ? scheduleDClassificationResult.form1040Line7
      : 0;
    const worksheetAdjustments = isCanonicalComposerInput(input)
      ? round2(
        socialSecurity.adjustments
        + (scheduleSETotals?.deductiblePartOfSelfEmploymentTax ?? 0)
      )
      : socialSecurity.adjustments;
    const ss = taxableSocialSecurity.calculate({
      filingStatus: input.filingStatus,
      ...socialSecurity,
      otherIncome: round2(socialSecurity.otherIncome + scheduleDLine7),
      adjustments: worksheetAdjustments,
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
  const classified = input.scheduleD.mode === 'manual-net-long-term'
    ? scheduleDClassification.calculateManualNetLongTerm({
      filingStatus: input.filingStatus,
      netLongTermGainOrLoss: input.scheduleD.netLongTermGainOrLoss,
    }, context)
    : scheduleDClassification.calculate({
      filingStatus: input.filingStatus,
      line7: input.scheduleD.line7,
      line15: input.scheduleD.line15,
      line16: input.scheduleD.line16,
      line18: input.scheduleD.line18 ?? 0,
      line19: input.scheduleD.line19 ?? 0,
      form4952Line4g: input.scheduleD.form4952Line4g ?? 0,
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

function calculateScheduleSETotals(input, context, audits){
  if(!Array.isArray(input.scheduleSE) || input.scheduleSE.length === 0) return null;
  let selfEmploymentTaxTotal = 0;
  let deductiblePartOfSelfEmploymentTax = 0;
  const auditIndexes = [];
  for(const scheduleSE of input.scheduleSE){
    const calculated = selfEmploymentTax.calculate(scheduleSE, context);
    audits.push(calculated.audit);
    auditIndexes.push(audits.length - 1);
    selfEmploymentTaxTotal += calculated.result.selfEmploymentTax;
    deductiblePartOfSelfEmploymentTax +=
      calculated.result.deductiblePartOfSelfEmploymentTax;
  }
  return {
    selfEmploymentTaxTotal: round2(selfEmploymentTaxTotal),
    deductiblePartOfSelfEmploymentTax:
      round2(deductiblePartOfSelfEmploymentTax),
    auditIndexes,
  };
}

function buildLine10(input, context, audits, scheduleSETotals){
  const supplied = readSupplied(input, 'line10');
  const suppliedTraditionalIraDeduction =
    input.adjustmentComponents?.traditionalIraDeduction;
  const canonicalSocialSecurityAdjustments =
    isCanonicalComposerInput(input) && input.socialSecurity
      ? input.socialSecurity.adjustments
      : 0;
  const calculatedHalfSETaxDeduction =
    scheduleSETotals?.deductiblePartOfSelfEmploymentTax ?? 0;
  const minimumSuppliedLine10 = round2(
    canonicalSocialSecurityAdjustments + calculatedHalfSETaxDeduction
  );
  if(supplied !== undefined && suppliedTraditionalIraDeduction !== undefined){
    throw new Error(
      'Form 1040 line 10 cannot mix a supplied total with a supplied traditional IRA component'
    );
  }
  if(supplied !== undefined && supplied < minimumSuppliedLine10){
    throw new TaxInputError(
      'Supplied Form 1040 line 10 is less than the Social Security worksheet-eligible adjustments plus calculated half-SE-tax deduction',
      {
        suppliedLine10: supplied,
        socialSecurityWorksheetEligibleAdjustments:
          canonicalSocialSecurityAdjustments,
        deductiblePartOfSelfEmploymentTax: calculatedHalfSETaxDeduction,
        minimumSuppliedLine10,
      }
    );
  }
  if(supplied !== undefined) return suppliedLine('line10', supplied);
  if(isCanonicalComposerInput(input)
      && canonicalSocialSecurityAdjustments > 0
      && suppliedTraditionalIraDeduction === undefined){
    return deferredLine('line10');
  }
  // A supplied Schedule 1 total is authoritative and is presumed to include
  // any half-SE-tax deduction. Engine-calculated half-SE tax is added only
  // when no complete line 10 total was supplied.
  let total = supplied ?? scheduleSETotals?.deductiblePartOfSelfEmploymentTax ?? 0;
  let calculatedRuleId = scheduleSETotals && supplied === undefined
    ? 'FED_SELF_EMPLOYMENT_TAX'
    : null;
  let calculatedAuditIndex = scheduleSETotals && supplied === undefined
    ? scheduleSETotals.auditIndexes[0]
    : null;

  if(input.traditionalIra){
    const ira = traditionalIraDeductibility.calculate({
      filingStatus: input.filingStatus,
      ...input.traditionalIra,
    }, context);
    audits.push(ira.audit);
    total = round2(total + ira.result.deductibleContribution);
    return calculatedLine('line10', total, {
      ruleId: calculatedRuleId
        ? `${calculatedRuleId}+FED_TRADITIONAL_IRA_DEDUCTIBILITY`
        : 'FED_TRADITIONAL_IRA_DEDUCTIBILITY',
      auditIndex: audits.length - 1,
    });
  }

  if(suppliedTraditionalIraDeduction !== undefined){
    total = round2(total + suppliedTraditionalIraDeduction);
    if(calculatedRuleId){
      return calculatedLine('line10', total, {
        ruleId: `${calculatedRuleId}+SUPPLIED_TRADITIONAL_IRA_DEDUCTION`,
        auditIndex: calculatedAuditIndex,
      });
    }
    return suppliedLine('line10', total);
  }
  if(calculatedRuleId){
    return calculatedLine('line10', total, {
      ruleId: calculatedRuleId,
      auditIndex: calculatedAuditIndex,
    });
  }
  return deferredLine('line10');
}

function wantsStandardDeduction(input){
  if(isCanonicalComposerInput(input)
      && input.deductions?.source === 'supplied-line12e'){
    return false;
  }
  if(input.deductions?.source === 'calculated'
      && input.deductions?.method === 'itemized') return false;
  if(input.deductions?.source === 'calculated'
      && input.deductions?.method === 'standard') return true;
  if(input.deductions?.useStandard === false) return false;
  if(input.deductions?.useStandard === true) return true;
  if(input.deductions?.itemizedAmount !== undefined) return false;
  if(readSupplied(input, 'line12e') !== undefined) return false;
  return isFullIncomePath(input);
}

function buildLine13a(input){
  const supplied = readSupplied(input, 'line13a');
  return supplied !== undefined
    ? passThroughLine('line13a', supplied)
    : deferredLine('line13a');
}

function buildLine13b(input, context, audits, adjustedGrossIncomeLine){
  const supplied = readSupplied(input, 'line13b');
  if(supplied !== undefined) return passThroughLine('line13b', supplied);

  const schedule1A = input.deductions?.schedule1A;
  if(schedule1A?.mode !== 'calculate-enhanced-senior'){
    return deferredLine('line13b');
  }
  if(schedule1A.magi.mode === 'line11b-no-exclusions'
      && adjustedGrossIncomeLine.status === LINE_STATUS.DEFERRED){
    return deferredLine('line13b');
  }
  const modifiedAdjustedGrossIncome = schedule1A.magi.mode === 'supplied-magi'
    ? schedule1A.magi.amount
    : adjustedGrossIncomeLine.value;
  const senior = enhancedSeniorDeduction.calculate({
    filingStatus: input.filingStatus,
    modeledTaxpayer: input.returnScope?.modeledTaxpayer,
    modifiedAdjustedGrossIncome,
    taxpayers: input.taxpayers,
  }, context);
  audits.push(senior.audit);
  return calculatedLine('line13b', senior.result.enhancedSeniorDeduction, {
    ruleId: 'FED_ENHANCED_SENIOR_DEDUCTION',
    auditIndex: audits.length - 1,
  });
}

function buildLine12e(input, context, audits, {
  adjustedGrossIncome,
  line13a,
  line13b,
} = {}){
  const supplied = readSupplied(input, 'line12e');
  if(supplied !== undefined) return suppliedLine('line12e', supplied);

  if(input.deductions?.itemizedAmount !== undefined){
    return suppliedLine('line12e', input.deductions.itemizedAmount);
  }

  if(input.deductions?.source === 'calculated'
      && input.deductions?.method === 'itemized'){
    if(adjustedGrossIncome === undefined){
      return deferredLine('line12e');
    }
    let itemized;
    try {
      itemized = calculateItemizedDeduction({
        filingStatus: input.filingStatus,
        itemized: input.deductions.itemized,
        adjustedGrossIncome,
        qualifiedBusinessIncomeDeduction:
          line13a?.status === LINE_STATUS.DEFERRED ? undefined : line13a?.value,
        schedule1ADeduction:
          line13b?.status === LINE_STATUS.DEFERRED ? undefined : line13b?.value,
      }, context, audits);
    } catch(error){
      const deferredCanonicalDependency = isCanonicalComposerInput(input)
        && error instanceof TaxInputError
        && error.details?.code === OVERALL_ITEMIZED_DEPENDENCIES_MISSING;
      if(deferredCanonicalDependency){
        return deferredLine('line12e');
      }
      throw error;
    }
    return calculatedLine(
      'line12e',
      itemized.result.allowedItemizedDeductions,
      {
        ruleId: 'COMPOSER_CALCULATED_ITEMIZED_DEDUCTION',
        auditIndex: itemized.auditIndex,
      }
    );
  }

  if(wantsStandardDeduction(input)){
    const canonicalCalculated = input.deductions?.source === 'calculated'
      && input.deductions?.method === 'standard';
    let canonicalStandardFacts = {};
    if(canonicalCalculated){
      const baseAndAgeScope = input.deductions.standardScope
        === 'base-and-age';
      canonicalStandardFacts = baseAndAgeScope
        ? {
          taxpayers: input.taxpayers,
          standardScope: input.deductions.standardScope,
        }
        : {
          modeledTaxpayer: input.returnScope?.modeledTaxpayer,
          spouseItemizes: input.returnScope?.spouseItemizes,
          taxpayers: input.taxpayers,
          standardEligibility: input.deductions.standardEligibility,
        };
    }
    const std = standardDeduction.calculate({
      filingStatus: input.filingStatus,
      ...(canonicalCalculated ? canonicalStandardFacts : {}),
    }, context);
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
  const scheduleSETotals = calculateScheduleSETotals(input, context, audits);

  if(isLine15Shortcut(input)){
    const pref = preferentialIncome(input, scheduleDClassificationResult);
    const line15Value = pref > 0
      ? round2(input.taxableOrdinaryIncome + pref)
      : input.taxableOrdinaryIncome;
    const ordinaryTaxableIncome = input.taxableOrdinaryIncome;

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
      scheduleSETotals,
    };
  }

  const line10 = buildLine10(input, context, audits, scheduleSETotals);
  const line3a = buildLine3a(input);
  const incomeLines = {
    line1z: resolveIncomeComponent('line1z', readSupplied(input, 'line1z')),
    line2b: resolveIncomeComponent('line2b', readSupplied(input, 'line2b')),
    line3b: buildLine3b(input),
    line4b: resolveIncomeComponent('line4b', readSupplied(input, 'line4b')),
    line5b: resolveIncomeComponent('line5b', readSupplied(input, 'line5b')),
    line6b: buildLine6b(
      input,
      context,
      audits,
      scheduleSETotals,
      scheduleDClassificationResult
    ),
    line7a: buildLine7a(input, context, audits, scheduleDClassificationResult),
    line8: resolveIncomeComponent('line8', readSupplied(input, 'line8')),
  };

  const canonical = isCanonicalComposerInput(input);
  const unresolvedCanonicalIncome = canonical
    && INCOME_COMPONENT_IDS.some(
      lineId => incomeLines[lineId].status === LINE_STATUS.DEFERRED
    );
  const line9 = unresolvedCanonicalIncome
    ? deferredLine('line9')
    : calculatedLine(
      'line9',
      round2(
        INCOME_COMPONENT_IDS.reduce(
          (sum, id) => sum + lineAmount(incomeLines[id]),
          0
        )
      )
    );

  const line11aValue = (
    line9.status === LINE_STATUS.DEFERRED
    || line10.status === LINE_STATUS.DEFERRED
  )
    ? null
    : round2(lineAmount(line9) - lineAmount(line10));
  const line11a = canonical && line11aValue === null
    ? deferredLine('line11a')
    : calculatedLine(
      'line11a',
      line11aValue === null
        ? round2(lineAmount(line9) - lineAmount(line10))
        : line11aValue
    );
  const line11b = line11a.status === LINE_STATUS.DEFERRED
    ? deferredLine('line11b')
    : calculatedLine('line11b', line11a.value);

  const line13a = buildLine13a(input);
  const line13b = buildLine13b(input, context, audits, line11a);
  const line12e = buildLine12e(input, context, audits, {
    adjustedGrossIncome:
      line11a.status === LINE_STATUS.DEFERRED ? undefined : line11a.value,
    line13a,
    line13b,
  });

  const unresolvedDeduction = [line12e, line13a, line13b]
    .some(line => line.status === LINE_STATUS.DEFERRED);
  const line14 = canonical && unresolvedDeduction
    ? deferredLine('line14')
    : calculatedLine(
      'line14',
      round2(lineAmount(line12e) + lineAmount(line13a) + lineAmount(line13b))
    );

  const line15 = canonical
      && (line11b.status === LINE_STATUS.DEFERRED
        || line14.status === LINE_STATUS.DEFERRED)
    ? deferredLine('line15')
    : calculatedLine(
      'line15',
      Math.max(0, round2(lineAmount(line11b) - lineAmount(line14)))
    );

  const rawPreferentialIncome = canonical && line3a.status === LINE_STATUS.DEFERRED
    ? null
    : preferentialIncome(input, scheduleDClassificationResult);
  const pref = line15.status === LINE_STATUS.DEFERRED
      || rawPreferentialIncome === null
    ? null
    : Math.min(
      line15.value,
      Math.max(0, rawPreferentialIncome)
    );
  const ordinaryTaxableIncome = (
    line15.status === LINE_STATUS.DEFERRED
    || pref === null
  )
    ? null
    : input.ordinaryTaxableIncome !== undefined
    ? input.ordinaryTaxableIncome
    : Math.max(0, round2(line15.value - pref));

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
    scheduleSETotals,
  };
}

export function buildForm1040IncomeSpine(input, context){
  const audits = [];
  return { ...buildIncomeAndDeductionLines(input, context, audits), audits };
}

export { isLine15Shortcut, isFullIncomePath, preferentialIncome };
