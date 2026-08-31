// Projection Engine implementation; public consumers import engine.js.


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

export function resolveHouseholdTimeline(plan, overrides = {}){
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

export function externalIncomeAtAge(p, age){
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

export function householdStateAtYear(p, yearIndex){
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

export function householdIncomeAtYear(p, yearIndex){
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

export function householdTaxStatusAtAge(p, age){
  return householdStateAtYear(p, age - p.currentAge);
}
