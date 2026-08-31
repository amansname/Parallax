// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { join } from 'node:path';
export async function verifyWithdrawalResults({
  page,
  plannerDiagnosticState,
  stableClick,
  waitForPlannerState,
  withdrawalPlannerFixtureHouseholdId,
  WITHDRAWAL_PLANNER_FIXTURE,
  WITHDRAWAL_PLANNER_ORACLE,
  OUT
}) {
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1
  });
  const beforePlanner = await plannerDiagnosticState();
  await stableClick('.htab[data-page="tax-buckets"]');
  await waitForPlannerState({
    afterRevision: beforePlanner.renderRevision,
    wages: '$50,000',
    ordinaryTax: '$3,820',
    federalTax: '$3,820',
    resultCode: null,
    incomeSourcesComplete: false
  });
  const planner = await page.evaluate(() => ({
    active: document.querySelector('.page.on')?.dataset.page || '',
    columns: document.querySelectorAll('[data-taw-col]').length,
    sliders: document.querySelectorAll('.taw-range').length,
    enabledSliders: document.querySelectorAll('.taw-range:not(:disabled)').length,
    sliderCaps: Object.fromEntries(Array.from(document.querySelectorAll('.taw-range'), input => [input.dataset.tawLever, Number(input.max)])),
    householdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId ?? null,
    realizedGainLabel: document.querySelector('[data-taw-slider="realizedGain"] .taw-slider-label')?.textContent.trim() ?? null,
    ord: !!document.querySelector('[data-taw-col="ord"]')
  }));
  if (planner.active !== 'tax-buckets') throw new Error(`Tax Buckets tab not active: ${JSON.stringify(planner)}`);
  if (planner.columns !== 4 || !planner.ord) throw new Error(`Withdrawal planner layout incomplete: ${JSON.stringify(planner)}`);
  if (planner.sliders !== 5) throw new Error(`Withdrawal planner expected five sliders: ${planner.sliders}`);
  if (planner.enabledSliders !== 5 || Object.values(planner.sliderCaps).some(cap => !(cap > 0))) {
    throw new Error(`funded Withdrawal Planner sliders are not enabled: ${JSON.stringify(planner)}`);
  }
  if (planner.sliderCaps.rothConversion !== 500000 || planner.sliderCaps.deferredWithdrawal !== 500000 || planner.sliderCaps.realizedGain !== 500000 || planner.sliderCaps.rothWithdrawal !== 400000) {
    throw new Error(`Withdrawal Planner display ceilings are wrong: ${JSON.stringify(planner.sliderCaps)}`);
  }
  if (planner.householdId !== withdrawalPlannerFixtureHouseholdId || planner.realizedGainLabel !== 'Realized gain') {
    throw new Error(`Withdrawal Planner did not load the selected production household: ${JSON.stringify(planner)}`);
  }
  const thresholdProof = await page.evaluate(() => {
    const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
    return {
      ordinary: text('[data-taw-col="ord"] .taw-col-edge span'),
      ltcg: text('[data-taw-col="ltcg"] .taw-col-edge span'),
      irmaa: text('[data-taw-col="irmaa"] .taw-col-edge span'),
      socialSecurity: text('[data-taw-col="ss"] .taw-col-edge span'),
      federalTax: text('[data-taw-federal-tax]'),
      effectiveRate: text('[data-taw-effective-rate]'),
      marginalRate: text('[data-taw-marginal-rate]')
    };
  });
  const expected = WITHDRAWAL_PLANNER_FIXTURE.plannerOracle.baseline;
  if (thresholdProof.ordinary !== expected.ordinary || thresholdProof.ltcg !== expected.longTermGainTax || thresholdProof.socialSecurity !== expected.socialSecurityTax || thresholdProof.irmaa !== expected.irmaaAnnual || thresholdProof.federalTax !== expected.federalTax || thresholdProof.effectiveRate !== expected.effectiveRate || thresholdProof.marginalRate !== expected.marginalRate) {
    throw new Error(`rendered threshold contract differs from literal oracle: ${JSON.stringify({
      thresholdProof,
      expected
    })}`);
  }
  const plannerControls = await page.evaluate(() => ({
    localTaxOverrides: document.querySelectorAll('[data-taw-year], [data-taw-fs], [data-taw-mfs], [data-taw-law]').length,
    methodologyCopy: document.querySelectorAll('.taw-att-note').length,
    wageTag: document.querySelector('[data-taw-fact-wages]')?.tagName ?? null,
    fixedIncomeInputs: document.querySelectorAll('input[data-taw-fact-wages], input[data-taw-fact-ss], input[data-taw-fact-other]').length,
    fixedIncomeOrder: Array.from(document.querySelector('.taw-income-list')?.children || [], element => element.className),
    amountRightEdges: ['[data-taw-fact-ss]', '[data-taw-fact-wages]', '[data-taw-fact-other]', '[data-taw-baseline-total]', '[data-taw-slider-val="rothConversion"]', '[data-taw-slider-val="rothWithdrawal"]', '[data-taw-slider-val="qcd"]', '[data-taw-slider-val="deferredWithdrawal"]', '[data-taw-slider-val="realizedGain"]'].map(selector => document.querySelector(selector)?.getBoundingClientRect().right ?? null)
  }));
  const amountEdges = plannerControls.amountRightEdges.filter(Number.isFinite);
  if (plannerControls.localTaxOverrides !== 0 || plannerControls.methodologyCopy !== 0 || plannerControls.wageTag !== 'SPAN' || plannerControls.fixedIncomeInputs !== 0 || plannerControls.fixedIncomeOrder.join('|') !== ['taw-income-heading', 'taw-income-row', 'taw-income-row', 'taw-income-row', 'taw-income-total'].join('|') || amountEdges.length !== 9 || Math.max(...amountEdges) - Math.min(...amountEdges) > 0.5) {
    throw new Error(`Withdrawal Planner contains non-canonical controls or copy: ${JSON.stringify(plannerControls)}`);
  }
  const plannerSnapshot = () => page.evaluate(() => {
    const text = selector => document.querySelector(selector)?.textContent.trim() ?? null;
    const inventory = Array.from(document.querySelectorAll('[data-taw-col]'), column => [column.dataset.tawCol, column.querySelector('.taw-col-name')?.textContent.trim()]);
    const expectedInventory = [['ord', 'Income Tax'], ['ltcg', 'Long-term gains'], ['irmaa', 'Medicare IRMAA'], ['ss', 'Social Security']];
    if (JSON.stringify(inventory) !== JSON.stringify(expectedInventory)) {
      throw new Error(`Withdrawal column inventory drifted: ${JSON.stringify(inventory)}`);
    }
    const columns = Object.fromEntries(['ord', 'ltcg', 'irmaa', 'ss'].map(id => {
      const column = document.querySelector(`[data-taw-col="${id}"]`);
      const base = column?.querySelector('.taw-col-base');
      const fill = column?.querySelector('.taw-col-fill');
      const gap = column?.querySelector('.taw-col-gap');
      const edge = column?.querySelector('.taw-col-edge');
      const paint = {};
      for (const [region, element, extent] of [['base', base, base?.style.height], ['fill', fill, fill?.style.height], ['edge', edge, edge?.style.bottom]]) {
        if (!element) throw new Error(`Missing ${id} ${region}`);
        const style = getComputedStyle(element);
        paint[region] = {
          image: style.backgroundImage,
          color: style.backgroundColor
        };
        if (parseFloat(extent) > 0 && style.backgroundImage === 'none' && ['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor)) {
          throw new Error(`Funded threshold paint is transparent: ${id} ${region}`);
        }
      }
      return [id, {
        paint,
        value: text(`[data-taw-col="${id}"] .taw-col-edge span`),
        baseStyle: base?.style.height ?? null,
        fillStyle: fill?.style.height ?? null,
        gapStyle: gap?.style.height ?? null,
        basePixels: base?.getBoundingClientRect().height ?? null,
        fillPixels: fill?.getBoundingClientRect().height ?? null,
        gapPixels: gap?.getBoundingClientRect().height ?? null
      }];
    }));
    return {
      revision: Number(document.querySelector('[data-taw-root]')?.dataset.tawRenderRevision || -1),
      federalTax: text('[data-taw-federal-tax]'),
      effectiveRate: text('[data-taw-effective-rate]'),
      marginalRate: text('[data-taw-marginal-rate]'),
      taxCaused: {
        roth: text('[data-taw-caused="roth"] [data-taw-caused-val]'),
        traditional: text('[data-taw-caused="traditional"] [data-taw-caused-val]'),
        taxable: text('[data-taw-caused="taxable"] [data-taw-caused-val]')
      },
      columns
    };
  });
  const exerciseLever = async key => {
    const effect = WITHDRAWAL_PLANNER_ORACLE.leverEffects[key];
    if (!effect) throw new Error(`literal lever-effect oracle is missing: ${key}`);
    const selector = `[data-taw-lever="${key}"]`;
    const before = await plannerSnapshot();
    const control = await page.$eval(selector, input => ({
      disabled: input.disabled,
      min: Number(input.min),
      max: Number(input.max)
    }));
    if (control.disabled || !(control.max > control.min)) {
      throw new Error(`funded Planner lever is unavailable: ${JSON.stringify({
        key,
        control
      })}`);
    }
    await stableClick(selector);
    await page.keyboard.press('End');
    await page.waitForFunction(({
      leverKey,
      previousRevision
    }) => {
      const root = document.querySelector('[data-taw-root]');
      const input = document.querySelector(`[data-taw-lever="${leverKey}"]`);
      return root?.getAttribute('aria-busy') === 'false' && Number(root.dataset.tawRenderRevision || -1) > previousRevision && input?.value === input?.max;
    }, {
      timeout: 15000
    }, {
      leverKey: key,
      previousRevision: before.revision
    });
    const causedBucket = {
      rothWithdrawal: 'roth',
      deferredWithdrawal: 'traditional',
      realizedGain: 'taxable'
    }[key];
    if (causedBucket) {
      await page.waitForFunction(bucket => document.querySelector(`[data-taw-caused="${bucket}"] [data-taw-caused-val]`)?.textContent.trim() !== '\u2014', {
        timeout: 15000
      }, causedBucket);
    }
    const after = await plannerSnapshot();
    const allowedZeroTaxEffectiveRate = before.effectiveRate === '\u2014' && after.effectiveRate === '\u2014' && effect.financial === 'unchanged';
    if (after.federalTax === '\u2014' || after.effectiveRate === '\u2014' && !allowedZeroTaxEffectiveRate || after.marginalRate === '\u2014' || after.columns.ord.value === '\u2014' || after.columns.ltcg.value === '\u2014' || after.columns.ss.value === '\u2014' || Object.values(after.columns).some(column => !Number.isFinite(column.basePixels) || !Number.isFinite(column.fillPixels) || !Number.isFinite(column.gapPixels))) {
      throw new Error(`Planner lever blanked visible outputs or fill geometry: ${JSON.stringify({
        key,
        before,
        after
      })}`);
    }
    const financialView = snapshot => ({
      federalTax: snapshot.federalTax,
      effectiveRate: snapshot.effectiveRate,
      marginalRate: snapshot.marginalRate,
      columns: Object.fromEntries(Object.entries(snapshot.columns).map(([id, column]) => [id, column.value]))
    });
    const geometryView = snapshot => Object.fromEntries(Object.entries(snapshot.columns).map(([id, column]) => [id, {
      baseStyle: column.baseStyle,
      fillStyle: column.fillStyle,
      gapStyle: column.gapStyle
    }]));
    const financialChanged = JSON.stringify(financialView(after)) !== JSON.stringify(financialView(before));
    const geometryChanged = JSON.stringify(geometryView(after)) !== JSON.stringify(geometryView(before));
    if (financialChanged !== (effect.financial === 'changes')) {
      throw new Error(`Planner lever financial-output contract failed: ${JSON.stringify({
        key,
        effect,
        before,
        after
      })}`);
    }
    if (geometryChanged !== (effect.geometry === 'changes')) {
      throw new Error(`Planner lever fill-geometry contract failed: ${JSON.stringify({
        key,
        effect,
        before,
        after
      })}`);
    }
    if (effect.taxCaused !== undefined) {
      if (!causedBucket || after.taxCaused[causedBucket] !== effect.taxCaused) {
        throw new Error(`Planner lever tax-caused contract failed: ${JSON.stringify({
          key,
          effect,
          after
        })}`);
      }
    }
    await stableClick(selector);
    await page.keyboard.press('Home');
    await page.waitForFunction(({
      leverKey,
      previousRevision
    }) => {
      const root = document.querySelector('[data-taw-root]');
      const input = document.querySelector(`[data-taw-lever="${leverKey}"]`);
      return root?.getAttribute('aria-busy') === 'false' && Number(root.dataset.tawRenderRevision || -1) > previousRevision && input?.value === input?.min;
    }, {
      timeout: 15000
    }, {
      leverKey: key,
      previousRevision: after.revision
    });
    const reset = await plannerSnapshot();
    const comparable = snapshot => ({
      federalTax: snapshot.federalTax,
      effectiveRate: snapshot.effectiveRate,
      marginalRate: snapshot.marginalRate,
      columns: Object.fromEntries(Object.entries(snapshot.columns).map(([id, column]) => [id, {
        value: column.value,
        baseStyle: column.baseStyle,
        fillStyle: column.fillStyle,
        gapStyle: column.gapStyle
      }]))
    });
    if (JSON.stringify(comparable(reset)) !== JSON.stringify(comparable(before))) {
      throw new Error(`Planner lever did not restore its visible baseline: ${JSON.stringify({
        key,
        before,
        after,
        reset
      })}`);
    }
    return {
      key,
      control,
      before,
      after
    };
  };
  const leverProof = [];
  for (const key of ['rothConversion', 'rothWithdrawal', 'qcd', 'deferredWithdrawal', 'realizedGain']) {
    leverProof.push(await exerciseLever(key));
  }
  const realized = leverProof.find(candidate => candidate.key === 'realizedGain');
  const realizedOracle = WITHDRAWAL_PLANNER_FIXTURE.plannerOracle.realizedGainAtDisplayCeiling;
  const realizedVisible = {
    slider: `$${realized.control.max.toLocaleString('en-US')}`,
    federalTax: realized.after.federalTax,
    ordinary: realized.after.columns.ord.value,
    longTermGainTax: realized.after.columns.ltcg.value,
    irmaaAnnual: realized.after.columns.irmaa.value,
    effectiveRate: realized.after.effectiveRate,
    taxCaused: realized.after.taxCaused.taxable
  };
  if (Object.entries(realizedVisible).some(([key, value]) => value !== realizedOracle[key])) {
    throw new Error(`Realized Gain differs from the independent literal oracle: ${JSON.stringify({
      realizedVisible,
      realizedOracle
    })}`);
  }
  if (!(parseFloat(realized.after.columns.ltcg.fillStyle || '0') > 0)) {
    throw new Error(`Realized Gain did not produce visible long-term-gain fill: ${JSON.stringify(realized)}`);
  }
  const defaultIds = Object.keys(WITHDRAWAL_PLANNER_ORACLE.households);
  const selectableIds = await page.$$eval('#hh-switch option', options => options.map(option => option.value));
  if (selectableIds[0] !== '' || defaultIds.some(id => !selectableIds.includes(id)) || !selectableIds.includes(withdrawalPlannerFixtureHouseholdId) || ['demo', 'default-pre-retirement-solo', 'default-pre-retirement-couple'].some(id => selectableIds.includes(id))) {
    throw new Error(`production household selector is incomplete: ${JSON.stringify({
      selectableIds,
      defaultIds
    })}`);
  }
  const productionDefaultProof = {};
  for (const householdId of defaultIds) {
    await page.select('#hh-switch', householdId);
    try {
      await page.waitForFunction(expectedHouseholdId => {
        const root = document.querySelector('[data-taw-root]');
        return root?.dataset.tawHouseholdId === expectedHouseholdId && root?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.taw-range:not(:disabled)').length === 5 && document.querySelector('[data-taw-federal-tax]')?.textContent.trim() !== '\u2014';
      }, {
        timeout: 30000
      }, householdId);
    } catch (error) {
      const observed = await page.evaluate(() => ({
        selectedHouseholdId: document.querySelector('#hh-switch')?.value ?? null,
        wizardHouseholdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId ?? null,
        householdName: document.querySelector('#hh-rail-name')?.textContent.trim() ?? null,
        plannerHouseholdId: document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId ?? null,
        busy: document.querySelector('[data-taw-root]')?.getAttribute('aria-busy') ?? null,
        federalTax: document.querySelector('[data-taw-federal-tax]')?.textContent.trim() ?? null,
        controls: Array.from(document.querySelectorAll('.taw-range'), input => ({
          lever: input.dataset.tawLever ?? null,
          value: input.value,
          max: input.max,
          disabled: input.disabled
        }))
      }));
      throw new Error(`production default did not reach ready funded Planner state: ${JSON.stringify({
        householdId,
        observed
      })}`, {
        cause: error
      });
    }
    const baseline = await plannerSnapshot();
    const oracle = WITHDRAWAL_PLANNER_ORACLE.households[householdId];
    if (baseline.federalTax !== oracle.baseline.federalTax || baseline.columns.ord.value !== oracle.baseline.ordinary || baseline.columns.ltcg.value !== oracle.baseline.longTermGainTax) {
      throw new Error(`production default baseline differs from literal oracle: ${JSON.stringify({
        householdId,
        baseline,
        oracle
      })}`);
    }
    const proofs = [];
    for (const key of ['rothConversion', 'rothWithdrawal', 'qcd', 'deferredWithdrawal', 'realizedGain']) {
      proofs.push(await exerciseLever(key));
    }
    const realizedProof = proofs.find(candidate => candidate.key === 'realizedGain');
    const realizedExpected = oracle.realizedGainAtDisplayCeiling;
    const realizedActual = {
      slider: `$${realizedProof.control.max.toLocaleString('en-US')}`,
      federalTax: realizedProof.after.federalTax,
      ordinary: realizedProof.after.columns.ord.value,
      longTermGainTax: realizedProof.after.columns.ltcg.value,
      effectiveRate: realizedProof.after.effectiveRate,
      taxCaused: realizedProof.after.taxCaused.taxable
    };
    if (Object.entries(realizedActual).some(([key, value]) => value !== realizedExpected[key])) {
      throw new Error(`production default Realized Gain differs from literal oracle: ${JSON.stringify({
        householdId,
        realizedActual,
        realizedExpected
      })}`);
    }
    productionDefaultProof[householdId] = proofs;
  }
  if (Object.values(productionDefaultProof).some(proofs => proofs.length !== 5)) {
    throw new Error(`not every funded lever was exercised for every production default: ${JSON.stringify(productionDefaultProof)}`);
  }
  await page.select('#hh-switch', withdrawalPlannerFixtureHouseholdId);
  await page.waitForFunction(expectedHouseholdId => document.querySelector('[data-hh-wizard-root]')?.dataset.householdId === expectedHouseholdId && document.querySelector('[data-taw-root]')?.dataset.tawHouseholdId === expectedHouseholdId && document.querySelector('[data-taw-root]')?.getAttribute('aria-busy') === 'false', {
    timeout: 30000
  }, withdrawalPlannerFixtureHouseholdId);
  await page.screenshot({
    path: join(OUT, '02-tax-buckets.png')
  });
  await page.setViewport({
    width: 1920,
    height: 1080,
    deviceScaleFactor: 3
  });
}
