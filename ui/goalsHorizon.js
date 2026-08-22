import { escHtml } from './dom.js';
import {
  GOAL_CATEGORIES,
  GOAL_CATEGORY_MAP,
  createGoalForCategory,
  defaultGoalId,
  duplicateGoal,
  formatGoalAmount,
  goalDisplayAmount,
  goalHasFutureWorkingYears,
  goalPct,
  goalTimingLabel,
  isOneTimeGoal,
  normalizeGoalCategory,
  resolveEffectiveGoal,
  resolveGoalSpan,
  setGoalDisplayAmount,
  setGoalKind,
  setGoalPer,
  setGoalRange,
  shiftGoal,
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

function effectiveGoalForView(goal, span){
  const resolved = resolveEffectiveGoal(goal, null, span.retirementAge);
  const startAge = Number.isFinite(Number(resolved.startAge))
    ? Number(resolved.startAge)
    : span.retirementAge;
  const requestedEnd = Number.isFinite(Number(resolved.endAge))
    ? Number(resolved.endAge)
    : span.planEndAge;
  const endAge = Math.max(startAge, Math.min(requestedEnd, span.planEndAge));
  return { ...goal, startAge, endAge };
}

function materializeGoalTiming(goal, span, { detachFromRetirement = false } = {}){
  const effective = effectiveGoalForView(goal, span);
  goal.startAge = effective.startAge;
  goal.endAge = effective.endAge;
  if(detachFromRetirement) goal.startsAtRetirement = false;
  return goal;
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

function tickAges(span){
  const ages=[span.retirementAge];
  for(let age=Math.ceil((span.retirementAge + 1) / 5) * 5; age<=span.planEndAge; age+=5) ages.push(age);
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

function renderRail(goal,index,span,disabled){
  if(!goal) return '';
  const viewGoal=effectiveGoalForView(goal,span);
  const id=viewGoalId(goal,index);
  const category=normalizeGoalCategory(viewGoal);
  const categoryDef=GOAL_CATEGORY_MAP[category];
  const once=isOneTimeGoal(viewGoal);
  const presets=timingPresets(span);
  const presetButtons=presets.map(preset=>{
    const selected=!once && +viewGoal.startAge===preset.from && +viewGoal.endAge===preset.to;
    return `<button class="gh-preset${selected?' is-selected':''}" type="button" data-action="preset" data-preset="${preset.key}"${disabledAttr(disabled)}>${preset.label}</button>`;
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
  const years=once
    ? `<div class="gh-once-age">
        <span>at age</span>
        <button type="button" data-action="age-minus" aria-label="Decrease age"${disabledAttr(disabled)}>−</button>
        <input class="gh-age-input" data-field="once-age" inputmode="numeric" value="${viewGoal.startAge}"${disabledAttr(disabled)}>
        <button type="button" data-action="age-plus" aria-label="Increase age"${disabledAttr(disabled)}>+</button>
      </div>`
    : `<div class="gh-presets">${presetButtons}</div>
      <div class="gh-range-inputs">
        <span>from age</span><input class="gh-age-input" data-field="start-age" inputmode="numeric" value="${viewGoal.startAge}"${disabledAttr(disabled)}>
        <span>to</span><input class="gh-age-input" data-field="end-age" inputmode="numeric" value="${viewGoal.endAge}"${disabledAttr(disabled)}>
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
        <div class="gh-field-label">Which years</div>
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
  const state={ selectedId:null, addOpen:false, initialSelectionResolved:false, flashId:null, toast:null, drag:null };
  let root=null;
  let abortController=null;
  let toastTimer=null;

  const goals=()=>Array.isArray(deps.getPlan().goals) ? deps.getPlan().goals : [];
  const disabled=()=>Boolean(deps.isReadOnly?.());
  const span=()=>resolveGoalSpan(deps.getPlan());

  const selectedRecord=()=>{
    const list=goals();
    const index=goalIndexByViewId(list,state.selectedId);
    return index>=0 ? {goal:list[index],index} : null;
  };

  const prepareGoal=(goal,index)=>{
    if(!goal.id){
      const old=viewGoalId(goal,index);
      goal.id=defaultGoalId(index);
      if(state.selectedId===old) state.selectedId=goal.id;
      if(root){
        const lane=root.querySelector(`[data-goal-lane="${CSS.escape(old)}"]`);
        const chip=root.querySelector(`[data-goal-chip="${CSS.escape(old)}"]`);
        if(lane) lane.dataset.goalLane=goal.id;
        if(chip) chip.dataset.goalChip=goal.id;
      }
    }
    const cat=normalizeGoalCategory(goal);
    goal.cat=cat;
    goal.area=cat;
    if(goal.per!=='mo') goal.per='yr';
    return goal;
  };

  const render=()=>{
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
    const toast=state.toast ? `<div class="gh-toast" role="status"><span>Deleted “${escHtml(state.toast.goal.name || 'Untitled goal')}”</span><button type="button" data-action="undo">Undo</button><button type="button" data-action="dismiss-toast" aria-label="Dismiss">×</button></div>` : '';
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
      ${selected ? renderRail(selected.goal,selected.index,currentSpan,isDisabled) : addRail}
      ${toast}
    </div>`;
  };

  const rerender=()=>{
    if(!root) return;
    root.innerHTML=render();
    bind(root);
  };

  const arm=()=>deps.arm?.();
  const commit=()=>deps.commit?.();

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
    toastTimer=setTimeout(()=>{ state.toast=null; toastTimer=null; rerender(); },8000);
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
      if(!deps.guardMutation()) return;
      const currentSpan=span();
      const goal=createGoalForCategory(addEl.dataset.addCategory,currentSpan);
      const index=goals().length;
      deps.insertGoal(index,goal);
      state.selectedId=goal.id;
      state.flashId=goal.id;
      state.addOpen=false;
      commit();
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
      if(!state.toast || !deps.guardMutation()) return;
      const restored=state.toast;
      dismissToast();
      deps.insertGoal(restored.index,restored.goal,restored.overrides);
      state.flashId=restored.goal.id || `legacy_${restored.index}`;
      commit();
      setTimeout(()=>{ state.flashId=null; },1500);
      return;
    }
    if(!deps.guardMutation()) return;
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    prepareGoal(goal,index);
    const currentSpan=span();
    const once=isOneTimeGoal(goal);
    if(action==='amount-minus'||action==='amount-plus'){
      const step=once ? (goalDisplayAmount(goal)>=100000?25000:5000) : goal.per==='mo'?250:1000;
      setGoalDisplayAmount(goal,Math.max(0,goalDisplayAmount(goal)+(action==='amount-plus'?step:-step)));
    }else if(action==='per-year') setGoalPer(goal,'yr');
    else if(action==='per-month') setGoalPer(goal,'mo');
    else if(action==='fund-outside') goal.fundFromPortfolioBeforeRetirement=false;
    else if(action==='fund-portfolio') goal.fundFromPortfolioBeforeRetirement=true;
    else if(action==='kind-once'){
      materializeGoalTiming(goal,currentSpan,{detachFromRetirement:true});
      setGoalKind(goal,'once',currentSpan.planEndAge);
    }else if(action==='kind-rec'){
      materializeGoalTiming(goal,currentSpan,{detachFromRetirement:true});
      setGoalKind(goal,'rec',currentSpan.planEndAge);
    }
    else if(action==='preset'){
      const preset=timingPresets(currentSpan).find(item=>item.key===actionEl.dataset.preset);
      if(preset){
        goal.startsAtRetirement=false;
        setGoalRange(goal,preset.from,preset.to,currentSpan.planEndAge);
      }
    }else if(action==='age-minus'||action==='age-plus'){
      materializeGoalTiming(goal,currentSpan,{detachFromRetirement:true});
      const age=+goal.startAge+(action==='age-plus'?1:-1);
      setGoalRange(goal,age,age,currentSpan.planEndAge);
    }else if(action==='category'){
      const cat=GOAL_CATEGORY_MAP[actionEl.dataset.category]?actionEl.dataset.category:'custom';
      goal.cat=cat; goal.area=cat;
    }else if(action==='duplicate'){
      const copy=duplicateGoal(goal);
      deps.insertGoal(index+1,copy);
      state.selectedId=copy.id;
      state.flashId=copy.id;
      commit();
      setTimeout(()=>{ state.flashId=null; },1500);
      return;
    }else if(action==='delete'){
      // Essentials and Healthcare are the household's baseline spending, not
      // discretionary goals. The button is hidden for them; this guards the
      // path anyway so a stale DOM or a keyboard route cannot remove one.
      if(goals()[index]?.system) return;
      const removed=deps.removeGoal(index);
      state.selectedId=null;
      state.toast={...removed,index};
      scheduleToast();
      commit();
      return;
    }else return;
    state.selectedId=goal.id;
    commit();
  };

  const inputHandler=e=>{
    if(!deps.guardMutation()) return;
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    prepareGoal(goal,index);
    if(e.target.matches('.gh-name-input')){
      goal.name=e.target.value;
      arm();
      updateChipText(goal,goal.id);
    }else if(e.target.matches('.gh-amount-input')){
      liveCommas(e.target);
      setGoalDisplayAmount(goal,parseInt(e.target.value.replace(/[^0-9]/g,''),10)||0);
      arm();
      updateChipText(goal,goal.id);
    }
  };

  const changeHandler=e=>{
    const field=e.target.dataset.field;
    if(!['once-age','start-age','end-age'].includes(field)) return;
    if(!deps.guardMutation()) return;
    const selected=selectedRecord();
    if(!selected) return;
    const {goal,index}=selected;
    prepareGoal(goal,index);
    const currentSpan=span();
    const value=parseInt(e.target.value.replace(/[^0-9]/g,''),10);
    const effective=effectiveGoalForView(goal,currentSpan);
    if(field==='once-age'){
      goal.startsAtRetirement=false;
      setGoalRange(goal,value,value,currentSpan.planEndAge);
    }else if(field==='start-age'){
      goal.startsAtRetirement=false;
      setGoalRange(goal,value,effective.endAge,currentSpan.planEndAge,'start');
    }else{
      setGoalRange(goal,effective.startAge,value,currentSpan.planEndAge,'end');
    }
    state.selectedId=goal.id;
    commit();
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
    const effective=effectiveGoalForView(goal,currentSpan);
    state.drag={ id,index,goal,startX:e.clientX,startAge:+effective.startAge,endAge:+effective.endAge,dragged:false,armed:false,rect,currentSpan,chip };
    const move=event=>{
      const drag=state.drag;
      if(!drag) return;
      const dx=event.clientX-drag.startX;
      if(!drag.dragged && Math.abs(dx)<=4) return;
      let firstMove=false;
      if(!drag.armed){
        if(!deps.guardMutation()) return;
        const list=goals();
        const index=goalIndexByViewId(list,drag.id);
        if(index<0) return;
        drag.goal=list[index];
        drag.index=index;
        drag.armed=true;
        firstMove=true;
      }
      drag.dragged=true;
      drag.chip.classList.add('is-dragging');
      drag.goal.startsAtRetirement=false;
      drag.goal.startAge=drag.startAge;
      drag.goal.endAge=drag.endAge;
      const years=Math.round(dx/(drag.rect.width/(drag.currentSpan.axisMax-drag.currentSpan.axisMin)));
      shiftGoal(drag.goal,years,{dragMin:drag.currentSpan.axisMin,planEndAge:drag.currentSpan.planEndAge});
      if(!drag.goal.id) prepareGoal(drag.goal,drag.index);
      drag.id=drag.goal.id;
      updateGoalGeometry(drag.goal,drag.id,drag.currentSpan);
      if(firstMove) arm();
    };
    const up=()=>{
      const drag=state.drag;
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',up);
      window.removeEventListener('pointercancel',up);
      state.drag=null;
      if(!drag) return;
      if(drag.dragged){ commit(); return; }
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
    abortController=new AbortController();
    const options={signal:abortController.signal};
    root.addEventListener('click',clickHandler,options);
    root.addEventListener('input',inputHandler,options);
    root.addEventListener('change',changeHandler,options);
    root.addEventListener('pointerdown',pointerDownHandler,options);
  }

  return { render, bind };
}
