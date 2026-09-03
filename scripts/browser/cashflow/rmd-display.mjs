export async function verifyGrossRmdDisplay({
  page
}) {
  const grossRmdDisplayProof = await page.evaluate(async () => {
    const {
      buildSimulationRows,
      renderCashflow
    } = await import('./ui/cashflow.js');
    const rows = buildSimulationRows({
      rows: [{
        age: 73,
        phase: 'ret',
        withdrawal: 80000,
        accountBreakdown: {
          traditional: 80000
        },
        rmdRequired: 30000,
        rmd: 0,
        taxes: 15000,
        balance: 620000,
        fundingShortfall: 0
      }]
    }, {
      plan: {
        household: {
          primary: {
            currentAge: 73
          }
        },
        goals: []
      },
      currentYear: 2026
    });
    const scenario = {
      id: 'browser-gross-rmd-proof',
      name: 'Browser gross RMD proof',
      tone: '#c6a662',
      raw: {
        res: {}
      }
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      host.innerHTML = renderCashflow(scenario, [scenario], {
        cashFlowResult: () => ({
          kind: 'typical',
          pathId: 'typical',
          rows,
          summary: {},
          taxScope: 'MODELED_FEDERAL_LINE_24'
        }),
        pathRows: () => [],
        cashSummary: () => ({}),
        cashFromRetirement: false,
        isTypicalPath: () => true,
        typicalPathFederalTax: () => null,
        pathFederalTax: () => null,
        wdColor: () => 'inherit',
        num: value => String(value),
        esc: value => String(value),
        fmtMoney: value => '$' + Math.round(value).toLocaleString('en-US'),
        cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'Eff. WD Rate', 'Ending']
      });
      const cells = [...host.querySelectorAll('.cf-row .cf-cell')].map(cell => cell.textContent.trim());
      return {
        rmd: cells[2] ?? '',
        tax: cells[5] ?? '',
        draw: cells[6] ?? ''
      };
    } finally {
      host.remove();
    }
  });
  if (grossRmdDisplayProof.rmd !== '$30,000' || grossRmdDisplayProof.tax !== '$15,000' || grossRmdDisplayProof.draw !== '($80,000)') {
    throw new Error(`Cash Flow gross RMD display or unaffected Tax/Draw drifted: ${JSON.stringify(grossRmdDisplayProof)}`);
  }
}
