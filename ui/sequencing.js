import { pathReplay, savePathReplay } from '../src/state.js';

import { fmtM } from './formatters.js';

import { CHART_LAYOUT } from './chartLayout.js';



export function selectedPathIndex(res){
  if(!res || !Array.isArray(res.sims) || !res.sims.length) return 0;
  if(pathReplay.mode === 'typical'){
    return (res.paths && res.paths.p50 && res.paths.p50.simIndex != null) ? res.paths.p50.simIndex : 0;
  }
  if(pathReplay.mode === 'stressed'){
    return (res.paths && res.paths.p10 && res.paths.p10.simIndex != null) ? res.paths.p10.simIndex : 0;
  }
  if(pathReplay.mode === 'favorable'){
    return (res.paths && res.paths.p90 && res.paths.p90.simIndex != null) ? res.paths.p90.simIndex : 0;
  }
  if(pathReplay.mode === 'sequence-stress'){
    return (res.paths && res.paths.p10 && res.paths.p10.simIndex != null) ? res.paths.p10.simIndex : 0;
  }
  return 0;
}

export function pathModeLabel(){
  return ({
    typical:'Typical path',
    stressed:'Stressed path',
    favorable:'Favorable path',
    'sequence-stress':'Sequence Stress'
  })[pathReplay.mode] || 'Typical path';
}

export function pathOutcomeText(sim){
  if(!sim) return '';
  return sim.failed
    ? `Ran dry at age ${sim.depletionAge || 'n/a'}`
    : `Survived with ${fmtM(sim.terminalBalance || 0)}`;
}

export function drawSeqChart(svg, runs, retAge, seqChartSvg, { grid, axisInk }){
  const W=1000,H=320;
  svg.innerHTML=seqChartSvg(runs, retAge,{
    width:W,
    height:H,
    layout:CHART_LAYOUT.scenarioPath,
    fmtM,
    grid:grid,
    axisInk:axisInk
  });
}

export function renderPrints(container, runs, pathDigest){
  // All three figures come straight from the engine's pathDigest: first-decade
  // CAGR, lowest balance, and the damage window (longest run of years the
  // cumulative return sat below its retirement-day level — a long '66/'73
  // grind hurts a withdrawing portfolio far more than a V-shaped '08 shock).
  const pct=v=>(v>=0?'+':'')+(v*100).toFixed(1)+'%';
  const outcome=r=> r.depletionAge!=null
    ? {t:`Ran dry @ ${r.depletionAge}`, cls:'neg'}
    : {t:`Survived · ${fmtM(r.terminalBalance)}`, cls:'pos'};
  const card=(m,res)=>{
    const o=outcome(res);
    const d=pathDigest(res);
    // Only when there IS a drawdown — a good market never goes underwater, so the
    // row would just read "—". Show it where it tells a story; omit it otherwise.
    const dwBlock = d.underwaterSpellMax ? `
      <div class="pr-row" style="border-bottom:none"><span class="pr-k">Duration</span><span class="pr-v">${d.underwaterSpellMax} yr${d.underwaterSpellMax>1?'s':''}</span></div>
      <div class="dw-bar"><div class="dw-fill" style="width:${Math.min(100,d.underwaterSpellMax/12*100).toFixed(0)}%"></div></div>` : '';
    return `<div class="seq-print">
      <h4><span class="dot" style="border-color:${m.c}"></span>${m.y} · ${m.tag}</h4>
      <div class="pr-row"><span class="pr-k">First decade</span><span class="pr-v">${pct(d.first10Cagr)}</span></div>
      <div class="pr-row"><span class="pr-k">Lowest</span><span class="pr-v">${fmtM(d.minBalance)}</span></div>
      ${dwBlock}
      <div class="pr-row"><span class="pr-k">Outcome</span><span class="pr-v ${o.cls}">${o.t}</span></div>
    </div>`;
  };
  container.innerHTML=runs.map(r=>card(r.m, r.res)).join('');
}

export function syncPathControls(){
  const mode=document.querySelector('#path-mode');
  if(mode) mode.value = pathReplay.mode;
}

export function updatePathReplayMode(mode){
  pathReplay.mode=mode;
  savePathReplay();
}
