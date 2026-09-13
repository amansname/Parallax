import { escHtml } from './dom.js';
import { createMobileGoalsController } from './goalsMobile.js';
import { effectiveGoalForView } from './goalsTimingPresentation.js';
import { createGoalCommands } from '../src/goals/goalCommands.js';
import {
  GOAL_CATEGORIES,
  GOAL_CATEGORY_MAP,
  formatGoalAmount,
  goalAgeToPeriodValue,
  goalDisplayAmount,
  goalHasFutureWorkingYears,
  goalPct,
  goalPeriodValueToAge,
  goalTimingLabel,
  isOneTimeGoal,
  normalizeGoalCategory,
  resolveGoalSpan,
} from '../src/goals/horizonModel.js';

const ICON_ROOT = 'assets/goals-horizon';
const ARTIFACT_ID = '__PARALLAX_ARTIFACT_ID__';

const disabledAttr = disabled => disabled ? ' disabled aria-disabled="true"' : '';
const icon = (category, className = 'gh-icon') =>
  `<img class="${className}" src="${ICON_ROOT}/${category}.svg?v=${ARTIFACT_ID}" alt="" aria-hidden="true">`;

const inputMoney = value => Math.max(0, Math.round(+value || 0)).toLocaleString('en-US');

function viewGoalId(goal, index){
  return typeof goal.id === 'string' && goal.id ? goal.id : `legacy_${index}`;
}

function goalIndexByViewId(goals, id){
  const direct = goals.findIndex(goal => goal.id === id);
  if(direct >= 0) return direct;
  if(/^legacy_\d+$/.test(id)){
    const index = +id.slice(7);
    return goals[index] && !goals[index].id ? index : -1;
  }
  return -1;
}

function timingPresets(span){
  const start = span.retirementAge;
  const end = span.planEndAge;
  const earlyEnd = Math.min(start + 9, end);
  const middleStart = Math.min(earlyEnd + 1, end);
  const middleEnd = Math.min(middleStart + 9, end);
  const laterStart = Math.max(start, Math.min(middleEnd + 1, end - 10));
  return [
    { key:'all', label:`All retirement ${start}–${end}`, from:start, to:end },
    { key:'early', label:`Early ${start}–${earlyEnd}`, from:start, to:earlyEnd },
    { key:'middle', label:`Middle ${middleStart}–${middleEnd}`, from:middleStart, to:middleEnd },
    { key:'later', label:`Later ${laterStart}–${end}`, from:laterStart, to:end },
  ];
}

function timingOwnerOptions(plan, lens){
  const primaryName=plan?.meta?.primaryName || 'Client';
  const spouseName=plan?.meta?.spouseName || 'Co-client';
  const options=[`<option value="primary"${lens.owner==='primary'?' selected':''}>${escHtml(primaryName)}</option>`];
  if(plan?.household?.spouse){
    options.push(`<option value="spouse"${lens.owner==='spouse'?' selected':''}>${escHtml(spouseName)}</option>`);
  }
  return options.join('');
}

function renderTimingOwner(plan, lens, disabled){
  if(lens.mode !== 'age') return '';
  if(!plan?.household?.spouse){
    return `<span class="gh-timing-person">${escHtml(plan?.meta?.primaryName || 'Client')}</span>`;
  }
  return `<select class="gh-timing-owner" data-field="timing-owner" aria-label="Whose age"${disabledAttr(disabled)}>${timingOwnerOptions(plan,lens)}</select>`;
}

function periodValue(age, plan, lens){
  return goalAgeToPeriodValue(age,plan,lens);
}

function tickAges(span){
  const ages=[span.retirementAge];
  const firstRegularTick=Math.ceil((span.retirementAge + 3) / 5) * 5;
  for(let age=firstRegularTick; age<=span.planEndAge; age+=5) ages.push(age);
  if(ages[ages.length-1] !== span.planEndAge) ages.push(span.planEndAge);
  return [...new Set(ages)];
}

function renderTicks(span){
  return tickAges(span).map((age,index)=>{
    const pct=goalPct(age,span.axisMin,span.axisMax).toFixed(3);
    return `<span class="gh-tick${index===0?' gh-tick--retire':''}" style="--gh-x:${pct}%">${age}${index===0?' · retire':''}</span>`;
  }).join('');
}

function renderGuides(span){
  const guideAges=[span.retirementAge];
  for(let age=Math.ceil((span.retirementAge + 1) / 10) * 10 + 5; age<span.axisMax; age+=10) guideAges.push(age);
  guideAges.push(span.axisMax);
  return [...new Set(guideAges)].map((age,index)=>
    `<span class="gh-guide${index===0?' gh-guide--retire':''}" style="--gh-x:${goalPct(age,span.axisMin,span.axisMax).toFixed(3)}%"></span>`
  ).join('');
}

function renderLane(goal,index,span,state,disabled){
  const viewGoal=effectiveGoalForView(goal,span);
  const id=viewGoalId(goal,index);
  const category=normalizeGoalCategory(viewGoal);
  const categoryDef=GOAL_CATEGORY_MAP[category];
  const once=isOneTimeGoal(viewGoal);
  const start=goalPct(viewGoal.startAge,span.axisMin,span.axisMax);
  const end=once ? start : goalPct(Math.min(+viewGoal.endAge+1,span.axisMax),span.axisMin,span.axisMax);
  const width=Math.max(1.4,end-start);
  const flip=+viewGoal.startAge > Math.min(84, span.planEndAge-4);
  const style=`--goal-color:${categoryDef.color};--gh-start:${start.toFixed(3)}%;--gh-end:${end.toFixed(3)}%;--gh-width:${width.toFixed(3)}%`;
  const title=`${goalTimingLabel(viewGoal)} · drag to move`;
  return `<div class="gh-lane${state.selectedId===id?' is-selected':''}${state.flashId===id?' gh-lane--flash':''}" data-goal-lane="${escHtml(id)}" style="${style}">
    ${once
      ? '<span class="gh-diamond" aria-hidden="true"></span>'
      : '<span class="gh-band" aria-hidden="true"></span>'}
    <button class="gh-chip${once?' gh-chip--once':''}${flip?' gh-chip--flip':''}" type="button" data-goal-chip="${escHtml(id)}" title="${escHtml(title)}"${disabledAttr(disabled)}>
      <span class="gh-chip__icon">${icon(category)}</span>
      <span class="gh-chip__name">${escHtml(viewGoal.name || 'Untitled goal')}</span>
      <span class="gh-chip__amount">${escHtml(formatGoalAmount(viewGoal))}</span>
    </button>
  </div>`;
}

function renderAddRail(disabled){
  const starters=GOAL_CATEGORIES.map(category=>
    `<button class="gh-starter" type="button" data-add-category="${category.key}" style="--goal-color:${category.color}"${disabledAttr(disabled)}>
      ${icon(category.key,'gh-starter__icon')}<span>${category.label}</span>
    </button>`
  ).join('');
  return `<aside class="gh-rail gh-add-rail" aria-label="Add a goal">
    <header class="gh-rail__header">
      <div class="gh-add-rail__heading"><span class="gh-field-label">Add a goal</span><strong>Choose a category</strong></div>
      <button class="gh-rail__close" type="button" data-action="close" aria-label="Close add goal">×</button>
    </header>
    <div class="gh-rail__body"><div class="gh-starters">${starters}</div></div>
  </aside>`;
}

function renderRail(goal,index,span,disabled,plan,lens){
  if(!goal) return '';
  const viewGoal=effectiveGoalForView(goal,span);
  const id=viewGoalId(goal,index);
  const category=normalizeGoalCategory(viewGoal);
  const categoryDef=GOAL_CATEGORY_MAP[category];
  const once=isOneTimeGoal(viewGoal);
  const presets=timingPresets(span);
  const presetButtons=presets.map(preset=>{
    const selected=!once && +viewGoal.startAge===preset.from && +viewGoal.endAge===preset.to;
    const from=periodValue(preset.from,plan,lens);
    const to=periodValue(preset.to,plan,lens);
    const label=lens.mode==='year' && preset.key==='all'
      ? `All ${from}–${to}`
      : preset.label.replace(/\d+–\d+$/,`${from}–${to}`);
    return `<button class="gh-preset${selected?' is-selected':''}" type="button" data-action="preset" data-preset="${preset.key}"${disabledAttr(disabled)}>${label}</button>`;
  }).join('');
  const categoryButtons=GOAL_CATEGORIES.map(item=>
    `<button class="gh-category${item.key===category?' is-selected':''}" type="button" data-action="category" data-category="${item.key}" title="${item.label}" aria-label="${item.label}" style="--goal-color:${item.color}"${disabledAttr(disabled)}>${icon(item.key,'gh-category__icon')}</button>`
  ).join('');
  const hasWorkingYears=goalHasFutureWorkingYears(viewGoal,span);
  const portfolioFunded=goal.fundFromPortfolioBeforeRetirement===true;
  const fundingSection=hasWorkingYears ? `<section class="gh-editor-section">
        <div class="gh-field-label">Before retirement</div>
        <div class="gh-seg gh-funding-seg" role="group" aria-label="Before retirement funding source"><button class="${portfolioFunded?'':'is-selected'}" type="button" data-action="fund-outside" aria-pressed="${portfolioFunded?'false':'true'}"${disabledAttr(disabled)}>Working income / outside portfolio</button><button class="${portfolioFunded?'is-selected':''}" type="button" data-action="fund-portfolio" aria-pressed="${portfolioFunded?'true':'false'}"${disabledAttr(disabled)}>Portfolio</button></div>
        <div class="gh-funding-note">Choose Portfolio to include the pre-retirement years in plan funding and success.</div>
      </section>` : '';
  const timingOwner=renderTimingOwner(plan,lens,disabled);
  const startValue=periodValue(viewGoal.startAge,plan,lens);
  const endValue=periodValue(viewGoal.endAge,plan,lens);
  const periodUnit=lens.mode==='year'?'year':'age';
  const years=once
    ? `<div class="gh-once-age">
        ${timingOwner}<span>${lens.mode==='year'?'in':'at'}</span>
        <button type="button" data-action="age-minus" aria-label="Decrease ${periodUnit}"${disabledAttr(disabled)}>−</button>
        <input class="gh-age-input${lens.mode==='year'?' gh-year-input':''}" data-field="once-${periodUnit}" inputmode="numeric" aria-label="Goal ${periodUnit}" value="${startValue}"${disabledAttr(disabled)}>
        <button type="button" data-action="age-plus" aria-label="Increase ${periodUnit}"${disabledAttr(disabled)}>+</button>
      </div>`
    : `<div class="gh-presets">${presetButtons}</div>
      <div class="gh-range-inputs">
        ${timingOwner}<input class="gh-age-input${lens.mode==='year'?' gh-year-input':''}" data-field="start-${periodUnit}" inputmode="numeric" aria-label="Start ${periodUnit}" value="${startValue}"${disabledAttr(disabled)}>
        <span aria-hidden="true">–</span><input class="gh-age-input${lens.mode==='year'?' gh-year-input':''}" data-field="end-${periodUnit}" inputmode="numeric" aria-label="End ${periodUnit}" value="${endValue}"${disabledAttr(disabled)}>
      </div>`;
  return `<aside class="gh-rail" data-goal-rail="${escHtml(id)}" style="--goal-color:${categoryDef.color}" aria-label="Edit goal">
    <header class="gh-rail__header">
      <span class="gh-rail__icon">${icon(category)}</span>
      <input class="gh-name-input" data-field="name" value="${escHtml(viewGoal.name || '')}" placeholder="Name this goal" aria-label="Name this goal"${disabledAttr(disabled)}>
      <button class="gh-rail__close" type="button" data-action="close" aria-label="Close editor">×</button>
    </header>
    <div class="gh-rail__body">
      <section class="gh-editor-section">
        <div class="gh-field-label">Amount</div>
        <div class="gh-money-row">
          <button type="button" data-action="amount-minus" aria-label="Decrease amount"${disabledAttr(disabled)}>−</button>
          <label class="gh-money-input"><span>$</span><input class="gh-amount-input" data-field="amount" inputmode="numeric" value="${inputMoney(goalDisplayAmount(viewGoal))}"${disabledAttr(disabled)}></label>
          <button type="button" data-action="amount-plus" aria-label="Increase amount"${disabledAttr(disabled)}>+</button>
        </div>
        ${once ? '<div class="gh-money-meta"><span>today’s dollars</span></div>' : `<div class="gh-money-meta">
          <div class="gh-mini-seg"><button class="${viewGoal.per!=='mo'?'is-selected':''}" type="button" data-action="per-year"${disabledAttr(disabled)}>per year</button><button class="${viewGoal.per==='mo'?'is-selected':''}" type="button" data-action="per-month"${disabledAttr(disabled)}>per month</button></div>
          <span>today’s dollars</span>
        </div>`}
      </section>
      <section class="gh-editor-section">
        <div class="gh-field-label">How often</div>
        <div class="gh-seg"><button class="${once?'is-selected':''}" type="button" data-action="kind-once"${disabledAttr(disabled)}>One-time</button><button class="${once?'':'is-selected'}" type="button" data-action="kind-rec"${disabledAttr(disabled)}>Every year</button></div>
      </section>
      <section class="gh-editor-section">
        <div class="gh-period-head"><div class="gh-field-label">Which years</div><div class="gh-period-mode" role="group" aria-label="Enter goal period by age or calendar year"><button class="${lens.mode==='age'?'is-selected':''}" type="button" data-action="timing-age" aria-pressed="${lens.mode==='age'}"${disabledAttr(disabled)}>Age</button><button class="${lens.mode==='year'?'is-selected':''}" type="button" data-action="timing-year" aria-pressed="${lens.mode==='year'}"${disabledAttr(disabled)}>Year</button></div></div>
        ${years}
      </section>
      ${fundingSection}
      <section class="gh-editor-section">
        <div class="gh-field-label">Category</div>
        <div class="gh-categories">${categoryButtons}</div>
      </section>
    </div>
    <footer class="gh-rail__footer">
      ${goal.system
        ? ''
        : `<button class="gh-delete" type="button" data-action="delete"${disabledAttr(disabled)}>Delete goal</button>`}
      <span class="gh-rail__footer-spacer"></span>
      ${goal.system ? '' : `<button class="gh-ghost" type="button" data-action="duplicate"${disabledAttr(disabled)}>Duplicate</button>`}
      <button class="gh-done" type="button" data-action="done">Done</button>
    </footer>
  </aside>`;
}

function liveCommas(input){
  const old=input.value;
  const caret=input.selectionStart ?? old.length;
  const digitsBefore=(old.slice(0,caret).match(/\d/g)||[]).length;
  const digits=old.replace(/[^0-9]/g,'');
  input.value=digits ? parseInt(digits,10).toLocaleString('en-US') : '';
  let pos=0,seen=0;
  while(pos<input.value.length && seen<digitsBefore){ if(/\d/.test(input.value[pos])) seen++; pos++; }
  input.setSelectionRange(pos,pos);
}

export function createGoalsHorizonController(deps){
  const mobileMedia = globalThis.matchMedia?.('(max-width: 760px), (max-width: 1023px) and (max-height: 500px)');
  const commands = createGoalCommands(deps);
  const mobile = createMobileGoalsController({ ...deps, commands, onEditorClosed: () => rerender(), onInteractionEnd: () => {
    if(renderedMobile !== Boolean(mobileMedia?.matches) && !state.selectedId && !state.drag) rerender();
  } });
  const state={ selectedId:null, addOpen:true, initialSelectionResolved:false, flashId:null, toast:null, drag:null, timingLens:new Map() };
  let renderedMobile = Boolean(mobileMedia?.matches);
  let root=null;
  let abortController=null;
  let toastTimer=null;
  let householdId=deps.getHouseholdId?.();

  const goals=()=>Array.isArray(deps.getPlan().goals) ? deps.getPlan().goals : [];
  const disabled=()=>Boolean(deps.isReadOnly?.());
  const span=()=>resolveGoalSpan(deps.getPlan());
  const currentYear=Number.isFinite(+deps.currentYear) ? Math.round(+deps.currentYear) : new Date().getFullYear();

  const timingLensFor=(goal,index)=>{
    const id=viewGoalId(goal,index);
    const stored=state.timingLens.get(id) || {};
    return {
      mode:stored.mode==='year'?'year':'age',
      owner:stored.owner==='spouse' && deps.getPlan()?.household?.spouse ? 'spouse' : 'primary',
      currentYear,
    };
  };

  const updateTimingLens=(goal,index,update)=>{
    const id=viewGoalId(goal,index);
    state.timingLens.set(id,{...timingLensFor(goal,index),...update});
  };

  const selectedRecord=()=>{
    const list=goals();
    const index=goalIndexByViewId(list,state.selectedId);
    return index>=0 ? {goal:list[index],index} : null;
  };

  const acceptReceipt=receipt=>{
    const { goal, oldId: old } = receipt;
    if(old && old !== goal.id){
      if(state.timingLens.has(old)){
        state.timingLens.set(goal.id,state.timingLens.get(old));
        state.timingLens.delete(old);
      }
      if(state.selectedId===old) state.selectedId=goal.id;
      if(root){
        const lane=root.querySelector(`[data-goal-lane="${CSS.escape(old)}"]`);
        const chip=root.querySelector(`[data-goal-chip="${CSS.escape(old)}"]`);
        if(lane) lane.dataset.goalLane=goal.id;
        if(chip) chip.dataset.goalChip=goal.id;
      }
    }
    return goal;
  };

  const render=()=>{
    const nextHouseholdId=deps.getHouseholdId?.();
    if(householdId !== nextHouseholdId){
      householdId=nextHouseholdId;
      state.selectedId=null; state.drag=null; state.toast=null;
      state.addOpen=true; state.timingLens.clear();
      if(toastTimer){ clearTimeout(toastTimer); toastTimer=null; }
    }
    if(state.selectedId && !selectedRecord()) state.selectedId=null;
    if(!mobile.isEditing() && !state.selectedId && !state.drag) renderedMobile = Boolean(mobileMedia?.matches);
    if(renderedMobile) return mobile.render();
    const list=goals();
    if(!state.initialSelectionResolved && list.length){
      state.initialSelectionResolved=true;
      if(state.selectedId===null && !state.addOpen){
        state.selectedId=viewGoalId(list[0],0);
      }
    }
    const currentSpan=span();
    const isDisabled=disabled();
    const lanes=list.length
      ? list.map((goal,index)=>renderLane(goal,index,currentSpan,state,isDisabled)).join('')
      : '<div class="gh-empty">Nothing on the horizon yet — add a goal and it will land right here on the timeline.</div>';
    const selected=selectedRecord();
    const toast=state.toast ? `<div class="gh-toast" role="status"><span>${state.toast.error ? escHtml(state.toast.error) : `Deleted “${escHtml(state.toast.goal.name || 'Untitled goal')}”`}</span>${state.toast.error ? '' : '<button type="button" data-action="undo">Undo</button>'}<button type="button" data-action="dismiss-toast" aria-label="Dismiss">×</button></div>` : '';
    const addRail=state.addOpen ? renderAddRail(isDisabled) : '';
    return `<div class="gh-page${selected || state.addOpen ? '' : ' is-editor-closed'}">
      <div class="gh-main">
        <section class="gh-card" aria-label="Goals horizon">
          <div class="gh-track">
            <div class="gh-ticks">${renderTicks(currentSpan)}</div>
            <div class="gh-guides" aria-hidden="true">${renderGuides(currentSpan)}</div>
            <div class="gh-lanes" data-axis-min="${currentSpan.axisMin}" data-axis-max="${currentSpan.axisMax}">${lanes}</div>
          </div>
          <div class="gh-add-row">
            <button class="gh-add-toggle" type="button" data-action="toggle-add" aria-expanded="${state.addOpen}"${disabledAttr(isDisabled)}><span>+</span>Add a goal</button>
          </div>
        </section>
      </div>
      ${selected ? renderRail(selected.goal,selected.index,currentSpan,isDisabled,deps.getPlan(),timingLensFor(selected.goal,selected.index)) : addRail}
      ${toast}
    </div>`;
  };

  const rerender=()=>{
    if(!root) return;
    root.innerHTML=render();
    bind(root);
  };

  const updateChipText=(goal,id,currentSpan=span())=>{
    if(!root) return;
    const lane=root.querySelector(`[data-goal-lane="${CSS.escape(id)}"]`);
    if(!lane) return;
    const viewGoal=effectiveGoalForView(goal,currentSpan);
    const name=lane.querySelector('.gh-chip__name');
    const amount=lane.querySelector('.gh-chip__amount');
    const chip=lane.querySelector('.gh-chip');
    if(name) name.textContent=viewGoal.name || 'Untitled goal';
    if(amount) amount.textContent=formatGoalAmount(viewGoal);
    if(chip) chip.title=`${goalTimingLabel(viewGoal)} · drag to move`;
  };

  const updateGoalGeometry=(goal,id,currentSpan)=>{
    if(!root) return;
    const lane=root.querySelector(`[data-goal-lane="${CSS.escape(id)}"]`);
    if(!lane) return;
    const viewGoal=effectiveGoalForView(goal,currentSpan);
    const once=isOneTimeGoal(viewGoal);
    const start=goalPct(viewGoal.startAge,currentSpan.axisMin,currentSpan.axisMax);
    const end=once?start:goalPct(Math.min(+viewGoal.endAge+1,currentSpan.axisMax),currentSpan.axisMin,currentSpan.axisMax);
    lane.style.setProperty('--gh-start',`${start.toFixed(3)}%`);
    lane.style.setProperty('--gh-end',`${end.toFixed(3)}%`);
    lane.style.setProperty('--gh-width',`${Math.max(1.4,end-start).toFixed(3)}%`);
    lane.querySelector('.gh-chip')?.classList.toggle('gh-chip--flip',+viewGoal.startAge>Math.min(84,currentSpan.planEndAge-4));
    updateChipText(viewGoal,id,currentSpan);
  };

  const dismissToast=()=>{
    state.toast=null;
    if(toastTimer){ clearTimeout(toastTimer); toastTimer=null; }
  };

  const scheduleToast=()=>{
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>{ state.toast=null; toastTimer=null; root?.querySelector('.gh-toast')?.remove(); },8000);
  };

  const clickHandler=e=>{
    const keyboardGoalChip=e.detail===0 ? e.target.closest('[data-goal-chip]') : null;
    if(keyboardGoalChip){
      const index=goalIndexByViewId(goals(),keyboardGoalChip.dataset.goalChip);
      if(index<0) return;
      state.selectedId=viewGoalId(goals()[index],index);
      state.addOpen=false;
      rerender();
      return;
    }
    const actionEl=e.target.closest('[data-action]');
    const addEl=e.target.closest('[data-add-category]');
    if(addEl){
      const receipt=commands.create(addEl.dataset.addCategory);
      if(!receipt) return;
      const {goal}=receipt;
      state.selectedId=goal.id;
      state.flashId=goal.id;
      state.addOpen=false;
      commands.publish(receipt);
      setTimeout(()=>{ state.flashId=null; },1500);
      return;
    }
    if(!actionEl) return;
    const action=actionEl.dataset.action;
    if(action==='toggle-add'){
      state.addOpen=!state.addOpen;
      if(state.addOpen) state.selectedId=null;
      rerender();
      return;
    }
    if(action==='close'||action==='done'){
      state.selectedId=null;
      state.addOpen=false;
      rerender();
      return;
    }
    if(action==='dismiss-toast'){
      dismissToast(); rerender(); return;
    }
    if(action==='undo'){
      if(!state.toast) return;
      let restored;
      try { restored=commands.restore(state.toast); }
      catch(error){ state.toast.error=error.message; rerender(); return; }
      if(!restored) return;
      dismissToast();
      state.flashId=restored.goal.id || `legacy_${restored.index}`;
      commands.publish(restored);
      setTimeout(()=>{ state.flashId=null; },1500);
      return;
    }
    if(action==='timing-age'||action==='timing-year'){
      const selected=selectedRecord();
      if(!selected) return;
      updateTimingLens(selected.goal,selected.index,{mode:action==='timing-year'?'year':'age'});
      rerender();
      return;
    }
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    const currentSpan=span();
    let edit;
    if(action==='amount-minus'||action==='amount-plus'){
      edit={type:'amount-step',direction:action==='amount-plus'?1:-1};
    }else if(action==='per-year') edit={type:'per',value:'yr'};
    else if(action==='per-month') edit={type:'per',value:'mo'};
    else if(action==='fund-outside') edit={type:'funding',value:false};
    else if(action==='fund-portfolio') edit={type:'funding',value:true};
    else if(action==='kind-once'||action==='kind-rec') edit={type:'kind',value:action==='kind-once'?'once':'rec'};
    else if(action==='preset'){
      const preset=timingPresets(currentSpan).find(item=>item.key===actionEl.dataset.preset);
      if(!preset) return;
      edit={type:'preset',from:preset.from,to:preset.to};
    }else if(action==='age-minus'||action==='age-plus'){
      edit={type:'age-step',direction:action==='age-plus'?1:-1};
    }else if(action==='category'){
      edit={type:'category',value:actionEl.dataset.category};
    }else if(action==='duplicate'){
      const receipt=commands.duplicate(viewGoalId(goal,index));
      if(!receipt) return;
      const copy=receipt.goal;
      state.selectedId=copy.id;
      state.flashId=copy.id;
      commands.publish(receipt);
      setTimeout(()=>{ state.flashId=null; },1500);
      return;
    }else if(action==='delete'){
      // Essentials and Healthcare are the household's baseline spending, not
      // discretionary goals. The button is hidden for them; this guards the
      // path anyway so a stale DOM or a keyboard route cannot remove one.
      const removed=commands.remove(viewGoalId(goal,index));
      if(!removed) return;
      state.selectedId=null;
      state.toast=removed;
      scheduleToast();
      commands.publish(removed);
      return;
    }else return;
    const receipt=commands.update(viewGoalId(goal,index),edit);
    if(!receipt) return;
    acceptReceipt(receipt);
    state.selectedId=receipt.goal.id;
    commands.publish(receipt);
  };

  const inputHandler=e=>{
    const isName=e.target.matches('.gh-name-input');
    const isAmount=e.target.matches('.gh-amount-input');
    if(!isName && !isAmount) return;
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    if(isAmount) liveCommas(e.target);
    const receipt=commands.update(viewGoalId(goal,index),isName
      ? {type:'name',value:e.target.value}
      : {type:'amount',value:parseInt(e.target.value.replace(/[^0-9]/g,''),10)||0});
    if(!receipt) return;
    acceptReceipt(receipt);
    commands.publish(receipt,'arm');
    updateChipText(receipt.goal,receipt.goal.id);
  };

  const changeHandler=e=>{
    const field=e.target.dataset.field;
    if(field==='timing-owner'){
      const selected=selectedRecord();
      if(!selected) return;
      updateTimingLens(selected.goal,selected.index,{owner:e.target.value==='spouse'?'spouse':'primary'});
      rerender();
      return;
    }
    if(!['once-age','start-age','end-age','once-year','start-year','end-year'].includes(field)) return;
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    const entered=parseInt(e.target.value.replace(/[^0-9]/g,''),10);
    const lens=timingLensFor(goal,index);
    const value=goalPeriodValueToAge(entered,deps.getPlan(),lens);
    let receipt;
    try { receipt=commands.update(viewGoalId(goal,index),{type:'range',edge:field.split('-')[0],value}); }
    catch(error){ e.target.setCustomValidity?.(error.message); e.target.reportValidity?.(); return; }
    if(!receipt) return;
    e.target.setCustomValidity?.('');
    acceptReceipt(receipt);
    state.selectedId=receipt.goal.id;
    commands.publish(receipt);
  };

  const pointerDownHandler=e=>{
    const chip=e.target.closest('[data-goal-chip]');
    if(!chip || disabled() || e.button!==0) return;
    const id=chip.dataset.goalChip;
    const list=goals();
    const index=goalIndexByViewId(list,id);
    if(index<0) return;
    const goal=list[index];
    const track=root.querySelector('.gh-lanes');
    const rect=track?.getBoundingClientRect();
    if(!rect?.width) return;
    e.preventDefault();
    const currentSpan=span();
    const token=commands.beginMove(id);
    if(!token) return;
    state.drag={ id,index,goal,startX:e.clientX,dragged:false,rect,currentSpan,chip,token };
    const move=event=>{
      const drag=state.drag;
      if(!drag) return;
      const dx=event.clientX-drag.startX;
      if(!drag.dragged && Math.abs(dx)<=4) return;
      const years=Math.round(dx/(drag.rect.width/(drag.currentSpan.axisMax-drag.currentSpan.axisMin)));
      const receipt=commands.move(drag.token,years);
      if(!receipt) return;
      drag.receipt=receipt; drag.dragged=true;
      drag.chip.classList.add('is-dragging');
      acceptReceipt(receipt);
      drag.id=receipt.goal.id;
      updateGoalGeometry(receipt.goal,drag.id,drag.currentSpan);
      if(receipt.firstMove) commands.publish(receipt,'arm');
    };
    const up=()=>{
      const drag=state.drag;
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',up);
      window.removeEventListener('pointercancel',up);
      state.drag=null;
      if(!drag) return;
      if(drag.dragged){ commands.publish(drag.receipt); return; }
      state.selectedId=drag.id;
      state.addOpen=false;
      rerender();
    };
    window.addEventListener('pointermove',move);
    window.addEventListener('pointerup',up,{once:true});
    window.addEventListener('pointercancel',up,{once:true});
  };

  function bind(element){
    root=element;
    abortController?.abort();
    mobile.unbind();
    if(renderedMobile){ mobile.bind(root); return; }
    abortController=new AbortController();
    const options={signal:abortController.signal};
    root.addEventListener('click',clickHandler,options);
    root.addEventListener('input',inputHandler,options);
    root.addEventListener('change',changeHandler,options);
    root.addEventListener('pointerdown',pointerDownHandler,options);
  }

  mobileMedia?.addEventListener('change', () => {
    // Keep raw text, caret and gesture ownership until the current editor closes.
    if(mobile.isEditing() || state.selectedId || state.drag) return;
    rerender();
  });
  return { render, bind };
}
