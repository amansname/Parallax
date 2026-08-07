export function soloRowText(key, baseV, newV, { levCfg, defaultLevers }){
  const cfg = levCfg.find(c=>c.key===key);
  const fmt = v => { const [a,u]=cfg.fmt(v, {...defaultLevers(), [key]:v, eventAge:70}); return u && u!=='growth / defensive' ? `${a} ${u}` : a; };
  const from = fmt(baseV), to = fmt(newV);
  let delta = '';
  if(newV === baseV)                 delta = 'no change needed';
  else if(key==='spend')             delta = `${newV<baseV?'−':'+'}${Math.abs(Math.round((newV-baseV)/baseV*100))}%`;
  else if(key==='savings')           delta = `${newV>baseV?'+':'−'}$${Math.abs(Math.round((newV-baseV)/1000))}k/yr`;
  else if(key==='risk')              delta = `${newV>baseV?'+':''}${newV-baseV} level${Math.abs(newV-baseV)>1?'s':''}`;
  else /* ages */                    delta = `${newV>baseV?'+':''}${newV-baseV} yr${Math.abs(newV-baseV)>1?'s':''}`;
  return { name: cfg.name, from, to, delta, unchanged: newV===baseV };
}

export function goalParamsHtml(goalType, baseLev, defPct, { goals, currentAge, planEndAge = 99 }){
  const g = goals[goalType];
  const cur = currentAge;
  const money = (id,lbl,val,suf='') => `<label class="sf-field"><span class="sf-lbl">${lbl}</span><span class="sf-box-wrap"><span class="sf-prefix">$</span><input class="sf-box sf-money" id="${id}" type="text" inputmode="numeric" value="${val.toLocaleString('en-US')}">${suf?`<span class="sf-suffix">${suf}</span>`:''}</span></label>`;
  const age = (id,lbl,val,min=55,max=99) => `<label class="sf-field"><span class="sf-lbl">${lbl}</span><span class="sf-box-wrap"><input class="sf-box" id="${id}" type="number" min="${min}" max="${max}" value="${val}"></span></label>`;
  let h = '';
  if(goalType==='retire')    h += age('sf-p-age','By age', baseLev.retireAge, 55, 72);
  if(goalType==='purchase'){ h += money('sf-p-amount','Amount', 300000); h += age('sf-p-age','At age', Math.min(72, baseLev.retireAge+2), cur, planEndAge); }
  if(goalType==='gift'){     h += money('sf-p-amount','Each year', 25000, '/yr'); h += age('sf-p-toage','Through age', Math.min(85,planEndAge), cur, planEndAge); }
  if(goalType==='legacy')    h += money('sf-p-amount','At least', 1000000);
  const barLbl = g.bar==='chance' ? 'Chance' : 'Confidence';
  const barDef = g.bar==='chance' ? 85 : defPct;
  h += `<label class="sf-field"><span class="sf-lbl">${barLbl}</span><span class="sf-box-wrap"><input class="sf-box" id="sf-pct" type="number" min="50" max="99" value="${barDef}"><span class="sf-suffix">%</span></span></label>`;
  return h;
}

export function comboPillValue(key, baseV, val){
  if(key==='spend'){   const d=Math.round((val-baseV)/12); return (d<0?'−$':'+$')+Math.abs(d).toLocaleString('en-US')+'/mo'; }
  if(key==='savings'){ const d=Math.round((val-baseV)/1000); return (d<0?'−$':'+$')+Math.abs(d)+'k/yr'; }
  return String(val);  // ages: the claim/retire age itself
}

export function comboGoalPill(goalType, params){
  if(goalType==='retire')   return { k:'Retire', v:String(params.age) };
  if(goalType==='purchase') return { k:'Buy',    v:'$'+Math.round(params.amount/1000)+'k @'+params.age };
  if(goalType==='gift')     return { k:'Gift',   v:'$'+Math.round(params.amount/1000)+'k/yr→'+params.toAge };
  if(goalType==='legacy')   return { k:'Leave',  v:'≥$'+Math.round(params.amount/1000)+'k' };
  return null;  // plain confidence goal has no extra anchor
}

export function renderComboField(C, { comboShort }){
  if(!C.combos.length){
    return `<div class="combo-field">
      <div class="combo-head">No balanced pair reaches ${C.target}%.</div>
      <div class="combo-empty">Even two moves together can't clear it within reasonable bands — ease the goal, or this plan needs a bigger change.</div></div>`;
  }
  const gp = comboGoalPill(C.goalType, C.params);
  const cards = C.combos.map((c,idx)=>{
    let pills = '';
    if(gp) pills += `<span class="cpill pin"><span class="pk">${gp.k}</span><span class="pv">${gp.v}</span></span>`;
    c.items.forEach((m,i)=>{
      if(gp || i>0) pills += `<span class="cc-plus">+</span>`;
      pills += `<span class="cpill ${m.cut?'cut':'move'}"><span class="pk">${comboShort[m.key]||m.key}</span><span class="pv">${m.pv}</span></span>`;
    });
    return `<div class="combo-card${idx===0?' lead':''}">
      <div class="cc-moves">${pills}</div>
      <div class="cc-conf"><div class="cv">${c.pct.toFixed(0)}%</div><div class="ck">confidence</div><div class="cd">+${c.deltaPts.toFixed(0)} pts ✓</div></div>
      <button class="cc-load" data-combo-idx="${idx}" ${C.canLoad?'':'disabled'}>Load</button>
    </div>`;
  }).join('');
  return `<div class="combo-field">
    <div class="combo-head">Balanced ways to reach ${C.goalType==='retire'?C.params.age:'the goal'} — two gentler moves instead of one big one:</div>
    <div class="combo-sub">Each pair shares the load across two levers and still clears <b>${C.target}%</b>. Ordered least-disruptive first.</div>
    ${cards}
    <div class="combo-foot">The goal is held fixed; the engine searched pairs of the remaining levers through the same markets and kept the combinations where neither lever does all the work. Load any one as a new scenario column.</div>
  </div>`;
}

export function solvePanelHTML({
  solverFormOpen, scenarios, defaultLevers, goals, currentAge, planEndAge,
  solverResults, solverSearching, comboOpen, comboSearching, comboResults,
  levCfg, comboShort, escHtml,
}){
  // The goal-entry FORM takes priority — full-width card so it has room to breathe.
  if(solverFormOpen){
    const baseLev = scenarios.find(s=>s.base)?.lev || defaultLevers();
    const baseSucc = scenarios.find(s=>s.base)?.res?.successRate ?? 85;
    const defPct = Math.min(95, Math.ceil((baseSucc+1)/5)*5);
    const goalOpts = Object.entries(goals).map(([k,g])=>`<option value="${k}"${k==='retire'?' selected':''}>${g.label}</option>`).join('');
    return `
      <div class="solve-panel solve-form-panel">
        <div class="solve-panel-head">
          <span class="solve-panel-title">What would it take? — solve each lever to a goal</span>
          <button class="solve-clear" id="sf-cancel">✕ Cancel</button>
        </div>
        <div class="solve-scope">Quick solve uses the simplified tax estimate. Loaded scenarios are recalculated with modeled federal tax.</div>
        <form class="sf-form" id="solver-form">
          <label class="sf-field"><span class="sf-lbl">Goal</span>
            <select class="sf-select" id="sf-goal">${goalOpts}</select></label>
          <span id="sf-params" class="sf-params">${goalParamsHtml('retire', baseLev, defPct, { goals, currentAge, planEndAge })}</span>
          <button type="submit" class="sf-go">Solve →</button>
        </form>
      </div>`;
  }
  if(!solverResults && !solverSearching) return '';
  if(solverSearching){
    return `<div class="solve-panel"><div class="solve-searching">Solving each lever</div></div>`;
  }
  const R = solverResults;
  const P = R.params;
  const money = v => '$' + Math.round(v).toLocaleString('en-US');
  // Goal sentence reads the client's wish back, then the bar.
  let goal;
  if(R.goalType==='legacy'){
    goal = `For a <b>${R.targetPct}%</b> chance of leaving at least <b>${money(P.amount)}</b>`;
  } else if(R.goalType==='retire'){
    goal = `To retire by <b>${P.age}</b> at <b>${R.targetPct}%</b> confidence`;
  } else if(R.goalType==='purchase'){
    goal = `To afford <b>${money(P.amount)}</b> at age <b>${P.age}</b> and stay at <b>${R.targetPct}%</b> confidence`;
  } else if(R.goalType==='gift'){
    goal = `To gift <b>${money(P.amount)}/yr</b> through age <b>${P.toAge}</b> and stay at <b>${R.targetPct}%</b> confidence`;
  } else {
    goal = `To reach <b>${R.targetPct}%</b> confidence`;
  }
  goal += `, here's what each lever would need to be on its own:`;
  const allCapped = R.rows.length > 0 && R.rows.every(r => r.capped);
  const rows = R.rows.map((row,i) => {
    const t = soloRowText(row.key, R.soloBase[row.key], row.value, { levCfg, defaultLevers });
    const capped = row.capped;
    // "Already meets it" only when NOT capped and no move needed. When capped,
    // the lever can't get there at all — show the best it can do, never "meets it".
    const justMeets = t.unchanged && !capped;
    const move = justMeets
      ? `<span class="solo-to">${t.to}</span><span class="solo-delta">already meets it</span>`
      : t.unchanged   // capped but no useful move exists
        ? `<span class="solo-to">${t.to}</span><span class="solo-delta">no setting reaches it</span>`
        : `<span class="solo-from">${t.from}</span><span class="solo-arrow">→</span><span class="solo-to">${t.to}</span><span class="solo-delta">${t.delta}</span>`;
    return `<div class="solo-row ${capped?'capped':''} ${justMeets?'unchanged':''}">
      <div class="solo-name">${escHtml(t.name)}</div>
      <div class="solo-move">${move}</div>
      <div class="solo-pct ${capped?'capped':''}">${capped ? `best hits ${row.reachedPct.toFixed(0)}%` : `${row.reachedPct.toFixed(0)}% ✓`}</div>
      <button class="solve-load" data-solo-idx="${i}" ${capped||justMeets||!R.canLoad?'disabled':''}>Load</button>
    </div>`;
  }).join('');
  const allCappedNote = allCapped
    ? `<div class="solo-allcapped">No single lever reaches ${R.targetPct}% — combine moves, or ease the goal.</div>` : '';
  // The small solo widget folds DOWN into the combo field. The tab is always
  // offered once we have solo results; the heavy search only runs when opened.
  let comboHtml = `<div class="fold-cta"><button class="fold-tab" id="combo-toggle">${comboOpen?'↑ Hide combinations':'↓ Balanced combinations'}</button></div>`;
  if(comboOpen){
    comboHtml += comboSearching
      ? `<div class="combo-field"><div class="combo-searching">Searching balanced combinations</div></div>`
      : (comboResults ? renderComboField(comboResults, { comboShort }) : '');
  }
  return `
    <div class="solve-panel">
      <div class="solve-panel-head">
        <span class="solve-panel-title">${goal}</span>
        <button class="solve-clear" id="solve-clear-btn">✕ Clear</button>
      </div>
      <div class="solve-scope">Quick solve uses the simplified tax estimate. Loaded scenarios are recalculated with modeled federal tax.</div>
      <div class="solo-list">${rows}</div>
      ${allCappedNote}
    </div>
    ${comboHtml}`;
}

