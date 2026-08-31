// Existing browser assertions; run by scripts/verify.mjs in campaign order.

export async function verifyRapidApprovals({
  page
}) {
  const proof = await page.evaluate(async () => {
    const {
      createTaxAwareWithdrawalController
    } = await import('/ui/taxAwareWithdrawal.js?verify=lever-queue');
    const host = document.createElement('div');
    const plan = {
      meta: {
        householdId: 'lever-queue-fixture',
        filingStatus: 'single'
      }
    };
    const calls = [];
    let releaseFirst;
    const firstGate = new Promise(resolveGate => {
      releaseFirst = resolveGate;
    });
    let nextApprovalGate = firstGate;
    let nextRefreshGate = null;
    let refreshStateCalls = 0;
    let approvalReturns = 0;
    const waitFor = async (predicate, label) => {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolveWait => setTimeout(resolveWait, 0));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const accountState = levers => {
      const remainingTraditional = Math.max(0, 100000 - levers.rothConversion - levers.qcd - levers.deferredWithdrawal);
      return {
        valid: true,
        limits: {
          rothConversion: {
            max: levers.rothConversion + remainingTraditional
          },
          rothWithdrawal: {
            max: 50000
          },
          qcd: {
            max: levers.qcd + remainingTraditional
          },
          deferredWithdrawal: {
            max: levers.deferredWithdrawal + remainingTraditional
          },
          realizedGain: {
            max: 50000
          }
        }
      };
    };
    const adapter = {
      withdrawalAccountState: async (_plan, levers) => {
        const gate = nextRefreshGate;
        if (gate) {
          nextRefreshGate = null;
          refreshStateCalls++;
          await gate;
        }
        return accountState(levers);
      },
      householdIncome: async () => ({
        available: false,
        filingStatus: 'single',
        socialSecurityBenefits: 12000,
        otherIncome: null,
        wages: 25000
      }),
      evaluateYear: async () => ({
        code: 'VERIFY_ONLY'
      }),
      attributeSleeves: async () => null,
      approveWithdrawalPlannerLeverChange: async (_plan, currentLevers, key, value) => {
        calls.push({
          currentLevers: {
            ...currentLevers
          },
          key,
          value
        });
        const gate = nextApprovalGate;
        nextApprovalGate = null;
        if (gate) await gate;
        const nextLevers = {
          ...currentLevers,
          [key]: value
        };
        approvalReturns++;
        return {
          approved: true,
          levers: nextLevers,
          state: accountState(nextLevers)
        };
      }
    };
    const controller = createTaxAwareWithdrawalController({
      getPlan: () => plan,
      adapter
    });
    controller.bind(host);
    const conversion = host.querySelector('[data-taw-lever="rothConversion"]');
    const distribution = host.querySelector('[data-taw-lever="deferredWithdrawal"]');
    const wages = host.querySelector('[data-taw-fact-wages]');
    await waitFor(() => conversion.max === '100000' && wages.textContent === '$25,000', 'initial engine limits and available income fields');
    conversion.value = '60000';
    conversion.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    distribution.value = '40000';
    distribution.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    await waitFor(() => calls.length === 1, 'first approval');
    const callsBeforeRelease = calls.length;
    releaseFirst();
    await waitFor(() => calls.length === 2, 'second approval');
    await waitFor(() => conversion.value === '60000' && distribution.value === '40000', 'both approved slider values');
    let releaseStaleApproval;
    nextApprovalGate = new Promise(resolveGate => {
      releaseStaleApproval = resolveGate;
    });
    conversion.value = '30000';
    conversion.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    const conversionImmediatelyAfterInput = conversion.value;
    await waitFor(() => calls.length === 3, 'approval pending before refresh');
    let releaseRefresh;
    nextRefreshGate = new Promise(resolveGate => {
      releaseRefresh = resolveGate;
    });
    controller.sync();
    await waitFor(() => refreshStateCalls === 1 && conversion.value === '60000', 'refresh invalidation of pending approval');
    releaseStaleApproval();
    await waitFor(() => approvalReturns === 3, 'stale approval return');
    await new Promise(resolveWait => setTimeout(resolveWait, 0));
    const conversionAfterStaleReturn = conversion.value;
    const realizedGain = host.querySelector('[data-taw-lever="realizedGain"]');
    realizedGain.value = '10000';
    realizedGain.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    await new Promise(resolveWait => setTimeout(resolveWait, 0));
    const callsWhileRefreshPending = calls.length;
    releaseRefresh();
    await waitFor(() => calls.length === 4, 'approval queued after refresh');
    await waitFor(() => realizedGain.value === '10000', 'post-refresh approved slider value');
    return {
      callsBeforeRelease,
      calls,
      finalConversion: conversion.value,
      finalDistribution: distribution.value,
      finalDistributionMax: distribution.max,
      partialIncome: {
        socialSecurity: host.querySelector('[data-taw-fact-ss]').textContent,
        otherIncome: host.querySelector('[data-taw-fact-other]').textContent,
        wages: wages.textContent
      },
      refreshRace: {
        conversionImmediatelyAfterInput,
        conversionAfterStaleReturn,
        callsWhileRefreshPending,
        postRefreshCall: calls[3],
        finalRealizedGain: realizedGain.value
      }
    };
  });
  if (proof.callsBeforeRelease !== 1) {
    throw new Error(`approvals ran concurrently: ${JSON.stringify(proof)}`);
  }
  if (proof.calls[1]?.currentLevers?.rothConversion !== 60000) {
    throw new Error(`second approval missed the first accepted change: ${JSON.stringify(proof)}`);
  }
  if (proof.finalConversion !== '60000' || proof.finalDistribution !== '40000' || proof.finalDistributionMax !== '40000') {
    throw new Error(`approved shared-balance controls are inconsistent: ${JSON.stringify(proof)}`);
  }
  if (proof.partialIncome.socialSecurity !== '$12,000' || proof.partialIncome.otherIncome !== '—' || proof.partialIncome.wages !== '$25,000') {
    throw new Error(`available income fields were erased by a partial result: ${JSON.stringify(proof)}`);
  }
  if (proof.refreshRace.conversionImmediatelyAfterInput !== '30000' || proof.refreshRace.conversionAfterStaleReturn !== '60000' || proof.refreshRace.callsWhileRefreshPending !== 3 || proof.refreshRace.postRefreshCall?.currentLevers?.rothConversion !== 60000 || proof.refreshRace.finalRealizedGain !== '10000') {
    throw new Error(`refresh and approval ordering is unsafe: ${JSON.stringify(proof)}`);
  }
}
export async function verifyRmdControls({
  page
}) {
  const proof = await page.evaluate(async () => {
    const [engineModule, accountModule, factModule, controllerModule, adapter] = await Promise.all([import('/engine.js'), import('/src/household/createAccount.js'), import('/src/household/factEnvelope.js'), import('/ui/taxAwareWithdrawal.js?verify=production-rmd'), import('/src/planning/taxBuckets/taxEngineAdapter.js')]);
    const plan = structuredClone(engineModule.defaultPlan);
    plan.meta = {
      ...plan.meta,
      householdId: 'production-rmd-fixture',
      filingStatus: 'single',
      planningAsOfYear: 2026
    };
    plan.household.primary = {
      currentAge: 73,
      retirementAge: 73,
      planEndAge: 75,
      birthYear: 1953
    };
    plan.household.spouse = null;
    plan.taxProfiles.client.birthDate = factModule.createFact('1953-01-15', 'confirmed', 'household-entry', '2026-01-15T12:00:00Z');
    plan.income.socialSecurity = {
      primary: {
        pia: 0,
        claimAge: 70
      },
      spouse: null
    };
    plan.income.other = [];
    plan.savings.annual = 0;
    plan.portfolio.accounts.taxable.balance = 0;
    plan.portfolio.accounts.taxable.basisPct = 1;
    plan.portfolio.accounts.traditional.balance = 0;
    plan.portfolio.accounts.roth.balance = 0;
    plan.portfolio.extraAccounts = [accountModule.createAccount('traditional_ira', {
      owner: 'client',
      balance: 265000,
      valuationDate: '2025-12-31'
    })];
    const host = document.createElement('div');
    host.style.position = 'fixed';
    host.style.left = '-10000px';
    document.body.appendChild(host);
    const controller = controllerModule.createTaxAwareWithdrawalController({
      getPlan: () => plan,
      adapter
    });
    controller.bind(host);
    const waitFor = async (predicate, label) => {
      const deadline = performance.now() + 10000;
      while (performance.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolveWait => setTimeout(resolveWait, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const conversion = host.querySelector('[data-taw-lever="rothConversion"]');
    const distribution = host.querySelector('[data-taw-lever="deferredWithdrawal"]');
    try {
      await waitFor(() => distribution.min === '10000' && distribution.max === '265000' && distribution.value === '10000' && conversion.max === '255000', 'initial RMD-backed limits');
    } catch (error) {
      const debugFacts = await adapter.householdIncome(plan, 2026);
      const debugState = await adapter.withdrawalAccountState(plan, {}, debugFacts);
      throw new Error(`${error.message}: ${JSON.stringify({
        distributionMin: distribution.min,
        distributionMax: distribution.max,
        distributionValue: distribution.value,
        conversionMax: conversion.max,
        busy: host.querySelector('[data-taw-root]')?.getAttribute('aria-busy') ?? null,
        revision: host.querySelector('[data-taw-root]')?.dataset.tawRenderRevision ?? null,
        facts: debugFacts,
        state: debugState
      })}`);
    }
    const initial = {
      distributionMin: distribution.min,
      distributionMax: distribution.max,
      distributionValue: distribution.value,
      conversionMax: conversion.max
    };
    conversion.value = '160000';
    conversion.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    distribution.value = '160000';
    distribution.dispatchEvent(new Event('input', {
      bubbles: true
    }));
    await waitFor(() => conversion.value === '160000' && distribution.value === '105000' && conversion.max === '160000' && distribution.max === '105000', 'serialized shared-IRA approvals');
    const final = {
      distributionMin: distribution.min,
      distributionMax: distribution.max,
      distributionValue: distribution.value,
      conversionMax: conversion.max,
      conversionValue: conversion.value
    };
    host.remove();
    return {
      initial,
      final
    };
  });
  if (proof.initial.distributionMin !== '10000' || proof.initial.distributionMax !== '265000' || proof.initial.distributionValue !== '10000' || proof.initial.conversionMax !== '255000' || proof.final.distributionMin !== '10000' || proof.final.distributionMax !== '105000' || proof.final.distributionValue !== '105000' || proof.final.conversionMax !== '160000' || proof.final.conversionValue !== '160000') {
    throw new Error(`rendered RMD/shared-IRA limits are wrong: ${JSON.stringify(proof)}`);
  }
}
