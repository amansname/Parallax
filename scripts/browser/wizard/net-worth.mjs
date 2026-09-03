// Wizard browser contract: net worth.
import { requireCondition } from './assertions.mjs';
import { setWizardValue, clickWizardAction, openNetWorthCategory, reloadWizard } from './actions.mjs';
async function addNetWorthShellEntry(page, {
  categoryId,
  type,
  name,
  value,
  expectedValue,
  custom = false,
  openMore = false,
  tax = ''
}) {
  await openNetWorthCategory(page, categoryId);
  if (openMore) {
    await clickWizardAction(page, '[data-hh-action="net-worth-toggle-more"]');
  }
  if (custom) {
    await clickWizardAction(page, `[data-hh-action="net-worth-pick-custom"][data-category-id="${categoryId}"]`);
    await setWizardValue(page, '[data-net-worth-draft="type"]', type, {
      expectRevision: false,
      eventType: 'input'
    });
  } else {
    await clickWizardAction(page, `[data-hh-action="net-worth-pick-type"][data-category-id="${categoryId}"][data-type-label="${type}"]`);
  }
  await setWizardValue(page, '[data-net-worth-draft="name"]', name, {
    expectRevision: false,
    eventType: 'input'
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'client', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', value, {
    expectRevision: false,
    eventType: 'input'
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const matches = await page.evaluate(expectedName => [...document.querySelectorAll('.nw-saved-row')].flatMap(row => {
    const savedName = row.querySelector('.nw-saved-name')?.textContent.trim() || '';
    if (savedName !== expectedName) return [];
    const remove = row.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="shell"]');
    return [{
      id: remove?.dataset.shellId || '',
      name: savedName,
      meta: row.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    }];
  }), name);
  requireCondition(matches.length === 1 && matches[0].id && matches[0].value === expectedValue && matches[0].meta.includes(type) && matches[0].meta.includes('Client') && matches[0].meta.includes('Net worth only') && matches[0].meta.includes('not projected') && (!tax || matches[0].meta.includes(tax)), `Net Worth shell entry did not save exact visible truth: ${JSON.stringify(matches)}`);
  return matches[0].id;
}
export async function verifyNetWorthFlow(page) {
  await openNetWorthCategory(page, 'bank');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-account-type-id="checking"]');
  const accountDraft = await page.evaluate(() => ({
    name: document.querySelectorAll('[data-net-worth-draft="name"]').length,
    owner: document.querySelectorAll('[data-net-worth-draft="owner"]').length,
    value: document.querySelectorAll('[data-net-worth-draft="value"]').length,
    saveDisabled: document.querySelector('[data-hh-action="net-worth-save-entry"]')?.disabled === true,
    ownerRequired: document.querySelector('[data-hh-action="net-worth-save-entry"]')?.dataset.netWorthOwnerRequired || ''
  }));
  requireCondition(accountDraft.name === 1 && accountDraft.owner === 1 && accountDraft.value === 1 && accountDraft.saveDisabled && accountDraft.ownerRequired === 'true', `Net Worth canonical account draft is unsafe: ${JSON.stringify(accountDraft)}`);
  await setWizardValue(page, '[data-net-worth-draft="name"]', 'Verifier checking', {
    expectRevision: false,
    eventType: 'input'
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'client', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '250000.75', {
    expectRevision: false,
    eventType: 'input'
  });
  const formattedAccount = await page.evaluate(() => ({
    value: document.querySelector('[data-net-worth-draft="value"]')?.value || '',
    saveDisabled: document.querySelector('[data-hh-action="net-worth-save-entry"]')?.disabled === true
  }));
  requireCondition(formattedAccount.value === '$250,000.75' && !formattedAccount.saveDisabled, `Net Worth account draft did not become savable: ${JSON.stringify(formattedAccount)}`);
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const account = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.nw-saved-row')].find(candidate => (
      candidate.querySelector('.nw-saved-name')?.textContent.trim() === 'Verifier checking'
    ));
    const remove = row?.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]');
    return {
      id: remove?.dataset.accountId || '',
      count: document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="account"]').length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    };
  });
  requireCondition(account.count === 1 && account.id && account.name === 'Verifier checking' && account.meta.includes('Checking') && account.meta.includes('Client') && account.value === '$250,001', `Net Worth account did not save canonical truth: ${JSON.stringify(account)}`);
  await page.waitForFunction(expectedId => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active]?.portfolio?.extraAccounts?.find(item => item.id === expectedId);
    return saved?.balance === 250001;
  }, {
    timeout: 10000
  }, account.id);
  await reloadWizard(page);
  await openNetWorthCategory(page, 'bank');
  const persistedAccountValue = await page.$eval(`[data-hh-action="net-worth-remove-entry"][data-entry-source="account"][data-account-id="${account.id}"]`, button => button.closest('.nw-saved-row')?.querySelector('.nw-saved-actions span')?.textContent.trim() || '');
  requireCondition(persistedAccountValue === '$250,001', `Canonical account value changed after reload: "${persistedAccountValue}"`);
  await openNetWorthCategory(page, 'property');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-type-label="Second Home"]');
  await setWizardValue(page, '[data-net-worth-draft="name"]', 'Verifier lake house', {
    expectRevision: false,
    eventType: 'input'
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'joint', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '500000.25', {
    expectRevision: false,
    eventType: 'input'
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const property = await page.evaluate(() => {
    const remove = document.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]');
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]').length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    };
  });
  requireCondition(property.count === 1 && property.name === 'Verifier lake house' && property.meta === 'Second Home \u00b7 Joint' && property.value === '$500,000', `Property display metadata did not save canonical truth: ${JSON.stringify(property)}`);
  await openNetWorthCategory(page, 'mortgage');
  await clickWizardAction(page, '[data-hh-action="net-worth-pick-type"][data-type-label="Second Home"]');
  const autoLink = await page.evaluate(() => ({
    value: document.querySelector('[data-net-worth-draft="link"]')?.value || '',
    label: document.querySelector('[data-net-worth-draft="link"]')?.selectedOptions?.[0]?.textContent.trim() || '',
    available: document.querySelector('[data-hh-action="net-worth-save-entry"]')?.dataset.netWorthResolvedLinkAvailable || ''
  }));
  requireCondition(autoLink.value === '0' && autoLink.label === 'Verifier lake house' && autoLink.available === 'true', `Saved property was not mortgage-linkable by name: ${JSON.stringify(autoLink)}`);
  await setWizardValue(page, '[data-net-worth-draft="name"]', 'Verifier lender', {
    expectRevision: false,
    eventType: 'input'
  });
  await setWizardValue(page, '[data-net-worth-draft="owner"]', 'joint', {
    expectRevision: false
  });
  await setWizardValue(page, '[data-net-worth-draft="value"]', '120000.75', {
    expectRevision: false,
    eventType: 'input'
  });
  await clickWizardAction(page, '[data-hh-action="net-worth-save-entry"]');
  const mortgage = await page.evaluate(() => {
    const remove = document.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]');
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]').length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    };
  });
  requireCondition(mortgage.count === 1 && mortgage.name === 'Verifier lender' && mortgage.meta === 'Second Home \u00b7 Joint \u00b7 Verifier lake house' && mortgage.value === '$120,001', `Mortgage did not preserve its exact metadata/link: ${JSON.stringify(mortgage)}`);
  const shellSpecs = [{
    categoryId: 'investment',
    type: 'Trust',
    name: 'Verifier trust',
    value: '100000',
    expectedValue: '$100,000',
    openMore: true,
    tax: 'Taxable'
  }, {
    categoryId: 'insurance',
    type: 'Whole Life',
    name: 'Verifier insurance',
    value: '50000',
    expectedValue: '$50,000'
  }, {
    categoryId: 'card',
    type: 'Revolving',
    name: 'Verifier card',
    value: '5000',
    expectedValue: '$5,000'
  }, {
    categoryId: 'loan',
    type: 'Auto',
    name: 'Verifier loan',
    value: '20000',
    expectedValue: '$20,000'
  }, {
    categoryId: 'bank',
    type: 'Custom bank record',
    name: 'Verifier custom bank',
    value: '3000',
    expectedValue: '$3,000',
    custom: true,
    openMore: true
  }];
  for (const spec of shellSpecs) {
    spec.id = await addNetWorthShellEntry(page, spec);
  }
  await page.waitForFunction(expected => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const plan = db?.[active];
    const shell = plan?.netWorth?.shellEntries || [];
    const property = db?.[active]?.properties?.[0];
    return expected.every(item => shell.some(entry => entry.id === item.id && entry.categoryId === item.categoryId && entry.name === item.name && entry.type === item.type && entry.owner === 'client' && entry.value === Number(item.value) && entry.projectionTreatment === 'net-worth-only')) && property?.name === 'Verifier lake house' && property?.value === 500000 && property?.netWorthMeta?.type === 'Second Home' && property?.netWorthMeta?.owner === 'joint' && property?.mortgage?.balance === 120001 && property?.mortgage?.netWorthMeta?.present === true && property?.mortgage?.netWorthMeta?.name === 'Verifier lender' && property?.mortgage?.netWorthMeta?.type === 'Second Home' && property?.mortgage?.netWorthMeta?.owner === 'joint';
  }, {
    timeout: 10000
  }, shellSpecs);
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  const entryTotals = await page.evaluate(() => {
    const readOne = selector => {
      const nodes = [...document.querySelectorAll(selector)];
      return {
        count: nodes.length,
        text: nodes[0]?.textContent.trim() || ''
      };
    };
    const category = id => readOne(`[data-hh-action="net-worth-open-category"][data-category-id="${id}"] .nw-tile-copy > span`);
    return {
      railCount: document.querySelectorAll('.nw-rail').length,
      railTotal: readOne('.nw-rail > strong'),
      continueActions: document.querySelectorAll('.nw-rail-actions [data-hh-action="step-next"]').length,
      backActions: document.querySelectorAll('.nw-rail-actions [data-hh-action="step-back"]').length,
      categories: Object.fromEntries(['bank', 'investment', 'property', 'insurance', 'card', 'mortgage', 'loan'].map(id => [id, category(id)]))
    };
  });
  requireCondition(entryTotals.railCount === 1 && entryTotals.railTotal.count === 1 && entryTotals.railTotal.text === '$758,000' && entryTotals.continueActions === 1 && entryTotals.backActions === 1 && JSON.stringify(entryTotals.categories) === JSON.stringify({
    bank: {
      count: 1,
      text: '$253,001'
    },
    investment: {
      count: 1,
      text: '$100,000'
    },
    property: {
      count: 1,
      text: '$500,000'
    },
    insurance: {
      count: 1,
      text: '$50,000'
    },
    card: {
      count: 1,
      text: '$5,000'
    },
    mortgage: {
      count: 1,
      text: '$120,001'
    },
    loan: {
      count: 1,
      text: '$20,000'
    }
  }), `Net Worth entry totals did not reconcile exactly: ${JSON.stringify(entryTotals)}`);
  await reloadWizard(page);
  for (const spec of shellSpecs) {
    await openNetWorthCategory(page, spec.categoryId);
    const persistedShell = await page.evaluate(expected => [...document.querySelectorAll('.nw-saved-row')].flatMap(row => {
      const button = row.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="shell"]');
      if (button?.dataset.shellId !== expected.id) return [];
      return [{
        name: row.querySelector('.nw-saved-name')?.textContent.trim() || '',
        meta: row.querySelector('.nw-saved-meta')?.textContent.trim() || '',
        value: row.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
      }];
    }), spec);
    requireCondition(persistedShell.length === 1 && persistedShell[0].name === spec.name && persistedShell[0].value === spec.expectedValue && persistedShell[0].meta.includes(spec.type) && persistedShell[0].meta.includes('Net worth only') && persistedShell[0].meta.includes('not projected'), `Net Worth shell record changed after reload: ${JSON.stringify({
      spec,
      persistedShell
    })}`);
  }
  await openNetWorthCategory(page, 'property');
  const persistedProperty = await page.evaluate(() => {
    const remove = document.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]');
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="property"]').length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    };
  });
  requireCondition(persistedProperty.count === 1 && persistedProperty.name === 'Verifier lake house' && persistedProperty.meta === 'Second Home \u00b7 Joint' && persistedProperty.value === '$500,000', `Property metadata changed after reload: ${JSON.stringify(persistedProperty)}`);
  await openNetWorthCategory(page, 'mortgage');
  const persistedMortgage = await page.evaluate(() => {
    const remove = document.querySelector('[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]');
    const row = remove?.closest('.nw-saved-row');
    return {
      count: document.querySelectorAll('[data-hh-action="net-worth-remove-entry"][data-entry-source="mortgage"]').length,
      name: row?.querySelector('.nw-saved-name')?.textContent.trim() || '',
      meta: row?.querySelector('.nw-saved-meta')?.textContent.trim() || '',
      value: row?.querySelector('.nw-saved-actions span')?.textContent.trim() || ''
    };
  });
  requireCondition(persistedMortgage.count === 1 && persistedMortgage.name === 'Verifier lender' && persistedMortgage.meta === 'Second Home \u00b7 Joint \u00b7 Verifier lake house' && persistedMortgage.value === '$120,001', `Mortgage metadata changed after reload: ${JSON.stringify(persistedMortgage)}`);
  await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
  const reloadedEntry = await page.evaluate(() => {
    const rail = document.querySelector('.nw-rail');
    return {
      railCount: document.querySelectorAll('.nw-rail').length,
      total: rail?.querySelector(':scope > strong')?.textContent.trim() || '',
      continueActions: rail?.querySelectorAll('[data-hh-action="step-next"]').length || 0,
      backActions: rail?.querySelectorAll('[data-hh-action="step-back"]').length || 0
    };
  });
  requireCondition(reloadedEntry.railCount === 1 && reloadedEntry.total === '$758,000' && reloadedEntry.continueActions === 1 && reloadedEntry.backActions === 1, `Net Worth rail did not reconcile after reload: ${JSON.stringify(reloadedEntry)}`);
}
