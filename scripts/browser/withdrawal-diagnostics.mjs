export function createPlannerDiagnostics({
  page,
  stableEvaluate,
  errs
}) {
  const plannerDiagnosticState = () => stableEvaluate('read Withdrawal Planner diagnostic state', () => {
    const root = document.querySelector('[data-taw-root]');
    const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
    let current1040 = null;
    try {
      const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
      current1040 = db?.[activeHouseholdId]?.incomeTax?.current1040 ?? null;
    } catch {
      current1040 = null;
    }
    const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
    return {
      activePage: document.querySelector('.page.on')?.dataset.page ?? null,
      activeHouseholdId,
      busy: root?.getAttribute('aria-busy') ?? null,
      renderRevision: Number(root?.dataset.tawRenderRevision ?? -1),
      renderedHouseholdId: root?.dataset.tawHouseholdId ?? null,
      resultCode: root?.dataset.tawResultCode || null,
      wages: text('[data-taw-fact-wages]'),
      ordinaryTax: text('[data-taw-col="ord"] .taw-col-edge span'),
      federalTax: text('[data-taw-federal-tax]'),
      incomeSourcesComplete: current1040?.incomeSourcesComplete === true
    };
  });
  const waitForPlannerState = async ({
    afterRevision,
    wages,
    ordinaryTax,
    federalTax,
    resultCode,
    incomeSourcesComplete
  }) => {
    const expected = {
      afterRevision,
      wages,
      ordinaryTax,
      federalTax,
      resultCode,
      incomeSourcesComplete
    };
    try {
      await page.waitForFunction(want => {
        const root = document.querySelector('[data-taw-root]');
        const activeHouseholdId = localStorage.getItem('parallax.activeHouseholdId');
        let current1040 = null;
        try {
          const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
          current1040 = db?.[activeHouseholdId]?.incomeTax?.current1040 ?? null;
        } catch {
          current1040 = null;
        }
        const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
        return root?.getAttribute('aria-busy') === 'false' && Number(root.dataset.tawRenderRevision || -1) > want.afterRevision && root.dataset.tawHouseholdId === activeHouseholdId && (root.dataset.tawResultCode || null) === want.resultCode && text('[data-taw-fact-wages]') === want.wages && text('[data-taw-col="ord"] .taw-col-edge span') === want.ordinaryTax && text('[data-taw-federal-tax]') === want.federalTax && current1040?.incomeSourcesComplete === true === want.incomeSourcesComplete;
      }, {
        timeout: 15000
      }, expected);
    } catch (error) {
      const observed = await plannerDiagnosticState();
      throw new Error(`Withdrawal Planner state timeout: ${JSON.stringify({
        expected,
        observed,
        consoleErrors: errs
      })}; ${error.message || error}`, { cause: error });
    }
    return plannerDiagnosticState();
  };
  return {
    plannerDiagnosticState,
    waitForPlannerState
  };
}
