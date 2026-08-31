export async function verifyUnderfundedMatrix({
  page,
  observedHistoricalOutcomes
}) {
  const underfundedMatrixProof = await page.evaluate(async () => {
    const [{
      createCashFlowController
    }, {
      renderCashflow
    }] = await Promise.all([import('./src/scenarios/createCashFlowController.js'), import('./ui/cashflow.js')]);
    const typicalSimulation = {
      simIndex: 7,
      rows: [{
        year: 1,
        age: 65,
        phase: 'ret',
        source: 1995,
        startBalance: 700000,
        balance: 650000,
        withdrawal: 28000,
        fundingShortfall: 0,
        failed: false,
        wdRate: 4,
        taxes: 0
      }, {
        year: 2,
        age: 66,
        phase: 'ret',
        source: 1996,
        startBalance: 650000,
        balance: 700000,
        withdrawal: 32500,
        fundingShortfall: 0,
        failed: false,
        wdRate: 5,
        taxes: 0
      }]
    };
    const historicalRows = [{
      year: 1,
      age: 65,
      phase: 'ret',
      source: 1973,
      startBalance: 90000,
      balance: 50000,
      fundingShortfall: 0,
      failed: false,
      wdRate: 6,
      taxes: 0
    }, {
      year: 2,
      age: 66,
      phase: 'ret',
      source: 1974,
      startBalance: 50000,
      balance: 0,
      fundingShortfall: 20000,
      failed: true,
      wdRate: 100,
      taxes: 0,
      people: {
        client: {
          age: 66,
          alive: true
        },
        spouse: null
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
        maxRealDrawdownPct: 100,
        maxRealDrawdownTroughAge: 66,
        yearsAboveSixPctWdRate: 1,
        portfolioUnderwaterYearsMax: 2,
        portfolioRecoveryPeriodStatus: 'never',
        portfolioRecoveryPeriodYears: null,
        realBalanceAtAge80: null,
        fundedThroughAge: 65,
        planEndAge: 66,
        fundingMarginYears: -1,
        fundingMarginKind: 'years-short'
      },
      taxScope: 'MODELED_FEDERAL_LINE_24'
    };
    const buildRows = simulation => simulation.rows.map(row => ({
      year: 2025 + row.year,
      age: row.age,
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
      ending: row.balance,
      fundingShortfall: row.fundingShortfall,
      shortfall: row.fundingShortfall > 0.01,
      startPort: row.startBalance,
      goalTag: null
    }));
    const selection = {
      id: 'historical-1973'
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
      digest: () => ({
        maxRealDrawdownPct: 7.142857142857143,
        maxRealDrawdownTroughAge: 65,
        yearsAboveSixPctWdRate: 0,
        portfolioUnderwaterYearsMax: 1,
        portfolioRecoveryPeriodStatus: 'recovered',
        portfolioRecoveryPeriodYears: 1,
        realBalanceAtAge80: null,
        fundedThroughAge: 66,
        planEndAge: 66,
        fundingMarginYears: 18.46153846153846,
        fundingMarginKind: 'zero-return-runway'
      })
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
          cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending']
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
      renderSelected(selected);
      const summary = host.querySelector('[data-cash-path-metrics]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--neg)';
      scenarioPage.appendChild(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const recovery = readRecovery();
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
            typicalPathRecoveryStatus: 'never'
          } : metric)
        }
      });
      const reverseRecovery = readRecovery();
      return {
        outcome: summary?.dataset.outcome || '',
        metrics: [...host.querySelectorAll('[data-historical-metric]')].map(metric => metric.dataset.historicalMetric),
        glyph: status.textContent.trim(),
        statusClass: status.className,
        statusColor: getComputedStyle(status).color,
        expectedColor,
        recovery,
        reverseRecovery
      };
    } finally {
      host.remove();
      select.remove();
      status.remove();
      liveStatus.id = 'cashflow-path-status';
    }
  });
  if (underfundedMatrixProof.outcome !== 'underfunded' || JSON.stringify(underfundedMatrixProof.metrics) !== JSON.stringify(['max-real-drawdown', 'recovery-period', 'balance-at-age-80', 'funded-through-margin']) || underfundedMatrixProof.recovery.reference !== '1 yr' || underfundedMatrixProof.recovery.figure !== 'Never' || underfundedMatrixProof.recovery.delta !== '' || underfundedMatrixProof.recovery.tone !== 'negative' || underfundedMatrixProof.recovery.referenceFontSize !== '15px' || underfundedMatrixProof.recovery.figureFontSize !== '24px' || underfundedMatrixProof.recovery.deltaMinHeight !== '12px' || underfundedMatrixProof.recovery.deltaHeight < 12 || underfundedMatrixProof.reverseRecovery.reference !== 'Never' || underfundedMatrixProof.reverseRecovery.figure !== '0 yrs' || underfundedMatrixProof.reverseRecovery.delta !== '' || underfundedMatrixProof.reverseRecovery.tone !== 'muted' || underfundedMatrixProof.reverseRecovery.referenceFontSize !== '15px' || underfundedMatrixProof.reverseRecovery.figureFontSize !== '24px' || underfundedMatrixProof.reverseRecovery.deltaMinHeight !== '12px' || underfundedMatrixProof.reverseRecovery.deltaHeight < 12 || underfundedMatrixProof.glyph !== '!' || !/is-underfunded/.test(underfundedMatrixProof.statusClass) || underfundedMatrixProof.statusColor !== underfundedMatrixProof.expectedColor) {
    throw new Error(`controlled underfunded Historical matrix is incomplete: ${JSON.stringify(underfundedMatrixProof)}`);
  }
  observedHistoricalOutcomes.add(underfundedMatrixProof.outcome);
  if (JSON.stringify([...observedHistoricalOutcomes].sort()) !== JSON.stringify(['survives', 'underfunded'])) {
    throw new Error(`Cash Flow verifier did not observe both locked Historical outcomes: ${JSON.stringify([...observedHistoricalOutcomes])}`);
  }
}
