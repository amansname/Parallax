// Projection Engine Social Security contracts. Public consumers import engine.js.

const SS_FRA = 67;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function finitePia(value){
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function timelineAge(primaryCurrentAge, personCurrentAge, personAge){
  return primaryCurrentAge + (personAge - personCurrentAge);
}

function retirementFullRetirementAge(birthYear){
  if(!Number.isInteger(birthYear)) return SS_FRA;
  if(birthYear <= 1937) return 65;
  if(birthYear <= 1942) return 65 + ((birthYear - 1937) * 2) / 12;
  if(birthYear <= 1954) return 66;
  if(birthYear <= 1959) return 66 + ((birthYear - 1954) * 2) / 12;
  return 67;
}

function survivorFullRetirementAge(birthYear){
  if(!Number.isInteger(birthYear)) return SS_FRA;
  if(birthYear <= 1939) return 65;
  if(birthYear <= 1944) return 65 + ((birthYear - 1939) * 2) / 12;
  if(birthYear <= 1956) return 66;
  if(birthYear <= 1961) return 66 + ((birthYear - 1956) * 2) / 12;
  return 67;
}

// `pia` is the worker benefit at FRA. The optional FRA preserves the public
// modern-age default while resolved households use their birth cohort.
export function ssAdjust(pia, claimAge, fullRetirementAge = SS_FRA){
  const c = clamp(claimAge, 62, 70);
  if(c >= fullRetirementAge){
    return pia * (1 + 0.08 * (c - fullRetirementAge));
  }
  const monthsEarly = (fullRetirementAge - c) * 12;
  const first36 = Math.min(monthsEarly, 36);
  const beyond = Math.max(0, monthsEarly - 36);
  return pia * (1 - (first36 * (5 / 900) + beyond * (5 / 1200)));
}

// The age reduction applies to the spousal excess, not the worker benefit.
function adjustSpousalExcess(excess, entitlementAge, fullRetirementAge){
  const monthsEarly = Math.max(0, (fullRetirementAge - entitlementAge) * 12);
  const first36 = Math.min(monthsEarly, 36);
  const beyond = Math.max(0, monthsEarly - 36);
  return excess * (1 - (first36 * (25 / 3600) + beyond * (5 / 1200)));
}

function survivorBenefitBasis(decedentConfig, decedentTimeline, fullRetirementAge){
  const pia = finitePia(decedentConfig?.pia);
  if(!(pia > 0)) return { unreducedAmount: 0, ribLimit: null };
  const claimAge = decedentTimeline.socialSecurityClaimAge;
  const deathAge = decedentTimeline.planEndAge;
  if(!Number.isFinite(deathAge)) return { unreducedAmount: 0, ribLimit: null };

  // If the worker died before claiming, delayed credits accrue only through the
  // assumed death age. Before FRA, the unreduced PIA remains the survivor base.
  const workerAgeForSurvivor = Number.isFinite(claimAge) && claimAge <= deathAge
    ? claimAge
    : clamp(deathAge, fullRetirementAge, 70);
  const workerAmount = ssAdjust(pia, workerAgeForSurvivor, fullRetirementAge);

  if(workerAgeForSurvivor < fullRetirementAge){
    return {
      unreducedAmount: pia,
      // RIB-LIM caps the already age-reduced widow(er) amount; it is not the
      // base to which the survivor reduction is applied.
      ribLimit: Math.min(pia, Math.max(workerAmount, pia * 0.825)),
    };
  }
  return { unreducedAmount: workerAmount, ribLimit: null };
}

function adjustSurvivorBenefit(amount, entitlementAge, fullRetirementAge){
  if(entitlementAge >= fullRetirementAge) return amount;
  const monthsEarly = Math.max(0, (fullRetirementAge - Math.max(60, entitlementAge)) * 12);
  const possibleReductionMonths = (fullRetirementAge - 60) * 12;
  return amount * (1 - 0.285 * (monthsEarly / possibleReductionMonths));
}

function personConfig(config, timeline, owner, primaryCurrentAge){
  const saved = owner === 'client' ? config.primary : config.spouse;
  const person = timeline.people[owner];
  if(!person) return null;
  const pia = finitePia(saved?.pia);
  const claimAge = person.socialSecurityClaimAge;
  const retirementFRA = retirementFullRetirementAge(person.birthYear);
  const survivorFRA = survivorFullRetirementAge(person.birthYear);
  if(!Number.isFinite(claimAge) || !Number.isFinite(person.currentAge)){
    return {
      owner,
      saved,
      person,
      pia,
      claimAge: null,
      retirementFullRetirementAge: retirementFRA,
      survivorFullRetirementAge: survivorFRA,
    };
  }
  return {
    owner,
    saved,
    person,
    pia,
    claimAge,
    retirementFullRetirementAge: retirementFRA,
    survivorFullRetirementAge: survivorFRA,
    claimAgeOnPrimaryTimeline: timelineAge(
      primaryCurrentAge,
      person.currentAge,
      claimAge,
    ),
  };
}

/**
 * Resolve worker, spouse, and survivor benefits into the primary-age frame.
 * The annual model treats each planEndAge as the inclusive final living year;
 * survivor payments therefore begin no earlier than the following row.
 */
export function resolveSocialSecurityModel({
  config = {},
  timeline,
  primaryCurrentAge,
  stressMultiplier = 1,
}){
  const people = {
    client: personConfig(config, timeline, 'client', primaryCurrentAge),
    spouse: personConfig(config, timeline, 'spouse', primaryCurrentAge),
  };
  const streams = [];

  for(const owner of ['client', 'spouse']){
    const entry = people[owner];
    if(!entry || !(entry.pia > 0) || entry.claimAge === null) continue;
    streams.push(Object.freeze({
      kind: 'worker',
      owner,
      amount: ssAdjust(
        entry.pia,
        entry.claimAge,
        entry.retirementFullRetirementAge,
      ) * stressMultiplier,
      startAge: entry.claimAgeOnPrimaryTimeline,
      endAge: entry.person.planEndAgeOnPrimaryTimeline,
    }));
  }

  if(people.client && people.spouse
      && people.client.claimAge !== null && people.spouse.claimAge !== null){
    for(const [owner, workerOwner] of [['client', 'spouse'], ['spouse', 'client']]){
      const recipient = people[owner];
      const worker = people[workerOwner];
      const excess = Math.max(0, worker.pia * 0.5 - recipient.pia);
      if(!(excess > 0)) continue;
      const workerClaimAgeForRecipient = recipient.person.currentAge
        + (worker.claimAgeOnPrimaryTimeline - primaryCurrentAge);
      const entitlementAge = Math.max(recipient.claimAge, workerClaimAgeForRecipient);
      streams.push(Object.freeze({
        kind: 'spousal',
        owner,
        amount: adjustSpousalExcess(
          excess,
          entitlementAge,
          recipient.retirementFullRetirementAge,
        ) * stressMultiplier,
        startAge: Math.max(
          recipient.claimAgeOnPrimaryTimeline,
          worker.claimAgeOnPrimaryTimeline,
        ),
        endAge: Math.min(
          recipient.person.planEndAgeOnPrimaryTimeline,
          worker.person.planEndAgeOnPrimaryTimeline,
        ),
      }));
    }
  }

  const survivorBenefits = {};
  for(const [owner, decedentOwner] of [['client', 'spouse'], ['spouse', 'client']]){
    const survivor = people[owner];
    const decedent = people[decedentOwner];
    if(!survivor || !decedent) continue;
    if(decedent.claimAge === null) continue;
    const survivorEnd = survivor.person.planEndAgeOnPrimaryTimeline;
    const decedentEnd = decedent.person.planEndAgeOnPrimaryTimeline;
    if(!Number.isFinite(survivorEnd) || !Number.isFinite(decedentEnd)
        || decedentEnd >= survivorEnd){
      continue;
    }
    const firstSurvivorYear = decedentEnd + 1;
    const survivorAgeAtBoundary = survivor.person.currentAge
      + (firstSurvivorYear - primaryCurrentAge);
    const configuredClaimAge = Number.isFinite(survivor.saved?.survivorClaimAge)
      ? clamp(survivor.saved.survivorClaimAge, 60, 70)
      : 60;
    const entitlementAge = Math.max(60, configuredClaimAge, survivorAgeAtBoundary);
    const startAge = timelineAge(
      primaryCurrentAge,
      survivor.person.currentAge,
      entitlementAge,
    );
    if(startAge > survivorEnd) continue;
    const basis = survivorBenefitBasis(
      decedent.saved,
      decedent.person,
      decedent.retirementFullRetirementAge,
    );
    const ageReducedAmount = adjustSurvivorBenefit(
      basis.unreducedAmount,
      entitlementAge,
      survivor.survivorFullRetirementAge,
    );
    survivorBenefits[owner] = Object.freeze({
      owner,
      deceasedOwner: decedentOwner,
      amount: Math.min(ageReducedAmount, basis.ribLimit ?? Infinity)
        * stressMultiplier,
      entitlementAge,
      startAge,
      endAge: survivorEnd,
    });
  }

  return Object.freeze({
    streams: Object.freeze(streams),
    survivorBenefits: Object.freeze(survivorBenefits),
  });
}

export function socialSecurityIncomeAtAge(p, age, householdState){
  const active = stream => age >= stream.startAge
    && (stream.endAge == null || age <= stream.endAge);
  const streams = Array.isArray(p.ss) ? p.ss : [];
  if(!householdState?.survivor){
    return streams.reduce((sum, stream) => sum + (active(stream) ? stream.amount : 0), 0);
  }

  const owner = householdState.survivingOwner;
  const workerAmount = streams
    .filter(stream => stream.kind !== 'spousal' && stream.owner === owner && active(stream))
    .reduce((sum, stream) => sum + stream.amount, 0);
  const survivor = p.survival?.socialSecuritySurvivorBenefits?.[owner];
  const survivorAmount = survivor && active(survivor) ? survivor.amount : 0;
  return Math.max(workerAmount, survivorAmount);
}
