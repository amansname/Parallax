import assert from 'node:assert/strict';

// Synthetic failure-state contract, not a replay of the user's saved household.
// Use the shipped controller and renderer in an isolated page of the artifact.
export async function runRolloverErrorBrowserContract(browser, baseUrl){
  // App startup may update household storage. Keep the synthetic page entirely
  // separate from the verifier's real visible-input household journey.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try{
    await page.goto(baseUrl, { waitUntil: 'networkidle0' });
    const actual = await page.evaluate(async () => {
      const { createCashFlowController } = await import('/src/scenarios/createCashFlowController.js');
      const { renderCashflow } = await import('/ui/cashflow.js');
      const raw = { base: true, name: 'Baseline', res: {
        projectionStatus: 'unavailable', issue: 'TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE', issueAge: 92,
      } };
      const controller = createCashFlowController({
        getScenarios: () => [raw], scenarioInputsByResult: new WeakMap(),
        selection: { id: 'typical' }, buildRows: () => { throw Error('unavailable projection must not render financial rows'); },
      });
      const scenario = { id: 'baseline', name: 'Baseline', tone: '#8fa57e', raw };
      const escape = value => { const element = document.createElement('span'); element.textContent = String(value); return element.innerHTML; };
      const root = document.createElement('main');
      root.innerHTML = renderCashflow(scenario, [scenario], {
        cashFlowResult: () => controller.resultForScenario(raw), cashFromRetirement: false,
        isTypicalPath: () => true, typicalPathFederalTax: () => null, pathFederalTax: () => null,
        wdColor: () => '', num: String, esc: escape, fmtMoney: String,
        cfCols: ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending'],
      });
      document.body.replaceChildren(root);
      return {
        text: root.textContent,
        headers: [...root.querySelectorAll('.cf-th')].map(node => node.textContent.trim()),
        fallbackCount: root.querySelectorAll('[data-tax-fallback]').length,
        summaryCount: root.querySelectorAll('.cf-summary').length,
      };
    });
    assert.match(actual.text, /age 92/);
    assert.match(actual.text, /TRADITIONAL_ACCOUNT_OWNER_LIFECYCLE_UNAVAILABLE/);
    assert.match(actual.text, /account ownership and plan-end ages/);
    assert.doesNotMatch(actual.text, /handoff|Tax column uses engine estimates/);
    assert.equal(actual.fallbackCount, 0);
    assert.equal(actual.summaryCount, 0);
    assert.deepEqual(actual.headers, ['Year', 'Age', 'Income', 'RMD', 'Essential', 'Goals', 'Tax', 'Draw', 'Return', 'WD Rate', 'Ending']);
  }finally{
    await context.close();
  }
}
