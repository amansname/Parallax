// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../wizard-browser-contract.mjs';
export async function verifyScenarioAllocation({
  page,
  withdrawalPlannerFixtureHouseholdId,
  stableReload,
  stableClick
}) {
  const legacySeed = await page.evaluate(householdId => {
    const readAge = key => Number(document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim());
    const retainedLevers = {
      retireAge: readAge('retireAge'),
      spouseRetireAge: readAge('spouseRetireAge'),
      ssAge: readAge('ssAge'),
      spouseSsAge: readAge('spouseSsAge'),
      allocationPresetId: document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]')?.value || 'current'
    };
    const key = `parallax.scenarios.${householdId}.v1`;
    const raw = JSON.stringify([{
      name: 'Baseline',
      base: true,
      lev: {
        ...retainedLevers
      }
    }, {
      name: 'Legacy twin',
      base: false,
      lev: {
        ...retainedLevers
      }
    }, {
      name: 'Legacy sale bytes',
      base: false,
      lev: {
        ...retainedLevers,
        sellAge: 70
      }
    }]);
    localStorage.setItem(key, raw);
    return {
      key,
      raw,
      retainedLevers
    };
  }, withdrawalPlannerFixtureHouseholdId);
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await page.evaluate(({
    key
  }) => {
    const originalSetItem = Storage.prototype.setItem;
    window.__legacyScenarioOriginalSetItem = originalSetItem;
    window.__legacyScenarioAttemptedBytes = null;
    Storage.prototype.setItem = function (storageKey, value) {
      if (this === localStorage && storageKey === key) {
        window.__legacyScenarioAttemptedBytes = value;
        return;
      }
      return originalSetItem.call(this, storageKey, value);
    };
  }, legacySeed);
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await stableClick('button[data-page="scenarios"]');
  await page.waitForSelector('#scn-view .compare', {
    visible: true,
    timeout: 30000
  });
  await page.waitForFunction(() => {
    const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')].map(element => element.textContent.trim());
    const medians = [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim());
    return probabilities.length === 3
      && medians.length === 3
      && probabilities.every(value => value && value !== '—%')
      && probabilities[1] === probabilities[2]
      && medians[1] === medians[2];
  }, {
    timeout: 30000
  });
  const legacyRead = await page.evaluate(({
    key,
    raw
  }) => {
    const probabilities = [...document.querySelectorAll('#scn-view .scol__prob')].map(element => element.textContent.trim());
    const medians = [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim());
    return {
      sourceBytesUnchanged: localStorage.getItem(key) === raw,
      attemptedBytes: window.__legacyScenarioAttemptedBytes,
      scenarioCount: document.querySelectorAll('#scn-view .scol__name').length,
      removedDecisionControlCount: document.querySelectorAll('#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]').length,
      removedDecisionLabelCount: [...document.querySelectorAll('#scn-view .lever__name')].filter(element => /^Sell\s/i.test(element.textContent.trim())).length,
      probabilities,
      medians
    };
  }, legacySeed);
  const attemptedLegacyLevers = JSON.parse(legacyRead.attemptedBytes || 'null')?.[2]?.lev;
  if (!legacyRead.sourceBytesUnchanged || !legacyRead.attemptedBytes || Object.prototype.hasOwnProperty.call(attemptedLegacyLevers || {}, 'sellAge') || legacyRead.scenarioCount !== 3 || legacyRead.removedDecisionControlCount !== 0 || legacyRead.removedDecisionLabelCount !== 0 || legacyRead.probabilities[1] !== legacyRead.probabilities[2] || legacyRead.medians[1] !== legacyRead.medians[2]) {
    throw new Error(`legacy sellAge bytes still affect Scenarios: ${JSON.stringify(legacyRead)}`);
  }
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__legacyScenarioOriginalSetItem;
    delete window.__legacyScenarioOriginalSetItem;
    delete window.__legacyScenarioAttemptedBytes;
  });
  const before = await page.evaluate(householdId => {
    const scenarioCount = document.querySelectorAll('#scn-view .scol__name').length;
    const leverNames = [...document.querySelectorAll('#scn-view .lever__name')].map(element => element.textContent.trim());
    const select = document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]');
    const bodyFontSize = getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim();
    const bodyFontWeight = getComputedStyle(document.documentElement).getPropertyValue('--fw-body').trim();
    const bodyLineHeight = getComputedStyle(document.documentElement).getPropertyValue('--lh-body').trim();
    const bodyLetterSpacing = getComputedStyle(document.documentElement).getPropertyValue('--ls-body').trim();
    const editorTypography = [...document.querySelectorAll('#scn-view .cmp-lev-val, #scn-view .cmp-lev-in, #scn-view .cmp-lev-select, #scn-view .cmp-goal-in')].map(element => {
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing
      };
    });
    const ageValues = {};
    for (const key of ['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge']) {
      const value = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
      ageValues[key] = Number(value);
    }
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      householdId,
      scenarioCount,
      leverNames,
      allocationValue: select?.value ?? null,
      allocationLabels: [...(select?.options || [])].map(option => option.textContent.trim()),
      allocationCount: document.querySelectorAll('#scn-view .cmp-lev-select[data-lever-key="allocationPresetId"]').length,
      removedDecisionControlCount: document.querySelectorAll('#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]').length,
      bodyFontSize,
      bodyFontWeight,
      bodyLineHeight,
      bodyLetterSpacing,
      editorTypography,
      ageValues,
      ageControlCounts: Object.fromEntries(['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge'].map(key => [key, document.querySelectorAll(`#scn-view .cmp-step-btn[data-lever-key="${key}"][data-scn-id]`).length])),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  }, withdrawalPlannerFixtureHouseholdId);
  const expectedAllocationLabels = ['Current mix', 'Defensive', 'Conservative', 'Balanced', 'Growth', 'Aggressive', 'All Equity'];
  const expectedLeverNames = ['Client 1 Retirement', 'Client 2 Retirement', 'Client 1 SS Age', 'Client 2 SS Age', 'Allocation'];
  if (before.active !== withdrawalPlannerFixtureHouseholdId || before.scenarioCount < 2 || before.allocationCount !== before.scenarioCount || JSON.stringify(before.allocationLabels) !== JSON.stringify(expectedAllocationLabels) || expectedLeverNames.some(name => !before.leverNames.includes(name)) || before.leverNames.some(name => /^Sell\s/i.test(name)) || before.removedDecisionControlCount !== 0 || before.editorTypography.length === 0 || before.editorTypography.some(role => role.fontSize !== before.bodyFontSize || role.fontWeight !== before.bodyFontWeight || role.lineHeight !== `${Number.parseFloat(before.bodyFontSize) * Number.parseFloat(before.bodyLineHeight)}px` || (Number.parseFloat(before.bodyLetterSpacing) === 0 ? !['normal', '0px'].includes(role.letterSpacing) : role.letterSpacing !== before.bodyLetterSpacing)) || Object.values(before.ageValues).some(value => !Number.isInteger(value)) || Object.values(before.ageControlCounts).some(count => count !== before.scenarioCount * 2) || before.overflow > 2) {
    throw new Error(`scenario person/allocation controls are incomplete: ${JSON.stringify(before)}`);
  }
  const targetAllocation = before.allocationValue === 'aggressive' ? 'defensive' : 'aggressive';
  await page.select('#scn-view .cmp-lev-select[data-scn-id="2"][data-lever-key="allocationPresetId"]', targetAllocation);
  await page.waitForFunction(target => document.querySelector('#scn-view .cmp-lev-select[data-scn-id="2"][data-lever-key="allocationPresetId"]')?.value === target && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  }, targetAllocation);
  const rewrittenLegacy = await page.evaluate(({
    key,
    retainedLevers
  }) => {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    const levers = saved?.[2]?.lev;
    return {
      sellAgePresent: Object.prototype.hasOwnProperty.call(levers || {}, 'sellAge'),
      retained: Object.fromEntries(Object.keys(retainedLevers).map(key => [key, levers?.[key]]))
    };
  }, legacySeed);
  if (rewrittenLegacy.sellAgePresent || Object.entries(legacySeed.retainedLevers).some(([key, value]) => key !== 'allocationPresetId' && rewrittenLegacy.retained[key] !== value) || rewrittenLegacy.retained.allocationPresetId !== targetAllocation) {
    throw new Error(`ordinary scenario edit did not safely rewrite legacy bytes: ${JSON.stringify(rewrittenLegacy)}`);
  }
  await page.select('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]', targetAllocation);
  await page.waitForFunction(target => document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]')?.value === target && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  }, targetAllocation);
  const editedAges = {};
  for (const [key, max] of [['retireAge', 72], ['spouseRetireAge', 72], ['ssAge', 70], ['spouseSsAge', 70]]) {
    const original = before.ageValues[key];
    const dir = original < max ? 1 : -1;
    editedAges[key] = original + dir;
    await page.click(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"][data-dir="${dir}"]`);
    await page.waitForFunction(({
      key,
      expected
    }) => {
      const value = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
      return Number(value) === expected && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || '');
    }, {
      timeout: 30000
    }, {
      key,
      expected: editedAges[key]
    });
  }
  await page.waitForFunction(({
    householdId,
    allocation,
    ages
  }) => {
    const raw = localStorage.getItem(`parallax.scenarios.${householdId}.v1`);
    const saved = raw ? JSON.parse(raw) : null;
    const levers = saved?.[1]?.lev;
    return levers?.allocationPresetId === allocation && !Object.prototype.hasOwnProperty.call(levers || {}, 'sellAge') && Object.entries(ages).every(([key, value]) => levers?.[key] === value);
  }, {
    timeout: 10000
  }, {
    householdId: withdrawalPlannerFixtureHouseholdId,
    allocation: targetAllocation,
    ages: editedAges
  });
  await stableReload({
    waitUntil: 'networkidle2',
    timeout: 20000
  });
  await waitForWizard(page, {
    householdId: 'joe-household'
  });
  await stableClick('.htab[data-page="household"]');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await stableClick('button[data-page="scenarios"]');
  await page.waitForSelector('#scn-view .compare', {
    visible: true,
    timeout: 30000
  });
  await page.waitForFunction(({
    allocation,
    ages
  }) => {
    const selectedAllocation = document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]')?.value;
    return selectedAllocation === allocation && Object.entries(ages).every(([key, expected]) => {
      const value = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
      return Number(value) === expected;
    });
  }, {
    timeout: 30000
  }, {
    allocation: targetAllocation,
    ages: editedAges
  });
  const restored = await page.evaluate(() => {
    const allocation = document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]')?.value;
    const ages = {};
    for (const key of ['retireAge', 'spouseRetireAge', 'ssAge', 'spouseSsAge']) {
      const value = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
      ages[key] = Number(value);
    }
    return {
      allocation,
      ages
    };
  });
  if (restored.allocation !== targetAllocation || Object.entries(editedAges).some(([key, value]) => restored.ages[key] !== value)) {
    throw new Error(`scenario controls did not survive reload: ${JSON.stringify({
      editedAges,
      restored
    })}`);
  }
  await page.select('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]', before.allocationValue);
  await page.waitForFunction(value => document.querySelector('#scn-view .cmp-lev-select[data-scn-id="1"][data-lever-key="allocationPresetId"]')?.value === value && /Plan updated|Partial run/i.test(document.querySelector('#status')?.textContent || ''), {
    timeout: 30000
  }, before.allocationValue);
  for (const [key, original] of Object.entries(before.ageValues)) {
    const dir = editedAges[key] > original ? -1 : 1;
    await page.evaluate(({
      key,
      dir
    }) => {
      const button = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"][data-dir="${dir}"]`);
      if (!button) throw new Error(`scenario cleanup control is missing: ${key}/${dir}`);
      button.click();
    }, {
      key,
      dir
    });
    await page.waitForFunction(({
      householdId,
      key,
      original
    }) => {
      const value = document.querySelector(`#scn-view .cmp-step-btn[data-scn-id="1"][data-lever-key="${key}"]`)?.closest('.cmp-lev-row')?.querySelector('.cmp-lev-val')?.textContent.trim();
      const saved = JSON.parse(localStorage.getItem(`parallax.scenarios.${householdId}.v1`) || 'null');
      return Number(value) === original && saved?.[1]?.lev?.[key] === original;
    }, {
      timeout: 30000
    }, {
      householdId: withdrawalPlannerFixtureHouseholdId,
      key,
      original
    });
  }
  const goalsToggle = await page.$('#scn-view [data-goals-toggle]');
  if (goalsToggle && (await page.$eval('#scn-view [data-goals-toggle]', element => element.getAttribute('aria-expanded'))) !== 'true') {
    await goalsToggle.click();
    await page.waitForFunction(() => document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded') === 'true', {
      timeout: 10000
    });
  }
  await page.click('#scn-seg-focus');
  await page.waitForSelector('#scn-view .focus', {
    visible: true,
    timeout: 10000
  });
  const focusContract = await page.evaluate(() => {
    const bodyFontSize = getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim();
    const bodyFontWeight = getComputedStyle(document.documentElement).getPropertyValue('--fw-body').trim();
    const bodyLineHeight = getComputedStyle(document.documentElement).getPropertyValue('--lh-body').trim();
    const bodyLetterSpacing = getComputedStyle(document.documentElement).getPropertyValue('--ls-body').trim();
    const editorTypography = [...document.querySelectorAll('#scn-view .assum__value, #scn-view .assum__select')].map(element => {
      const style = getComputedStyle(element);
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing
      };
    });
    return {
      bodyFontSize,
      bodyFontWeight,
      bodyLineHeight,
      bodyLetterSpacing,
      editorTypography,
      removedDecisionControlCount: document.querySelectorAll('#scn-view [data-lever-key="sellAge"], #scn-view [data-key="sellAge"]').length,
      removedDecisionLabelCount: [...document.querySelectorAll('#scn-view .assum__label')].filter(element => /^Sell\s/i.test(element.textContent.trim())).length
    };
  });
  if (focusContract.removedDecisionControlCount !== 0 || focusContract.removedDecisionLabelCount !== 0 || focusContract.editorTypography.length === 0 || focusContract.editorTypography.some(role => role.fontSize !== focusContract.bodyFontSize || role.fontWeight !== focusContract.bodyFontWeight || role.lineHeight !== `${Number.parseFloat(focusContract.bodyFontSize) * Number.parseFloat(focusContract.bodyLineHeight)}px` || (Number.parseFloat(focusContract.bodyLetterSpacing) === 0 ? !['normal', '0px'].includes(role.letterSpacing) : role.letterSpacing !== focusContract.bodyLetterSpacing))) {
    throw new Error(`scenario Focus controls violate the removed-decision/type contract: ${JSON.stringify(focusContract)}`);
  }
  await page.click('#scn-seg-compare');
  await page.waitForSelector('#scn-view .compare', {
    visible: true,
    timeout: 10000
  });
}
