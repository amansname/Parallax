import { applyGoalEdit, effectiveGoalForView } from './goalEditing.js';
import { applyMobileGoalDraft } from './mobileGoalDraft.js';
import { prepareGoalSessionSave } from './goalEditSession.js';
import { createGoalForCategory, defaultGoalId, duplicateGoal, normalizeGoalCategory, resolveGoalSpan, shiftGoal } from './horizonModel.js';

export const goalViewId = (goal, index) => typeof goal.id === 'string' && goal.id ? goal.id : `legacy_${index}`;

export function createGoalCommands(deps){
  const goals = () => deps.getPlan().goals || [];
  const identity = () => deps.getHouseholdId?.();
  const span = () => resolveGoalSpan(deps.getPlan());
  const find = id => {
    const index = goals().findIndex((goal, i) => goalViewId(goal, i) === id);
    return index < 0 ? null : { goal: goals()[index], index };
  };
  function guard(expected = identity()){
    if(expected !== identity() || deps.isReadOnly?.()) return false;
    return deps.guardMutation?.() === true && expected === identity();
  }
  function prepare(record){
    const oldId = goalViewId(record.goal, record.index);
    if(!record.goal.id) record.goal.id = defaultGoalId(record.index);
    const category = normalizeGoalCategory(record.goal);
    record.goal.cat = category; record.goal.area = category;
    if(record.goal.per !== 'mo') record.goal.per = 'yr';
    return { ...record, oldId, householdId: identity() };
  }
  function guardedRecord(id){
    const before = find(id);
    const legacy = before && !before.goal.id ? JSON.stringify(goals()) : null;
    if(!guard()) return null;
    if(legacy !== null && legacy !== JSON.stringify(goals())) return null;
    return find(id);
  }
  function update(id, edit){
    const record = guardedRecord(id);
    if(!record) return null;
    // Validate the complete operation before assigning an id or changing facts.
    const value = applyGoalEdit(structuredClone(record.goal), edit, span());
    Object.assign(record.goal, value);
    return prepare(record);
  }
  function create(category){
    if(!guard()) return null;
    const goal = createGoalForCategory(category, span());
    const index = goals().length;
    deps.insertGoal(index, goal);
    return prepare({ goal, index });
  }
  function duplicate(id){
    const record = guardedRecord(id);
    if(!record || record.goal.system) return null;
    const goal = duplicateGoal(record.goal);
    const index = record.index + 1;
    deps.insertGoal(index, goal);
    return prepare({ goal, index });
  }
  const snapshot = () => ({
    householdId: identity(), order: goals().map(goalViewId),
    scenarios: [...(deps.getScenarios?.() || [])],
    scenarioValues: JSON.stringify((deps.getScenarios?.() || []).map(s => [s.name, s.base, s.lev])),
  });
  function sameSnapshot(saved){
    const current = snapshot();
    return saved.householdId === current.householdId
      && JSON.stringify(saved.order) === JSON.stringify(current.order)
      && saved.scenarios.length === current.scenarios.length
      && saved.scenarios.every((scenario, index) => scenario === current.scenarios[index])
      && saved.scenarioValues === current.scenarioValues;
  }
  function remove(id){
    const record = guardedRecord(id);
    if(!record || record.goal.system) return null;
    return { ...deps.removeGoal(record.index), index: record.index, householdId: identity(), removed: true };
  }
  function restore(token){
    if(!token?.context || !sameSnapshot(token.context)) throw new Error('The plan changed after this deletion. Undo is no longer available.');
    if(!guard(token.householdId)) return null;
    if(!sameSnapshot(token.context)) throw new Error('The plan changed after this deletion. Undo is no longer available.');
    deps.insertGoal(token.index, token.goal, token.overrides);
    return { goal: token.goal, index: token.index, householdId: identity() };
  }
  function applyDraft(session){
    if(!guard(session.householdId)) return null;
    if(!prepareGoalSessionSave(session, deps.getPlan())) throw new Error(Object.values(session.errors)[0]);
    if(session.isNew){
      const goal = structuredClone(session.draft.value);
      const index = goals().length;
      deps.insertGoal(index, goal);
      return prepare({ goal, index });
    }
    const record = find(session.id);
    if(!record) throw new Error('This goal is no longer available. Return to Goals.');
    if(!record.goal.id && JSON.stringify(record.goal) !== JSON.stringify(session.draft.original)){
      throw new Error('This goal changed while you were editing. Return to Goals and reopen it.');
    }
    applyMobileGoalDraft(record.goal, session.draft);
    return prepare(record);
  }
  function beginMove(id){
    const record = find(id);
    if(!record) return null;
    const currentSpan = span();
    const effective = effectiveGoalForView(record.goal, currentSpan);
    return { id, householdId: identity(), startAge: effective.startAge, endAge: effective.endAge, span: currentSpan, armed: false,
      legacy: record.goal.id ? null : JSON.stringify(goals()) };
  }
  function move(token, years){
    if(!token || token.householdId !== identity() || deps.isReadOnly?.()) return null;
    if(!token.armed && !guard(token.householdId)) return null;
    if(!token.armed && token.legacy !== null && token.legacy !== JSON.stringify(goals())) return null;
    const record = find(token.id);
    if(!record) return null;
    record.goal.startsAtRetirement = false;
    record.goal.startAge = token.startAge;
    record.goal.endAge = token.endAge;
    shiftGoal(record.goal, years, { dragMin: token.span.axisMin, planEndAge: token.span.planEndAge });
    const receipt = prepare(record);
    token.id = receipt.goal.id; token.householdId = identity();
    const firstMove = !token.armed; token.armed = true;
    return { ...receipt, firstMove };
  }
  function publish(receipt, cadence = 'commit'){
    if(!receipt || receipt.householdId !== identity()) return false;
    if(cadence === 'arm') deps.arm?.(); else deps.commit?.();
    if(receipt.removed) receipt.context = snapshot();
    return !deps.isSaveFailed?.() && !deps.isReadOnly?.();
  }
  return { identity, find, update, create, duplicate, remove, restore, applyDraft, beginMove, move, publish };
}
