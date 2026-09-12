import { escHtml as esc } from './dom.js';
import { effectiveGoalForView, materializeGoalTiming } from './goalsTimingPresentation.js';
import { createMobileGoalDraft, applyMobileGoalDraft } from '../src/goals/mobileGoalDraft.js';
import {
  GOAL_CATEGORIES, GOAL_CATEGORY_MAP, createGoalForCategory, defaultGoalId,
  goalDisplayAmount, goalHasFutureWorkingYears, goalTimingLabel, isOneTimeGoal,
  normalizeGoalCategory, resolveGoalSpan, setGoalDisplayAmount, setGoalPer,
  setGoalKind, setGoalRange, goalAgeToPeriodValue, goalPeriodValueToAge,
} from '../src/goals/horizonModel.js';

const icon = category => `<img src="assets/goals-horizon/${category}.svg?v=__PARALLAX_ARTIFACT_ID__" alt="" aria-hidden="true">`;
const idFor = (goal, index) => goal.id || `legacy_${index}`;
const disabled = value => value ? ' disabled aria-disabled="true"' : '';
const money = value => Number(value).toLocaleString('en-US');

export function createMobileGoalsController(deps){
  let root = null;
  let events = null;
  let householdId;
  let editing = null;
  let undo = null;
  let error = '';
  const list = () => deps.getPlan().goals || [];
  const identity = () => deps.getHouseholdId?.() ?? deps.getPlan();
  const span = () => resolveGoalSpan(deps.getPlan());
  const readOnly = () => Boolean(deps.isReadOnly?.());
  const undoContext = () => JSON.stringify([list().map(idFor), deps.getGoalUndoContext?.()]);
  const find = id => {
    const index = list().findIndex((goal, i) => idFor(goal, i) === id);
    return index < 0 ? null : { goal: list()[index], index };
  };

  function syncIdentity(){
    const next = identity();
    if(next === householdId) return;
    householdId = next;
    editing = null;
    undo = null;
    error = '';
  }

  function categories(action, selected = null){
    return `<div class="gm-categories" role="group" aria-label="Goal categories">${GOAL_CATEGORIES.map(category =>
      `<button type="button" class="gh-starter" data-gm-action="${action}" data-category="${category.key}" aria-pressed="${category.key === selected}"${disabled(readOnly())}>${icon(category.key)}<span>${esc(category.label)}</span></button>`).join('')}</div>`;
  }

  function renderList(){
    const currentSpan = span();
    return `<div class="gh-page gm-page" data-mobile-goals="list">
      <header class="gm-heading"><h1 tabindex="-1">Goals</h1><span>${list().length} goals</span></header>
      ${categories('new')}
      <div class="gm-list">${list().map((goal, index) => {
        const effective = effectiveGoalForView(goal, currentSpan);
        const id = esc(idFor(goal, index));
        return `<div class="gm-row" data-mobile-goal="${id}">
          <button class="gm-open" type="button" data-gm-action="open" data-goal-id="${id}">
            ${icon(normalizeGoalCategory(goal))}<span><strong>${esc(goal.name || 'Untitled goal')}</strong><small>${esc(goalTimingLabel(effective))}</small></span>
          </button>
          <label class="gm-inline-amount"><span class="gh-sr-only">${esc(goal.name || 'Goal')} amount</span><span aria-hidden="true">$</span>
            <input type="text" inputmode="decimal" data-gm-inline="${id}" value="${money(goalDisplayAmount(goal))}"${disabled(readOnly())}>
            <small>${isOneTimeGoal(effective) ? 'once' : goal.per === 'mo' ? '/ month' : '/ year'}</small>
          </label>
        </div>`;
      }).join('') || '<p class="gm-empty">Choose a category to add your first goal.</p>'}</div>
      ${undo ? `<div class="gm-undo" role="status"><span>Deleted ${esc(undo.goal.name || 'goal')}</span><button type="button" data-gm-action="undo"${disabled(readOnly())}>Undo</button></div>` : ''}
      <p class="gm-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
    </div>`;
  }

  function renderEditor(){
    const goal = editing.draft.value;
    const currentSpan = span();
    const effective = effectiveGoalForView(goal, currentSpan);
    const once = isOneTimeGoal(effective);
    const frequency = once ? 'once' : goal.per === 'mo' ? 'monthly' : 'annual';
    const lens = editing.lens;
    const unit = lens.mode === 'year' ? 'year' : 'age';
    const period = age => goalAgeToPeriodValue(age, deps.getPlan(), lens);
    const category = normalizeGoalCategory(goal);
    const blocked = readOnly();
    const timing = (field, label, age) => `<label class="gm-field"><span>${label}</span><input type="text" inputmode="numeric" data-gm-field="${field}" data-field="${field}-${unit}" value="${esc(editing.raw[field] ?? period(age))}"${disabled(blocked)}></label>`;
    return `<div class="gh-page gm-page gm-editor" data-mobile-goals="editor" data-goal-rail="${esc(editing.id)}">
      <header class="gm-detail-heading"><button type="button" data-gm-action="cancel" aria-label="Cancel and return to Goals">‹</button><h1 tabindex="-1">${editing.isNew ? 'New goal' : 'Edit goal'}</h1><span></span></header>
      ${categories('category', category)}
      <div class="gm-editor-body">
        <label class="gm-field gm-name"><span>Goal name</span><input class="gh-name-input" data-gm-field="name" data-field="name" value="${esc(goal.name || '')}" placeholder="Name this goal"${disabled(blocked)}></label>
        <label class="gm-field gm-amount"><span>Amount</span><span class="gm-money"><span aria-hidden="true">$</span><input class="gh-amount-input" inputmode="decimal" data-gm-field="amount" data-field="amount" value="${esc(editing.raw.amount ?? money(goalDisplayAmount(goal)))}"${disabled(blocked)}></span></label>
        <div class="gm-segments" role="group" aria-label="Frequency">${[['once', 'Once'], ['monthly', 'Monthly'], ['annual', 'Annually']].map(([value, label]) => `<button type="button" data-gm-action="frequency" data-frequency="${value}" aria-pressed="${frequency === value}"${disabled(blocked)}>${label}</button>`).join('')}</div>
        <div class="gm-period-heading"><span>Timing</span><div class="gm-segments" role="group" aria-label="Enter timing by age or calendar year">${['age', 'year'].map(mode => `<button type="button" data-gm-action="lens" data-mode="${mode}" aria-pressed="${lens.mode === mode}">${mode === 'age' ? 'Age' : 'Year'}</button>`).join('')}</div></div>
        ${lens.mode === 'age' && deps.getPlan().household?.spouse ? `<label class="gm-field"><span>Whose age</span><select data-gm-field="owner"${disabled(blocked)}><option value="primary" ${lens.owner === 'primary' ? 'selected' : ''}>${esc(deps.getPlan().meta?.primaryName || 'You')}</option><option value="spouse" ${lens.owner === 'spouse' ? 'selected' : ''}>${esc(deps.getPlan().meta?.spouseName || 'Spouse')}</option></select></label>` : ''}
        <div class="gm-pair">${timing('start', once ? `At ${unit}` : `Start ${unit}`, effective.startAge)}${once ? '' : timing('end', `End ${unit}`, effective.endAge)}</div>
        <div class="gm-field" data-gm-funding ${goalHasFutureWorkingYears(effective, currentSpan) ? '' : 'hidden'}><span>Before retirement</span><div class="gm-segments" role="group" aria-label="Before retirement funding source"><button type="button" data-gm-action="funding" data-portfolio="false" aria-pressed="${goal.fundFromPortfolioBeforeRetirement !== true}"${disabled(blocked)}>Working income / outside portfolio</button><button type="button" data-gm-action="funding" data-portfolio="true" aria-pressed="${goal.fundFromPortfolioBeforeRetirement === true}"${disabled(blocked)}>Portfolio</button></div></div>
        <p class="gm-error" role="alert" ${error ? '' : 'hidden'}>${esc(error)}</p>
      </div>
      <footer class="gm-footer"><button type="button" data-gm-action="cancel">Cancel</button><button class="gm-save" type="button" data-gm-action="save"${disabled(blocked)}>Save goal</button></footer>
      ${!editing.isNew && !goal.system ? `<button class="gm-delete" type="button" data-gm-action="delete"${disabled(blocked)}>Delete goal</button>` : ''}
    </div>`;
  }

  function render(){ syncIdentity(); return editing ? renderEditor() : renderList(); }
  function rerender(focusSelector = null){
    if(!root) return;
    root.innerHTML = render();
    bind(root);
    if(focusSelector) root.querySelector(focusSelector)?.focus({ preventScroll: true });
  }
  function showError(message, control = null, focus = false){
    error = message;
    const notice = root?.querySelector('.gm-error');
    if(notice){ notice.hidden = false; notice.textContent = message; }
    if(control){
      control.setAttribute('aria-invalid', 'true');
      if(focus) control.focus({ preventScroll: true });
    }
  }
  function clearError(control){
    control?.removeAttribute('aria-invalid');
    if(root?.querySelector('[aria-invalid="true"]')) return;
    error = '';
    const notice = root?.querySelector('.gm-error');
    if(notice){ notice.hidden = true; notice.textContent = ''; }
  }
  function numeric(control){
    const text = control.value.replace(/[$,\s]/g, '');
    const value = text === '' ? NaN : Number(text);
    if(!Number.isFinite(value) || value < 0){ showError('Enter a number of zero or more.', control); return null; }
    clearError(control);
    return value;
  }
  function startEditing(goal, id, isNew){
    editing = { id, isNew, raw: {}, draft: createMobileGoalDraft(goal), lens: { mode: 'age', owner: 'primary', currentYear: Number(deps.currentYear) || new Date().getFullYear() } };
    error = '';
    rerender('.gm-detail-heading h1');
  }
  function cancel(){
    const id = editing?.id;
    editing = null; error = '';
    rerender();
    [...root.querySelectorAll('[data-gm-action="open"]')].find(button => button.dataset.goalId === id)?.focus({ preventScroll: true });
  }
  function save(){
    if(!editing || !flushFields()) return;
    if(!editing.draft.value.name?.trim()){ showError('Enter a goal name.', root.querySelector('[data-gm-field="name"]'), true); return; }
    if(!deps.guardMutation()) return;
    const pending = editing;
    if(pending.isNew) deps.insertGoal(list().length, structuredClone(pending.draft.value));
    else {
      const record = find(pending.id);
      if(!record){ showError('This goal is no longer available. Return to Goals.'); return; }
      try { applyMobileGoalDraft(record.goal, pending.draft); }
      catch(failure){ showError(failure.message); return; }
      if(!record.goal.id) record.goal.id = defaultGoalId(record.index);
    }
    editing = null; error = ''; householdId = identity();
    deps.commit();
    rerender('.gm-heading h1');
  }
  function click(event){
    const button = event.target.closest('[data-gm-action]');
    if(!button || button.disabled) return;
    const action = button.dataset.gmAction;
    if(action === 'new'){ startEditing(createGoalForCategory(button.dataset.category, span()), '', true); return; }
    if(action === 'open'){ const record = find(button.dataset.goalId); if(record) startEditing(record.goal, button.dataset.goalId, false); return; }
    if(action === 'cancel'){ cancel(); return; }
    if(action === 'save'){ save(); return; }
    if(action === 'undo'){
      if(!undo || !deps.guardMutation()) return;
      if(undo.context !== undoContext()){
        undo = null;
        showError('The plan changed after this deletion. Undo is no longer available.');
        rerender(); return;
      }
      deps.insertGoal(undo.index, undo.goal, undo.overrides); undo = null;
      householdId = identity(); deps.commit(); rerender(); return;
    }
    if(!editing) return;
    const goal = editing.draft.value;
    if(action === 'delete'){
      if(goal.system || !deps.guardMutation()) return;
      const record = find(editing.id);
      if(!record || record.goal.system) return;
      undo = { ...deps.removeGoal(record.index), index: record.index, context: undoContext() };
      editing = null; householdId = identity(); deps.commit(); rerender(); return;
    }
    if(!flushFields()) return;
    if(action === 'lens') editing.lens.mode = button.dataset.mode === 'year' ? 'year' : 'age';
    else if(readOnly()) return;
    else if(action === 'category'){
      const category = GOAL_CATEGORY_MAP[button.dataset.category] ? button.dataset.category : 'custom';
      goal.cat = category; goal.area = category;
    }else if(action === 'frequency'){
      const frequency = button.dataset.frequency;
      const once = isOneTimeGoal(effectiveGoalForView(goal, span()));
      if((frequency === 'once') !== once){
        materializeGoalTiming(goal, span(), { detachFromRetirement: true });
        setGoalKind(goal, frequency === 'once' ? 'once' : 'rec', span().planEndAge);
      }
      setGoalPer(goal, frequency === 'monthly' ? 'mo' : 'yr');
    }else if(action === 'funding') goal.fundFromPortfolioBeforeRetirement = button.dataset.portfolio === 'true';
    else return;
    rerender();
  }
  function input(event){
    if(!editing || readOnly()) return;
    const control = event.target;
    if(control.dataset.gmField === 'name'){
      editing.draft.value.name = control.value;
      clearError(control);
    }
    if(control.dataset.gmField === 'amount'){
      editing.raw.amount = control.value;
    }
    if(control.dataset.gmField === 'start' || control.dataset.gmField === 'end') editing.raw[control.dataset.gmField] = control.value;
  }

  // Validate at commit/blur boundaries, so clearing and typing into a field
  // never steals focus or silently restores an earlier value.
  function flushFields(){
    for(const control of root.querySelectorAll('[data-gm-field]')){
      if(Object.hasOwn(editing.raw, control.dataset.gmField)) change({ target: control });
    }
    const invalid = root.querySelector('[aria-invalid="true"]');
    invalid?.focus({ preventScroll: true });
    return !invalid;
  }
  function change(event){
    const control = event.target;
    if(control.dataset.gmInline){
      const amount = numeric(control);
      if(amount === null || !deps.guardMutation()) return;
      const record = find(control.dataset.gmInline);
      if(!record) return;
      setGoalDisplayAmount(record.goal, amount);
      if(!record.goal.id) record.goal.id = defaultGoalId(record.index);
      control.dataset.gmInline = record.goal.id;
      control.closest('[data-mobile-goal]').querySelector('[data-goal-id]').dataset.goalId = record.goal.id;
      control.value = money(goalDisplayAmount(record.goal));
      deps.arm?.(); return;
    }
    if(!editing || readOnly()) return;
    const field = control.dataset.gmField;
    if(field === 'owner'){
      if(!flushFields()) return;
      editing.lens.owner = control.value === 'spouse' ? 'spouse' : 'primary'; rerender(); return;
    }
    if(field === 'amount'){
      const amount = numeric(control);
      if(amount !== null){
        setGoalDisplayAmount(editing.draft.value, amount);
        delete editing.raw.amount;
        control.value = money(goalDisplayAmount(editing.draft.value));
      }
      return;
    }
    if(field !== 'start' && field !== 'end') return;
    const entered = numeric(control);
    if(entered === null) return;
    const goal = editing.draft.value;
    const effective = effectiveGoalForView(goal, span());
    const age = goalPeriodValueToAge(entered, deps.getPlan(), editing.lens);
    if(field === 'start'){
      goal.startsAtRetirement = false;
      setGoalRange(goal, age, isOneTimeGoal(effective) ? age : effective.endAge, span().planEndAge, 'start');
    }else {
      if(goal.startsAtRetirement === true && age < effective.startAge){
        showError(`End age must be ${effective.startAge} or later for a goal that starts at retirement.`, control);
        return;
      }
      setGoalRange(goal, effective.startAge, age, span().planEndAge, 'end');
    }
    delete editing.raw[field];
    const updated = effectiveGoalForView(goal, span());
    const once = isOneTimeGoal(updated);
    if(once) setGoalPer(goal, 'yr');
    for(const button of root.querySelectorAll('[data-frequency]')){
      button.setAttribute('aria-pressed', String(button.dataset.frequency === (once ? 'once' : goal.per === 'mo' ? 'monthly' : 'annual')));
    }
    const startControl = root.querySelector('[data-gm-field="start"]');
    startControl.closest('label').querySelector('span').textContent = `${once ? 'At' : 'Start'} ${editing.lens.mode === 'year' ? 'year' : 'age'}`;
    const endControl = root.querySelector('[data-gm-field="end"]');
    if(endControl) endControl.closest('label').hidden = once;
    if(!Object.hasOwn(editing.raw, 'amount')) root.querySelector('[data-gm-field="amount"]').value = money(goalDisplayAmount(goal));
    for(const peer of root.querySelectorAll('[data-gm-field="start"], [data-gm-field="end"]')){
      if(!Object.hasOwn(editing.raw, peer.dataset.gmField)) peer.value = goalAgeToPeriodValue(peer.dataset.gmField === 'start' ? updated.startAge : updated.endAge, deps.getPlan(), editing.lens);
    }
    root.querySelector('[data-gm-funding]').hidden = !goalHasFutureWorkingYears(updated, span());
  }
  function unbind(){ events?.abort(); }
  function bind(element){
    root = element; unbind(); events = new AbortController();
    const options = { signal: events.signal };
    root.addEventListener('click', click, options);
    root.addEventListener('input', input, options);
    root.addEventListener('change', change, options);
  }
  return { render, bind, unbind };
}
