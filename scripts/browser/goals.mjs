// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { join } from 'node:path';
import { waitForWizard } from '../wizard-browser-contract.mjs';
import { goToWizardStep } from '../wizard-browser-contract.mjs';
import { selectHouseholdVisible } from '../wizard-browser-contract.mjs';
async function ensureGoalChooserOpen(page) {
  const expanded = await page.$eval(
    '.gh-add-toggle',
    button => button.getAttribute('aria-expanded'),
  );
  if(expanded !== 'true') await page.click('.gh-add-toggle');
  await page.waitForSelector('.gh-starter', {
    visible: true,
    timeout: 10000,
  });
}
export async function verifyGoalsTimeline({
  stableClick,
  page,
  OUT
}) {
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForFunction(() => document.querySelector('.gh-page .gh-card')
    && document.querySelector('.gh-page .gh-lane')
    && document.querySelector('.gh-add-toggle[aria-expanded="true"]')
    && document.querySelector('.gh-add-rail'), {
    timeout: 10000
  });
  const m = await page.evaluate(() => {
    const pageRoot = document.querySelector('.gh-page');
    const text = (pageRoot?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      page: !!pageRoot,
      card: !!document.querySelector('.gh-card'),
      redundantTitle: !!document.querySelector('.gh-title'),
      lanes: document.querySelectorAll('.gh-lane').length,
      chips: document.querySelectorAll('.gh-chip').length,
      marks: document.querySelectorAll('.gh-band, .gh-diamond').length,
      ticks: document.querySelectorAll('.gh-tick').length,
      add: !!document.querySelector('.gh-add-toggle'),
      addExpanded: document.querySelector('.gh-add-toggle')?.getAttribute('aria-expanded'),
      addRail: !!document.querySelector('.gh-add-rail[aria-label="Add a goal"]'),
      editorRails: document.querySelectorAll('[data-goal-rail]').length,
      starters: [...document.querySelectorAll('.gh-starter')].map(element => element.dataset.addCategory),
      lifetime: /Lifetime goal spend|Lifetime total|Lifetime/i.test(text),
      legacy: !!document.querySelector('#gl-ledger, .glx-row, .glc-card, .ga-board'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  if (!m.page || !m.card) throw new Error('Goals Horizon page/card did not render');
  if (m.redundantTitle) throw new Error('Goals Horizon rendered a redundant standalone title');
  if (m.lanes < 1 || m.chips !== m.lanes || m.marks !== m.lanes) throw new Error(`Goals Horizon lanes incomplete (${JSON.stringify(m)})`);
  if (m.ticks < 5 || !m.add) throw new Error(`Goals Horizon axis/add control incomplete (${JSON.stringify(m)})`);
  if (m.addExpanded !== 'true' || !m.addRail || m.editorRails !== 0 || JSON.stringify(m.starters) !== JSON.stringify(['travel', 'home', 'vehicle', 'education', 'family', 'giving', 'health', 'custom'])) {
    throw new Error(`Goals Horizon did not open with the exact goal category chooser (${JSON.stringify(m)})`);
  }
  if (m.lifetime) throw new Error('Goals Horizon must not render Lifetime goal spend');
  if (m.legacy) throw new Error('retired Goals implementation still renders');
  if (m.overflow > 2) throw new Error(`Goals Horizon caused ${m.overflow}px document overflow`);
  await page.screenshot({
    path: join(OUT, '02-goals.png'),
    fullPage: true
  });
}
export async function verifyGoalsEditing({
  stableClick,
  page,
  withdrawalPlannerFixtureHouseholdId,
  VERIFIED_ARTIFACT
}) {
  await stableClick('.htab[data-page="household"]');
  await waitForWizard(page, {
    householdId: withdrawalPlannerFixtureHouseholdId
  });
  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForSelector('.gh-lane', {
    visible: true
  });
  const before = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
  await ensureGoalChooserOpen(page);
  const starters = await page.evaluate(() => document.querySelectorAll('.gh-starter').length);
  if (starters !== 8) throw new Error(`expected 8 goal starters, got ${starters}`);
  await page.click('.gh-starter[data-add-category="travel"]');
  await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count, {
    timeout: 10000
  }, before + 1);
  let m = await page.evaluate(() => ({
    lanes: document.querySelectorAll('.gh-lane').length,
    rail: !!document.querySelector('.gh-rail'),
    name: document.querySelector('.gh-name-input')?.value || '',
    amount: document.querySelector('.gh-amount-input')?.value || '',
    status: document.querySelector('#status')?.textContent || ''
  }));
  if (m.lanes !== before + 1 || !m.rail || m.name !== 'Travel' || m.amount !== '10,000') throw new Error(`Travel starter did not create the expected editable lane (${JSON.stringify(m)})`);
  if (!/Saved automatically/.test(m.status)) throw new Error(`goal add did not confirm automatic save: "${m.status}"`);
  await page.click('.gh-name-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('European summers');
  await page.click('.gh-amount-input');
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type('24000');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '24,000');
  m = await page.evaluate(() => ({
    railName: document.querySelector('.gh-name-input')?.value,
    chipName: [...document.querySelectorAll('.gh-chip__name')].some(el => el.textContent === 'European summers'),
    amount: document.querySelector('.gh-amount-input')?.value,
    chipAmount: [...document.querySelectorAll('.gh-chip__amount')].find(el => el.closest('.gh-chip')?.querySelector('.gh-chip__name')?.textContent === 'European summers')?.textContent
  }));
  if (m.railName !== 'European summers' || !m.chipName || m.amount !== '24,000' || !/24k/.test(m.chipAmount || '')) throw new Error(`live goal editing failed (${JSON.stringify(m)})`);
  await page.click('[data-action="per-month"]');
  await page.waitForFunction(() => document.querySelector('.gh-amount-input')?.value === '2,000');
  m = await page.evaluate(() => ({
    amount: document.querySelector('.gh-amount-input')?.value,
    monthly: document.querySelector('[data-action="per-month"]')?.classList.contains('is-selected')
  }));
  if (m.amount !== '2,000' || !m.monthly) throw new Error(`monthly cadence conversion failed (${JSON.stringify(m)})`);
  await page.click('[data-action="kind-once"]');
  await page.waitForSelector('[data-field="once-age"]', {
    visible: true
  });
  if (!(await page.evaluate(() => !!document.querySelector('[data-field="once-age"]')))) throw new Error('one-time cadence did not expose a single age control');
  await page.click('[data-action="kind-rec"]');
  await page.waitForSelector('[data-field="start-age"]', {
    visible: true
  });
  if (!(await page.evaluate(() => !!document.querySelector('[data-field="start-age"]') && !!document.querySelector('[data-field="end-age"]')))) throw new Error('recurring cadence did not restore a range');
  await page.click('[data-action="preset"][data-preset="later"]');
  await page.waitForFunction(() => document.querySelector('[data-action="preset"][data-preset="later"]')?.classList.contains('is-selected'));
  m = await page.evaluate(() => ({
    start: document.querySelector('[data-field="start-age"]')?.value,
    end: document.querySelector('[data-field="end-age"]')?.value
  }));
  if (!m.start || !m.end || +m.start >= +m.end) throw new Error(`later preset produced an invalid range (${JSON.stringify(m)})`);
  await page.click('[data-action="category"][data-category="home"]');
  await page.waitForFunction(artifactId => {
    const icon = document.querySelector('.gh-rail__icon img');
    const src = icon?.getAttribute('src');
    if (!src) return false;
    const iconUrl = new URL(src, location.href);
    return iconUrl.pathname.endsWith('/assets/goals-horizon/home.svg') && iconUrl.searchParams.get('v') === artifactId && icon.complete && icon.naturalWidth > 0;
  }, {
    timeout: 8000
  }, VERIFIED_ARTIFACT.manifest.artifactId);
  const beforeDuplicate = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
  await page.click('[data-action="duplicate"]');
  await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count, {
    timeout: 10000
  }, beforeDuplicate + 1);
  m = await page.evaluate(() => ({
    lanes: document.querySelectorAll('.gh-lane').length,
    name: document.querySelector('.gh-name-input')?.value || ''
  }));
  if (m.lanes !== beforeDuplicate + 1 || !m.name.endsWith(' copy')) throw new Error(`duplicate failed (${JSON.stringify(m)})`);
  await page.click('[data-action="delete"]');
  await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count && document.querySelector('.gh-toast'), {
    timeout: 10000
  }, beforeDuplicate);
  m = await page.evaluate(() => ({
    lanes: document.querySelectorAll('.gh-lane').length,
    toast: document.querySelector('.gh-toast')?.textContent || ''
  }));
  if (m.lanes !== beforeDuplicate || !/Undo/.test(m.toast)) throw new Error(`delete/toast failed (${JSON.stringify(m)})`);
  await page.click('[data-action="undo"]');
  await page.waitForFunction(count => document.querySelectorAll('.gh-lane').length === count, {
    timeout: 10000
  }, beforeDuplicate + 1);
  const restoredLaneCount = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
  if (restoredLaneCount !== beforeDuplicate + 1) throw new Error('undo did not restore the deleted goal');
  await page.waitForFunction(expected => {
    const id = localStorage.getItem('parallax.activeHouseholdId');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return Array.isArray(db?.[id]?.goals) && db[id].goals.length === expected;
  }, {
    timeout: 10000
  }, restoredLaneCount);
}
export async function prepareScenarioFamily({
  stableClick,
  page,
  withdrawalPlannerFixtureHouseholdId
}) {
  await stableClick('.htab[data-page="household"]');
  await waitForWizard(page, {
    householdId: withdrawalPlannerFixtureHouseholdId
  });
  await goToWizardStep(page, 'family');
  const commitFamilyValue = async (selector, value) => {
    const before = await page.$eval('[data-hh-wizard-root]', root => Number(root.dataset.renderRevision || -1));
    const count = await page.$$eval(selector, elements => elements.length);
    if (count !== 1) {
      throw new Error(`Family fixture control must resolve once (${selector}: ${count})`);
    }
    await page.evaluate(({
      selector,
      value
    }) => {
      const control = document.querySelector(selector);
      control.value = String(value);
      control.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }, {
      selector,
      value
    });
    await waitForWizard(page, {
      step: 'family',
      afterRevision: before
    });
  };
  const readFixtureTiming = () => page.evaluate(householdId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const household = db?.[householdId]?.household;
    return {
      active: localStorage.getItem('parallax.activeHouseholdId'),
      primary: household?.primary ? {
        currentAge: household.primary.currentAge,
        retirementAge: household.primary.retirementAge,
        planEndAge: household.primary.planEndAge
      } : null,
      spouse: household?.spouse ? {
        currentAge: household.spouse.currentAge,
        retirementAge: household.spouse.retirementAge,
        planEndAge: household.spouse.planEndAge
      } : null
    };
  }, withdrawalPlannerFixtureHouseholdId);
  const assertFixtureTiming = async stage => {
    const timing = await readFixtureTiming();
    if (timing.active !== withdrawalPlannerFixtureHouseholdId || timing.primary?.currentAge !== 64 || timing.primary?.retirementAge !== 70 || timing.primary?.planEndAge !== 96 || timing.spouse?.currentAge !== 63 || timing.spouse?.retirementAge !== 68 || timing.spouse?.planEndAge !== 96) {
      throw new Error(`retirement-relative fixture timing drifted ${stage}: ${JSON.stringify(timing)}`);
    }
  };
  // This contract exercises retirement-relative scenario goals, so keep the
  // fixture decisively pre-retirement. The semantic wizard contract already
  // covers physical typing; this Scenarios setup uses the same delegated
  // production change path without relying on keyboard focus behavior.
  await commitFamilyValue('[data-wizard-field="filingStatus"]', 'marriedFilingJointly');
  await commitFamilyValue('[data-wizard-field="client.retirementAge"]', 70);
  await commitFamilyValue('[data-wizard-field="client.planEndAge"]', 96);
  await commitFamilyValue('[data-birth-date-group="spouse"] [data-birth-date-value]', '1963-01-15');
  await commitFamilyValue('[data-wizard-field="spouse.retirementAge"]', 68);
  await commitFamilyValue('[data-wizard-field="spouse.planEndAge"]', 96);
  await assertFixtureTiming('after visible Family edits');
  return assertFixtureTiming;
}

export async function verifyGoalsDrag({ stableClick, page, withdrawalPlannerFixtureHouseholdId }) {
  const assertFixtureTiming = await prepareScenarioFamily({ stableClick, page, withdrawalPlannerFixtureHouseholdId });
  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForSelector('.gh-page', {
    visible: true,
    timeout: 8000
  });
  const target = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.gh-chip')].find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'));
    if (!chip) return null;
    const rect = chip.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      title: chip.title
    };
  });
  if (!target) throw new Error('drag target missing');
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x - 100, target.y, {
    steps: 8
  });
  await page.mouse.up();
  await page.waitForFunction(previousTitle => {
    const chip = [...document.querySelectorAll('.gh-chip')].find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'));
    return chip?.title && chip.title !== previousTitle;
  }, {
    timeout: 8000
  }, target.title);
  const after = await page.evaluate(() => [...document.querySelectorAll('.gh-chip')].find(el => el.querySelector('.gh-chip__name')?.textContent.includes('European summers'))?.title || '');
  if (after === target.title || !/Every year, ages/.test(after)) throw new Error(`goal drag did not shift the recurring range ("${target.title}" -> "${after}")`);
  await assertFixtureTiming('after Goals drag');
  const laneCount = await page.evaluate(() => document.querySelectorAll('.gh-lane').length);
  await stableClick('button[data-page="scenarios"]');
  await page.waitForSelector('#scn-view', {
    visible: true,
    timeout: 15000
  });
  await page.click('#scn-seg-compare');
  let scenarioColumnCount = await page.evaluate(() => document.querySelectorAll('#scn-view .scol__name').length);
  while (scenarioColumnCount < 3) {
    await stableClick('#scn-add');
    scenarioColumnCount += 1;
    await page.waitForFunction(expected => document.querySelectorAll('#scn-view .scol__name').length >= expected, {
      timeout: 15000
    }, scenarioColumnCount);
  }
  try {
    await page.waitForFunction(expected => {
      const toggle = document.querySelector('#scn-view [data-goals-toggle]');
      const names = document.querySelectorAll('#scn-view .goal-detail__name');
      const inputs = document.querySelectorAll('#scn-view .cmp-goal-in');
      const runButton = document.querySelector('#run-btn');
      const status = document.querySelector('#status')?.textContent || '';
      const medians = [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim());
      return runButton && !runButton.disabled && /Plan updated|Partial run/i.test(status) && toggle?.getAttribute('aria-expanded') === 'true' && names.length === expected && inputs.length >= expected && medians.length > 0 && medians.every(value => /^\$[\d,.]+[KMB]?$/.test(value));
    }, {
      timeout: 10000
    }, laneCount);
  } catch (error) {
    const observed = await page.evaluate(() => ({
      householdId: document.querySelector('[data-hh-wizard-root]')?.dataset.householdId ?? null,
      expanded: document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded') ?? null,
      names: [...document.querySelectorAll('#scn-view .goal-detail__name')].map(element => element.textContent.trim()),
      inputs: document.querySelectorAll('#scn-view .cmp-goal-in').length,
      medians: [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim()),
      status: document.querySelector('#status')?.textContent.trim() ?? null
    }));
    throw new Error(`Goals did not reach ready Scenarios view: ${JSON.stringify({
      laneCount,
      observed
    })}`, {
      cause: error
    });
  }
  const scenarioGoals = await page.evaluate(() => {
    const text = document.querySelector('#scn-view .goal-pill, #scn-view .goal-note')?.textContent || '';
    return {
      active: +(text.match(/(\d+)\s*active/)?.[1] || -1),
      expanded: document.querySelector('#scn-view [data-goals-toggle]')?.getAttribute('aria-expanded'),
      details: [...document.querySelectorAll('#scn-view .goal-detail__name')].map(element => element.textContent.trim()),
      medians: [...document.querySelectorAll('#scn-view .scol__median b')].map(element => element.textContent.trim())
    };
  });
  if (scenarioGoals.active !== laneCount || scenarioGoals.details.length !== laneCount || scenarioGoals.medians.some(value => !/^\$[\d,.]+[KMB]?$/.test(value))) {
    throw new Error(`Goals Horizon details did not reach Scenarios (${laneCount} lanes / ${JSON.stringify(scenarioGoals)})`);
  }
}
export async function verifyStarterGoals({
  page,
  stableClick,
  withdrawalPlannerFixtureHouseholdId
}) {
  await goToWizardStep(page, 'family');
  const beforeNew = await page.$eval('[data-hh-wizard-root]', element => Number(element.dataset.renderRevision));
  await stableClick('#hh-menu-btn');
  await stableClick('#hh-new');
  await waitForWizard(page, {
    afterRevision: beforeNew
  });
  await page.waitForFunction(() => {
    const id = localStorage.getItem('parallax.activeHouseholdId');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    return id && Boolean(db?.[id]);
  }, {
    timeout: 10000
  });
  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForSelector('.gh-page', {
    visible: true,
    timeout: 8000
  });
  let m = await page.evaluate(() => ({
    lanes: document.querySelectorAll('.gh-lane').length,
    names: [...document.querySelectorAll('.gh-chip__name')].map(element => element.textContent.trim()),
    amounts: [...document.querySelectorAll('.gh-chip__amount')].map(element => element.textContent.trim()),
    lifetime: /Lifetime/i.test(document.querySelector('.gh-page')?.textContent || '')
  }));
  if (m.lanes !== 2 || JSON.stringify(m.names) !== JSON.stringify(['Essentials', 'Healthcare']) || JSON.stringify(m.amounts) !== JSON.stringify(['$0 / yr', '$5.5k / yr']) || m.lifetime) {
    throw new Error(`new-household Goals Horizon system goals are wrong (${JSON.stringify(m)})`);
  }
  await ensureGoalChooserOpen(page);
  await page.click('.gh-starter[data-add-category="home"]');
  await page.waitForSelector('.gh-lane', {
    visible: true,
    timeout: 8000
  });
  m = await page.evaluate(() => ({
    lanes: document.querySelectorAll('.gh-lane').length,
    name: document.querySelector('.gh-name-input')?.value,
    age: document.querySelector('[data-field="once-age"]')?.value
  }));
  if (m.lanes !== 3 || m.name !== 'Home improvements' || m.age !== '68') throw new Error(`new-household starter did not derive from its 65 retirement age (${JSON.stringify(m)})`);
  await goToWizardStep(page, 'family');
  await stableClick('#hh-menu-btn');
  await selectHouseholdVisible(page, withdrawalPlannerFixtureHouseholdId);
  await page.click('.htab[data-sub-target="goals"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.gh-chip__name')].some(element => element.textContent.includes('European summers')), {
    timeout: 8000
  });
  const restored = await page.evaluate(() => [...document.querySelectorAll('.gh-chip__name')].map(el => el.textContent));
  if (!restored.includes('European summers') || !restored.some(name => name.endsWith(' copy'))) throw new Error(`saved custom Goals Horizon inventory did not persist (${JSON.stringify(restored)})`);
}
