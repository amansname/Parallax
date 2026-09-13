import { buildCurrentTaxBucketSnapshot } from '../planning/taxBuckets/buildCurrentTaxBucketSnapshot.js';
import {
  createHouseholdWizard,
  HOUSEHOLD_WIZARD_STEPS,
} from '../../ui/householdWizard.js';
import { escHtml } from '../../ui/dom.js';
import { refreshHouseholdFamilyFields, replaceHouseholdFinanceRail } from '../../ui/householdFamilyUpdates.js';
import { refreshHouseholdTaxFields, restoreHouseholdTaxFocus } from '../../ui/householdTaxUpdates.js';
import { syncHouseholdTaxChoices } from '../../ui/householdTaxChoices.js';
import { renderHouseholdCommitNotice } from '../../ui/householdCommitNotice.js';
import { createHouseholdPendingSavePresentation } from '../../ui/householdPendingSave.js';
import { createHouseholdMobilePresentation } from '../../ui/householdMobile.js';
import { getWizardAccountTypes } from './accountTypes.js';
import {
  buildWizardIncomeTaxSummary,
  readWizardTaxState,
} from './wizardIntake.js';

const $ = selector => document.querySelector(selector);

export const HOUSEHOLD_WIZARD_ACCOUNT_TYPES = getWizardAccountTypes();

const STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
  ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
  ['DC','District of Columbia'],
];

const STEP_IDS = HOUSEHOLD_WIZARD_STEPS.map(step => step.id);

export function createHouseholdWizardController({
  getPlan,
  getHouseholdsDb,
  getActiveHouseholdId,
  getSaveFailed = () => false,
  isStorageBlocked,
  renderBlockedRecoverySurfaces,
  syncRecoveryControls,
  canDeleteHousehold = () => false,
  onSwitchHousehold,
  onNewHousehold,
  onDeleteHousehold = () => {},
}){
  let stepId = 'family';
  let renderRevision = 0;
  let wizard;
  let refreshFailed = false;
  let previousTaxView = null;
  let pointerActive = false;
  let deferredTaxRender = false;
  let pointerFrame = null;
  const mobilePresentation = createHouseholdMobilePresentation();
  const syncPendingSave = createHouseholdPendingSavePresentation();
  const financeOverlayMedia = globalThis.matchMedia?.('(max-width: 1023px)');

  const state = {
    financeRailOpen: !financeOverlayMedia?.matches,
    financeOwner: financeOverlayMedia?.matches ? null : 'client',
    financeMode: 'savings',
    financeTypeId: null,
    financeSaveStatus: false,
    financeDraft: null,
    financePending: null,
    netWorthView: 'entry',
    netWorthPanelCategory: null,
    netWorthMoreOpen: false,
    netWorthDraft: null,
    taxView: 'simplified',
    optionalTaxItems: new Set(),
    optionalMenuOpen: false,
    explicitSavePending: null,
  };

  const uiState = {
    get explicitSavePending(){ return state.explicitSavePending; },
    set explicitSavePending(value){ state.explicitSavePending = value; },
    get refreshFailed(){ return refreshFailed; },
    set refreshFailed(value){ refreshFailed = value === true; syncCommitNotice(); },
    get stepId(){ return stepId; },
    get renderRevision(){ return renderRevision; },
    get financeRailOpen(){ return state.financeRailOpen; },
    set financeRailOpen(value){
      state.financeRailOpen = value === true;
      if(!state.financeRailOpen) clearFinanceDraft();
    },
    get financeOwner(){ return state.financeOwner; },
    set financeOwner(value){
      clearFinanceDraft();
      state.financeOwner = value === 'client' || value === 'spouse' ? value : null;
    },
    get financeMode(){ return state.financeMode; },
    set financeMode(value){
      clearFinanceDraft();
      state.financeMode = value === 'income' ? 'income' : 'savings';
    },
    get financeTypeId(){ return state.financeTypeId; },
    set financeTypeId(value){
      clearFinanceDraft();
      state.financeTypeId = value || null;
    },
    get financeSaveStatus(){ return state.financeSaveStatus; },
    set financeSaveStatus(value){ state.financeSaveStatus = value === true; },
    get financeDraft(){ return state.financeDraft; },
    set financeDraft(value){ state.financeDraft = value; },
    get financePending(){ return state.financePending; },
    set financePending(value){ state.financePending = value; },
    get netWorthView(){ return state.netWorthView; },
    set netWorthView(value){ state.netWorthView = value === 'summary' ? 'summary' : 'entry'; },
    get netWorthPanelCategory(){ return state.netWorthPanelCategory; },
    set netWorthPanelCategory(value){ state.netWorthPanelCategory = value || null; },
    get netWorthMoreOpen(){ return state.netWorthMoreOpen; },
    set netWorthMoreOpen(value){ state.netWorthMoreOpen = value === true; },
    get netWorthDraft(){ return state.netWorthDraft; },
    set netWorthDraft(value){ state.netWorthDraft = value; },
    get taxView(){ return state.taxView; },
    set taxView(value){ state.taxView = value === 'detailed' ? 'detailed' : 'simplified'; },
    get optionalTaxItems(){ return state.optionalTaxItems; },
    get optionalMenuOpen(){ return state.optionalMenuOpen; },
    set optionalMenuOpen(value){ state.optionalMenuOpen = value === true; },
  };

  function ensureWizard(){
    if(wizard) return wizard;
    wizard = createHouseholdWizard({
      get plan(){ return getPlan(); },
      uiState,
      states: STATES,
      accountTypes: HOUSEHOLD_WIZARD_ACCOUNT_TYPES,
      taxState: () => readWizardTaxState(getPlan()),
      taxBucketSnapshot: () => buildCurrentTaxBucketSnapshot(getPlan()),
      incomeTaxSummary: () => buildWizardIncomeTaxSummary(getPlan()),
    });
    return wizard;
  }

  function clearFinanceDraft(){
    state.financeDraft = null;
    state.financePending = null;
  }

  function resetTransient(){
    clearFinanceDraft();
    state.financeRailOpen = !financeOverlayMedia?.matches;
    state.financeOwner = financeOverlayMedia?.matches ? null : 'client';
    state.financeMode = 'savings';
    state.financeTypeId = null;
    state.financeSaveStatus = false;
    state.netWorthView = 'entry';
    state.netWorthPanelCategory = null;
    state.netWorthMoreOpen = false;
    state.netWorthDraft = null;
    state.optionalMenuOpen = false;
  }

  function resetForPlan(){
    refreshFailed = false;
    state.explicitSavePending = null;
    stepId = 'family';
    state.taxView = 'simplified';
    state.optionalTaxItems.clear();
    resetTransient();
  }

  function updateHouseholdControls(){
    const selector = $('#hh-switch');
    if(!selector) return;
    const db = getHouseholdsDb();
    const activeId = getActiveHouseholdId();
    const placeholder = `<option value="" disabled ${activeId ? '' : 'selected'}>Select household</option>`;
    selector.innerHTML = placeholder + Object.keys(db).map(id => {
      const meta = db[id]?.meta || {};
      const name = meta.name || meta.primaryName || 'Household';
      return `<option value="${escHtml(id)}" ${id === activeId ? 'selected' : ''}>${escHtml(name)}</option>`;
    }).join('');
    selector.value = activeId || '';
    const deleteButton = $('#hh-delete');
    if(deleteButton){
      const enabled = Boolean(activeId && canDeleteHousehold(activeId));
      deleteButton.disabled = !enabled;
      deleteButton.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
  }

  function updateSidebar(plan){
    const householdName = $('#hh-rail-name');
    if(householdName){
      householdName.textContent = getActiveHouseholdId()
        ? (plan.meta?.name || (plan.meta?.primaryName ? `${plan.meta.primaryName} household` : 'Household'))
        : '';
    }
    const progress = $('#hh-progress-copy');
    const index = STEP_IDS.indexOf(stepId);
    if(progress) progress.textContent = `Step ${index + 1} of ${STEP_IDS.length}`;
    const progressPercent = $('#hh-progress-percent');
    if(progressPercent){
      progressPercent.textContent = `${Math.round(((index + 1) / STEP_IDS.length) * 100)}%`;
    }
    const bar = $('#hh-progress-bar');
    if(bar) bar.style.width = `${((index + 1) / STEP_IDS.length) * 100}%`;
    const accountSummary = $('#hh-nav-summary-net-worth');
    if(accountSummary){
      const count = plan.portfolio?.extraAccounts?.length || 0;
      accountSummary.textContent = `${count} ${count === 1 ? 'account' : 'accounts'}`;
    }
  }

  function sync({ financeOnly = false, familyFieldsOnly = false } = {}){
    const view = $('#hh-view');
    const root = document.querySelector('[data-hh-wizard-root]');
    if(!view || !root) return;
    if(isStorageBlocked()){
      renderBlockedRecoverySurfaces();
      return;
    }
    // A blur commit can reveal a new tax row above the pressed target. Finish
    // that pointer gesture before changing its geometry or replacing chrome.
    if(pointerActive && stepId === 'tax' && root.dataset.wizardStep === 'tax'
        && root.dataset.householdId === getActiveHouseholdId()){
      deferredTaxRender = true;
      return;
    }
    deferredTaxRender = false;
    root.dataset.wizardReady = 'false';
    root.setAttribute('aria-busy', 'true');
    const plan = getPlan();
    const activeId = getActiveHouseholdId();
    const hasActiveHousehold = Boolean(activeId);
    if(financeOnly || familyFieldsOnly){
      if(stepId !== 'family' || root.dataset.householdId !== activeId || !hasActiveHousehold){
        throw new Error('Partial Family update requires the active household Family screen');
      }
      const householdWizard = ensureWizard();
      if(financeOnly) replaceHouseholdFinanceRail(view, householdWizard.renderFinanceRail());
      else {
        refreshHouseholdFamilyFields(view, householdWizard.render('family'));
        // Keep the household switcher mounted when an edit blurs into it.
        for(const option of $('#hh-switch')?.options || []){
          const meta = getHouseholdsDb()[option.value]?.meta;
          if(meta) option.textContent = meta.name || meta.primaryName || 'Household';
        }
        updateSidebar(plan);
      }
      finishRender(root, activeId, { familyRefreshed: !financeOnly });
      return;
    }
    const progress = document.querySelector('.hh-progress');
    const stepper = document.querySelector('.hh-stepper');
    const footer = $('#hh-wiz-footer');
    const menuButton = $('#hh-menu-btn');
    const menu = $('#hh-menu-pop');
    root.classList.toggle('is-unselected', !hasActiveHousehold);
    if(progress) progress.hidden = !hasActiveHousehold;
    if(stepper) stepper.hidden = !hasActiveHousehold;
    if(footer) footer.hidden = !hasActiveHousehold;
    if(menuButton){
      menuButton.hidden = !hasActiveHousehold;
      menuButton.setAttribute('aria-expanded', 'false');
    }
    if(menu) menu.hidden = hasActiveHousehold;
    updateHouseholdControls();

    if(!hasActiveHousehold){
      view.innerHTML = '';
      if(footer) footer.innerHTML = '';
      updateSidebar(plan);
      renderRevision += 1;
      root.dataset.wizardStep = '';
      root.dataset.renderRevision = String(renderRevision);
      root.dataset.householdId = '';
      root.dataset.wizardReady = 'true';
      root.setAttribute('aria-busy', 'false');
      mobilePresentation.sync(root);
      syncPendingSave(root, null);
      syncCommitNotice();
      syncRecoveryControls();
      return;
    }

    const householdWizard = ensureWizard();
    const taxView = stepId === 'tax' ? householdWizard.renderTaxView() : null;
    const html = taxView ? taxView.html : householdWizard.render(stepId);
    const sameTaxHousehold = stepId === 'tax' && root.dataset.householdId === activeId;
    const taxUpdate = sameTaxHousehold ? refreshHouseholdTaxFields(view, previousTaxView, taxView) : null;
    if(!taxUpdate) view.innerHTML = html;
    previousTaxView = taxView;
    if(footer && (root.dataset.wizardStep !== stepId || !footer.firstElementChild)){
      footer.innerHTML = householdWizard.footer(stepId);
    }

    for(const step of HOUSEHOLD_WIZARD_STEPS){
      const button = document.querySelector(`[data-hh-wizard-nav="${step.id}"]`);
      if(!button) continue;
      const active = step.id === stepId;
      const done = STEP_IDS.indexOf(step.id) < STEP_IDS.indexOf(stepId);
      button.classList.toggle('is-current', active);
      button.classList.toggle('is-done', done);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.setAttribute('aria-current', active ? 'step' : 'false');
    }
    updateSidebar(plan);
    finishRender(root, activeId);
    restoreHouseholdTaxFocus(taxUpdate, root);
  }

  function finishRender(root, activeId, { familyRefreshed = true } = {}){
    if(familyRefreshed) refreshFailed = false;
    renderRevision += 1;
    root.dataset.wizardStep = stepId;
    root.dataset.renderRevision = String(renderRevision);
    root.dataset.householdId = activeId;
    root.dataset.wizardReady = String(!refreshFailed);
    root.setAttribute('aria-busy', 'false');
    mobilePresentation.sync(root);
    syncPendingSave(root, state.explicitSavePending);
    syncCommitNotice();
    syncRecoveryControls();
    syncHouseholdTaxChoices(root);
  }

  function syncCommitNotice(){
    renderHouseholdCommitNotice(document.querySelector('[data-hh-wizard-root]'), {
      activeHouseholdId: getActiveHouseholdId(), saveFailed: getSaveFailed(), refreshFailed,
      explicitSavePending: state.explicitSavePending,
    });
  }

  function setStep(nextStepId){
    if(state.explicitSavePending) return false;
    if(!STEP_IDS.includes(nextStepId)) return false;
    stepId = nextStepId;
    resetTransient();
    sync();
    return true;
  }

  function navigate(direction){
    const index = STEP_IDS.indexOf(stepId);
    if(direction === 'back') return setStep(STEP_IDS[Math.max(0, index - 1)]);
    if(direction !== 'next') return false;
    if(index >= STEP_IDS.length - 1){
      const goals = document.querySelector('.htab[data-sub-target="goals"]');
      if(goals) goals.click();
      return true;
    }
    return setStep(STEP_IDS[index + 1]);
  }

  function bindRail(){
    document.addEventListener('pointerdown', event => {
      pointerActive = Boolean(event.target.closest?.('[data-hh-wizard-root]'));
    }, true);
    const finishPointer = () => {
      if(!pointerActive || pointerFrame !== null) return;
      // The next paint follows pointer-up, click, and native details toggling.
      // This is an interaction boundary, not a timeout used to hide a race.
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = null;
        pointerActive = false;
        if(deferredTaxRender){
          try { sync(); }
          catch(error){
            refreshFailed = true;
            const root = document.querySelector('[data-hh-wizard-root]');
            if(root){
              root.dataset.wizardReady = 'false';
              root.dataset.validationCode = 'WIZARD_REFRESH_FAILED';
              root.setAttribute('aria-busy', 'false');
            }
            syncCommitNotice();
            console.error('Household screen could not refresh after the edit:', error);
          }
        }
      });
    };
    document.addEventListener('pointerup', finishPointer, true);
    document.addEventListener('pointercancel', finishPointer, true);
    // Responsive CSS changes the rail's placement. Resizing never discards its
    // active owner, entry type or raw draft (including the tablet boundary).
    document.querySelectorAll('[data-hh-wizard-nav]').forEach(button =>
      button.addEventListener('click', () => setStep(button.dataset.hhWizardNav)));
    const menuButton = $('#hh-menu-btn');
    const menu = $('#hh-menu-pop');
    if(menuButton && menu){
      menuButton.addEventListener('click', event => {
        event.stopPropagation();
        const open = menu.hidden;
        menu.hidden = !open;
        menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', event => {
        if(!getActiveHouseholdId()){
          menu.hidden = false;
          return;
        }
        if(!menu.hidden && !menu.contains(event.target) && event.target !== menuButton){
          menu.hidden = true;
          menuButton.setAttribute('aria-expanded', 'false');
        }
      });
    }
    const switcher = $('#hh-switch');
    if(switcher) switcher.addEventListener('change', event => onSwitchHousehold(event.target.value));
    const newButton = $('#hh-new');
    if(newButton) newButton.addEventListener('click', () => onNewHousehold());
    const deleteButton = $('#hh-delete');
    if(deleteButton) deleteButton.addEventListener('click', () => onDeleteHousehold(getActiveHouseholdId()));
    updateHouseholdControls();
  }

  return {
    uiState,
    navigate,
    resetForPlan,
    setStep,
    sync,
    syncCommitNotice,
    updateHouseholdControls,
    bindRail,
  };
}
