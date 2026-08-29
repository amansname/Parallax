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

function planEndRow(rows, label){
  const row = rows.at(-1) ?? null;
  if(!isFullyFundedRetirement(row)
      || !Number.isFinite(row.age)
      || !Number.isFinite(row.balance)
      || row.balance < 0){
    throw new Error(`${label} funded plan-end row is unavailable`);
  }
  return row;
}

function livingPlanEndAge(row){
  const people = row?.people;
  if(!people?.client) throw new Error('Typical plan-end household ages are unavailable');
  const modeled = [people.client, people.spouse].filter(person => person !== null && person !== undefined);
  if(modeled.some(person => !Number.isFinite(person.age) || typeof person.alive !== 'boolean')){
    throw new Error('Typical plan-end household ages are incomplete');
  }
  const livingAges = modeled.filter(person => person.alive).map(person => person.age);
  if(livingAges.length === 0) throw new Error('Typical plan-end living household age is unavailable');
  return Math.max(...livingAges);
}

function typicalHeader(typicalSimulation){
  const rows = rowsFor(typicalSimulation, 'Typical');
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
    fundedThroughAge = previous.age;
    fundedThroughSupport = 'Plan underfunded';
    endingPosition = firstUnderfunded.balance;
  }else{
    const ending = planEndRow(rows, 'Typical');
    fundedThroughAge = livingPlanEndAge(ending);
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

function drawdownTroughAge(digest, drawdown, label){
  if(drawdown === 0 && digest?.maxRealDrawdownTroughAge === null) return null;
  return finiteMetric(digest, 'maxRealDrawdownTroughAge', `${label} drawdown trough age`, {
    integer: true,
    min: 0,
  });
}

function recoveryFacts(digest, label){
  const status = digest?.portfolioRecoveryPeriodStatus;
  const years = digest?.portfolioRecoveryPeriodYears;
  if(status === 'never'){
    if(years !== null) throw new Error(`${label} unrecovered period is invalid`);
    return { status, years: null };
  }
  if(status === 'no-dip'){
    if(years !== 0) throw new Error(`${label} no-dip recovery period is invalid`);
    return { status, years: 0 };
  }
  if(status === 'recovered'){
    if(!Number.isInteger(years) || years < 1){
      throw new Error(`${label} recovered period is unavailable`);
    }
    return { status, years };
  }
  throw new Error(`${label} recovery-period status is unavailable`);
}

function fundingFacts(digest, label){
  const fundedThroughAge = finiteMetric(digest, 'fundedThroughAge', `${label} funded-through age`, {
    integer: true,
    min: 0,
  });
  const planEndAge = finiteMetric(digest, 'planEndAge', `${label} plan-end age`, {
    integer: true,
    min: 0,
  });
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
  return { fundedThroughAge, planEndAge, marginYears, marginKind };
}

function historicalHeader(historicalResult, typicalDigest){
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

  const historicalDrawdown = finiteMetric(
    historicalDigest,
    'maxRealDrawdownPct',
    'Historical max real drawdown',
    { min: 0, max: 100 }
  );
  const typicalDrawdown = finiteMetric(
    typicalDigest,
    'maxRealDrawdownPct',
    'Typical max real drawdown',
    { min: 0, max: 100 }
  );
  const historicalRecovery = recoveryFacts(historicalDigest, 'Historical');
  const typicalRecovery = recoveryFacts(typicalDigest, 'Typical');
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
  const historicalFunding = fundingFacts(historicalDigest, 'Historical');
  const typicalFunding = fundingFacts(typicalDigest, 'Typical');
  if(historicalFunding.planEndAge !== typicalFunding.planEndAge){
    throw new Error('Historical and Typical plan-end ages do not match');
  }

  return deepFreeze({
    kind: 'historical',
    outcome,
    rows: [
      {
        id: 'max-real-drawdown',
        label: 'Max real drawdown',
        format: 'drawdown',
        thisPath: historicalDrawdown,
        typicalPath: typicalDrawdown,
        delta: typicalDrawdown - historicalDrawdown,
        thisPathAge: drawdownTroughAge(historicalDigest, historicalDrawdown, 'Historical'),
        typicalPathAge: drawdownTroughAge(typicalDigest, typicalDrawdown, 'Typical'),
      },
      {
        id: 'years-above-6-wd-rate',
        label: 'Years above 6% WD rate',
        format: 'years',
        thisPath: finiteMetric(
          historicalDigest,
          'yearsAboveSixPctWdRate',
          'Historical years above 6% withdrawal rate',
          { integer: true, min: 0 }
        ),
        typicalPath: finiteMetric(
          typicalDigest,
          'yearsAboveSixPctWdRate',
          'Typical years above 6% withdrawal rate',
          { integer: true, min: 0 }
        ),
      },
      {
        id: 'recovery-period',
        label: 'Recovery period',
        format: 'recovery',
        thisPath: historicalRecovery.years,
        typicalPath: typicalRecovery.years,
        thisPathRecoveryStatus: historicalRecovery.status,
        typicalPathRecoveryStatus: typicalRecovery.status,
        delta: Number.isFinite(historicalRecovery.years) && Number.isFinite(typicalRecovery.years)
          ? historicalRecovery.years - typicalRecovery.years
          : historicalRecovery.status === 'never' && typicalRecovery.status === 'never'
            ? 0
            : null,
      },
      {
        id: 'balance-at-age-80',
        label: 'Real balance at age 80',
        format: 'money',
        thisPath: historicalAge80,
        typicalPath: typicalAge80,
        thisPathUnavailable: historicalAge80 === null
          ? (historicalFunding.marginKind === 'years-short'
              && historicalFunding.fundedThroughAge < 80
            ? 'Underfunded before 80'
            : 'Not modeled')
          : null,
        typicalPathUnavailable: typicalAge80 === null
          ? (typicalFunding.marginKind === 'years-short'
              && typicalFunding.fundedThroughAge < 80
            ? 'Underfunded before 80'
            : 'Not modeled')
          : null,
        delta: historicalAge80 !== null && typicalAge80 !== null
          ? historicalAge80 - typicalAge80
          : null,
      },
      {
        id: 'funded-through-margin',
        label: 'Funded through · margin',
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
        planEndAge: historicalFunding.planEndAge,
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
    return typicalHeader(typicalSimulation);
  }
  return historicalHeader(historicalResult, typicalDigest);
}
