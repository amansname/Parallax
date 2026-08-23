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

function exactRowForPlanYear(rows, planYear, label){
  if(!Number.isInteger(planYear)) throw new Error(`${label} plan-year index is unavailable`);
  const matches = rows.filter(row => row?.year === planYear);
  if(matches.length !== 1 || !isAuthoritative(matches[0])){
    throw new Error(`${label} exact plan-year row is unavailable`);
  }
  return matches[0];
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

function positiveFundedWithdrawalRates(rows, label){
  const rates = rows
    .filter(isFullyFundedRetirement)
    .map(row => row.wdRate)
    .filter(rate => Number.isFinite(rate) && rate > 0)
    .sort((a, b) => a - b);
  if(rates.length === 0) throw new Error(`${label} funded withdrawal rates are unavailable`);
  return rates;
}

function median(values){
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

function olderLivingAge(row){
  const people = row?.people;
  if(!people?.client) throw new Error('first-underfunded household ages are unavailable');
  const modeled = [people.client, people.spouse].filter(person => person !== null && person !== undefined);
  if(modeled.some(person => !Number.isFinite(person.age) || typeof person.alive !== 'boolean')){
    throw new Error('first-underfunded household ages are incomplete');
  }
  const livingAges = modeled.filter(person => person.alive).map(person => person.age);
  if(livingAges.length === 0) throw new Error('first-underfunded living household age is unavailable');
  return Math.max(...livingAges);
}

function typicalHeader(typicalSimulation, typicalDigest){
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
    fundedThroughAge = ending.age;
    endingPosition = ending.balance;
  }

  const peakWithdrawalRate = typicalDigest?.peakWdRate;
  const peakWithdrawalAge = typicalDigest?.peakWdAge;
  if(!Number.isFinite(peakWithdrawalRate) || peakWithdrawalRate < 0
      || (peakWithdrawalRate > 0 && !Number.isFinite(peakWithdrawalAge))){
    throw new Error('Typical peak withdrawal is unavailable');
  }

  return deepFreeze({
    kind: 'typical',
    outcome,
    fundedThroughAge,
    fundedThroughSupport,
    endingPosition,
    peakWithdrawalRate,
    peakWithdrawalAge: Number.isFinite(peakWithdrawalAge) ? peakWithdrawalAge : null,
  });
}

function successfulHistoricalHeader(historicalResult, typicalSimulation){
  const historicalRows = rowsFor(historicalResult?.simulation, 'Historical');
  const typicalRows = rowsFor(typicalSimulation, 'Typical');
  const historicalEnding = planEndRow(historicalRows, 'Historical');
  const typicalEnding = planEndRow(typicalRows, 'Typical');
  if(!Number.isFinite(historicalResult?.summary?.endingBalance)
      || Math.abs(historicalResult.summary.endingBalance - historicalEnding.balance) > 0.01){
    throw new Error('Historical ending portfolio does not match its plan-end row');
  }

  const historicalMedian = median(positiveFundedWithdrawalRates(historicalRows, 'Historical'));
  const typicalMedian = median(positiveFundedWithdrawalRates(typicalRows, 'Typical'));
  return deepFreeze({
    kind: 'historical',
    outcome: 'survives',
    rows: [
      {
        id: 'median-withdrawal-rate',
        label: 'Median withdrawal rate',
        format: 'percent',
        thisPath: historicalMedian,
        typicalPath: typicalMedian,
        delta: historicalMedian - typicalMedian,
      },
      {
        id: 'ending-portfolio',
        label: 'Ending portfolio',
        format: 'money',
        thisPath: historicalEnding.balance,
        typicalPath: typicalEnding.balance,
        delta: historicalEnding.balance - typicalEnding.balance,
      },
    ],
  });
}

function underfundedHistoricalHeader(historicalResult, typicalSimulation){
  const historicalRows = rowsFor(historicalResult?.simulation, 'Historical');
  const typicalRows = rowsFor(typicalSimulation, 'Typical');
  const retirementRows = historicalRows.filter(row => isAuthoritative(row) && isRetirement(row));
  const underfundedRows = retirementRows.filter(row => (
    Number.isFinite(row.fundingShortfall) && row.fundingShortfall > 0.01
  ));
  if(underfundedRows.length !== 1 || underfundedRows[0] !== retirementRows.at(-1)){
    throw new Error('Historical first-underfunded row is unavailable');
  }
  const firstUnderfunded = underfundedRows[0];
  const firstUnderfundedAge = olderLivingAge(firstUnderfunded);
  const firstUnderfundedPlanYear = firstUnderfunded.year;
  if(!Number.isInteger(firstUnderfundedPlanYear)){
    throw new Error('Historical first-underfunded plan-year index is unavailable');
  }

  const pressureRows = retirementRows.slice(0, 10)
    .filter(row => row !== firstUnderfunded)
    .filter(isFullyFundedRetirement)
    .filter(row => Number.isInteger(row.year) && Number.isFinite(row.wdRate) && row.wdRate > 0);
  if(pressureRows.length === 0){
    throw new Error('Historical early withdrawal pressure is unavailable');
  }
  const pressureRow = pressureRows.reduce((highest, row) => {
    if(!highest || row.wdRate > highest.wdRate) return row;
    if(row.wdRate === highest.wdRate && row.year < highest.year) return row;
    return highest;
  }, null);
  const typicalPressureRow = exactRowForPlanYear(
    typicalRows,
    pressureRow.year,
    'Typical early-pressure'
  );
  if(!isFullyFundedRetirement(typicalPressureRow) || !Number.isFinite(typicalPressureRow.wdRate)){
    throw new Error('Typical early-pressure row is unavailable');
  }

  const typicalBoundaryRow = exactRowForPlanYear(
    typicalRows,
    firstUnderfundedPlanYear,
    'Typical first-underfunded comparison'
  );
  if(!isRetirement(typicalBoundaryRow)
      || !Number.isFinite(firstUnderfunded.startBalance) || firstUnderfunded.startBalance < 0
      || !Number.isFinite(typicalBoundaryRow.startBalance) || typicalBoundaryRow.startBalance < 0){
    throw new Error('first-underfunded opening portfolio comparison is unavailable');
  }

  return deepFreeze({
    kind: 'historical',
    outcome: 'underfunded',
    firstUnderfundedPlanYear,
    rows: [
      {
        id: 'early-withdrawal-pressure',
        label: 'Early withdrawal pressure',
        format: 'percent',
        thisPath: pressureRow.wdRate,
        typicalPath: typicalPressureRow.wdRate,
        delta: pressureRow.wdRate - typicalPressureRow.wdRate,
        planYear: pressureRow.year,
      },
      {
        id: 'portfolio-at-underfunding',
        label: `Portfolio at age ${firstUnderfundedAge}`,
        format: 'money',
        thisPath: firstUnderfunded.startBalance,
        typicalPath: typicalBoundaryRow.startBalance,
        delta: firstUnderfunded.startBalance - typicalBoundaryRow.startBalance,
        planYear: firstUnderfundedPlanYear,
      },
      {
        id: 'first-underfunded-age',
        label: 'First underfunded age',
        format: 'age',
        thisPath: firstUnderfundedAge,
        typicalPath: null,
        delta: null,
        planYear: firstUnderfundedPlanYear,
      },
    ],
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
  if(historicalResult?.summary?.outcome === 'survives'){
    return successfulHistoricalHeader(historicalResult, typicalSimulation);
  }
  if(historicalResult?.summary?.outcome === 'underfunded'){
    return underfundedHistoricalHeader(historicalResult, typicalSimulation);
  }
  throw new Error('Historical outcome is unavailable');
}
