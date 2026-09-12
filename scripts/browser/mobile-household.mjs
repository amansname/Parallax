import assert from 'node:assert/strict';
import { join } from 'node:path';
import { selectHouseholdVisible, waitForWizard } from './wizard/actions.mjs';

const retirement = '[data-wizard-field="client.retirementAge"]';
const socialSecurity = '[data-wizard-field="client.socialSecurityAge"]';
const primaryName = '[data-wizard-field="primaryName"]';
const financeToggle = '[data-hh-action="toggle-finances-rail"]';

async function typeInto(page, selector, value){
  // A single real click followed by keyboard input exposes lost blur targets.
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
}

async function savedState(page, householdId){
  return page.evaluate(id => ({
    household: JSON.parse(localStorage.getItem('parallax.households.v1'))[id],
    scenarios: JSON.parse(localStorage.getItem(`parallax.scenarios.${id}.v1`)),
    householdBytes: localStorage.getItem('parallax.households.v1'),
    scenarioBytes: localStorage.getItem(`parallax.scenarios.${id}.v1`),
  }), householdId);
}

async function requireRetirementName(client){
  const { root } = await client.send('DOM.getDocument');
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: retirement });
  const { nodes } = await client.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  assert.equal(nodes[0]?.name?.value, 'Retires at', 'Inline error changed the retirement field accessible name');
}

async function requireFooterAction(page, householdId){
  const selector = '[data-hh-action="step-next"]';
  await page.$eval(selector, node => node.scrollIntoView({ block: 'center' }));
  const hit = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return node.contains(target) && rect.left >= 0 && rect.right <= innerWidth + 1
      && rect.top >= 0 && rect.bottom <= innerHeight + 1;
  });
  assert.equal(hit, true, 'Continue cannot receive a pointer action inside the viewport');
  await page.click(selector);
  await waitForWizard(page, { householdId, step: 'net-worth' });
  await page.click('[data-hh-wizard-nav="family"]');
  await waitForWizard(page, { householdId, step: 'family' });
}

async function requireFamilyContainment(page){
  const layout = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    controls: [...document.querySelectorAll('[data-hh-wizard-screen="family"] input:not([type="hidden"]), [data-hh-wizard-screen="family"] select')]
      .filter(node => node.getBoundingClientRect().height > 0).map(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, height: rect.height, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      }),
  }));
  assert.ok(layout.overflow <= 1, `Family document overflows by ${layout.overflow}px`);
  for(const control of layout.controls){
    assert.ok(control.left >= -1 && control.right <= layout.width + 1, 'Family control escapes viewport width');
    assert.ok(control.scrollHeight <= control.clientHeight + 1, 'Family control clips its enlarged text vertically');
  }
}

async function requireMobileInventory(page){
  const inventory = await page.evaluate(() => {
    const geometry = node => {
      const rect = node.getBoundingClientRect();
      return { height: rect.height, left: rect.left, right: rect.right };
    };
    const fields = [...document.querySelectorAll(
      '[data-hh-wizard-screen="family"] input:not([type="hidden"]), [data-hh-wizard-screen="family"] select',
    )].filter(node => node.getBoundingClientRect().height > 0);
    return {
      nav: [...document.querySelectorAll('.hdr__tabs .htab')].map(node => ({
        label: node.textContent.trim(), ...geometry(node),
      })),
      steps: [...document.querySelectorAll('[data-hh-wizard-nav]')].map(node => ({
        label: node.querySelector('strong').textContent.trim(), ...geometry(node),
      })),
      fields: fields.map(node => ({
        field: node.dataset.wizardField || node.dataset.hhField || 'birth-date',
        fontSize: parseFloat(getComputedStyle(node).fontSize), ...geometry(node),
      })),
      screenCount: document.querySelectorAll('[data-hh-wizard-screen]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: document.documentElement.clientWidth,
      footerPosition: getComputedStyle(document.querySelector('#hh-wiz-footer')).position,
    };
  });
  assert.deepEqual(inventory.nav.map(row => row.label), [
    'Household', 'Goals', 'Scenarios', 'Withdrawal planner', 'Sequencing',
  ]);
  assert.deepEqual(inventory.steps.map(row => row.label), ['Family', 'Net Worth', 'Tax', 'Summary']);
  assert.equal(inventory.screenCount, 1);
  assert.ok(inventory.overflow <= 1, `Mobile document overflows by ${inventory.overflow}px`);
  assert.equal(inventory.footerPosition, 'static');
  assert.ok(inventory.fields.some(row => row.field === 'client.retirementAge'));
  for(const row of [...inventory.nav, ...inventory.steps, ...inventory.fields]){
    assert.ok(row.height >= 44, `${row.label || row.field} height is ${row.height}px`);
    assert.ok(row.left >= -1 && row.right <= inventory.width + 1,
      `${row.label || row.field} escapes mobile width`);
  }
  for(const row of inventory.fields){
    assert.ok(row.fontSize >= 16, `${row.field} input font is ${row.fontSize}px`);
  }
}

export async function verifyMobileHousehold({ browser, url, screenshotDir }){
  const context = await browser.createBrowserContext();
  const pageErrors = [];
  try{
    const page = await context.newPage();
    const accessibility = await page.createCDPSession();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      const reportValidity = HTMLInputElement.prototype.reportValidity;
      window.__mobileHouseholdValidityCalls = 0;
      HTMLInputElement.prototype.reportValidity = function(...args){
        window.__mobileHouseholdValidityCalls += 1;
        return reportValidity.apply(this, args);
      };
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household', step: 'family' });

    // Runtime templates are temporary. Create a durable fixture visibly.
    await page.click('#hh-menu-btn');
    await page.click('#hh-new');
    await page.waitForFunction(() => {
      const id = document.querySelector('#hh-switch')?.value;
      const saved = JSON.parse(localStorage.getItem('parallax.households.v1') || '{}');
      return /^hh_/i.test(id || '') && Boolean(saved[id])
        && document.querySelector('[data-hh-wizard-root]')?.dataset.wizardReady === 'true';
    }, { timeout: 15000 });
    const householdId = await page.$eval('#hh-switch', control => control.value);
    await typeInto(page, primaryName, 'Mobile contract household');
    await page.click(retirement);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].meta.primaryName
        === 'Mobile contract household'
    ), {}, householdId);
    await typeInto(page, '[data-birth-date-group="client"] [data-birth-date-display]', '01011966');
    await page.click(retirement);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].taxProfiles.client.birthDate.value === '1966-01-01'
    ), {}, householdId);
    await requireMobileInventory(page);

    // Opening the finance controls must push Family down, not cover it.
    const beforeRail = await savedState(page, householdId);
    await page.click(financeToggle);
    await page.waitForFunction(() => document.querySelector(
      '[data-hh-action="toggle-finances-rail"]',
    )?.getAttribute('aria-expanded') === 'true');
    await page.click('[data-finances-person-owner="client"]');
    await page.waitForSelector('[data-finance-entry-panel]');
    const rail = await page.evaluate(() => {
      const element = document.querySelector('[data-finances-rail]');
      const people = document.querySelector('.hh-family-people');
      return {
        position: getComputedStyle(element).position,
        bottom: element.getBoundingClientRect().bottom,
        peopleTop: people.getBoundingClientRect().top,
        sourceCount: document.querySelectorAll('[data-finance-type-id]').length,
      };
    });
    assert.equal(rail.position, 'static');
    assert.ok(rail.bottom <= rail.peopleTop + 1, 'Finance rail overlaps Family fields');
    assert.equal(rail.sourceCount, 7);
    await page.click(financeToggle);
    await page.waitForFunction(() => document.querySelector(
      '[data-hh-action="toggle-finances-rail"]',
    )?.getAttribute('aria-expanded') === 'false');
    assert.deepEqual(await savedState(page, householdId), beforeRail,
      'Opening and closing finance presentation mutated saved data');

    const before = await savedState(page, householdId);
    assert.equal(before.household.household.primary.retirementAge, 65);
    assert.deepEqual(before.scenarios.map(scenario => scenario.lev.retireAge), [65, 67, 65]);
    const mountedRetirement = await page.$(retirement);
    const mountedNext = await page.$(socialSecurity);
    await requireRetirementName(accessibility);
    const revision = await page.$eval('[data-hh-wizard-root]', root => root.dataset.renderRevision);
    await typeInto(page, retirement, '44');
    await page.keyboard.press('Tab');
    await page.waitForSelector('[data-household-inline-error]');
    const invalid = await page.$eval(retirement, control => {
      const ids = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      const errors = ids.map(id => document.getElementById(id))
        .filter(node => node?.hasAttribute('data-household-inline-error'));
      return {
        invalid: control.getAttribute('aria-invalid'),
        messages: errors.map(node => node.textContent),
        roles: errors.map(node => node.getAttribute('role')),
        bubbleCalls: window.__mobileHouseholdValidityCalls,
        revision: document.querySelector('[data-hh-wizard-root]').dataset.renderRevision,
        status: document.querySelector('#status').textContent.trim(),
      };
    });
    assert.deepEqual(invalid, {
      invalid: 'true', messages: ['Enter a value from 45 through 90'],
      roles: ['alert'], bubbleCalls: 0, revision, status: 'Enter a value from 45 through 90',
    });
    await requireRetirementName(accessibility);
    assert.deepEqual(await savedState(page, householdId), before,
      'Rejected retirement age changed household or scenario bytes');
    await page.$eval('[data-household-inline-error]', element => element.scrollIntoView({ block: 'center' }));
    const errorBounds = await page.$eval('[data-household-inline-error]', element => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: document.documentElement.clientWidth, height: window.innerHeight,
      };
    });
    assert.ok(errorBounds.left >= 0 && errorBounds.right <= errorBounds.width + 1
      && errorBounds.top >= 0 && errorBounds.bottom <= errorBounds.height + 1,
    'Inline error is not fully reachable within the mobile viewport');
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-inline-error.png') });

    // Blank is also rejected by the domain boundary; it must not become saved zero.
    await page.click(retirement);
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Tab');
    await page.waitForSelector('[data-household-inline-error]');
    assert.equal(await page.$eval(retirement, control => control.value), '');
    assert.equal(await page.$eval('[data-household-inline-error]', node => node.textContent), 'Enter a value from 45 through 90');
    assert.deepEqual(await savedState(page, householdId), before, 'Blank retirement age changed saved data');
    await requireRetirementName(accessibility);

    await typeInto(page, retirement, '66');
    // One click must survive the blur commit; do not refocus the next field.
    await page.click(socialSecurity);
    await page.waitForFunction(id => (
      JSON.parse(localStorage.getItem('parallax.households.v1'))[id].household.primary.retirementAge === 66
    ), {}, householdId);
    assert.equal(await mountedRetirement.evaluate(control => (
      control === document.querySelector('[data-wizard-field="client.retirementAge"]')
    )), true, 'Retirement control was replaced during its commit');
    assert.equal(await mountedNext.evaluate(control => (
      control === document.querySelector('[data-wizard-field="client.socialSecurityAge"]')
        && document.activeElement === control
    )), true, 'The first next-field click was lost during the blur commit');
    const corrected = await page.$eval(retirement, control => ({
      invalid: control.getAttribute('aria-invalid'),
      validity: control.validationMessage,
      errorCount: document.querySelectorAll('[data-household-inline-error]').length,
      describedBy: control.getAttribute('aria-describedby'),
      bubbleCalls: window.__mobileHouseholdValidityCalls,
    }));
    assert.deepEqual(corrected, {
      invalid: null, validity: '', errorCount: 0, describedBy: null, bubbleCalls: 0,
    });
    await requireRetirementName(accessibility);
    assert.equal(await page.$eval('#status', node => node.textContent.trim()), 'Saved automatically · open Scenarios');
    const after = await savedState(page, householdId);
    const expectedHousehold = structuredClone(before.household);
    expectedHousehold.household.primary.retirementAge = 66;
    assert.deepEqual(after.household, expectedHousehold, 'Retirement edit altered unrelated household facts');
    assert.deepEqual(after.scenarios.map(scenario => scenario.lev.retireAge), [66, 68, 66]);
    for(const [index, scenario] of after.scenarios.entries()){
      const expectedScenario = structuredClone(before.scenarios[index]);
      expectedScenario.lev.retireAge += 1;
      // Blank-household pension quotes cap the linked pension age at 65.
      assert.deepEqual(scenario, expectedScenario, 'Retirement reseed altered unrelated scenario choices');
    }
    await requireMobileInventory(page);
    await page.$eval(primaryName, element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-family.png') });
    await mountedRetirement.dispose();
    await mountedNext.dispose();

    // Run through the visible navigation, then inspect the exact loaded artifact modules.
    const artifactId = await page.evaluate(() => {
      const script = document.querySelector('script[type="module"][src]');
      const direct = script && new URL(script.src, location.href).searchParams.get('v');
      const map = document.querySelector('script[type="importmap"]');
      const mapped = map && JSON.parse(map.textContent).imports?.['./src/main.js'];
      return direct || (mapped && new URL(mapped, location.href).searchParams.get('v')) || '';
    });
    assert.match(artifactId, /^[a-f0-9]{64}$/, 'Engine proof requires an immutable version-bound artifact');
    await page.click('.htab[data-page="scenarios"]');
    await page.waitForFunction(async version => {
      const stateUrl = new URL('./src/state.js', location.href);
      stateUrl.searchParams.set('v', version);
      const { uiState } = await import(stateUrl.href);
      return document.querySelector('.page.on')?.dataset.page === 'scenarios'
        && document.querySelector('#run-btn')?.disabled === false && uiState.plansDirty === false;
    }, { timeout: 30000 }, artifactId);
    const engineProof = await page.evaluate(async version => {
      const moduleUrl = path => {
        const target = new URL(path, location.href);
        target.searchParams.set('v', version);
        return target.href;
      };
      const [engine, configuration, state] = await Promise.all([
        import(moduleUrl('./engine.js')),
        import(moduleUrl('./src/scenarios/scenarioConfiguration.js')),
        import(moduleUrl('./src/state.js')),
      ]);
      return {
        dirty: state.uiState.plansDirty,
        visibleText: document.querySelector('#scn-view').innerText,
        probabilities: [...document.querySelectorAll('#scn-view .scol__prob')].map(node => node.textContent.trim()),
        rows: state.scenarios.map(scenario => {
          const resolved = engine.resolveInputs(configuration.planForScenario(scenario.lev), configuration.leversToOverrides(scenario.lev));
          return {
            retirement: resolved.retirementAge,
            simulationAvailable: resolved.simulationAvailable,
            simulationIssues: resolved.simulationIssues,
            runError: scenario.runError || null,
            hasResult: Boolean(scenario.res),
            successRate: scenario.res?.successRate ?? null,
            projectionStatus: scenario.res?.projectionStatus ?? null,
            issue: scenario.res?.issue ?? null,
          };
        }),
      };
    }, artifactId);
    assert.equal(engineProof.dirty, false);
    assert.deepEqual(engineProof.rows.map(row => row.retirement), [66, 68, 66]);
    assert.equal(engineProof.rows.length, 3);
    for(const [index, row] of engineProof.rows.entries()){
      if(row.runError){
        assert.ok(engineProof.visibleText.includes(row.runError), 'Scenario run error is not visible');
      }else if(row.hasResult && Number.isFinite(row.successRate)){
        assert.notEqual(row.projectionStatus, 'unavailable');
        assert.equal(engineProof.probabilities[index], `${row.successRate.toFixed(1)}%`,
          'Visible probability differs from the actual engine result');
      }else{
        assert.equal(row.simulationAvailable, false, 'Scenario has neither engine result nor explicit readiness issue');
        assert.ok(row.simulationIssues.length > 0);
        assert.match(engineProof.visibleText, /date of birth|required|incomplete|missing|enter.*age|add.*household/i,
          'Missing simulation facts have no actionable visible explanation');
      }
    }

    // All five existing destinations remain reachable by real navigation clicks.
    for(const destination of ['household', 'net-worth', 'scenarios', 'tax-buckets', 'sequencing']){
      await page.click(`.htab[data-page="${destination}"]`);
      await page.waitForFunction(expected => document.querySelector('.page.on')?.dataset.page === expected, {}, destination);
      assert.equal(await page.$eval(`.htab[data-page="${destination}"]`, button => button.getAttribute('aria-current')), 'page');
    }
    await page.click('.htab[data-page="household"]');
    await waitForWizard(page, { householdId, step: 'family' });

    for(const viewport of [{ width: 320, height: 568 }, { width: 760, height: 900 }, { width: 844, height: 390 }]){
      await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
      await requireFamilyContainment(page);
      await requireMobileInventory(page);
      await requireFooterAction(page, householdId);
    }
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    // Explicit 200% text fixture, not a claim of native OS text-size testing.
    const textScale = await page.addStyleTag({ content: `
      .hdr__tabs .htab, .app-header .status { font-size: 24px !important; }
      .hh-step strong, .hh-family-screen .hh-field > span { font-size: 28px !important; }
      .hh-family-screen input:not([type="hidden"]), .hh-family-screen select,
      .hh-family-screen button, #hh-wiz-footer button { font-size: 32px !important; }
    ` });
    await requireFamilyContainment(page);
    await requireMobileInventory(page);
    await requireFooterAction(page, householdId);
    await textScale.evaluate(node => node.remove());
    await textScale.dispose();
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    await accessibility.detach();

    // Reload deliberately chooses runtime startup. Explicitly reopen the saved fixture.
    await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
    await waitForWizard(page, { householdId: 'joe-household', step: 'family' });
    await selectHouseholdVisible(page, householdId);
    assert.equal(await page.$eval(retirement, control => control.value), '66');
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    assert.deepEqual((await savedState(page, householdId)).scenarios, after.scenarios);

    // Same browser storage, responsive desktop parity; this is not device sync.
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    assert.equal(await page.$eval(primaryName, control => control.value), 'Mobile contract household');
    assert.equal(await page.$eval(retirement, control => control.value), '66');
    assert.equal(await page.$$eval(retirement, controls => controls.length), 1);
    assert.deepEqual((await savedState(page, householdId)).household, after.household);
    assert.deepEqual((await savedState(page, householdId)).scenarios, after.scenarios);
    await page.screenshot({ path: join(screenshotDir, 'mobile-household-desktop-reopen.png') });
    assert.deepEqual(pageErrors, []);
  }finally{
    await context.close();
  }
}
