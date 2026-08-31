// Wizard browser contract: autosave.
import { requireCondition } from './assertions.mjs';
import { goToWizardStep, reloadWizard } from './actions.mjs';
async function waitForAutoSave(page) {
  const saveCount = await page.$$eval('#save-btn', elements => elements.length);
  requireCondition(saveCount === 0, 'Manual Save control still rendered');
  await page.waitForFunction(() => {
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || []).filter(row => row?.typeId === 'wages' || row?.typeId === 'bonus').map(row => ({
      owner: row.owner,
      amount: row.amount
    }));
    return JSON.stringify(rows) === JSON.stringify([{
      owner: 'client',
      amount: 81000
    }, {
      owner: 'spouse',
      amount: 39000
    }]);
  }, {
    timeout: 10000
  });
}
export async function verifyAutoSaveReloadAndMemberWages(page) {
  await waitForAutoSave(page);
  await reloadWizard(page);
  await goToWizardStep(page, 'tax');
  const savedWages = await page.evaluate(() => {
    const client = document.querySelector('[data-tax-field="income.wages.client"]');
    const spouse = document.querySelector('[data-tax-field="income.wages.spouse"]');
    const db = JSON.parse(localStorage.getItem('parallax.households.v1') || 'null');
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const saved = db?.[active];
    const rows = (saved?.income?.other || []).filter(row => row?.typeId === 'wages' || row?.typeId === 'bonus').map(row => ({
      owner: row.owner,
      amount: row.amount
    }));
    return {
      client: client?.value || '',
      spouse: spouse?.value || '',
      clientDisabled: client?.disabled === true,
      spouseDisabled: spouse?.disabled === true,
      sourceButtons: document.querySelectorAll('[data-income-group="wages"]').length,
      rows,
      peopleFacts: {
        client: {
          retirementAge: saved?.household?.primary?.retirementAge,
          socialSecurityAge: saved?.income?.socialSecurity?.primary?.claimAge,
          socialSecurityBenefit: saved?.income?.socialSecurity?.primary?.pia,
          planEndAge: saved?.household?.primary?.planEndAge
        },
        spouse: {
          retirementAge: saved?.household?.spouse?.retirementAge,
          socialSecurityAge: saved?.income?.socialSecurity?.spouse?.claimAge,
          socialSecurityBenefit: saved?.income?.socialSecurity?.spouse?.pia,
          planEndAge: saved?.household?.spouse?.planEndAge
        }
      },
      storedAggregate: Object.prototype.hasOwnProperty.call(saved?.incomeTax?.current1040?.income || {}, 'wages')
    };
  });
  requireCondition(savedWages.client === '81,000' && savedWages.spouse === '39,000' && !savedWages.clientDisabled && !savedWages.spouseDisabled && savedWages.sourceButtons === 0, `Auto-save/reload lost member wages: ${JSON.stringify(savedWages)}`);
  requireCondition(JSON.stringify(savedWages.rows) === JSON.stringify([{
    owner: 'client',
    amount: 81000
  }, {
    owner: 'spouse',
    amount: 39000
  }]) && JSON.stringify(savedWages.peopleFacts) === JSON.stringify({
    client: {
      retirementAge: 68,
      socialSecurityAge: 67,
      socialSecurityBenefit: 32000,
      planEndAge: 94
    },
    spouse: {
      retirementAge: 70,
      socialSecurityAge: 69,
      socialSecurityBenefit: 22000,
      planEndAge: 101
    }
  }) && savedWages.storedAggregate === false, `Auto-saved wages did not use the member-owned contract: ${JSON.stringify(savedWages)}`);
}
export async function verifyDuplicateRepair(page) {
  await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const activeKey = 'parallax.activeHouseholdId';
    const db = JSON.parse(localStorage.getItem(dbKey) || 'null');
    const active = localStorage.getItem(activeKey);
    const plan = db?.[active];
    if (!plan) throw new Error('Active household is unavailable for repair fixture');
    const wage = {
      typeId: 'wages',
      owner: 'client',
      label: 'Wages or salary',
      amount: 90000,
      startAge: plan.household.primary.currentAge,
      endAge: plan.household.primary.retirementAge - 1,
      realGrowth: 0,
      taxablePct: 1
    };
    delete plan.meta.householdRecordSchemaVersion;
    delete plan.meta.legacyRepairArchive;
    plan.income.other = [structuredClone(wage), structuredClone(wage)];
    localStorage.setItem(dbKey, JSON.stringify(db));
  });
  await reloadWizard(page);
  const repaired = await page.evaluate(() => {
    const dbKey = 'parallax.households.v1';
    const active = localStorage.getItem('parallax.activeHouseholdId');
    const raw = localStorage.getItem(dbKey);
    const plan = JSON.parse(raw || 'null')?.[active];
    return {
      raw,
      rows: plan?.income?.other || [],
      archive: plan?.meta?.legacyRepairArchive || [],
      version: plan?.meta?.householdRecordSchemaVersion
    };
  });
  requireCondition(repaired.rows.length === 1 && typeof repaired.rows[0]?.id === 'string' && repaired.archive.length === 1 && repaired.archive[0]?.code === 'LEGACY_GPC_DUPLICATE_WAGE_REMOVED' && repaired.version === 2, `Legacy duplicate repair was not narrow/recoverable: ${JSON.stringify(repaired)}`);
  await reloadWizard(page);
  const secondRaw = await page.evaluate(() => localStorage.getItem('parallax.households.v1'));
  requireCondition(secondRaw === repaired.raw, 'Legacy duplicate repair was not byte-stable on the second reload');
}
