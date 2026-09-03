function deepFreeze(value){
  if(!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for(const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function rowsFor(simulation, label){
  if(!Array.isArray(simulation?.rows) || simulation.rows.length === 0){
    throw new Error(`${label} rows are unavailable`);
  }
  return simulation.rows;
}

function isAuthoritative(row){
  return row?.source != null;
}

function isRetirement(row){
  return row?.phase !== 'accum';
}

function isFullyFundedRetirement(row){
  return isAuthoritative(row)
    && isRetirement(row)
    && Number.isFinite(row.fundingShortfall)
    && row.fundingShortfall <= 0.01
    && row.failed !== true;
}

function planEndRow(rows, timelinePlanEndAge, label){
  const row = rows.at(-1) ?? null;
  if(!isFullyFundedRetirement(row)
      || !Number.isFinite(row.age)
      || row.age !== timelinePlanEndAge
      || !Number.isFinite(row.balance)
      || row.balance < 0){
    throw new Error(`${label} funded plan-end row is unavailable`);
  }
  return row;
}

function timelineRowAtAge(simulation, timelineAge, label, { authoritative = true } = {}){
  const matches = rowsFor(simulation, label).filter(row => (
    Number.isFinite(row?.age)
      && row.age === timelineAge
      && (!authoritative || isAuthoritative(row))
  ));
  if(matches.length !== 1){
    throw new Error(`${label} timeline row is unavailable`);
  }
  return matches[0];
}

function terminalSurvivorLens(typicalSimulation, timelinePlanEndAge){
  const rows = rowsFor(typicalSimulation, 'Typical plan-end');
  if(rows.at(-1)?.age !== timelinePlanEndAge){
    throw new Error('Typical digest and simulation plan-end ages do not match');
  }
  const row = timelineRowAtAge(
    typicalSimulation,
    timelinePlanEndAge,
    'Typical plan-end',
    { authoritative: false }
  );
  const people = row?.people;
  if(!people?.client) throw new Error('Typical plan-end household ages are unavailable');
  const modeled = [
    ['client', people.client],
    ['spouse', people.spouse],
  ].filter(([, person]) => person !== null && person !== undefined);
  if(modeled.some(([, person]) => !Number.isFinite(person.age) || typeof person.alive !== 'boolean')){
    throw new Error('Typical plan-end household ages are incomplete');
  }
  const living = modeled.filter(([, person]) => person.alive);
  if(living.length === 0) throw new Error('Typical plan-end living household age is unavailable');
  const maxLivingAge = Math.max(...living.map(([, person]) => person.age));
  const [personKey, person] = living.find(([, candidate]) => candidate.age === maxLivingAge);
  const ageOffset = person.age - timelinePlanEndAge;
  if(!Number.isInteger(person.age) || person.age < 0 || !Number.isInteger(ageOffset)){
    throw new Error('Typical plan-end survivor age lens is invalid');
  }
  return { personKey, ageOffset, planEndAge: person.age };
}

function translateTimelineAge(simulation, timelineAge, lens, label, options = {}){
  const row = timelineRowAtAge(simulation, timelineAge, label, options);
  const person = row?.people?.[lens.personKey];
  if(!person || !Number.isFinite(person.age) || typeof person.alive !== 'boolean'){
    throw new Error(`${label} terminal survivor is unavailable`);
  }
  const expectedAge = timelineAge + lens.ageOffset;
  if(!Number.isInteger(person.age) || person.age < 0 || person.age !== expectedAge){
    throw new Error(`${label} terminal-survivor age is inconsistent`);
  }
  if(!person.alive){
    throw new Error(`${label} terminal survivor is not living`);
  }
  return person.age;
}

function oldestLivingAgeAtTimelineAge(simulation, timelineAge, label){
  const row = timelineRowAtAge(simulation, timelineAge, label);
  const people = row?.people;
  if(!people?.client) throw new Error(`${label} household ages are unavailable`);
  const modeled = [people.client, people.spouse]
    .filter(person => person !== null && person !== undefined);
  if(modeled.some(person => !Number.isFinite(person.age) || typeof person.alive !== 'boolean')){
    throw new Error(`${label} household ages are incomplete`);
  }
  const livingAges = modeled.filter(person => person.alive).map(person => person.age);
  if(livingAges.length === 0) throw new Error(`${label} living household age is unavailable`);
  return Math.max(...livingAges);
}

function typicalHeader(typicalSimulation, typicalDigest){
  const rows = rowsFor(typicalSimulation, 'Typical');
  const timelinePlanEndAge = rows.at(-1)?.age;
  if(!Number.isInteger(timelinePlanEndAge) || timelinePlanEndAge < 0){
    throw new Error('Typical plan-end age is unavailable');
  }
  if(Object.prototype.hasOwnProperty.call(typicalDigest ?? {}, 'planEndAge')){
    const digestPlanEndAge = finiteMetric(
      typicalDigest,
      'planEndAge',
      'Typical plan-end age',
      { integer: true, min: 0 }
    );
    if(digestPlanEndAge !== timelinePlanEndAge){
      throw new Error('Typical digest and simulation plan-end ages do not match');
    }
  }
  const ageLens = terminalSurvivorLens(typicalSimulation, timelinePlanEndAge);
  const realRows = rows.filter(isAuthoritative);
  const underfundedRows = realRows.filter(row => (
    isRetirement(row)
      && Number.isFinite(row.fundingShortfall)
      && row.fundingShortfall > 0.01
  ));
  if(underfundedRows.length > 1){
    throw new Error('Typical first-underfunded boundary is ambiguous');
  }

  const firstUnderfunded = underfundedRows[0] ?? null;
  let outcome = 'survives';
  let fundedThroughAge;
  let fundedThroughSupport = 'Plan end';
  let endingPosition;

  if(firstUnderfunded){
    if(firstUnderfunded !== realRows.at(-1)){
      throw new Error('Typical first-underfunded boundary is not final');
    }
    const boundaryIndex = rows.indexOf(firstUnderfunded);
    const previous = rows.slice(0, boundaryIndex).reverse().find(row => (
      isFullyFundedRetirement(row) && Number.isFinite(row.age)
    ));
    if(!previous) throw new Error('Typical last funded age is unavailable');
    if(!Number.isFinite(firstUnderfunded.balance) || firstUnderfunded.balance < 0){
      throw new Error('Typical underfunded ending position is unavailable');
    }
    outcome = 'underfunded';
    fundedThroughAge = translateTimelineAge(
      typicalSimulation,
      previous.age,
      ageLens,
      'Typical funded-through'
    );
    fundedThroughSupport = 'Plan underfunded';
    endingPosition = firstUnderfunded.balance;
  }else{
    const ending = planEndRow(rows, timelinePlanEndAge, 'Typical');
    fundedThroughAge = translateTimelineAge(
      typicalSimulation,
      ending.age,
      ageLens,
      'Typical plan-end',
      { authoritative: false }
    );
    endingPosition = ending.balance;
  }

  return deepFreeze({
    kind: 'typical',
    outcome,
    fundedThroughAge,
    fundedThroughSupport,
    endingPosition,
  });
}

function finiteMetric(digest, key, label, { integer = false, min = 0, max = Infinity } = {}){
  const value = digest?.[key];
  if(!Number.isFinite(value)
      || (integer && !Number.isInteger(value))
      || value < min
      || value > max){
    throw new Error(`${label} is unavailable`);
  }
  return value;
}

function optionalFiniteMetric(digest, key, label, options = {}){
  if(digest?.[key] === null) return null;
  return finiteMetric(digest, key, label, options);
}

function earlyBalanceFacts(digest, label){
  const balance = finiteMetric(
    digest,
    'lowestRealBalanceFirst10Years',
    `${label} first-decade low balance`,
    { min: 0 }
  );
  const age = finiteMetric(digest, 'lowestRealBalanceFirst10Age', `${label} first-decade low age`, {
    integer: true,
    min: 0,
  });
  return { balance, age };
}

function effectiveWithdrawalRateFacts(digest, label){
  const average = finiteMetric(
    digest,
    'avgEffectiveWdRate',
    `${label} average effective withdrawal rate`,
    { min: 0 }
  );
  return { average };
}

function recoveryFacts(digest, simulation, label){
  const status = digest?.marketRecoveryPeriodStatus;
  const years = digest?.marketRecoveryPeriodYears;
  const age = digest?.marketRecoveryAge;
  if(status === 'never' || status === 'not-observed'){
    if(years !== null || age !== null) throw new Error(`${label} unrecovered period is invalid`);
    return { status, years: null, age: null };
  }
  if(status === 'no-dip'){
    if(years !== 0 || age !== null) throw new Error(`${label} no-dip recovery period is invalid`);
    return { status, years: 0, age: null };
  }
  if(status === 'recovered'){
    if(!Number.isInteger(years) || years < 1){
      throw new Error(`${label} recovered period is unavailable`);
    }
    if(!Number.isInteger(age) || age < 0){
      throw new Error(`${label} recovery age is unavailable`);
    }
    return {
      status,
      years,
      age: oldestLivingAgeAtTimelineAge(simulation, age, `${label} recovery`),
    };
  }
  throw new Error(`${label} recovery-period status is unavailable`);
}

function recoveryDelta(historical, typical){
  if(Number.isFinite(historical.years) && Number.isFinite(typical.years)){
    return historical.years - typical.years;
  }
  if(historical.status === typical.status && ['never', 'not-observed'].includes(historical.status)){
    return 0;
  }
  return null;
}

function fundingFacts(digest, simulation, ageLens, label){
  const timelineFundedThroughAge = finiteMetric(digest, 'fundedThroughAge', `${label} funded-through age`, {
    integer: true,
    min: 0,
  });
  const fundedThroughAge = translateTimelineAge(
    simulation,
    timelineFundedThroughAge,
    ageLens,
    `${label} funded-through`
  );
  const marginKind = digest?.fundingMarginKind;
  if(!['zero-return-runway', 'years-short', 'no-portfolio-draw'].includes(marginKind)){
    throw new Error(`${label} funding-margin kind is unavailable`);
  }
  const marginYears = optionalFiniteMetric(
    digest,
    'fundingMarginYears',
    `${label} funding margin`,
    { min: marginKind === 'years-short' ? -Infinity : 0 }
  );
  if(marginKind === 'years-short' && !(marginYears <= 0)){
    throw new Error(`${label} years-short margin is invalid`);
  }
  if(marginKind === 'no-portfolio-draw' && marginYears !== null){
    throw new Error(`${label} no-draw funding margin is invalid`);
  }
  if(marginKind === 'zero-return-runway' && marginYears === null){
    throw new Error(`${label} zero-return runway is unavailable`);
  }
  return {
    fundedThroughAge,
    timelineFundedThroughAge,
    marginYears,
    marginKind,
  };
}

function historicalHeader(historicalResult, typicalSimulation, typicalDigest){
  const historicalDigest = historicalResult?.digest;
  if(!historicalDigest || typeof historicalDigest !== 'object'){
    throw new Error('Historical path digest is unavailable');
  }
  if(!typicalDigest || typeof typicalDigest !== 'object'){
    throw new Error('Typical path digest is unavailable');
  }
  const outcome = historicalResult?.summary?.outcome;
  if(!['survives', 'underfunded'].includes(outcome)){
    throw new Error('Historical outcome is unavailable');
  }
  const historicalPlanEndAge = finiteMetric(
    historicalDigest,
    'planEndAge',
    'Historical plan-end age',
    { integer: true, min: 0 }
  );
  const typicalPlanEndAge = finiteMetric(
    typicalDigest,
    'planEndAge',
    'Typical plan-end age',
    { integer: true, min: 0 }
  );
  if(historicalPlanEndAge !== typicalPlanEndAge){
    throw new Error('Historical and Typical plan-end ages do not match');
  }
  const ageLens = terminalSurvivorLens(typicalSimulation, typicalPlanEndAge);

  const historicalEarlyBalance = earlyBalanceFacts(historicalDigest, 'Historical');
  const typicalEarlyBalance = earlyBalanceFacts(typicalDigest, 'Typical');
  const historicalEffectiveWithdrawal = effectiveWithdrawalRateFacts(historicalDigest, 'Historical');
  const typicalEffectiveWithdrawal = effectiveWithdrawalRateFacts(typicalDigest, 'Typical');
  const historicalRecovery = recoveryFacts(
    historicalDigest,
    historicalResult?.simulation,
    'Historical'
  );
  const typicalRecovery = recoveryFacts(typicalDigest, typicalSimulation, 'Typical');
  const historicalAge80 = optionalFiniteMetric(
    historicalDigest,
    'realBalanceAtAge80',
    'Historical real balance at age 80',
    { min: 0 }
  );
  const typicalAge80 = optionalFiniteMetric(
    typicalDigest,
    'realBalanceAtAge80',
    'Typical real balance at age 80',
    { min: 0 }
  );
  const historicalFunding = fundingFacts(
    historicalDigest,
    historicalResult?.simulation,
    ageLens,
    'Historical'
  );
  const typicalFunding = fundingFacts(typicalDigest, typicalSimulation, ageLens, 'Typical');

  return deepFreeze({
    kind: 'historical',
    outcome,
    rows: [
      {
        id: 'lowest-balance-first-10-years',
        label: '10-year Low',
        format: 'money',
        thisPath: historicalEarlyBalance.balance,
        typicalPath: typicalEarlyBalance.balance,
        delta: historicalEarlyBalance.balance - typicalEarlyBalance.balance,
        thisPathAge: historicalEarlyBalance.age,
        typicalPathAge: typicalEarlyBalance.age,
      },
      {
        id: 'average-effective-withdrawal-rate',
        label: 'Effective WD Rate',
        format: 'percentage',
        thisPath: historicalEffectiveWithdrawal.average,
        typicalPath: typicalEffectiveWithdrawal.average,
        delta: historicalEffectiveWithdrawal.average - typicalEffectiveWithdrawal.average,
      },
      {
        id: 'recovery-period',
        label: 'Recovery',
        format: 'recovery',
        thisPath: historicalRecovery.years,
        typicalPath: typicalRecovery.years,
        thisPathRecoveryStatus: historicalRecovery.status,
        typicalPathRecoveryStatus: typicalRecovery.status,
        thisPathRecoveryAge: historicalRecovery.age,
        typicalPathRecoveryAge: typicalRecovery.age,
        delta: recoveryDelta(historicalRecovery, typicalRecovery),
      },
      {
        id: 'balance-at-age-80',
        label: 'Age 80',
        format: 'money',
        thisPath: historicalAge80,
        typicalPath: typicalAge80,
        thisPathUnavailable: historicalAge80 === null
          ? (historicalFunding.marginKind === 'years-short'
              && historicalFunding.timelineFundedThroughAge < 80
            ? 'Underfunded before 80'
            : 'Not modeled')
          : null,
        typicalPathUnavailable: typicalAge80 === null
          ? (typicalFunding.marginKind === 'years-short'
              && typicalFunding.timelineFundedThroughAge < 80
            ? 'Underfunded before 80'
            : 'Not modeled')
          : null,
        delta: historicalAge80 !== null && typicalAge80 !== null
          ? historicalAge80 - typicalAge80
          : null,
      },
      {
        id: 'funded-through-margin',
        label: 'Funded through',
        description: 'If funded through plan end, margin is zero-return years at the final modeled portfolio draw; otherwise it is years short of plan end.',
        format: 'funding',
        thisPath: historicalFunding.fundedThroughAge,
        typicalPath: typicalFunding.fundedThroughAge,
        delta: historicalFunding.fundedThroughAge - typicalFunding.fundedThroughAge,
        marginDelta: historicalFunding.marginYears !== null && typicalFunding.marginYears !== null
          ? historicalFunding.marginYears - typicalFunding.marginYears
          : null,
        thisPathMargin: historicalFunding.marginYears,
        typicalPathMargin: typicalFunding.marginYears,
        thisPathMarginKind: historicalFunding.marginKind,
        typicalPathMarginKind: typicalFunding.marginKind,
        planEndAge: ageLens.planEndAge,
      },
    ].map(row => {
      if(row.delta === undefined && Number.isFinite(row.thisPath) && Number.isFinite(row.typicalPath)){
        return { ...row, delta: row.thisPath - row.typicalPath };
      }
      return row;
    }),
  });
}

export function buildCashFlowHeaderMetrics({
  historicalResult = null,
  typicalSimulation,
  typicalDigest,
}){
  if(!historicalResult){
    return typicalHeader(typicalSimulation, typicalDigest);
  }
  return historicalHeader(historicalResult, typicalSimulation, typicalDigest);
}
