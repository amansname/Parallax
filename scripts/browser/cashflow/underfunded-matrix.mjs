export async function verifyUnderfundedMatrix({
  page,
  observedHistoricalOutcomes
}) {
  const underfundedMatrixProof = await page.evaluate(async () => {
    const [{
      createCashFlowController
    }, {
      ASSET_KEYS,
      defaultPlan,
      pathDigest,
      resolveInputs,
      runSinglePath
    }, {
      renderCashflow
    }, {
      snapshotLegacyRiskProfileAllocation
    }] = await Promise.all([
      import('./src/scenarios/createCashFlowController.js'),
      import('./engine.js'),
      import('./ui/cashflow.js'),
      import('./src/household/investmentAllocation.js')
    ]);
    const typicalSimulation = {
      simIndex: 7,
      rows: [{
        year: 1,
        age: 95,
        phase: 'ret',
        source: 1995,
        startBalance: 700000,
        balance: 650000,
        withdrawal: 28000,
        fundingShortfall: 0,
        failed: false,
        wdRate: 4,
        effectiveWdRate: 4,
        returnDollars: 0,
        taxes: 0,
        people: { client: { age: 95, alive: true }, spouse: { age: 92, alive: true } }
      }, {
        year: 2,
        age: 98,
        phase: 'ret',
        source: 1996,
        startBalance: 650000,
        balance: 700000,
        withdrawal: 32500,
        fundingShortfall: 0,
        failed: false,
        wdRate: 5,
        effectiveWdRate: 5,
        returnDollars: 0,
        taxes: 0,
        people: { client: { age: 98, alive: false }, spouse: { age: 95, alive: true } }
      }]
    };
    const historicalRows = [{
      year: 1,
      age: 95,
      phase: 'ret',
      source: 1973,
      startBalance: 90000,
      balance: 50000,
      fundingShortfall: 0,
      failed: false,
      wdRate: 6,
      effectiveWdRate: 6,
      returnDollars: 0,
      taxes: 0,
      people: { client: { age: 95, alive: true }, spouse: { age: 92, alive: true } }
    }, {
      year: 2,
      age: 96,
      phase: 'ret',
      source: 1974,
      startBalance: 50000,
      balance: 0,
      fundingShortfall: 20000,
      failed: true,
      wdRate: 100,
      effectiveWdRate: 100,
      returnDollars: 0,
      taxes: 0,
      people: {
        client: {
          age: 96,
          alive: false
        },
        spouse: {
          age: 93,
          alive: true
        }
      }
    }];
    const scenario = {
      base: true,
      name: 'Browser underfunded proof',
      res: {
        sims: [typicalSimulation],
        paths: {
          p50: {
            simIndex: 7
          }
        }
      }
    };
    const plan = {
      meta: {
        planningAsOfYear: 2026
      },
      household: {
        primary: {
          currentAge: 65
        }
      },
      goals: []
    };
    const historical = {
      kind: 'historical',
      pathId: 'historical-1973',
      simulation: {
        rows: historicalRows
      },
      summary: {
        outcome: 'underfunded'
      },
      digest: {
        lowestRealBalanceFirst10Years: 0,
        lowestRealBalanceFirst10Age: 96,
        yearsAboveFivePctWdRateFirst10Years: 2,
        yearsAboveFivePctEffectiveWdRateFirst10Years: 2,
        avgEffectiveWdRate: 53,
        earlyWindowYears: 2,
        marketRecoveryPeriodStatus: 'not-observed',
        marketRecoveryPeriodYears: null,
        marketRecoveryAge: null,
        realBalanceAtAge80: null,
        fundedThroughAge: 95,
        planEndAge: 98,
        fundingMarginYears: -3,
        fundingMarginKind: 'years-short'
      },
      taxScope: 'MODELED_FEDERAL_LINE_24'
    };
    const buildRows = simulation => simulation.rows.map(row => ({
      year: 2025 + row.year,
      age: row.age,
      livingAge: Math.max(...[row.people?.client, row.people?.spouse]
        .filter(person => person?.alive === true)
        .map(person => person.age)),
      sourceYear: row.source,
      accum: row.phase === 'accum',
      ret: 0,
      income: 0,
      rmd: 0,
      essential: 20000,
      goals: 0,
      tax: row.taxes,
      draw: 20000,
      wdRate: row.wdRate,
      effectiveWdRate: row.effectiveWdRate,
      returnDollars: row.returnDollars,
      ending: row.balance,
      fundingShortfall: row.fundingShortfall,
      shortfall: row.fundingShortfall > 0.01,
      startPort: row.startBalance,
      goalTag: null
    }));
    const selection = {
      id: 'historical-1973'
    };
    const typicalDigest = {
      lowestRealBalanceFirst10Years: 650000,
      lowestRealBalanceFirst10Age: 95,
      yearsAboveFivePctWdRateFirst10Years: 0,
      yearsAboveFivePctEffectiveWdRateFirst10Years: 0,
      avgEffectiveWdRate: 4.5,
      earlyWindowYears: 2,
      marketRecoveryPeriodStatus: 'recovered',
      marketRecoveryPeriodYears: 1,
      marketRecoveryAge: 98,
      realBalanceAtAge80: null,
      fundedThroughAge: 98,
      planEndAge: 98,
      fundingMarginYears: 18.46153846153846,
      fundingMarginKind: 'zero-return-runway'
    };
    const controller = createCashFlowController({
      getScenarios: () => [scenario],
      scenarioInputsByResult: new WeakMap([[scenario.res, {
        plan,
        overrides: {}
      }]]),
      selection,
      historicalCache: {
        get: () => historical,
        peek: args => args.analysis === scenario.res && args.periodId === selection.id ? historical : null
      },
      buildRows,
      digest: () => typicalDigest
    });
    const liveStatus = document.querySelector('#cashflow-path-status');
    const scenarioPage = document.querySelector('.page[data-page="scenarios"]');
    if (!liveStatus || !scenarioPage) throw new Error('Cash Flow status host is unavailable');
    liveStatus.id = 'cashflow-path-status-live';
    const status = document.createElement('span');
    status.id = 'cashflow-path-status';
    status.className = 'cashflow-path-status';
    status.hidden = true;
    const select = document.createElement('select');
    const host = document.createElement('div');
    scenarioPage.append(status, select, host);
    try {
      controller.syncSelect(select, scenario);
      const selected = controller.resultForScenario(scenario);
      const display = {
        raw: scenario,
        id: 'browser-underfunded-proof',
        name: scenario.name,
        tone: '#c6a662',
        prob: 0,
        probStr: '0',
        median: '$0'
      };
      const renderSelected = result => {
        host.innerHTML = renderCashflow(display, [display], {
          cashFlowResult: () => result,
          pathRows: () => [],
          cashSummary: () => ({}),
          cashFromRetirement: false,
          isTypicalPath: () => false,
          typicalPathFederalTax: () => null,
          pathFederalTax: () => null,
          wdColor: () => 'inherit',
          num: value => String(value),
          esc: value => String(value),
          fmtMoney: value => '$' + Math.round(value).toLocaleString('en-US'),
          cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending']
        });
      };
      const readRecovery = () => {
        const recovery = host.querySelector('[data-historical-metric="recovery-period"]');
        const recoveryReference = host.querySelector('[data-path-reference-metric="recovery-period"]');
        const delta = recovery?.querySelector('.cf-path-rail__delta');
        return {
          reference: recoveryReference?.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || '',
          figure: recovery?.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
          delta: delta?.textContent.trim() || '',
          tone: recovery?.dataset.deltaTone || '',
          referenceFontSize: recoveryReference ? getComputedStyle(recoveryReference.querySelector('.cf-path-rail__reference-value')).fontSize : '',
          figureFontSize: recovery ? getComputedStyle(recovery.querySelector('.cf-path-rail__figure')).fontSize : '',
          deltaMinHeight: delta ? getComputedStyle(delta).minHeight : '',
          deltaHeight: delta?.getBoundingClientRect().height ?? 0
        };
      };
      const readFunding = () => {
        const funding = host.querySelector('[data-historical-metric="funded-through-margin"]');
        const fundingReference = host.querySelector('[data-path-reference-metric="funded-through-margin"]');
        return {
          reference: fundingReference?.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || '',
          figure: funding?.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
          delta: funding?.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
          planEndAge: Number(funding?.dataset.planEndAge),
          thisPath: Number(funding?.dataset.thisPath),
          typicalPath: Number(funding?.dataset.typicalPath)
        };
      };
      const readEffectiveWithdrawalRate = () => {
        const metric = host.querySelector('[data-historical-metric="average-effective-withdrawal-rate"]');
        const reference = host.querySelector('[data-path-reference-metric="average-effective-withdrawal-rate"]');
        return {
          reference: reference?.querySelector('.cf-path-rail__reference-value')?.textContent.trim() || '',
          figure: metric?.querySelector('.cf-path-rail__figure')?.textContent.trim() || '',
          delta: metric?.querySelector('.cf-path-rail__delta')?.textContent.trim() || '',
          tone: metric?.dataset.deltaTone || ''
        };
      };
      renderSelected(selected);
      const summary = host.querySelector('[data-cash-path-metrics]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--neg)';
      scenarioPage.appendChild(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const recovery = readRecovery();
      const funding = readFunding();
      renderSelected({
        ...selected,
        headerMetrics: {
          ...selected.headerMetrics,
          rows: selected.headerMetrics.rows.map(metric => metric.id === 'recovery-period' ? {
            ...metric,
            thisPath: 0,
            typicalPath: null,
            delta: null,
            thisPathRecoveryStatus: 'no-dip',
            typicalPathRecoveryStatus: 'not-observed',
            thisPathRecoveryAge: null,
            typicalPathRecoveryAge: null
          } : metric)
        }
      });
      const reverseRecovery = readRecovery();
      const noCapitalPlan = structuredClone(defaultPlan);
      noCapitalPlan.meta = {
        ...noCapitalPlan.meta,
        planningAsOfYear: 2026,
        spendingSchemaVersion: 1
      };
      noCapitalPlan.household.primary = {
        currentAge: 64,
        retirementAge: 65,
        planEndAge: 65
      };
      noCapitalPlan.household.spouse = null;
      const noCapitalAllocation = snapshotLegacyRiskProfileAllocation(
        noCapitalPlan.portfolio.riskProfile
      );
      noCapitalPlan.portfolio.accounts = {
        taxable: { balance: 0, basisPct: 1, investmentAllocation: noCapitalAllocation },
        traditional: { balance: 0, investmentAllocation: noCapitalAllocation },
        roth: { balance: 0, investmentAllocation: noCapitalAllocation }
      };
      noCapitalPlan.portfolio.extraAccounts = [];
      noCapitalPlan.expenses = {
        living: 0,
        housing: 0,
        debt: 0,
        healthcare: 0,
        extra: [],
        healthcareRealGrowth: 0
      };
      noCapitalPlan.income.socialSecurity.primary = { pia: 0, claimAge: 67 };
      noCapitalPlan.income.socialSecurity.spouse = null;
      noCapitalPlan.income.other = [];
      noCapitalPlan.income.pension = { benefitByAge: {}, base: 0, startAge: 65, colaPct: 0 };
      noCapitalPlan.goals = [{
        name: 'Required spending',
        system: 'essentials',
        amount: 20000,
        startAge: 65,
        endAge: 65,
        realGrowth: 0
      }];
      noCapitalPlan.taxes = { ordinary: 0, capitalGains: 0 };
      const noCapitalInputs = resolveInputs(noCapitalPlan, {});
      const noCapitalReturnRow = sourceYear => ({
        y: sourceYear,
        ...Object.fromEntries(ASSET_KEYS.map(key => [key, 0]))
      });
      const noCapitalSimulation = (simIndex, sourceYear) => ({
        ...runSinglePath(noCapitalInputs, [
          noCapitalReturnRow(sourceYear - 1),
          noCapitalReturnRow(sourceYear)
        ]),
        simIndex
      });
      const noCapitalTypicalSimulation = noCapitalSimulation(9, 1995);
      const noCapitalHistoricalSimulation = noCapitalSimulation(10, 1973);
      const noCapitalScenario = {
        base: true,
        name: 'Browser no-capital proof',
        res: {
          sims: [noCapitalTypicalSimulation],
          paths: { p50: { simIndex: 9 } }
        }
      };
      const noCapitalHistorical = {
        kind: 'historical',
        pathId: 'historical-1973',
        simulation: noCapitalHistoricalSimulation,
        summary: { outcome: 'underfunded' },
        digest: pathDigest(noCapitalHistoricalSimulation),
        taxScope: 'MODELED_FEDERAL_LINE_24'
      };
      const noCapitalController = createCashFlowController({
        getScenarios: () => [noCapitalScenario],
        scenarioInputsByResult: new WeakMap([[noCapitalScenario.res, {
          plan: noCapitalPlan,
          overrides: {}
        }]]),
        selection: { id: 'historical-1973' },
        historicalCache: {
          get: () => noCapitalHistorical,
          peek: () => noCapitalHistorical
        },
        buildRows,
        digest: pathDigest
      });
      const noCapitalSelected = noCapitalController.resultForScenario(noCapitalScenario);
      renderSelected(noCapitalSelected);
      const noCapitalEffectiveWithdrawalRate = readEffectiveWithdrawalRate();
      return {
        outcome: summary?.dataset.outcome || '',
        metrics: [...host.querySelectorAll('[data-historical-metric]')].map(metric => metric.dataset.historicalMetric),
        glyph: status.textContent.trim(),
        statusClass: status.className,
        statusColor: getComputedStyle(status).color,
        expectedColor,
        recovery,
        reverseRecovery,
        noCapitalEffectiveWithdrawalRate,
        noCapitalEngineRates: {
          historicalAnnual: noCapitalHistoricalSimulation.rows[1].effectiveWdRate,
          typicalAnnual: noCapitalTypicalSimulation.rows[1].effectiveWdRate,
          historical: noCapitalHistorical.digest.avgEffectiveWdRate,
          typical: pathDigest(noCapitalTypicalSimulation).avgEffectiveWdRate,
          controllerHistorical: noCapitalSelected.headerMetrics.rows[1].thisPath,
          controllerTypical: noCapitalSelected.headerMetrics.rows[1].typicalPath
        },
        funding,
        rawTypicalTerminalAge: typicalSimulation.rows.at(-1).age,
        rawHistoricalFundedThroughAge: historical.digest.fundedThroughAge
      };
    } finally {
      host.remove();
      select.remove();
      status.remove();
      liveStatus.id = 'cashflow-path-status';
    }
  });
  if (underfundedMatrixProof.outcome !== 'underfunded' || JSON.stringify(underfundedMatrixProof.metrics) !== JSON.stringify(['lowest-balance-first-10-years', 'average-effective-withdrawal-rate', 'recovery-period', 'balance-at-age-80', 'funded-through-margin']) || underfundedMatrixProof.recovery.reference !== '1 yr · Age 95' || underfundedMatrixProof.recovery.figure !== 'Not observed' || underfundedMatrixProof.recovery.delta !== '' || underfundedMatrixProof.recovery.tone !== 'muted' || underfundedMatrixProof.recovery.referenceFontSize !== '15px' || underfundedMatrixProof.recovery.figureFontSize !== '22px' || underfundedMatrixProof.recovery.deltaMinHeight !== '12px' || underfundedMatrixProof.recovery.deltaHeight < 12 || underfundedMatrixProof.reverseRecovery.reference !== 'Not observed' || underfundedMatrixProof.reverseRecovery.figure !== '0 yrs' || underfundedMatrixProof.reverseRecovery.delta !== '' || underfundedMatrixProof.reverseRecovery.tone !== 'muted' || underfundedMatrixProof.reverseRecovery.referenceFontSize !== '15px' || underfundedMatrixProof.reverseRecovery.figureFontSize !== '22px' || underfundedMatrixProof.reverseRecovery.deltaMinHeight !== '12px' || underfundedMatrixProof.reverseRecovery.deltaHeight < 12 || Object.values(underfundedMatrixProof.noCapitalEngineRates).some(value => value !== null) || underfundedMatrixProof.noCapitalEffectiveWithdrawalRate.reference !== 'Not modeled' || underfundedMatrixProof.noCapitalEffectiveWithdrawalRate.figure !== 'Not modeled' || underfundedMatrixProof.noCapitalEffectiveWithdrawalRate.delta !== '' || underfundedMatrixProof.noCapitalEffectiveWithdrawalRate.tone !== 'muted' || underfundedMatrixProof.funding.reference !== 'Age 95' || underfundedMatrixProof.funding.figure !== 'Age 92' || underfundedMatrixProof.funding.delta !== '\u22123 yrs' || underfundedMatrixProof.funding.planEndAge !== 95 || underfundedMatrixProof.funding.thisPath !== 92 || underfundedMatrixProof.funding.typicalPath !== 95 || underfundedMatrixProof.rawTypicalTerminalAge !== 98 || underfundedMatrixProof.rawHistoricalFundedThroughAge !== 95 || underfundedMatrixProof.glyph !== '!' || !/is-underfunded/.test(underfundedMatrixProof.statusClass) || underfundedMatrixProof.statusColor !== underfundedMatrixProof.expectedColor) {
    throw new Error(`controlled underfunded Historical matrix is incomplete: ${JSON.stringify(underfundedMatrixProof)}`);
  }
  observedHistoricalOutcomes.add(underfundedMatrixProof.outcome);
  if (JSON.stringify([...observedHistoricalOutcomes].sort()) !== JSON.stringify(['survives', 'underfunded'])) {
    throw new Error(`Cash Flow verifier did not observe both locked Historical outcomes: ${JSON.stringify([...observedHistoricalOutcomes])}`);
  }
}
