import { createMobileGoalDraft } from './mobileGoalDraft.js';
import { applyGoalEdit, effectiveGoalForView } from './goalEditing.js';
import { goalPeriodValueToAge, isOneTimeGoal, resolveGoalSpan } from './horizonModel.js';

export function createGoalEditSession({ goal, id, isNew, householdId, currentYear }){
  return { id, isNew, householdId, raw: {}, errors: {}, draft: createMobileGoalDraft(goal),
    lens: { mode: 'age', owner: 'primary', currentYear } };
}

export function flushGoalSessionField(session, field, plan){
  if(!Object.hasOwn(session.raw, field)) return !session.errors[field];
  const text = session.raw[field].replace(/[$,\s]/g, '');
  const value = text === '' ? NaN : Number(text);
  if(!Number.isFinite(value) || value < 0){
    session.errors[field] = 'Enter a number of zero or more.';
    return false;
  }
  try{
    const edit = field === 'amount' ? { type: 'amount', value }
      : { type: 'range', edge: field, value: goalPeriodValueToAge(value, plan, session.lens) };
    applyGoalEdit(session.draft.value, edit, resolveGoalSpan(plan));
    delete session.raw[field]; delete session.errors[field];
    return true;
  }catch(error){ session.errors[field] = error.message; return false; }
}

export function flushGoalSession(session, plan){
  for(const field of Object.keys(session.raw)) flushGoalSessionField(session, field, plan);
  return !Object.keys(session.errors).length;
}

export function applyGoalSessionEdit(session, edit, plan){
  if(edit.type === 'name'){
    applyGoalEdit(session.draft.value, edit, resolveGoalSpan(plan));
    delete session.errors.name;
    return true;
  }
  if(!flushGoalSession(session, plan)) return false;
  const span = resolveGoalSpan(plan);
  if(edit.type === 'frequency'){
    const once = isOneTimeGoal(effectiveGoalForView(session.draft.value, span));
    if((edit.value === 'once') !== once){
      applyGoalEdit(session.draft.value, { type: 'kind', value: edit.value === 'once' ? 'once' : 'rec' }, span);
    }
    applyGoalEdit(session.draft.value, { type: 'per', value: edit.value === 'monthly' ? 'mo' : 'yr' }, span);
  }else applyGoalEdit(session.draft.value, edit, span);
  return true;
}

export function prepareGoalSessionSave(session, plan){
  delete session.errors.name;
  if(!session.draft.value.name?.trim()) session.errors.name = 'Enter a goal name.';
  flushGoalSession(session, plan);
  const goal = session.draft.value;
  // Validate canonical timing, before the display helper can clamp it.
  const span = resolveGoalSpan(plan);
  if(!Object.hasOwn(session.raw, 'end')) delete session.errors.end;
  if(goal.startsAtRetirement === true && Number(goal.endAge) < span.retirementAge){
    session.errors.end = `End age must be ${span.retirementAge} or later for a goal that starts at retirement.`;
  }
  return !Object.keys(session.errors).length;
}
